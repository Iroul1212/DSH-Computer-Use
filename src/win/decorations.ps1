# Screenshot decorations (grid / mark / dim) and frame-change detection.
# Dot-sourced by win-host.ps1 so the main host file stays readable.
function Test-DecFlag($a, [string]$name) {
  $v = Get-DecValue $a $name
  return ($v -eq $true -or $v -eq 'true' -or $v -eq 1 -or $v -eq '1')
}
function Get-DecValue($a, [string]$name) {
  try { return (Get-Arg $a $name) } catch { try { return $a.$name } catch { return $null } }
}
# Frame-to-frame comparison: a hashed copy of the previous capture lives here so
# a mutating action can answer "did the screen actually change?". One entry per
# capture target (window / screen), because images of different targets must
# never be diffed against each other.
$script:FrameCache = @{}
# Width the two frames are normalised to before diffing. Big enough to catch a
# button flipping state, small enough that the copy costs ~5ms even at 5K.
$script:FrameSampleWidth = 256

# Pixel diff for two 32bpp frames, compiled once: the PowerShell equivalent is
# ~500ms per frame at this size, which would double the cost of every screenshot.
if (-not ([System.Management.Automation.PSTypeName]'DshFrameDiff').Type) {
  Add-Type -TypeDefinition @"
using System;
namespace DshFrameDiff {
  public static class Diff {
    // Returns {ratio, minX, minY, maxX, maxY}; maxX < 0 means "identical".
    public static double[] Compare(byte[] a, byte[] b, int width, int height, int stride) {
      long diff = 0; long total = 0;
      int minX = width, minY = height, maxX = -1, maxY = -1;
      for (int y = 0; y < height; y++) {
        int row = y * stride;
        for (int x = 0; x < width; x++) {
          int i = row + x * 4;
          total++;
          if (a[i] != b[i] || a[i + 1] != b[i + 1] || a[i + 2] != b[i + 2] || a[i + 3] != b[i + 3]) {
            diff++;
            if (x < minX) minX = x;
            if (y < minY) minY = y;
            if (x > maxX) maxX = x;
            if (y > maxY) maxY = y;
          }
        }
      }
      double ratio = total == 0 ? 0.0 : (double)diff / (double)total;
      return new double[] { ratio, minX, minY, maxX, maxY };
    }
  }
}
"@
}
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
      $pen0 = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(255, 255, 140, 0)), 2
      try { $g.DrawRectangle($pen0, $x, $y, $w, $h) } finally { $pen0.Dispose() }
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
      $penm = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(255, 255, 40, 40)), 3
      try {
        $g.DrawEllipse($penm, $mx - 14, $my - 14, 28, 28)
        $g.DrawLine($penm, $mx - 22, $my, $mx + 22, $my)
        $g.DrawLine($penm, $mx, $my - 22, $mx, $my + 22)
      } finally { $penm.Dispose() }
    }
  } finally { $g.Dispose() }
  return $true
}
function Get-FrameSignature($bmp, [int]$SampleWidth) {
  # Normalise any capture to one small ARGB frame so two screenshots of the same
  # target can be diffed cheaply, whatever their size or DPI.
  $thumb = $null
  try {
    if ($SampleWidth -gt 0 -and $bmp.Width -gt $SampleWidth) {
      $thumb = Resize-BitmapToWidth (New-Object System.Drawing.Bitmap $bmp) $SampleWidth
    } else {
      $thumb = New-Object System.Drawing.Bitmap $bmp
    }
    $rect = New-Object System.Drawing.Rectangle 0, 0, $thumb.Width, $thumb.Height
    $data = $thumb.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    try {
      $stride = [int]$data.Stride
      $n = $stride * [int]$data.Height
      $bytes = New-Object byte[] $n
      [System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $bytes, 0, $n)
      return [pscustomobject]@{ width = [int]$thumb.Width; height = [int]$thumb.Height; stride = $stride; bytes = $bytes }
    } finally {
      $thumb.UnlockBits($data)
    }
  } finally {
    if ($null -ne $thumb) { try { $thumb.Dispose() } catch { } }
  }
}

function Get-FrameChange($bmp, $a) {
  # Answers "did the screen change since the previous capture of this target?".
  # Every capture refreshes the cache (even without `compare`), so the screenshot
  # the model looked at is exactly the reference the next action is judged by.
  $want = Test-DecFlag $a 'compare'
  $key = 'all'
  $hw = Get-DecValue $a 'hwnd'
  $sc = Get-DecValue $a 'screen'
  if ($null -ne $hw) { $key = 'w' + $hw } elseif ($null -ne $sc) { $key = 's' + $sc }
  $sig = $null
  try {
    $sig = Get-FrameSignature $bmp $script:FrameSampleWidth
    $prev = $null
    if ($script:FrameCache.ContainsKey($key)) { $prev = $script:FrameCache[$key] }
    $sample = ('' + $sig.width + 'x' + $sig.height)
    if (-not $want) { return $null }
    if ($null -eq $prev -or $prev.width -ne $sig.width -or $prev.height -ne $sig.height) {
      # First look at this target (or the window was resized): nothing to diff.
      return [ordered]@{ comparable = $false; changed = $null; ratio = $null; bounds = $null; sample = $sample }
    }
    $cmp = [DshFrameDiff.Diff]::Compare($prev.bytes, $sig.bytes, $sig.width, $sig.height, $sig.stride)
    $ratio = [math]::Round([double]$cmp[0], 5)
    $bounds = $null
    if ($cmp[4] -ge 0) {
      $sx = [double]$bmp.Width / [double]$sig.width
      $sy = [double]$bmp.Height / [double]$sig.height
      $bx = [int][math]::Floor($cmp[1] * $sx)
      $by = [int][math]::Floor($cmp[2] * $sy)
      $bw = [int][math]::Ceiling(($cmp[3] - $cmp[1] + 1) * $sx)
      $bh = [int][math]::Ceiling(($cmp[4] - $cmp[2] + 1) * $sy)
      $bounds = [ordered]@{
        x = $bx
        y = $by
        width = [math]::Max(1, $bw)
        height = [math]::Max(1, $bh)
      }
    }
    return [ordered]@{
      comparable = $true
      changed = ($ratio -gt 0.0005)
      ratio = $ratio
      bounds = $bounds
      sample = $sample
    }
  } finally {
    if ($null -ne $sig) { $script:FrameCache[$key] = $sig }
  }
}
