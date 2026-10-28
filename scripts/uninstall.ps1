#Requires -Version 5.1
<#
.SYNOPSIS
    Remove dsh-computer-use from one DSH profile.

.DESCRIPTION
    THIS SCRIPT MODIFIES A DSH PROFILE. It runs
        npx @deepseek-ai/dsh plugin --profile <Profile> remove dsh-computer-use
    which edits "<DSH_HOME>\profiles\<Profile>\package.json" (drops the dependency and
    the dsh.profile.bundles entry) and runs pnpm inside that profile directory.

    Steps, each of which aborts with exit code 1 on failure:
      1. sanity-check the platform, Node >= 20, and PowerShell
      2. make pnpm available (generate a shim next to the bundled pnpm.mjs if pnpm
         is not on PATH; the PATH change is process-local only)
      3. remove the bundle from the profile
      4. report whether computer-use is gone from --dump-config

.PARAMETER Profile
    DSH profile to remove from. Default: web.

.PARAMETER PnpmMjs
    Explicit path to a bundled pnpm.mjs, used when pnpm is not on PATH.

.EXAMPLE
    pwsh -NoProfile -File scripts\uninstall.ps1 -Profile web
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$Profile = 'web',
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

Write-Host "dsh-computer-use uninstaller" -ForegroundColor Green
Write-Host "  profile : $Profile"
Write-Host "  target  : $(if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' })\profiles\$Profile\package.json"

Step "1/3 checking platform, Node and PowerShell"

if ($env:OS -ne 'Windows_NT' -or [System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
    Fail "this script manages a Windows profile plugin; run it on Windows."
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

$psCommand = Get-Command pwsh -ErrorAction SilentlyContinue
if (-not $psCommand) {
    $psCommand = Get-Command powershell -ErrorAction SilentlyContinue
}
if (-not $psCommand) {
    Fail "neither 'pwsh' nor 'powershell' was found on PATH."
}
$npxCommand = Get-Command npx -ErrorAction SilentlyContinue
if (-not $npxCommand) {
    Fail "npx was not found on PATH. Install Node.js 20 or newer."
}
Write-Host "    node    : $nodeVersion"
Write-Host "    host ps : $($psCommand.Source)"

Step "2/3 making pnpm available"

$pnpmCommand = Get-Command pnpm -ErrorAction SilentlyContinue
if ($pnpmCommand) {
    Write-Host "    pnpm    : $($pnpmCommand.Source) (from PATH)"
} else {
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
        Fail "the pnpm shim was created at '$shimPath' but 'pnpm' still does not resolve."
    }
    Write-Host "    pnpm    : $($pnpmCommand.Source) -> $resolved"
    Write-Host "    (PATH change is process-local; other shells are unaffected)"
}

Step "3/3 removing the bundle from profile '$Profile'"

if ($PSCmdlet.ShouldProcess("profile '$Profile'", 'npx @deepseek-ai/dsh plugin remove dsh-computer-use')) {
    & npx @deepseek-ai/dsh plugin --profile $Profile remove dsh-computer-use
    if ($LASTEXITCODE -ne 0) {
        Fail "dsh plugin remove failed with exit code $LASTEXITCODE. If this dsh build has no 'plugin remove', delete 'dsh-computer-use' from both dependencies and dsh.profile.bundles in the profile's package.json, then run pnpm install in that directory."
    }
}

$dump = ''
if ($PSCmdlet.ShouldProcess("profile '$Profile'", 'npx @deepseek-ai/dsh --dump-config')) {
    $dump = (& npx @deepseek-ai/dsh --profile $Profile --dump-config 2>&1 | Out-String)
    if ($LASTEXITCODE -ne 0) {
        Write-Host "WARNING: --dump-config failed (exit $LASTEXITCODE); verify the profile manually." -ForegroundColor Yellow
    } elseif ($dump | Select-String -Pattern 'computer-use' -SimpleMatch) {
        Write-Host "WARNING: computer-use is still present in the composed config." -ForegroundColor Yellow
    } else {
        Write-Host "    computer-use is no longer in the composed config."
    }
}

Write-Host ""
Write-Host "已卸载，请重启 DSH。" -ForegroundColor Green
Write-Host "Removed from profile '$Profile'. Restart DSH so the tools disappear from the tool table."
exit 0
