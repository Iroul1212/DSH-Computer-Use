# win-host.ps1 - DeepSeek Harness computer-use Windows desktop host (server side)
# Protocol: notes/win-host-protocol.md  (NDJSON over stdin/stdout, logs to stderr)
# ---------------------------------------------------------------------------
# Hard rules enforced here:
#   * stdout carries JSON lines ONLY. Everything else goes to [Console]::Error.
#   * every request is wrapped in try/catch; a single bad request never kills us.
#   * DPI awareness (Per-Monitor-V2) is set BEFORE any UI/Drawing type is touched.
#   * all P/Invoke is compiled exactly once, at startup.
# ---------------------------------------------------------------------------

$ErrorActionPreference = 'Stop'
$ProgressPreference    = 'SilentlyContinue'
$VerbosePreference     = 'SilentlyContinue'
$WarningPreference     = 'SilentlyContinue'
$InformationPreference = 'SilentlyContinue'
Set-StrictMode -Version 2.0

function Write-Host-Log([string]$msg) {
    try { [Console]::Error.WriteLine("[win-host] $msg") } catch { }
}

function Write-JsonLine($obj) {
    # Single-line JSON on stdout + immediate flush (Node reads line by line).
    $json = $obj | ConvertTo-Json -Depth 64 -Compress
    [Console]::Out.WriteLine($json)
    [Console]::Out.Flush()
}

function Fail([string]$code, [string]$message) {
    # Throw an error object the main loop turns into {"ok":false,...}
    $e = New-Object System.Exception $message
    $e.Data['code'] = $code
    throw $e
}

# --- UTF-8 both ways (no BOM) ----------------------------------------------
try {
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
    [Console]::InputEncoding  = New-Object System.Text.UTF8Encoding($false)
} catch { Write-Host-Log "could not set console encoding: $($_.Exception.Message)" }
$OutputEncoding = New-Object System.Text.UTF8Encoding($false)

# ---------------------------------------------------------------------------
# P/Invoke (compiled once).  Deliberately free of WinForms/Drawing references
# so it can be loaded before DPI awareness is set.
# ---------------------------------------------------------------------------
$script:CsSource = @"
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public static class DshWin32
{
    // ---- constants -------------------------------------------------------
    public const int SW_HIDE = 0, SW_SHOWNORMAL = 1, SW_SHOWMINIMIZED = 2,
                     SW_SHOWMAXIMIZED = 3, SW_RESTORE = 9;
    public const int GWL_EXSTYLE = -20;
    public const int WS_EX_TOOLWINDOW = 0x00000080;

    public const uint MOUSEEVENTF_MOVE        = 0x0001;
    public const uint MOUSEEVENTF_LEFTDOWN    = 0x0002;
    public const uint MOUSEEVENTF_LEFTUP      = 0x0004;
    public const uint MOUSEEVENTF_RIGHTDOWN   = 0x0008;
    public const uint MOUSEEVENTF_RIGHTUP     = 0x0010;
    public const uint MOUSEEVENTF_MIDDLEDOWN  = 0x0020;
    public const uint MOUSEEVENTF_MIDDLEUP    = 0x0040;
    public const uint MOUSEEVENTF_XDOWN       = 0x0080;
    public const uint MOUSEEVENTF_XUP         = 0x0100;
    public const uint MOUSEEVENTF_WHEEL       = 0x0800;
    public const uint MOUSEEVENTF_HWHEEL      = 0x1000;
    public const uint MOUSEEVENTF_ABSOLUTE    = 0x8000;
    public const uint MOUSEEVENTF_VIRTUALDESK = 0x4000;

    public const uint KEYEVENTF_EXTENDEDKEY = 0x0001;
    public const uint KEYEVENTF_KEYUP       = 0x0002;
    public const uint KEYEVENTF_UNICODE     = 0x0004;

    public const int INPUT_MOUSE    = 0;
    public const int INPUT_KEYBOARD = 1;

    public const int SM_XVIRTUALSCREEN  = 76;
    public const int SM_YVIRTUALSCREEN  = 77;
    public const int SM_CXVIRTUALSCREEN = 78;
    public const int SM_CYVIRTUALSCREEN = 79;

    public const uint CURSOR_SHOWING = 0x00000001;
    public const uint DI_NORMAL      = 0x0003;

    public const int DWMWA_EXTENDED_FRAME_BOUNDS = 9;
    public const int DWMWA_CLOAKED               = 14;

    public const uint CF_UNICODETEXT = 13;
    public const uint GMEM_MOVEABLE  = 0x0002;

    // ---- structs ---------------------------------------------------------
    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int x; public int y; }

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int left, top, right, bottom; }

    [StructLayout(LayoutKind.Sequential)]
    public struct CURSORINFO
    {
        public int cbSize;
        public uint flags;
        public IntPtr hCursor;
        public POINT ptScreenPos;
    }

    // x64: sizeof(INPUT) == 40.  type(4) + pad(4) + 32-byte union.
    [StructLayout(LayoutKind.Explicit, Size = 40)]
    public struct INPUT
    {
        [FieldOffset(0)] public uint type;
        [FieldOffset(8)] public MOUSEINPUT mi;
        [FieldOffset(8)] public KEYBDINPUT ki;
        [FieldOffset(8)] public HARDWAREINPUT hi;
    }

    [StructLayout(LayoutKind.Explicit, Size = 32)]
    public struct MOUSEINPUT
    {
        [FieldOffset(0)]  public int dx;
        [FieldOffset(4)]  public int dy;
        [FieldOffset(8)]  public uint mouseData;
        [FieldOffset(12)] public uint dwFlags;
        [FieldOffset(16)] public uint time;
        [FieldOffset(24)] public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Explicit, Size = 32)]
    public struct KEYBDINPUT
    {
        [FieldOffset(0)]  public ushort wVk;
        [FieldOffset(2)]  public ushort wScan;
        [FieldOffset(4)]  public uint dwFlags;
        [FieldOffset(8)]  public uint time;
        [FieldOffset(16)] public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Explicit, Size = 8)]
    public struct HARDWAREINPUT
    {
        [FieldOffset(0)] public uint uMsg;
        [FieldOffset(4)] public ushort wParamL;
        [FieldOffset(6)] public ushort wParamH;
    }

    // ---- imports: process / DPI -----------------------------------------
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")]
    public static extern int GetSystemMetrics(int index);
    [DllImport("shcore.dll")]
    public static extern int GetDpiForMonitor(IntPtr hmon, int dpiType, out uint dpiX, out uint dpiY);
    [DllImport("user32.dll")]
    public static extern uint GetDpiForWindow(IntPtr hwnd);
    [DllImport("user32.dll")]
    public static extern uint GetDpiForSystem();
    [DllImport("user32.dll")]
    public static extern IntPtr MonitorFromPoint(POINT pt, uint flags);
    [DllImport("user32.dll")]
    public static extern IntPtr MonitorFromWindow(IntPtr hwnd, uint flags);

    // ---- imports: input --------------------------------------------------
    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool GetCursorPos(out POINT p);
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")]
    public static extern short GetAsyncKeyState(int vKey);
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool GetCursorInfo(ref CURSORINFO ci);
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool DrawIconEx(IntPtr hdc, int x, int y, IntPtr hIcon,
                                        int cx, int cy, uint istep, IntPtr hbr, uint flags);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern short VkKeyScanW(char ch);
    [DllImport("user32.dll")]
    public static extern int MapVirtualKeyW(uint code, uint mapType);

    // ---- imports: windows ------------------------------------------------
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr SetFocus(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
    [DllImport("kernel32.dll")]
    public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")]
    public static extern bool IsWindow(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern bool IsZoomed(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetWindowTextLengthW(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder sb, int maxCount);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetClassNameW(IntPtr hWnd, StringBuilder sb, int maxCount);
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool GetClientRect(IntPtr hWnd, out RECT r);
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool ClientToScreen(IntPtr hWnd, ref POINT p);
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);
    [DllImport("dwmapi.dll")]
    public static extern int DwmGetWindowAttribute(IntPtr hWnd, int attr, out RECT value, int size);
    [DllImport("dwmapi.dll")]
    public static extern int DwmGetWindowAttribute(IntPtr hWnd, int attr, out int value, int size);

    // ---- imports: clipboard (Win32 fallback path) ------------------------
    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr OpenClipboard(IntPtr hWndNewOwner);
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool CloseClipboard();
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool EmptyClipboard();
    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr GetClipboardData(uint uFormat);
    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr SetClipboardData(uint uFormat, IntPtr hMem);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr GlobalAlloc(uint uFlags, UIntPtr dwBytes);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr GlobalLock(IntPtr hMem);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool GlobalUnlock(IntPtr hMem);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr GlobalFree(IntPtr hMem);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool PostMessageW(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr SendMessageTimeoutW(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam, uint fuFlags, uint uTimeout, out IntPtr lpdwResult);
}
"@

# ===========================================================================
# 1. Compile all P/Invoke exactly once.
# ===========================================================================
$script:BootSw = [System.Diagnostics.Stopwatch]::StartNew()
try {
    Add-Type -TypeDefinition $script:CsSource -Language CSharp -ErrorAction Stop
} catch {
    Write-Host-Log ("FATAL: Add-Type failed: " + $_.Exception.Message)
    exit 1
}
$script:InputSize = [int][System.Runtime.InteropServices.Marshal]::SizeOf([type][DshWin32+INPUT])
Write-Host-Log ("P/Invoke compiled in " + $script:BootSw.ElapsedMilliseconds + "ms; sizeof(INPUT)=" + $script:InputSize + " (x64 expects 40)")

# ===========================================================================
# 2. DPI awareness.  Must run BEFORE Drawing/WinForms/Screen is first touched,
#    otherwise every coordinate is logical (150% -> 2/3 of the real pixel).
# ===========================================================================
$script:DpiAware = $false
$script:DpiMode  = 'none'
try {
    if ([DshWin32]::SetProcessDpiAwarenessContext([IntPtr]::new(-4))) {
        $script:DpiAware = $true; $script:DpiMode = 'PER_MONITOR_AWARE_V2'
    } else {
        $err = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
        if ($err -eq 5) {
            # ERROR_ACCESS_DENIED: the host process (pwsh) already fixed awareness.
            $script:DpiAware = $true; $script:DpiMode = 'PRE_SET_BY_HOST'
            Write-Host-Log "SetProcessDpiAwarenessContext -> access denied (awareness already set by pwsh)"
        } else {
            Write-Host-Log ("SetProcessDpiAwarenessContext failed, win32=" + $err)
        }
    }
} catch { Write-Host-Log ("SetProcessDpiAwarenessContext threw: " + $_.Exception.Message) }
if (-not $script:DpiAware) {
    try {
        if ([DshWin32]::SetProcessDPIAware()) { $script:DpiAware = $true; $script:DpiMode = 'SYSTEM_AWARE' }
    } catch { Write-Host-Log ("SetProcessDPIAware threw: " + $_.Exception.Message) }
}
Write-Host-Log ("DPI awareness: " + $script:DpiMode)

# ===========================================================================
# 3. Managed assemblies (UIA is optional; the host must survive without it).
# ===========================================================================
foreach ($asm in @('System.Windows.Forms', 'System.Drawing', 'UIAutomationClient', 'UIAutomationTypes')) {
    try { Add-Type -AssemblyName $asm -ErrorAction Stop }
    catch { Write-Host-Log ("assembly unavailable: " + $asm + " -> " + $_.Exception.Message) }
}
$script:HasUia = $false
try { $null = [System.Windows.Automation.AutomationElement]; $script:HasUia = $true }
catch { Write-Host-Log 'UIA types unavailable: uia/uiaAct will answer UIA_UNAVAILABLE' }
$script:IsSta = ([System.Threading.Thread]::CurrentThread.GetApartmentState() -eq [System.Threading.ApartmentState]::STA)
Write-Host-Log ("uia=" + $script:HasUia + " sta=" + $script:IsSta)

$script:Guard = @{ armed = $false; tripped = $false; reason = $null; since = $null }
$script:ProcNameCache = @{}
$script:PatternCache = $null

# ===========================================================================
# 4. Argument helpers.  Optional JSON fields must never throw.
# ===========================================================================
function Get-Arg {
    param($Bag, [string]$Name, $Default = $null)
    if ($null -eq $Bag) { return $Default }
    $p = $Bag.PSObject.Properties[$Name]
    if ($null -eq $p) { return $Default }
    if ($null -eq $p.Value) { return $Default }
    return $p.Value
}
function Has-Arg {
    param($Bag, [string]$Name)
    if ($null -eq $Bag) { return $false }
    return ($null -ne $Bag.PSObject.Properties[$Name])
}
function Get-IntArg {
    param($Bag, [string]$Name, [int]$Default = 0)
    $v = Get-Arg $Bag $Name $null
    if ($null -eq $v) { return $Default }
    return [int]$v
}

# ===========================================================================
# 5. Screen geometry (physical pixels, virtual-screen origin may be negative)
# ===========================================================================
function Get-VirtualScreen {
    $x = [DshWin32]::GetSystemMetrics(76)   # SM_XVIRTUALSCREEN
    $y = [DshWin32]::GetSystemMetrics(77)   # SM_YVIRTUALSCREEN
    $w = [DshWin32]::GetSystemMetrics(78)   # SM_CXVIRTUALSCREEN
    $h = [DshWin32]::GetSystemMetrics(79)   # SM_CYVIRTUALSCREEN
    return [pscustomobject]@{ x = $x; y = $y; width = $w; height = $h }
}

function Get-ScreenList {
    $out = New-Object System.Collections.Generic.List[object]
    foreach ($s in [System.Windows.Forms.Screen]::AllScreens) {
        $b = $s.Bounds
        $dpi = 0
        try {
            $pt = New-Object 'DshWin32+POINT'
            $pt.x = $b.X + [int]($b.Width / 2)
            $pt.y = $b.Y + [int]($b.Height / 2)
            $hmon = [DshWin32]::MonitorFromPoint($pt, 2)   # MONITOR_DEFAULTTONEAREST
            if ($hmon -ne [IntPtr]::Zero) {
                $dx = [uint32]0; $dy = [uint32]0
                if ([DshWin32]::GetDpiForMonitor($hmon, 0, [ref]$dx, [ref]$dy) -eq 0 -and $dx -gt 0) { $dpi = [int]$dx }
            }
        } catch { }
        if ($dpi -le 0) { try { $dpi = [int][DshWin32]::GetDpiForSystem() } catch { $dpi = 96 } }
        if ($dpi -le 0) { $dpi = 96 }
        $out.Add([pscustomobject]@{
            id      = [string]$s.DeviceName
            x       = [int]$b.X
            y       = [int]$b.Y
            width   = [int]$b.Width
            height  = [int]$b.Height
            primary = [bool]$s.Primary
            scale   = [math]::Round($dpi / 96.0, 3)
        })
    }
    return $out.ToArray()
}

# ===========================================================================
# 6. SendInput primitives.  Structs are built in a child scope and assigned
#    whole into INPUT: PowerShell does not persist nested value-type writes.
# ===========================================================================
function Send-InputArray {
    param([object[]]$Items)
    if ($null -eq $Items -or $Items.Count -eq 0) { return }
    $arr = [DshWin32+INPUT[]]::new($Items.Count)
    for ($i = 0; $i -lt $Items.Count; $i++) { $arr[$i] = [DshWin32+INPUT]$Items[$i] }
    $sent = [int][DshWin32]::SendInput([uint32]$arr.Length, $arr, $script:InputSize)
    if ($sent -ne $arr.Length) {
        $e = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
        Fail 'SENDINPUT_FAILED' ("SendInput accepted " + $sent + "/" + $arr.Length + " event(s), win32=" + $e + " (a higher-integrity window may be blocking input)")
    }
}

function New-MouseInput {
    param([uint32]$Flags, [int]$Dx = 0, [int]$Dy = 0, [uint32]$Data = 0)
    $mi = [DshWin32+MOUSEINPUT]@{ dx = $Dx; dy = $Dy; mouseData = $Data; dwFlags = $Flags; time = [uint32]0; dwExtraInfo = [IntPtr]::Zero }
    $mi.dx = $Dx
    $mi.dy = $Dy
    $mi.mouseData = $Data
    $mi.dwFlags = $Flags
    $mi.time = [uint32]0
    $mi.dwExtraInfo = [IntPtr]::Zero
    $inp = New-Object 'DshWin32+INPUT'
    $inp.type = [uint32]0        # INPUT_MOUSE
    $inp = [DshWin32+INPUT]@{ type = [uint32]0; mi = $mi }
    return $inp
}

function New-KeyInput {
    param([uint16]$Vk, [uint16]$Scan, [uint32]$Flags)
    $ki = New-Object 'DshWin32+KEYBDINPUT'
    $ki.wVk = $Vk
    $ki.wScan = $Scan
    $ki.dwFlags = $Flags
    $ki.time = [uint32]0
    $ki.dwExtraInfo = [IntPtr]::Zero
    $inp = New-Object 'DshWin32+INPUT'
    $inp.type = [uint32]1        # INPUT_KEYBOARD
    $inp = [DshWin32+INPUT]@{ type = [uint32]1; ki = $ki }
    return $inp
}

function Get-CursorPos {
    $p = New-Object 'DshWin32+POINT'
    if (-not [DshWin32]::GetCursorPos([ref]$p)) { Fail 'CURSOR_FAILED' 'GetCursorPos failed' }
    return [pscustomobject]@{ x = [int]$p.x; y = [int]$p.y }
}

function Move-CursorTo {
    param([int]$X, [int]$Y)
    $vs = Get-VirtualScreen
    $vw = [math]::Max(2, $vs.width)
    $vh = [math]::Max(2, $vs.height)
    $nx = [int][math]::Round((($X - $vs.x) * 65535.0) / ($vw - 1))
    $ny = [int][math]::Round((($Y - $vs.y) * 65535.0) / ($vh - 1))
    if ($nx -lt 0) { $nx = 0 } elseif ($nx -gt 65535) { $nx = 65535 }
    if ($ny -lt 0) { $ny = 0 } elseif ($ny -gt 65535) { $ny = 65535 }
    $flags = [uint32](0x0001 -bor 0x8000 -bor 0x4000)   # MOVE|ABSOLUTE|VIRTUALDESK
    Send-InputArray @((New-MouseInput $flags $nx $ny))
}

function Get-ButtonFlags {
    param([string]$Button)
    switch ($Button.ToLowerInvariant()) {
        'left'   { return [pscustomobject]@{ down = [uint32]0x0002; up = [uint32]0x0004 } }
        'right'  { return [pscustomobject]@{ down = [uint32]0x0008; up = [uint32]0x0010 } }
        'middle' { return [pscustomobject]@{ down = [uint32]0x0020; up = [uint32]0x0040 } }
    }
    Fail 'BAD_ARGS' ("unknown mouse button: " + $Button)
}

function Send-ModifierKeys {
    param([string[]]$Modifiers, [bool]$Up)
    $out = New-Object System.Collections.Generic.List[object]
    if ($null -eq $Modifiers) { return $out.ToArray() }
    $list = @($Modifiers)
    if ($Up) { [array]::Reverse($list) }
    foreach ($m in $list) {
        if ([string]::IsNullOrWhiteSpace($m)) { continue }
        $vk = Get-KeyVk $m
        $flags = [uint32]0
        if ($Up) { $flags = [uint32]0x0002 }   # KEYEVENTF_KEYUP
        if (Test-ExtendedVk $vk) { $flags = [uint32]($flags -bor 0x0001) }
        $out.Add((New-KeyInput ([uint16]$vk) ([uint16]0) $flags))
    }
    return $out.ToArray()
}

# ===========================================================================
# 7. Virtual-key mapping ("key" command)
# ===========================================================================
$script:VkMap = @{
    'ctrl' = 0x11; 'control' = 0x11; 'shift' = 0x10; 'alt' = 0x12; 'menu' = 0x12
    'win' = 0x5B; 'lwin' = 0x5B; 'rwin' = 0x5C; 'cmd' = 0x5B; 'super' = 0x5B
    'lctrl' = 0xA2; 'rctrl' = 0xA3; 'lshift' = 0xA0; 'rshift' = 0xA1
    'lalt' = 0xA4; 'ralt' = 0xA5
    'enter' = 0x0D; 'return' = 0x0D; 'tab' = 0x09; 'esc' = 0x1B; 'escape' = 0x1B
    'space' = 0x20; 'spacebar' = 0x20; 'backspace' = 0x08; 'bksp' = 0x08
    'delete' = 0x2E; 'del' = 0x2E; 'insert' = 0x2D; 'ins' = 0x2D
    'home' = 0x24; 'end' = 0x23; 'pageup' = 0x21; 'prior' = 0x21
    'pagedown' = 0x22; 'next' = 0x22
    'up' = 0x26; 'down' = 0x28; 'left' = 0x25; 'right' = 0x27
    'arrowup' = 0x26; 'arrowdown' = 0x28; 'arrowleft' = 0x25; 'arrowright' = 0x27
    'capslock' = 0x14; 'numlock' = 0x90; 'scrolllock' = 0x91
    'printscreen' = 0x2C; 'prtsc' = 0x2C; 'pause' = 0x13; 'apps' = 0x5D
    'plus' = 0xBB; 'minus' = 0xBD; 'equal' = 0xBB; 'comma' = 0xBC; 'period' = 0xBE
    'slash' = 0xBF; 'backslash' = 0xDC; 'semicolon' = 0xBA; 'quote' = 0xDE
    'backtick' = 0xC0; 'grave' = 0xC0; 'lbracket' = 0xDB; 'rbracket' = 0xDD
    'volumeup' = 0xAF; 'volumedown' = 0xAE; 'volumemute' = 0xAD
    'playpause' = 0xB3; 'nexttrack' = 0xB0; 'prevtrack' = 0xB1
}
# Virtual keys that must be injected with KEYEVENTF_EXTENDEDKEY.
$script:ExtendedVks = @(0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x2D, 0x2E,
                        0x5B, 0x5C, 0x5D, 0x2C, 0x90, 0xA3, 0xA5, 0x6F, 0xAF, 0xAE, 0xAD,
                        0xB0, 0xB1, 0xB3)

function Get-KeyVk {
    param([string]$Name)
    if ([string]::IsNullOrEmpty($Name)) { Fail 'BAD_ARGS' 'empty key name' }
    $n = $Name.Trim().ToLowerInvariant()
    if ($script:VkMap.ContainsKey($n)) { return [int]$script:VkMap[$n] }
    if ($n -match '^f([1-9]|1[0-9]|2[0-4])$') { return 0x70 + ([int]$Matches[1]) - 1 }
    if ($n.Length -eq 1) {
        $c = $n[0]
        if ($c -match '^[a-z]$') { return [int][char]([char]::ToUpperInvariant($c)) }
        if ($c -match '^[0-9]$') { return 0x30 + ([int][char]$c - 0x30) }
        $vk = [int][DshWin32]::VkKeyScanW($c)
        if ($vk -ne -1 -and ($vk -band 0xFF) -ne 0xFF) { return ($vk -band 0xFF) }
        Fail 'BAD_ARGS' ("cannot map key to a virtual-key code: " + $Name)
    }
    Fail 'BAD_ARGS' ("unknown key name: " + $Name)
}

function Get-KeyShiftState {
    # 1 = needs shift, 2 = needs ctrl, 4 = needs alt (from VkKeyScanW high byte)
    param([string]$Name)
    if ([string]::IsNullOrEmpty($Name)) { return 0 }
    $n = $Name.Trim().ToLowerInvariant()
    if ($script:VkMap.ContainsKey($n)) { return 0 }
    if ($n -match '^f([1-9]|1[0-9]|2[0-4])$') { return 0 }
    if ($n.Length -eq 1) {
        $vk = [int][DshWin32]::VkKeyScanW($n[0])
        if ($vk -ne -1) { return (($vk -shr 8) -band 0xFF) }
    }
    return 0
}

function Test-ExtendedVk {
    param([int]$Vk)
    return ($script:ExtendedVks -contains $Vk)
}

# ===========================================================================
# 8. Window geometry helpers
# ===========================================================================
function Get-WindowRectSafe {
    param([IntPtr]$Hwnd)
    $r = New-Object 'DshWin32+RECT'
    $ok = $false
    try {
        $sz = [System.Runtime.InteropServices.Marshal]::SizeOf([type][DshWin32+RECT])
        if ([DshWin32]::DwmGetWindowAttribute($Hwnd, 9, [ref]$r, $sz) -eq 0) { $ok = $true }
    } catch { }
    if (-not $ok) { try { $ok = [DshWin32]::GetWindowRect($Hwnd, [ref]$r) } catch { $ok = $false } }
    if (-not $ok) { return $null }
    return [pscustomobject]@{
        x = [int]$r.left; y = [int]$r.top
        width = [int][math]::Max(0, $r.right - $r.left)
        height = [int][math]::Max(0, $r.bottom - $r.top)
    }
}

function Get-ClientRectSafe {
    param([IntPtr]$Hwnd)
    $r = New-Object 'DshWin32+RECT'
    if (-not [DshWin32]::GetClientRect($Hwnd, [ref]$r)) { return $null }
    $p = New-Object 'DshWin32+POINT'
    $p.x = 0; $p.y = 0
    if (-not [DshWin32]::ClientToScreen($Hwnd, [ref]$p)) { return $null }
    return [pscustomobject]@{
        x = [int]$p.x; y = [int]$p.y
        width = [int][math]::Max(0, $r.right - $r.left)
        height = [int][math]::Max(0, $r.bottom - $r.top)
    }
}

# ===========================================================================
# 9. Screen / window capture
# ===========================================================================
function Capture-ScreenBitmap {
    param([int]$X, [int]$Y, [int]$W, [int]$H)
    if ($W -lt 1 -or $H -lt 1) { Fail 'BAD_ARGS' 'capture area is empty' }
    $bmp = New-Object System.Drawing.Bitmap($W, $H, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = $null
    try {
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        # CaptureBlt also picks up layered windows; this runtime rejects the
        # SourceCopy|CaptureBlt union value, so the flags are tried one at a time.
        $lastErr = $null
        $done = $false
        foreach ($opFlag in @([System.Drawing.CopyPixelOperation]::SourceCopy, [System.Drawing.CopyPixelOperation]::CaptureBlt)) {
            try {
                $g.CopyFromScreen($X, $Y, 0, 0, (New-Object System.Drawing.Size($W, $H)), $opFlag)
                $done = $true
                break
            } catch { $lastErr = $_.Exception.Message }
        }
        if (-not $done) { Fail 'CAPTURE_FAILED' ("CopyFromScreen failed: " + $lastErr) }
        if ($done -and (Test-BitmapAllBlack $bmp)) {
            # SourceCopy missed everything (layered/overlay surface): retry with CaptureBlt.
            try { $g.CopyFromScreen($X, $Y, 0, 0, (New-Object System.Drawing.Size($W, $H)), [System.Drawing.CopyPixelOperation]::CaptureBlt) } catch { }
        }
    } catch {
        $bmp.Dispose()
        Fail 'CAPTURE_FAILED' ("CopyFromScreen failed: " + $_.Exception.Message)
    } finally {
        if ($null -ne $g) { $g.Dispose() }
    }
    return $bmp
}

function Test-BitmapAllBlack {
    param($Bmp)
    try {
        $xs = @(2, [int]($Bmp.Width / 2), $Bmp.Width - 3)
        $ys = @(2, [int]($Bmp.Height / 2), $Bmp.Height - 3)
        foreach ($x in $xs) {
            foreach ($y in $ys) {
                if ($x -lt 0 -or $y -lt 0 -or $x -ge $Bmp.Width -or $y -ge $Bmp.Height) { continue }
                $c = $Bmp.GetPixel($x, $y)
                if ($c.A -ne 0 -and ($c.R -ne 0 -or $c.G -ne 0 -or $c.B -ne 0)) { return $false }
            }
        }
        return $true
    } catch { return $false }
}

function Capture-WindowBitmap {
    param([IntPtr]$Hwnd)
    $r = Get-WindowRectSafe $Hwnd
    if ($null -eq $r -or $r.width -lt 1 -or $r.height -lt 1) { return $null }
    $bmp = New-Object System.Drawing.Bitmap($r.width, $r.height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = $null
    $ok = $false
    try {
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $hdc = $g.GetHdc()
        try { $ok = [DshWin32]::PrintWindow($Hwnd, $hdc, [uint32]2) }   # PW_RENDERFULLCONTENT
        finally { $g.ReleaseHdc($hdc) }
    } catch { $ok = $false }
    finally { if ($null -ne $g) { $g.Dispose() } }
    if (-not $ok) { $bmp.Dispose(); return $null }
    if (Test-BitmapAllBlack $bmp) { $bmp.Dispose(); return $null }   # DWM-cloaked / minimized
    return $bmp
}

function Resize-BitmapToWidth {
    param($Bmp, [int]$MaxWidth)
    if ($MaxWidth -le 0 -or $Bmp.Width -le $MaxWidth) { return $Bmp }
    $nw = [int]$MaxWidth
    $nh = [int][math]::Max(1, [math]::Round($Bmp.Height * ($nw / [double]$Bmp.Width)))
    $out = New-Object System.Drawing.Bitmap($nw, $nh, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = $null
    try {
        $g = [System.Drawing.Graphics]::FromImage($out)
        $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $g.DrawImage($Bmp, 0, 0, $nw, $nh)
    } finally {
        if ($null -ne $g) { $g.Dispose() }
        $Bmp.Dispose()
    }
    return $out
}

function Add-CursorToBitmap {
    param($Bmp, [int]$OffX, [int]$OffY)
    try {
        $ci = New-Object 'DshWin32+CURSORINFO'
        $ci.cbSize = [int][System.Runtime.InteropServices.Marshal]::SizeOf([type][DshWin32+CURSORINFO])
        if (-not [DshWin32]::GetCursorInfo([ref]$ci)) { return }
        if (($ci.flags -band 1) -eq 0) { return }
        $g = [System.Drawing.Graphics]::FromImage($Bmp)
        $hdc = $g.GetHdc()
        try {
            [void][DshWin32]::DrawIconEx($hdc, ($ci.ptScreenPos.x - $OffX), ($ci.ptScreenPos.y - $OffY),
                                         $ci.hCursor, 0, 0, [uint32]0, [IntPtr]::Zero, [uint32]3)
        } finally { $g.ReleaseHdc($hdc); $g.Dispose() }
    } catch { Write-Host-Log ("showCursor failed: " + $_.Exception.Message) }
}

function Get-BitmapBytes {
    param($Bmp, [string]$Format, [int]$Quality)
    $ms = New-Object System.IO.MemoryStream
    try {
        if ($Format -eq 'jpeg') {
            $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() |
                     Where-Object { $_.MimeType -eq 'image/jpeg' } | Select-Object -First 1
            $ep = New-Object System.Drawing.Imaging.EncoderParameters(1)
            $ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter(
                [System.Drawing.Imaging.Encoder]::Quality, [long]$Quality)
            $Bmp.Save($ms, $codec, $ep)
            $ep.Dispose()
        } else {
            $Bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
        }
        $bytes = $ms.ToArray()
        return ,$bytes   # comma: keep byte[] as ONE object, PS would otherwise unroll 840k boxed bytes
    } finally { $ms.Dispose() }
}


# ===========================================================================
# 10. Commands: screenshot / cursor / move / click / drag / scroll
# ===========================================================================
function Invoke-Cmd-Screenshot($a) {
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $format = ([string](Get-Arg $a 'format' 'png')).ToLowerInvariant()
    if ($format -eq 'jpg') { $format = 'jpeg' }
    if ($format -ne 'png' -and $format -ne 'jpeg') { Fail 'BAD_ARGS' ("unsupported format: " + $format) }
    $quality = [int][math]::Min(100, [math]::Max(10, (Get-IntArg $a 'quality' 80)))
    $showCursor = [bool](Get-Arg $a 'showCursor' $false)
    $hwnd = Get-Arg $a 'hwnd' $null
    $region = Get-Arg $a 'region' $null
    $screenIdx = Get-Arg $a 'screen' $null
    if (Has-Arg $a 'maxWidth') { $maxWidth = Get-IntArg $a 'maxWidth' 0 } else { $maxWidth = 1568 }
    if (Has-Arg $a 'maxPixels') { $maxPixels = Get-IntArg $a 'maxPixels' 0 } else { $maxPixels = 0 }

    $bmp = $null
    $capture = $null
    $fallback = $null

    if ($null -ne $hwnd) {
        $h = [IntPtr][int64]$hwnd
        if (-not [DshWin32]::IsWindow($h)) { Fail 'NO_WINDOW' ("hwnd is not a live window: " + $hwnd) }
        $wr = Get-WindowRectSafe $h
        $bmp = Capture-WindowBitmap $h
        if ($null -eq $bmp) { $fallback = 'screen' } else { $capture = $wr }
    }

    if ($null -eq $bmp) {
        if ($null -ne $region) {
            $rx = Get-IntArg $region 'x' 0
            $ry = Get-IntArg $region 'y' 0
            $rw = Get-IntArg $region 'width' 0
            $rh = Get-IntArg $region 'height' 0
            if ($rw -lt 1 -or $rh -lt 1) { Fail 'BAD_ARGS' 'region needs width>=1 and height>=1' }
            $capture = [pscustomobject]@{ x = $rx; y = $ry; width = $rw; height = $rh }
        } else {
            $sc = $script:Screens[0]
            if ($null -ne $screenIdx) {
                $i = [int]$screenIdx
                if ($i -lt 0 -or $i -ge $script:Screens.Count) {
                    Fail 'BAD_ARGS' ("screen index out of range: " + $i + " (have " + $script:Screens.Count + ")")
                }
                $sc = $script:Screens[$i]
            }
            $capture = [pscustomobject]@{ x = $sc.x; y = $sc.y; width = $sc.width; height = $sc.height }
        }
        $bmp = Capture-ScreenBitmap $capture.x $capture.y $capture.width $capture.height
    }

    $msCapture = [int]$sw.ElapsedMilliseconds
    $captureW = [int]$capture.width
    $captureH = [int]$capture.height
    try {
        if ($showCursor) { Add-CursorToBitmap $bmp $capture.x $capture.y }
        $targetW = [int]$bmp.Width
        if ($maxWidth -gt 0 -and $targetW -gt $maxWidth) { $targetW = [int]$maxWidth }
        if ($maxPixels -gt 0) {
            # area cap: width = sqrt(maxPixels * aspect), floored, then verified below
            $areaW = [int][math]::Floor([math]::Sqrt([double]$maxPixels * ([double]$bmp.Width / [double][math]::Max(1, $bmp.Height))))
            if ($areaW -gt 0 -and $areaW -lt $targetW) { $targetW = $areaW }
        }
        $bmp = Resize-BitmapToWidth $bmp $targetW
        if ($maxPixels -gt 0 -and ([int64]$bmp.Width * [int64]$bmp.Height) -gt $maxPixels) {
            $f2 = [math]::Sqrt([double]$maxPixels / ([double]$bmp.Width * [double]$bmp.Height)) * 0.998
            $tw2 = [int][math]::Floor($bmp.Width * $f2)
            if ($tw2 -ge 1) { $bmp = Resize-BitmapToWidth $bmp $tw2 }
        }
        $msTransform = [int]$sw.ElapsedMilliseconds
        $imgW = [int]$bmp.Width
        $imgH = [int]$bmp.Height
        $decorated = Add-ScreenshotDecorations $bmp $a
$change = Get-FrameChange $bmp $a
$bytes = Get-BitmapBytes $bmp $format $quality
        $msEncode = [int]$sw.ElapsedMilliseconds
    } finally {
        if ($null -ne $bmp) { try { $bmp.Dispose() } catch { } }
    }

    $cur = Get-CursorPos
    $prim = $script:Screens | Where-Object { $_.primary } | Select-Object -First 1
    if ($null -eq $prim) { $prim = $script:Screens[0] }

    $swFg = [System.Diagnostics.Stopwatch]::StartNew()
    $fgInfo = Get-ForegroundWindowInfo
    $swFg.Stop()
    $result = [ordered]@{
        image = [ordered]@{
            base64 = [System.Convert]::ToBase64String($bytes)
          decorated = $decorated
          change = $change
            mime   = 'image/' + $format
            width  = $imgW
            height = $imgH
            bytes  = $bytes.Length
        }
        capture = [ordered]@{ x = $capture.x; y = $capture.y; width = $captureW; height = $captureH }
        scale   = [math]::Round($imgW / [double][math]::Max(1, $captureW), 4)
        cursor  = [ordered]@{ x = $cur.x; y = $cur.y }
        screen  = [ordered]@{ width = $prim.width; height = $prim.height }
        foreground = $fgInfo
        timings = [ordered]@{ captureMs = $msCapture; transformMs = ($msTransform - $msCapture); encodeMs = ($msEncode - $msTransform); foregroundMs = [math]::Round($swFg.Elapsed.TotalMilliseconds, 2) }
        maxPixels = $maxPixels
        elapsedMs = [int]$sw.ElapsedMilliseconds
    }
    if ($null -ne $fallback) { $result['fallback'] = $fallback }
    return $result
}

function Invoke-Cmd-Cursor($a) {
    $c = Get-CursorPos
    return [ordered]@{ x = $c.x; y = $c.y }
}

function Invoke-Cmd-Move($a) {
    $x = Get-IntArg $a 'x' ([int]::MinValue)
    $y = Get-IntArg $a 'y' ([int]::MinValue)
    if ($x -eq [int]::MinValue -or $y -eq [int]::MinValue) { Fail 'BAD_ARGS' 'move needs integer x and y' }
    $dur = [int][math]::Max(0, (Get-IntArg $a 'durationMs' 0))
    if ($dur -le 0) {
        Move-CursorTo $x $y
    } else {
        $from = Get-CursorPos
        $steps = [int][math]::Min(60, [math]::Max(2, [math]::Round($dur / 10.0)))
        $sw = [System.Diagnostics.Stopwatch]::StartNew()
        for ($i = 1; $i -le $steps; $i++) {
            $t = $i / [double]$steps
            $cx = [int][math]::Round($from.x + ($x - $from.x) * $t)
            $cy = [int][math]::Round($from.y + ($y - $from.y) * $t)
            Move-CursorTo $cx $cy
            $target = [int]($dur * $t)
            $wait = $target - [int]$sw.ElapsedMilliseconds
            if ($wait -gt 0) { Start-Sleep -Milliseconds $wait }
        }
    }
    $c = Get-CursorPos
    return [ordered]@{ x = $c.x; y = $c.y }
}

function Invoke-Cmd-Click($a) {
    $button = [string](Get-Arg $a 'button' 'left')
    $count = [int][math]::Min(5, [math]::Max(1, (Get-IntArg $a 'count' 1)))
    $holdMs = [int][math]::Max(0, (Get-IntArg $a 'holdMs' 0))
    $mods = @(Get-Arg $a 'modifiers' @())
    $x = Get-Arg $a 'x' $null
    $y = Get-Arg $a 'y' $null

    $flags = Get-ButtonFlags $button
    if ($null -ne $x -and $null -ne $y) { Move-CursorTo ([int]$x) ([int]$y) }

    $down = New-Object System.Collections.Generic.List[object]
    foreach ($m in (Send-ModifierKeys $mods $false)) { $down.Add($m) }
    Send-InputArray $down.ToArray()

    for ($i = 0; $i -lt $count; $i++) {
        Send-InputArray @((New-MouseInput $flags.down))
        if ($holdMs -gt 0) { Start-Sleep -Milliseconds $holdMs }
        Send-InputArray @((New-MouseInput $flags.up))
        if ($i -lt $count - 1) { Start-Sleep -Milliseconds 70 }
    }

    $up = New-Object System.Collections.Generic.List[object]
    foreach ($m in (Send-ModifierKeys $mods $true)) { $up.Add($m) }
    Send-InputArray $up.ToArray()

    $c = Get-CursorPos
    return [ordered]@{ x = $c.x; y = $c.y; count = $count; button = $button }
}

function Test-EscapeDown {
    try { return (([DshWin32]::GetAsyncKeyState(0x1B)) -band 0x8000) -ne 0 } catch { return $false }
}

function Invoke-Cmd-Drag($a) {
    $from = Get-Arg $a 'from' $null
    $to = Get-Arg $a 'to' $null
    if ($null -eq $from -or $null -eq $to) { Fail 'BAD_ARGS' 'drag needs from{x,y} and to{x,y}' }
    $fx = Get-IntArg $from 'x' ([int]::MinValue); $fy = Get-IntArg $from 'y' ([int]::MinValue)
    $tx = Get-IntArg $to 'x' ([int]::MinValue);   $ty = Get-IntArg $to 'y' ([int]::MinValue)
    if ($fx -eq [int]::MinValue -or $fy -eq [int]::MinValue -or $tx -eq [int]::MinValue -or $ty -eq [int]::MinValue) {
        Fail 'BAD_ARGS' 'drag from/to need integer x and y'
    }
    $button = [string](Get-Arg $a 'button' 'left')
    $dur = [int][math]::Max(0, (Get-IntArg $a 'durationMs' 300))
    $mods = @(Get-Arg $a 'modifiers' @())
    $flags = Get-ButtonFlags $button
    $aborted = $false

    Move-CursorTo $fx $fy
    Start-Sleep -Milliseconds 30
    $down = New-Object System.Collections.Generic.List[object]
    foreach ($m in (Send-ModifierKeys $mods $false)) { $down.Add($m) }
    $down.Add((New-MouseInput $flags.down))
    Send-InputArray $down.ToArray()
    try {
        $steps = [int][math]::Min(80, [math]::Max(2, [math]::Round($dur / 12.0)))
        $sw = [System.Diagnostics.Stopwatch]::StartNew()
        for ($i = 1; $i -le $steps; $i++) {
            if (Test-EscapeDown) { $aborted = $true; break }
            $t = $i / [double]$steps
            $cx = [int][math]::Round($fx + ($tx - $fx) * $t)
            $cy = [int][math]::Round($fy + ($ty - $fy) * $t)
            Move-CursorTo $cx $cy
            $wait = [int](($dur * $t)) - [int]$sw.ElapsedMilliseconds
            if ($wait -gt 0) { Start-Sleep -Milliseconds $wait }
        }
    } finally {
        $up = New-Object System.Collections.Generic.List[object]
        $up.Add((New-MouseInput $flags.up))
        foreach ($m in (Send-ModifierKeys $mods $true)) { $up.Add($m) }
        Send-InputArray $up.ToArray()
    }
    if ($aborted) {
        Write-JsonLine ([ordered]@{
            event  = 'abort'
            result = [ordered]@{ reason = 'escape'; at = (Get-Date).ToUniversalTime().ToString('o') }
        })
    }
    $c = Get-CursorPos
    return [ordered]@{
        from = [ordered]@{ x = $fx; y = $fy }
        to   = [ordered]@{ x = $c.x; y = $c.y }
        button = $button
        aborted = $aborted
    }
}

function Invoke-Cmd-Scroll($a) {
    # dy/dx are WHEEL_DELTA units (one notch = 120); dy > 0 scrolls away from the user.
    # Optional unit:"notch" multiplies by 120 for callers that think in notches.
    $x = Get-Arg $a 'x' $null
    $y = Get-Arg $a 'y' $null
    $dy = Get-IntArg $a 'dy' 0
    $dx = Get-IntArg $a 'dx' 0
    $unit = [string](Get-Arg $a 'unit' 'delta')
    if ($unit -eq 'notch') { $dy = $dy * 120; $dx = $dx * 120 }
    if ($null -ne $x -and $null -ne $y) { Move-CursorTo ([int]$x) ([int]$y) }
    if ($dy -ne 0) { Send-InputArray @((New-MouseInput ([uint32]0x0800) 0 0 ([uint32]($dy -band 0xFFFFFFFF)))) }
    if ($dx -ne 0) { Send-InputArray @((New-MouseInput ([uint32]0x1000) 0 0 ([uint32]($dx -band 0xFFFFFFFF)))) }
    $c = Get-CursorPos
    return [ordered]@{ x = $c.x; y = $c.y; dy = $dy; dx = $dx }
}

# ===========================================================================
# 11. Commands: type / key
# ===========================================================================
function Invoke-Cmd-Type($a) {
    $text = [string](Get-Arg $a 'text' '')
    if ([string]::IsNullOrEmpty($text)) { return [ordered]@{ chars = 0 } }
    $interval = [int][math]::Max(0, (Get-IntArg $a 'intervalMs' 0))
    # ToCharArray() yields UTF-16 code units, so surrogate pairs (emoji) are sent
    # as two KEYEVENTF_UNICODE events, which is exactly what Windows expects.
    $units = $text.ToCharArray()
    $sent = 0
    if ($interval -le 0) {
        $batch = New-Object System.Collections.Generic.List[object]
        foreach ($u in $units) {
            $code = [uint16][int]$u
            $batch.Add((New-KeyInput ([uint16]0) $code ([uint32]0x0004)))
            $batch.Add((New-KeyInput ([uint16]0) $code ([uint32]0x0006)))
            $sent++
            if ($batch.Count -ge 400) { Send-InputArray $batch.ToArray(); $batch.Clear() }
        }
        if ($batch.Count -gt 0) { Send-InputArray $batch.ToArray() }
    } else {
        foreach ($u in $units) {
            $code = [uint16][int]$u
            Send-InputArray @(
                (New-KeyInput ([uint16]0) $code ([uint32]0x0004)),
                (New-KeyInput ([uint16]0) $code ([uint32]0x0006))
            )
            $sent++
            Start-Sleep -Milliseconds $interval
        }
    }
    return [ordered]@{ chars = $sent; units = $sent; intervalMs = $interval }
}

function Invoke-Cmd-Key($a) {
    $rawKeys = @(Get-Arg $a 'keys' @())
    if ($rawKeys.Count -eq 0) { Fail 'BAD_ARGS' 'key needs a non-empty keys array, e.g. ["ctrl","c"]' }
    $tokens = New-Object System.Collections.Generic.List[string]
    foreach ($k in $rawKeys) { if ($null -ne $k) { $tokens.Add([string]$k) } }

    $explicitShift = $false
    foreach ($t in $tokens) {
        $n = $t.Trim().ToLowerInvariant()
        if ($n -eq 'shift' -or $n -eq 'lshift' -or $n -eq 'rshift') { $explicitShift = $true }
    }

    $down = New-Object System.Collections.Generic.List[object]
    $up = New-Object System.Collections.Generic.List[object]
    foreach ($t in $tokens) {
        $vk = [int](Get-KeyVk $t)
        $needShift = (((Get-KeyShiftState $t) -band 1) -ne 0) -and (-not $explicitShift)
        if ($needShift) {
            $down.Add((New-KeyInput ([uint16]0x10) ([uint16]0) ([uint32]0)))
            $up.Add((New-KeyInput ([uint16]0x10) ([uint16]0) ([uint32]0x0002)))
        }
        $flags = [uint32]0
        if (Test-ExtendedVk $vk) { $flags = [uint32]0x0001 }
        $down.Add((New-KeyInput ([uint16]$vk) ([uint16]0) $flags))
        $up.Add((New-KeyInput ([uint16]$vk) ([uint16]0) ([uint32]($flags -bor 0x0002))))
    }

    Send-InputArray $down.ToArray()
    Start-Sleep -Milliseconds 12
    $upArr = $up.ToArray()
    [array]::Reverse($upArr)      # release in reverse order
    Send-InputArray $upArr
    return [ordered]@{ keys = $tokens.ToArray() }
}

# ===========================================================================
# 12. Window enumeration / inspection
# ===========================================================================
$script:EnumBuf = $null
function Get-TopWindowHandles {
    $buf = New-Object System.Collections.Generic.List[IntPtr]
    $script:EnumBuf = $buf
    $cb = [DshWin32+EnumWindowsProc]{
        param([IntPtr]$h, [IntPtr]$l)
        [void]$script:EnumBuf.Add($h)
        return $true
    }
    [void][DshWin32]::EnumWindows($cb, [IntPtr]::Zero)
    return $buf.ToArray()
}

function Test-WindowCloaked {
    param([IntPtr]$Hwnd)
    try {
        $v = [int]0
        if ([DshWin32]::DwmGetWindowAttribute($Hwnd, 14, [ref]$v, 4) -eq 0) { return ($v -ne 0) }
    } catch { }
    return $false
}

function Get-WindowTitle {
    param([IntPtr]$Hwnd)
    try {
        $len = [DshWin32]::GetWindowTextLengthW($Hwnd)
        if ($len -le 0) { return '' }
        $sb = New-Object System.Text.StringBuilder ($len + 2)
        [void][DshWin32]::GetWindowTextW($Hwnd, $sb, $sb.Capacity)
        return $sb.ToString()
    } catch { return '' }
}

function Get-WindowClass {
    param([IntPtr]$Hwnd)
    try {
        $sb = New-Object System.Text.StringBuilder 256
        [void][DshWin32]::GetClassNameW($Hwnd, $sb, 256)
        return $sb.ToString()
    } catch { return '' }
}

function Get-WindowProcessId {
    param([IntPtr]$Hwnd)
    try {
        $procId = [uint32]0
        [void][DshWin32]::GetWindowThreadProcessId($Hwnd, [ref]$procId)
        return [int]$procId
    } catch { return 0 }
}

function Get-WindowEntries {
    param([string]$Filter = '')
    $fg = [DshWin32]::GetForegroundWindow()
    $needle = ''
    if (-not [string]::IsNullOrEmpty($Filter)) { $needle = $Filter.ToLowerInvariant() }
    $rows = New-Object System.Collections.Generic.List[object]

    foreach ($h in (Get-TopWindowHandles)) {
        if (-not [DshWin32]::IsWindowVisible($h)) { continue }
        if (Test-WindowCloaked $h) { continue }
        $title = Get-WindowTitle $h
        if ([string]::IsNullOrWhiteSpace($title)) { continue }
        $procId = Get-WindowProcessId $h
        $procName = Get-ProcessNameFast $procId
        if ($needle -ne '') {
            $hay = ($title.ToLowerInvariant() + ' ' + $procName.ToLowerInvariant())
            if (-not $hay.Contains($needle)) { continue }
        }
        $bounds = Get-WindowRectSafe $h
        $client = Get-ClientRectSafe $h
        $rows.Add([ordered]@{
            hwnd         = $h.ToInt64()
            title        = $title
            class        = (Get-WindowClass $h)
            pid          = $procId
            process      = $procName
            bounds       = [ordered]@{ x = $bounds.x; y = $bounds.y; width = $bounds.width; height = $bounds.height }
            clientBounds = [ordered]@{ x = $client.x; y = $client.y; width = $client.width; height = $client.height }
            minimized    = [bool][DshWin32]::IsIconic($h)
            maximized    = [bool][DshWin32]::IsZoomed($h)
            foreground   = [bool]($h -eq $fg)
            visible      = $true
        })
    }

    $all = $rows.ToArray()
    $front = New-Object System.Collections.Generic.List[object]
    $back = New-Object System.Collections.Generic.List[object]
    foreach ($r in $all) { if ($r['foreground']) { $front.Add($r) } else { $back.Add($r) } }
    $sorted = $back | Sort-Object -Property @{ Expression = { $_['title'] } }
    $out = New-Object System.Collections.Generic.List[object]
    foreach ($r in $front) { $out.Add($r) }
    foreach ($r in $sorted) { $out.Add($r) }
    return $out.ToArray()
}

function Invoke-Cmd-Windows($a) {
    $filter = [string](Get-Arg $a 'filter' '')
    $rows = Get-WindowEntries $filter
    $fgCount = 0
    foreach ($r in $rows) { if ($r['foreground']) { $fgCount++ } }
    return [ordered]@{ windows = @($rows); count = @($rows).Count; foregroundCount = $fgCount }
}

# ===========================================================================
# 13. Commands: focus / window
# ===========================================================================
function Set-WindowForeground {
    param([IntPtr]$Hwnd)
    if ([DshWin32]::IsIconic($Hwnd)) { [void][DshWin32]::ShowWindow($Hwnd, 9) }   # SW_RESTORE
    if ([DshWin32]::SetForegroundWindow($Hwnd)) { return $true }
    if ([DshWin32]::GetForegroundWindow() -eq $Hwnd) { return $true }

    # AttachThreadInput lets a background process borrow the foreground thread's
    # input state, which is what makes SetForegroundWindow succeed here.
    $fgWin = [DshWin32]::GetForegroundWindow()
    $fgThread = [uint32]0
    if ($fgWin -ne [IntPtr]::Zero) { [void][DshWin32]::GetWindowThreadProcessId($fgWin, [ref]$fgThread) }
    $myThread = [DshWin32]::GetCurrentThreadId()
    $attached = $false
    try {
        if ($fgThread -ne 0 -and $fgThread -ne $myThread) {
            $attached = [DshWin32]::AttachThreadInput($fgThread, $myThread, $true)
        }
        [void][DshWin32]::BringWindowToTop($Hwnd)
        [void][DshWin32]::ShowWindow($Hwnd, 5)    # SW_SHOW
        [void][DshWin32]::SetForegroundWindow($Hwnd)
        [void][DshWin32]::SetFocus($Hwnd)
    } finally {
        if ($attached) { [void][DshWin32]::AttachThreadInput($fgThread, $myThread, $false) }
    }
    if ([DshWin32]::GetForegroundWindow() -eq $Hwnd) { return $true }

    # Last resort (foreground lock): tap ALT to make the OS believe the user
    # interacted with us, then retry once.
    Send-InputArray @(
        (New-KeyInput ([uint16]0x12) ([uint16]0) ([uint32]0)),
        (New-KeyInput ([uint16]0x12) ([uint16]0) ([uint32]0x0002))
    )
    Start-Sleep -Milliseconds 30
    [void][DshWin32]::SetForegroundWindow($Hwnd)
    return ([DshWin32]::GetForegroundWindow() -eq $Hwnd)
}

function Find-WindowByTitle {
    param([string]$Match)
    if ([string]::IsNullOrEmpty($Match)) { return [IntPtr]::Zero }
    $needle = $Match.ToLowerInvariant()
    $fg = [DshWin32]::GetForegroundWindow()
    foreach ($r in (Get-WindowEntries '')) {
        if ($r['hwnd'] -eq $fg.ToInt64()) { continue }
        if ($r['title'].ToLowerInvariant().Contains($needle)) { return [IntPtr][int64]$r['hwnd'] }
    }
    foreach ($r in (Get-WindowEntries '')) {
        if ($r['title'].ToLowerInvariant().Contains($needle)) { return [IntPtr][int64]$r['hwnd'] }
    }
    return [IntPtr]::Zero
}

function Get-ProcessNameFast {
    # ProcessName via the .NET API, not the Get-Process cmdlet: the cmdlet costs tens of ms
    # on first use, which alone would break the sub-3ms windowState budget (and slow windows).
    param([int]$ProcessIdValue)
    if ($ProcessIdValue -le 0) { return '' }
    $key = [string]$ProcessIdValue
    if ($script:ProcNameCache.ContainsKey($key)) { return [string]$script:ProcNameCache[$key] }
    $name = ''
    try { $name = [string][System.Diagnostics.Process]::GetProcessById($ProcessIdValue).ProcessName }
    catch { return '' }   # do not cache a miss: the pid may not be queryable yet
    $script:ProcNameCache[$key] = $name
    return $name
}

function Get-WindowInfoDict {
    # Single source of truth for a window record: the exact 11 fields that the
    # windows command returns. Used by focus / window / screenshot.foreground.
    param([IntPtr]$Hwnd)
    if ($null -eq $script:ProcNameCache) { $script:ProcNameCache = @{} }
    $bounds = Get-WindowRectSafe $Hwnd
    $client = Get-ClientRectSafe $Hwnd
    if ($null -eq $bounds) { $bounds = [pscustomobject]@{ x = 0; y = 0; width = 0; height = 0 } }
    if ($null -eq $client) { $client = [pscustomobject]@{ x = 0; y = 0; width = 0; height = 0 } }
    $procId = Get-WindowProcessId $Hwnd
    $procName = Get-ProcessNameFast $procId
    $fg = [DshWin32]::GetForegroundWindow()
    return [ordered]@{
        hwnd         = $Hwnd.ToInt64()
        title        = (Get-WindowTitle $Hwnd)
        class        = (Get-WindowClass $Hwnd)
        pid          = $procId
        process      = $procName
        bounds       = [ordered]@{ x = $bounds.x; y = $bounds.y; width = $bounds.width; height = $bounds.height }
        clientBounds = [ordered]@{ x = $client.x; y = $client.y; width = $client.width; height = $client.height }
        minimized    = [bool][DshWin32]::IsIconic($Hwnd)
        maximized    = [bool][DshWin32]::IsZoomed($Hwnd)
        foreground   = [bool]($Hwnd -eq $fg)
        visible      = [bool][DshWin32]::IsWindowVisible($Hwnd)
    }
}

function Get-ForegroundWindowInfo {
    # Foreground window as a full window record, or $null when it would be
    # filtered out of the windows list (untitled / invisible / DWM-cloaked).
    # Straight GetForegroundWindow: no EnumWindows pass.
    $h = [DshWin32]::GetForegroundWindow()
    if ($h -eq [IntPtr]::Zero) { return $null }
    if (-not [DshWin32]::IsWindow($h)) { return $null }
    if (-not [DshWin32]::IsWindowVisible($h)) { return $null }
    if (Test-WindowCloaked $h) { return $null }
    if ([string]::IsNullOrWhiteSpace((Get-WindowTitle $h))) { return $null }
    return (Get-WindowInfoDict $h)
}

function Invoke-Cmd-Focus($a) {
    $hwnd = Get-Arg $a 'hwnd' $null
    $titleMatch = [string](Get-Arg $a 'titleMatch' '')
    $target = [IntPtr]::Zero
    if ($null -ne $hwnd) {
        $target = [IntPtr][int64]$hwnd
        if (-not [DshWin32]::IsWindow($target)) { Fail 'WINDOW_GONE' ("hwnd is not a live window: " + $hwnd) }
    } elseif ($titleMatch -ne '') {
        $target = Find-WindowByTitle $titleMatch
        if ($target -eq [IntPtr]::Zero) { Fail 'NO_WINDOW' ("no visible window matching: " + $titleMatch) }
    } else {
        Fail 'BAD_ARGS' 'focus needs hwnd or titleMatch'
    }

    $ok = Set-WindowForeground $target
    Start-Sleep -Milliseconds 40
    $info = Get-WindowInfoDict $target
    return [ordered]@{
        window     = $info
        bounds     = $info['bounds']
        focused    = [bool]$ok
        foreground = [bool]($info['foreground'])
    }
}

function Invoke-Cmd-Window($a) {
    $hwnd = Get-Arg $a 'hwnd' $null
    $op = ([string](Get-Arg $a 'op' '')).ToLowerInvariant()
    if ($null -eq $hwnd) { Fail 'BAD_ARGS' 'window needs hwnd' }
    if ($op -ne 'minimize' -and $op -ne 'maximize' -and $op -ne 'restore' -and $op -ne 'close') {
        Fail 'BAD_ARGS' ("unsupported window op: " + $op + " (minimize|maximize|restore|close)")
    }
    $target = [IntPtr][int64]$hwnd
    if (-not [DshWin32]::IsWindow($target)) { Fail 'WINDOW_GONE' ("hwnd is not a live window: " + $hwnd) }

    $before = Get-WindowInfoDict $target
    switch ($op) {
        'minimize' { [void][DshWin32]::ShowWindow($target, 6) }    # SW_MINIMIZE
        'maximize' { [void][DshWin32]::ShowWindow($target, 3) }    # SW_MAXIMIZE
        'restore'  { [void][DshWin32]::ShowWindow($target, 9) }    # SW_RESTORE
        'close'    { [void][DshWin32]::PostMessageW($target, [uint32]0x0010, [IntPtr]::Zero, [IntPtr]::Zero) }
    }

    $closed = $false
    if ($op -eq 'close') {
        # Give the app time to run its WM_CLOSE handler; never TerminateProcess.
        for ($i = 0; $i -lt 25; $i++) {
            Start-Sleep -Milliseconds 20
            if (-not [DshWin32]::IsWindow($target)) { $closed = $true; break }
        }
    } else {
        Start-Sleep -Milliseconds 60
        if (-not [DshWin32]::IsWindow($target)) { Fail 'WINDOW_GONE' 'window disappeared while applying op' }
    }

    if ($closed) {
        return [ordered]@{
            hwnd = $before['hwnd']; op = $op; closed = $true
            bounds = $before['bounds']
            minimized = [bool]$before['minimized']; maximized = [bool]$before['maximized']
        }
    }
    $after = Get-WindowInfoDict $target
    return [ordered]@{
        hwnd = $after['hwnd']; op = $op; closed = $false
        bounds = $after['bounds']
        minimized = [bool]$after['minimized']; maximized = [bool]$after['maximized']
        title = $after['title']
    }
}

function Invoke-Cmd-WindowState($a) {
    # Cheap identity/geometry probe: IsWindow + rect + iconic + pid/process name only, no EnumWindows.
    # Callers poll this before a mutating action to notice the window being moved, retitled,
    # or its process restarting (a stale hwnd silently pointing at a recycled window is a real bug source).
    $hwnd = Get-Arg $a 'hwnd' $null
    if ($null -eq $hwnd) { Fail 'BAD_ARGS' 'windowState needs hwnd' }
    $h = [IntPtr][int64]$hwnd
    if (-not [DshWin32]::IsWindow($h)) { return [ordered]@{ hwnd = $h.ToInt64(); exists = $false } }
    $bounds = Get-WindowRectSafe $h
    if ($null -eq $bounds) { $bounds = [pscustomobject]@{ x = 0; y = 0; width = 0; height = 0 } }
    $procId = Get-WindowProcessId $h
    $procName = Get-ProcessNameFast $procId
    return [ordered]@{
        hwnd      = $h.ToInt64()
        exists    = $true
        pid       = $procId
        process   = $procName
        class     = (Get-WindowClass $h)
        bounds    = [ordered]@{ x = $bounds.x; y = $bounds.y; width = $bounds.width; height = $bounds.height }
        minimized = [bool][DshWin32]::IsIconic($h)
        visible   = [bool][DshWin32]::IsWindowVisible($h)
    }
}

# ===========================================================================
# 14. UIA tree (bounded depth / node count / wall clock)
# ===========================================================================
function Get-UiaRoot {
    param([IntPtr]$Hwnd)
    if (-not $script:HasUia) { Fail 'UIA_UNAVAILABLE' 'UIAutomationClient/UIAutomationTypes are not loadable in this host' }
    try { return [System.Windows.Automation.AutomationElement]::FromHandle($Hwnd) }
    catch { Fail 'UIA_FAILED' ("AutomationElement.FromHandle failed: " + $_.Exception.Message) }
}

function Get-PatternShortName {
    param([string]$ProgrammaticName)
    if ([string]::IsNullOrEmpty($ProgrammaticName)) { return '' }
    $n = $ProgrammaticName
    $dot = $n.IndexOf('.')
    if ($dot -gt 0) { $n = $n.Substring(0, $dot) }
    return ($n -replace 'PatternIdentifiers$', '')
}

function Get-ControlRoleName {
    param($ControlType)
    if ($null -eq $ControlType) { return '' }
    $p = [string]$ControlType.ProgrammaticName
    if ($p.StartsWith('ControlType.')) { return $p.Substring(12) }
    return $p
}

function Build-UiaNode {
    param($El, [string]$Path, [int]$Depth, [int]$MaxDepth, $Walker, $Sw, [int]$BudgetMs, [bool]$IncludeOffscreen)
    $script:UiaNodeCount = $script:UiaNodeCount + 1
    $node = [ordered]@{
        path         = $Path
        role         = ''
        name         = ''
        value        = $null
        automationId = ''
        class        = ''
        bounds       = $null
        enabled      = $false
        offscreen    = $false
        patterns     = @()
        children     = @()
    }
    try {
        $cur = $El.Current
        $node['name'] = [string]$cur.Name
        $node['automationId'] = [string]$cur.AutomationId
        $node['class'] = [string]$cur.ClassName
        $node['enabled'] = [bool]$cur.IsEnabled
        $node['offscreen'] = [bool]$cur.IsOffscreen
        $node['role'] = (Get-ControlRoleName $cur.ControlType)
    } catch { }
    try {
        $r = $El.Current.BoundingRectangle
        if ($r.Width -gt 0 -and $r.Height -gt 0) {
            $node['bounds'] = [ordered]@{ x = [int]$r.X; y = [int]$r.Y; width = [int]$r.Width; height = [int]$r.Height }
        }
    } catch { }
    $pats = New-Object System.Collections.Generic.List[string]
    try {
        foreach ($p in $El.GetSupportedPatterns()) {
            $s = Get-PatternShortName ([string]$p.ProgrammaticName)
            if ($s -ne '' -and -not $pats.Contains($s)) { $pats.Add($s) }
        }
    } catch { }
    $node['patterns'] = $pats.ToArray()
    if ($pats.Contains('Value')) {
        try {
            $vp = $El.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
            if ($null -ne $vp) { $node['value'] = [string]$vp.Current.Value }
        } catch { }
    }
    if ($Depth -ge $MaxDepth) { return $node }
    if ($script:UiaNodeCount -ge $script:UiaMaxNodes) { $script:UiaTruncated = $true; return $node }
    if ($Sw.ElapsedMilliseconds -gt $BudgetMs) { $script:UiaTruncated = $true; return $node }
    $kids = New-Object System.Collections.Generic.List[object]
    $child = $null
    try { $child = $Walker.GetFirstChild($El) } catch { $child = $null }
    $i = 0
    while ($null -ne $child) {
        if ($script:UiaNodeCount -ge $script:UiaMaxNodes) { $script:UiaTruncated = $true; break }
        if ($Sw.ElapsedMilliseconds -gt $BudgetMs) { $script:UiaTruncated = $true; break }
        $skip = $false
        if (-not $IncludeOffscreen) {
            try { if ($child.Current.IsOffscreen) { $skip = $true } } catch { $skip = $true }
        }
        if (-not $skip) {
            $kids.Add((Build-UiaNode $child ($Path + '/' + $i) ($Depth + 1) $MaxDepth $Walker $Sw $BudgetMs $IncludeOffscreen))
        }
        $i++
        try { $child = $Walker.GetNextSibling($child) } catch { $child = $null }
    }
    $node['children'] = $kids.ToArray()
    return $node
}

function Invoke-Cmd-Uia($a) {
    $hwnd = Get-Arg $a 'hwnd' $null
    if ($null -eq $hwnd) { $hwnd = [DshWin32]::GetForegroundWindow().ToInt64() }
    $h = [IntPtr][int64]$hwnd
    if (-not [DshWin32]::IsWindow($h)) { Fail 'WINDOW_GONE' ("hwnd is not a live window: " + $hwnd) }
    $maxDepth = [int][math]::Min(20, [math]::Max(0, (Get-IntArg $a 'depth' 8)))
    $script:UiaMaxNodes = [int][math]::Min(4000, [math]::Max(1, (Get-IntArg $a 'maxNodes' 1200)))
    $budgetMs = [int][math]::Min(30000, [math]::Max(200, (Get-IntArg $a 'timeoutMs' 6000)))
    $inclOff = [bool](Get-Arg $a 'includeOffscreen' $false)
    $root = Get-UiaRoot $h
    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $script:UiaNodeCount = 0
    $script:UiaTruncated = $false
    $tree = Build-UiaNode $root '0' 0 $maxDepth $walker $sw $budgetMs $inclOff
    return [ordered]@{
        hwnd      = $h.ToInt64()
        root      = $tree
        nodes     = [int]$script:UiaNodeCount
        truncated = [bool]$script:UiaTruncated
        elapsedMs = [int]$sw.ElapsedMilliseconds
    }
}

function Find-UiaByPath {
    param($Root, [string]$Path, $Walker)
    if ([string]::IsNullOrWhiteSpace($Path)) { Fail 'BAD_ARGS' 'uiaAct needs a path like 0/2/1' }
    $parts = $Path.Split('/')
    $cur = $Root
    for ($i = 1; $i -lt $parts.Count; $i++) {
        $seg = $parts[$i].Trim()
        $idx = 0
        if (-not [int]::TryParse($seg, [ref]$idx)) { Fail 'BAD_ARGS' ("bad path segment: " + $seg) }
        $child = $null
        try { $child = $Walker.GetFirstChild($cur) } catch { $child = $null }
        $n = 0
        while ($null -ne $child -and $n -lt $idx) {
            try { $child = $Walker.GetNextSibling($child) } catch { $child = $null }
            $n++
        }
        if ($null -eq $child) { Fail 'ELEMENT_NOT_FOUND' ("no element at path " + $Path + " (segment " + $i + ")") }
        $cur = $child
    }
    return $cur
}

function Get-UiaPatternObject {
    param($El, $Pattern, [string]$Name)
    $obj = $null
    try {
        if (-not $El.TryGetCurrentPattern($Pattern, [ref]$obj)) {
            Fail 'PATTERN_UNSUPPORTED' ("element does not support the " + $Name + " pattern")
        }
    } catch {
        $code = 'PATTERN_UNSUPPORTED'
        try { if ($null -ne $_.Exception.Data['code']) { throw } } catch { }
        Fail 'PATTERN_UNSUPPORTED' ("element does not support the " + $Name + " pattern: " + $_.Exception.Message)
    }
    return $obj
}

function Invoke-Cmd-UiaAct($a) {
    $hwnd = Get-Arg $a 'hwnd' $null
    $path = [string](Get-Arg $a 'path' '')
    $action = ([string](Get-Arg $a 'action' '')).ToLowerInvariant()
    $value = Get-Arg $a 'value' $null
    if ($null -eq $hwnd) { Fail 'BAD_ARGS' 'uiaAct needs hwnd' }
    $h = [IntPtr][int64]$hwnd
    if (-not [DshWin32]::IsWindow($h)) { Fail 'WINDOW_GONE' ("hwnd is not a live window: " + $hwnd) }
    $root = Get-UiaRoot $h
    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    $el = Find-UiaByPath $root $path $walker
    switch ($action) {
        'invoke' {
            $p = Get-UiaPatternObject $el ([System.Windows.Automation.InvokePattern]::Pattern) 'Invoke'
            $p.Invoke()
        }
        'setvalue' {
            if ($null -eq $value) { Fail 'BAD_ARGS' 'setValue needs a value' }
            $p = Get-UiaPatternObject $el ([System.Windows.Automation.ValuePattern]::Pattern) 'Value'
            $p.SetValue([string]$value)
        }
        'focus' {
            $el.SetFocus()
        }
        'expand' {
            $p = Get-UiaPatternObject $el ([System.Windows.Automation.ExpandCollapsePattern]::Pattern) 'ExpandCollapse'
            $p.Expand()
        }
        'collapse' {
            $p = Get-UiaPatternObject $el ([System.Windows.Automation.ExpandCollapsePattern]::Pattern) 'ExpandCollapse'
            $p.Collapse()
        }
        'select' {
            $p = Get-UiaPatternObject $el ([System.Windows.Automation.SelectionItemPattern]::Pattern) 'SelectionItem'
            $p.Select()
        }
        'toggle' {
            $p = Get-UiaPatternObject $el ([System.Windows.Automation.TogglePattern]::Pattern) 'Toggle'
            $p.Toggle()
        }
        default { Fail 'BAD_ARGS' ("unsupported uiaAct action: " + $action) }
    }
    Start-Sleep -Milliseconds 25
    $bounds = $null
    try {
        $r = $el.Current.BoundingRectangle
        if ($r.Width -gt 0 -and $r.Height -gt 0) { $bounds = [ordered]@{ x = [int]$r.X; y = [int]$r.Y; width = [int]$r.Width; height = [int]$r.Height } }
    } catch { }
    return [ordered]@{ action = $action; ok = $true; path = $path; bounds = $bounds }
}

# ===========================================================================
# 15. Clipboard.  WinForms Clipboard needs STA (the host starts with -STA);
#     the Win32 CF_UNICODETEXT path is the fallback when we ended up MTA.
# ===========================================================================
function Get-ClipboardTextWin32 {
    for ($i = 0; $i -lt 10; $i++) {
        if ([DshWin32]::OpenClipboard([IntPtr]::Zero)) {
            try {
                $hData = [DshWin32]::GetClipboardData([uint32]13)
                if ($hData -eq [IntPtr]::Zero) { return '' }
                $ptr = [DshWin32]::GlobalLock($hData)
                if ($ptr -eq [IntPtr]::Zero) { return '' }
                try { return [System.Runtime.InteropServices.Marshal]::PtrToStringUni($ptr) }
                finally { [void][DshWin32]::GlobalUnlock($hData) }
            } finally { [void][DshWin32]::CloseClipboard() }
        }
        Start-Sleep -Milliseconds 50
    }
    Fail 'CLIPBOARD_FAILED' 'could not open the clipboard for reading (it is locked by another app)'
}

function Set-ClipboardTextWin32 {
    param([string]$Text)
    for ($i = 0; $i -lt 10; $i++) {
        if ([DshWin32]::OpenClipboard([IntPtr]::Zero)) {
            try {
                [void][DshWin32]::EmptyClipboard()
                $bytes = [System.Text.Encoding]::Unicode.GetBytes($Text + [string][char]0)
                $hMem = [DshWin32]::GlobalAlloc([uint32]0x0002, [UIntPtr]([uint64]$bytes.Length))
                if ($hMem -eq [IntPtr]::Zero) { Fail 'CLIPBOARD_FAILED' 'GlobalAlloc failed' }
                $dst = [DshWin32]::GlobalLock($hMem)
                try { [System.Runtime.InteropServices.Marshal]::Copy($bytes, 0, $dst, $bytes.Length) }
                finally { [void][DshWin32]::GlobalUnlock($hMem) }
                if ([DshWin32]::SetClipboardData([uint32]13, $hMem) -eq [IntPtr]::Zero) {
                    [void][DshWin32]::GlobalFree($hMem)
                    Fail 'CLIPBOARD_FAILED' 'SetClipboardData failed'
                }
                return $true
            } finally { [void][DshWin32]::CloseClipboard() }
        }
        Start-Sleep -Milliseconds 50
    }
    Fail 'CLIPBOARD_FAILED' 'could not open the clipboard for writing (it is locked by another app)'
}

function Get-ClipboardText {
    if (-not $script:IsSta) { return (Get-ClipboardTextWin32) }
    $last = $null
    for ($i = 0; $i -lt 6; $i++) {
        try {
            if ([System.Windows.Forms.Clipboard]::ContainsText()) { return [string][System.Windows.Forms.Clipboard]::GetText() }
            return ''
        } catch { $last = $_.Exception.Message; Start-Sleep -Milliseconds 60 }
    }
    try { return (Get-ClipboardTextWin32) } catch { Fail 'CLIPBOARD_FAILED' ("clipboard read failed: " + $last) }
}

function Set-ClipboardText {
    param([string]$Text)
    if (-not $script:IsSta) { return (Set-ClipboardTextWin32 $Text) }
    $last = $null
    for ($i = 0; $i -lt 6; $i++) {
        try { [System.Windows.Forms.Clipboard]::SetText($Text); return $true }
        catch { $last = $_.Exception.Message; Start-Sleep -Milliseconds 60 }
    }
    try { return (Set-ClipboardTextWin32 $Text) } catch { Fail 'CLIPBOARD_FAILED' ("clipboard write failed: " + $last) }
}

function Invoke-Cmd-Clipboard($a) {
    $op = ([string](Get-Arg $a 'op' 'get')).ToLowerInvariant()
    if ($op -eq 'get') { return [ordered]@{ text = (Get-ClipboardText) } }
    if ($op -eq 'set') {
        $text = Get-Arg $a 'text' $null
        if ($null -eq $text) { $text = '' }
        [void](Set-ClipboardText ([string]$text))
        return [ordered]@{ ok = $true; chars = ([string]$text).Length }
    }
    Fail 'BAD_ARGS' ("unsupported clipboard op: " + $op)
}

# ===========================================================================
# 16. guard - shape is frozen by the protocol; the overlay owns the real logic.
# ===========================================================================
function Invoke-Cmd-Guard($a) {
    $op = ([string](Get-Arg $a 'op' 'status')).ToLowerInvariant()
    switch ($op) {
        'arm' { $script:Guard.armed = $true; $script:Guard.tripped = $false; $script:Guard.reason = $null; $script:Guard.since = (Get-Date).ToUniversalTime().ToString('o') }
        'disarm' { $script:Guard.armed = $false; $script:Guard.since = (Get-Date).ToUniversalTime().ToString('o') }
        'reset' { $script:Guard.armed = $false; $script:Guard.tripped = $false; $script:Guard.reason = $null; $script:Guard.since = $null }
        'status' { }
        default { Fail 'BAD_ARGS' ("unsupported guard op: " + $op) }
    }
    return [ordered]@{
        armed   = [bool]$script:Guard.armed
        tripped = [bool]$script:Guard.tripped
        reason  = $script:Guard.reason
        since   = $script:Guard.since
    }
}

# ===========================================================================
# 17. Command dispatch
# ===========================================================================
function Test-DecFlag($a, [string]$name) {
  try { $v = Get-Arg $a $name } catch { try { $v = $a.$name } catch { $v = $null } }
  return ($v -eq $true -or $v -eq 'true' -or $v -eq 1 -or $v -eq '1')
}
function Get-DecValue($a, [string]$name) {
  try { return (Get-Arg $a $name) } catch { try { return $a.$name } catch { return $null } }
}
$script:FrameCache = @{}
function Add-ScreenshotDecorations($bmp, $a) {
  $grid = Test-DecFlag $a 'grid'
  $mark = Get-DecValue $a 'mark'
  $dim = Get-DecValue $a 'dim'
  if (-not $grid -and $null -eq $mark -and $null -eq $dim) { return $false }
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  try {
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    if ($null -ne $dim) {
      $x = [int]$dim.x; $y = [int]$dim.y; $w = [int]$dim.width; $h = [int]$dim.height
      $shade = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(120, 0, 0, 0))
      try {
        $g.FillRectangle($shade, 0, 0, $bmp.Width, [Math]::Max(0, $y))
        $g.FillRectangle($shade, 0, $y + $h, $bmp.Width, [Math]::Max(0, $bmp.Height - $y - $h))
        $g.FillRectangle($shade, 0, $y, [Math]::Max(0, $x), $h)
        $g.FillRectangle($shade, $x + $w, $y, [Math]::Max(0, $bmp.Width - $x - $w), $h)
      } finally { $shade.Dispose() }
      $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(255, 255, 140, 0)), 2
      try { $g.DrawRectangle($pen, $x, $y, $w, $h) } finally { $pen.Dispose() }
    }
    if ($grid) {
      $step = [int](Get-DecValue $a 'gridStep')
      if ($step -le 0) { $step = [int]([Math]::Max(50, [Math]::Round($bmp.Width / 10.0 / 50) * 50)) }
      $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(120, 255, 80, 0)), 1
      $font = New-Object System.Drawing.Font 'Consolas', 9
      $ink = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(235, 255, 255, 255))
      $back = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(175, 0, 0, 0))
      try {
        for ($x = $step; $x -lt $bmp.Width; $x += $step) { $g.DrawLine($pen, $x, 0, $x, $bmp.Height) }
        for ($y = $step; $y -lt $bmp.Height; $y += $step) { $g.DrawLine($pen, 0, $y, $bmp.Width, $y) }
        for ($x = $step; $x -lt $bmp.Width; $x += $step) {
          for ($y = $step; $y -lt $bmp.Height; $y += $step) {
            $label = '' + $x + ',' + $y
            $size = $g.MeasureString($label, $font)
            $g.FillRectangle($back, $x + 1, $y + 1, $size.Width, $size.Height)
            $g.DrawString($label, $font, $ink, $x + 1, $y + 1)
          }
        }
      } finally { $pen.Dispose(); $font.Dispose(); $ink.Dispose(); $back.Dispose() }
    }
    if ($null -ne $mark) {
      $mx = [int]$mark.x; $my = [int]$mark.y
      $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(255, 255, 40, 40)), 3
      try {
        $g.DrawEllipse($pen, $mx - 14, $my - 14, 28, 28)
        $g.DrawLine($pen, $mx - 22, $my, $mx + 22, $my)
        $g.DrawLine($pen, $mx, $my - 22, $mx, $my + 22)
      } finally { $pen.Dispose() }
    }
  } finally { $g.Dispose() }
  return $true
}
function Get-FrameChange($bmp, $a) {
  $want = Test-DecFlag $a 'compare'
  $key = 'all'
  $hw = Get-DecValue $a 'hwnd'
  $sc = Get-DecValue $a 'screen'
  if ($null -ne $hw) { $key = 'w' + $hw } elseif ($null -ne $sc) { $key = 's' + $sc }
  $prev = $null
  if ($script:FrameCache.ContainsKey($key)) { $prev = $script:FrameCache[$key] }
  $result = $null
  if ($want -and $null -ne $prev -and $prev.Width -eq $bmp.Width -and $prev.Height -eq $bmp.Height) {
    $w = $bmp.Width; $h = $bmp.Height; $step = 4
    $changed = 0; $total = 0; $minX = $w; $minY = $h; $maxX = -1; $maxY = -1
    for ($y = 0; $y -lt $h; $y += $step) {
      for ($x = 0; $x -lt $w; $x += $step) {
        $total++
        if ($bmp.GetPixel($x, $y).ToArgb() -ne $prev.GetPixel($x, $y).ToArgb()) {
          $changed++
          if ($x -lt $minX) { $minX = $x }; if ($y -lt $minY) { $minY = $y }
          if ($x -gt $maxX) { $maxX = $x }; if ($y -gt $maxY) { $maxY = $y }
        }
      }
    }
    $ratio = 0
    if ($total -gt 0) { $ratio = [Math]::Round($changed / $total, 4) }
    $bounds = $null
    if ($maxX -ge 0) { $bounds = @{ x = $minX; y = $minY; width = [Math]::Max(1, $maxX - $minX + $step); height = [Math]::Max(1, $maxY - $minY + $step) } }
    $result = @{ changed = ($ratio -gt 0.001); ratio = $ratio; bounds = $bounds }
  }
  if ($null -ne $prev) { $prev.Dispose() }
  $script:FrameCache[$key] = New-Object System.Drawing.Bitmap $bmp
  if ($script:FrameCache.Count -gt 2) {
    foreach ($k in @($script:FrameCache.Keys)) { if ($k -ne $key) { $script:FrameCache[$k].Dispose(); $script:FrameCache.Remove($k) } }
  }
  return $result
}
function Invoke-HostCommand {
    param([string]$Cmd, $Args_)
    $name = $Cmd.Trim().ToLowerInvariant()
    switch ($name) {
        'screenshot' { return (Invoke-Cmd-Screenshot $Args_) }
        'cursor'     { return (Invoke-Cmd-Cursor $Args_) }
        'move'       { return (Invoke-Cmd-Move $Args_) }
        'click'      { return (Invoke-Cmd-Click $Args_) }
        'drag'       { return (Invoke-Cmd-Drag $Args_) }
        'scroll'     { return (Invoke-Cmd-Scroll $Args_) }
        'type'       { return (Invoke-Cmd-Type $Args_) }
        'key'        { return (Invoke-Cmd-Key $Args_) }
        'windows'    { return (Invoke-Cmd-Windows $Args_) }
        'focus'      { return (Invoke-Cmd-Focus $Args_) }
        'window'     { return (Invoke-Cmd-Window $Args_) }
        'windowstate' { return (Invoke-Cmd-WindowState $Args_) }
        'uia'        { return (Invoke-Cmd-Uia $Args_) }
        'uiaAct'     { return (Invoke-Cmd-UiaAct $Args_) }
        'clipboard'  { return (Invoke-Cmd-Clipboard $Args_) }
        'guard'      { return (Invoke-Cmd-Guard $Args_) }
        'shutdown'   { return [ordered]@{ ok = $true } }
        default { Fail 'UNKNOWN_CMD' ("unknown command: " + $Cmd) }
    }
}

# ===========================================================================
# 18. Boot: enumerate displays once, then announce ready on stdout.
# ===========================================================================
$script:Screens = @(Get-ScreenList)
if ($script:Screens.Count -eq 0) {
    $vs = Get-VirtualScreen
    $script:Screens = @([pscustomobject]@{ id = '\\.\DISPLAY1'; x = $vs.x; y = $vs.y; width = $vs.width; height = $vs.height; primary = $true; scale = 1.0 })
}
$script:UiaNodeCount = 0
$script:UiaMaxNodes = 1200
$script:UiaTruncated = $false
$cur0 = Get-CursorPos
# Warm up the foreground-window record path (function JIT + first .NET Process lookup,
# ~30ms one-off) so a later screenshot does not pay it inside result.foreground.
try { $null = Get-ForegroundWindowInfo } catch { Write-Host-Log ("foreground warm-up failed: " + $_.Exception.Message) }

$boot = [ordered]@{
    os        = [System.Environment]::OSVersion.VersionString
    psVersion = $PSVersionTable.PSVersion.ToString()
    psEdition = [string]$PSVersionTable.PSEdition
    sessionId = [int][System.Diagnostics.Process]::GetCurrentProcess().SessionId
    hostPid   = [int]$PID
    dpiAware  = [bool]$script:DpiAware
    dpiMode   = [string]$script:DpiMode
    apartment = [string][System.Threading.Thread]::CurrentThread.GetApartmentState()
    uia       = [bool]$script:HasUia
    inputStructBytes = [int]$script:InputSize
    screens   = @($script:Screens)
    virtualScreen = (Get-VirtualScreen)
    cursor    = [ordered]@{ x = $cur0.x; y = $cur0.y }
    bootMs    = [int]$script:BootSw.ElapsedMilliseconds
}
Write-JsonLine ([ordered]@{ event = 'ready'; result = $boot })
Write-Host-Log ("ready: " + $script:Screens.Count + " screen(s), dpi=" + $script:DpiMode + ", uia=" + $script:HasUia)

# ===========================================================================
# 19. Main loop.  One NDJSON request per line in, one response per line out.
# ===========================================================================
$script:RequestCount = 0
while ($true) {
    $line = $null
    try { $line = [Console]::In.ReadLine() } catch { break }
    if ($null -eq $line) { break }
    $line = $line.Trim()
    if ($line.Length -eq 0) { continue }

    $idOut = $null
    $cmdName = ''
    try {
        $req = $null
        try { $req = $line | ConvertFrom-Json } catch { Fail 'BAD_JSON' ("cannot parse request: " + $_.Exception.Message) }
        if ($null -eq $req) { Fail 'BAD_JSON' 'empty request' }
        if (Has-Arg $req 'id') { $idOut = $req.id }
        $cmdName = [string](Get-Arg $req 'cmd' '')
        $reqArgs = Get-Arg $req 'args' $null
        if ([string]::IsNullOrWhiteSpace($cmdName)) { Fail 'BAD_ARGS' 'request has no cmd' }
        $result = Invoke-HostCommand $cmdName $reqArgs
        Write-JsonLine ([ordered]@{ id = $idOut; ok = $true; result = $result })
        $script:RequestCount++
        if ($cmdName.Trim().ToLowerInvariant() -eq 'shutdown') { break }
    } catch {
        $code = 'INTERNAL'
        $msg = ''
        try { $msg = [string]$_.Exception.Message } catch { $msg = 'unknown error' }
        try {
            $c = $_.Exception.Data['code']
            if ($null -ne $c) { $code = [string]$c }
        } catch { }
        Write-JsonLine ([ordered]@{ id = $idOut; ok = $false; error = [ordered]@{ code = $code; message = $msg; cmd = $cmdName } })
        Write-Host-Log ("request failed (" + $cmdName + "): " + $code + " " + $msg)
    }
}
Write-Host-Log ("exiting after " + $script:RequestCount + " request(s)")
        timings = [ordered]@{ captureMs = $msCapture; transformMs = ($msTransform - $msCapture); encodeMs = ($msEncode - $msTransform) }
exit 0



