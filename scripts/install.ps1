#Requires -Version 5.1
<#
.SYNOPSIS
    Install dsh-computer-use into one DSH profile and verify the composed config.

.DESCRIPTION
    THIS SCRIPT MODIFIES A DSH PROFILE. It runs
        npx @deepseek-ai/dsh plugin --profile <Profile> add "file:<this repo>"
    which edits "<DSH_HOME>\profiles\<Profile>\package.json" (adds the dependency and
    appends "dsh-computer-use" to dsh.profile.bundles) and runs pnpm inside that
    profile directory. Nothing else on the machine is touched.

    Steps, each of which aborts with exit code 1 on failure:
      1. sanity-check the platform, Node >= 20, and PowerShell
      2. make pnpm available (generate a shim next to the bundled pnpm.mjs if pnpm
         is not on PATH; the PATH change is process-local only)
      3. add the bundle to the profile
      4. assert "computer-use" appears in --dump-config, then tell you to restart DSH

.PARAMETER Profile
    DSH profile to install into. Default: web.

.PARAMETER RepoRoot
    This repository's root. Default: the parent directory of this script.

.PARAMETER PnpmMjs
    Explicit path to a bundled pnpm.mjs, used when pnpm is not on PATH.

.EXAMPLE
    pwsh -NoProfile -File scripts\install.ps1 -Profile web

.EXAMPLE
    pwsh -NoProfile -File scripts\install.ps1 -Profile desktop -WhatIf
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$Profile = 'web',
    [string]$RepoRoot = (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)),
    [string]$PnpmMjs = ''
)

$ErrorActionPreference = 'Stop'

function Fail($message) {
    Write-Host "ERROR: $message" -ForegroundColor Red
    exit 1
}

function Step($message) {
    Write-Host ""
    Write-Host "==> $message" -ForegroundColor Cyan
}

Write-Host "dsh-computer-use installer" -ForegroundColor Green
Write-Host "  profile : $Profile"
Write-Host "  repo    : $RepoRoot"
Write-Host "  target  : $(if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' })\profiles\$Profile\package.json"

if (-not (Test-Path -LiteralPath (Join-Path $RepoRoot 'package.json'))) {
    Fail "package.json not found under '$RepoRoot'. Pass -RepoRoot with the absolute path of the dsh-computer-use repository."
}
if (-not (Test-Path -LiteralPath (Join-Path $RepoRoot 'cordis.patch.yml'))) {
    Fail "cordis.patch.yml not found under '$RepoRoot'; the bundle would not become a profile layer."
}

Step "1/4 checking platform, Node and PowerShell"

if ($env:OS -ne 'Windows_NT' -or [System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
    Fail "this plugin drives the Windows desktop and can only be installed on Windows."
}

$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCommand) {
    Fail "node was not found on PATH. Install Node.js 20 or newer."
}
$nodeVersion = (& node --version).Trim()
$nodeMajor = 0
if ($nodeVersion -match '^v(\d+)\.') { $nodeMajor = [int]$Matches[1] }
if ($nodeMajor -lt 20) {
    Fail "Node.js 20 or newer is required, found $nodeVersion."
}
Write-Host "    node    : $nodeVersion"

$psCommand = Get-Command pwsh -ErrorAction SilentlyContinue
if (-not $psCommand) {
    $psCommand = Get-Command powershell -ErrorAction SilentlyContinue
}
if (-not $psCommand) {
    Fail "neither 'pwsh' (PowerShell 7) nor 'powershell' (5.1) was found on PATH; the desktop host needs one of them."
}
Write-Host "    host ps : $($psCommand.Source)"

$npxCommand = Get-Command npx -ErrorAction SilentlyContinue
if (-not $npxCommand) {
    Fail "npx was not found on PATH. Install Node.js 20 or newer (it ships with npm/npx)."
}

Step "2/4 making pnpm available"

$pnpmCommand = Get-Command pnpm -ErrorAction SilentlyContinue
if ($pnpmCommand) {
    Write-Host "    pnpm    : $($pnpmCommand.Source) (from PATH)"
} else {
    Write-Host "    pnpm    : not on PATH, preparing a shim from the DSH bundled copy"

    $candidates = New-Object System.Collections.Generic.List[string]
    if ($PnpmMjs) { $candidates.Add($PnpmMjs) }
    if ($env:DSH_PNPM) { $candidates.Add($env:DSH_PNPM) }
    $dshHomes = @()
    if ($env:DSH_HOME) { $dshHomes += $env:DSH_HOME }
    $dshHomes += (Join-Path $env:USERPROFILE '.dsh')
    foreach ($home in ($dshHomes | Select-Object -Unique)) {
        $pattern = Join-Path $home 'dsh-runtimes\*\dependencies\pnpm\bin\pnpm.mjs'
        foreach ($found in (Get-ChildItem -Path $pattern -ErrorAction SilentlyContinue)) { $candidates.Add($found.FullName) }
    }

    $resolved = $null
    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path -LiteralPath $candidate)) { $resolved = $candidate; break }
    }
    if (-not $resolved) {
        Fail "pnpm is not on PATH and no bundled pnpm.mjs was found. Install pnpm (npm install -g pnpm) or pass -PnpmMjs <path to pnpm.mjs>."
    }

    $shimDir = Join-Path $env:TEMP 'dsh-cu-bin'
    $shimPath = Join-Path $shimDir 'pnpm.cmd'
    if ($PSCmdlet.ShouldProcess($shimPath, "create pnpm shim for $resolved")) {
        New-Item -ItemType Directory -Path $shimDir -Force | Out-Null
        "@node `"$resolved`" %*" | Set-Content -LiteralPath $shimPath -Encoding ascii
        $env:PATH = "$shimDir;$env:PATH"
    }
    $pnpmCommand = Get-Command pnpm -ErrorAction SilentlyContinue
    if (-not $pnpmCommand) {
        Fail "the pnpm shim was created at '$shimPath' but 'pnpm' still does not resolve. Check that $resolved exists and that node works."
    }
    Write-Host "    pnpm    : $($pnpmCommand.Source) -> $resolved"
    Write-Host "    (PATH change is process-local; other shells are unaffected)"
}

Step "3/4 adding the bundle to profile '$Profile'"

$packageSpec = "file:$RepoRoot"
if ($PSCmdlet.ShouldProcess("profile '$Profile'", "npx @deepseek-ai/dsh plugin --profile $Profile add $packageSpec")) {
    & npx @deepseek-ai/dsh plugin --profile $Profile add $packageSpec
    if ($LASTEXITCODE -ne 0) {
        Fail "dsh plugin add failed with exit code $LASTEXITCODE. Common causes: pnpm missing from PATH, or a profile that does not exist yet (run any dsh command for that profile once)."
    }
}

Step "4/4 verifying the composed config"

$dump = ''
if ($PSCmdlet.ShouldProcess("profile '$Profile'", 'npx @deepseek-ai/dsh --dump-config')) {
    $dump = (& npx @deepseek-ai/dsh --profile $Profile --dump-config 2>&1 | Out-String)
    if ($LASTEXITCODE -ne 0) {
        Fail "dsh --dump-config failed with exit code $LASTEXITCODE.`n$dump"
    }
    $hit = $dump | Select-String -Pattern 'computer-use' -SimpleMatch
    if (-not $hit) {
        Fail "the composed config for profile '$Profile' does not mention computer-use, so the bundle is not mounted. Check that 'dsh-computer-use' is listed in dsh.profile.bundles in the profile's package.json.`n$dump"
    }
    Write-Host "    found   : $($hit | Select-Object -First 1)"
}

Write-Host ""
Write-Host "已安装，请重启 DSH。" -ForegroundColor Green
Write-Host "Installed into profile '$Profile'. Restart DSH now (the bundle list is resolved at boot), then ask the agent to take a screenshot."
Write-Host "Uninstall with: pwsh -NoProfile -File scripts\uninstall.ps1 -Profile $Profile"
exit 0
