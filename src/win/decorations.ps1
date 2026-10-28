# Screenshot decorations (grid / mark / dim) and frame-change detection.
# Dot-sourced by win-host.ps1 so the main host file stays readable.
function Test-DecFlag($a, [string]$name) {
  $v = Get-DecValue $a $name
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
          if ($x -lt $minX) { $minX = $x }
          if ($y -lt $minY) { $minY = $y }
          if ($x -gt $maxX) { $maxX = $x }
          if ($y -gt $maxY) { $maxY = $y }
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
