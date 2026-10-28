# Windows OCR host (Windows.Media.Ocr via WinRT).
#
# This is a deliberately SEPARATE, resident process started with the in-box
# PowerShell 5.1 (`-STA`), because WinRT projection only works reliably there:
# in PowerShell 7 the same calls need csc.exe + winmd compilation, which is a
# build dependency this plugin refuses to take. The Node side keeps one of these
# alive and feeds it PNG paths, so every recognition costs decode + recognize
# only (measured ~120ms for a 1400x900 frame on the author's machine).
#
# Protocol: NDJSON on stdin/stdout, one response per request id.
#   {"id":"1","cmd":"ocr","args":{"png":"C:\\...\\x.png","lang":"auto","maxLines":200}}
#   -> {"id":"1","ok":true,"result":{"engine":"Windows.Media.Ocr","lang":"zh-Hans-CN","text":"..","lines":[{"text":"..","bounds":{x,y,width,height},"words":n}],"elapsedMs":123}}
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding $false
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
$OutputEncoding = [Console]::OutputEncoding

try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  [void][Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
  [void][Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
  [void][Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
  [void][Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]
} catch {
  [Console]::Out.WriteLine((@{ event = 'ready'; result = @{ ok = $false; reason = ('WINRT_LOAD_FAILED: ' + $_.Exception.Message) } } | ConvertTo-Json -Compress -Depth 5))
  exit 0
}

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]

function Await($op, $type) {
  $asTask = $asTaskGeneric.MakeGenericMethod($type)
  $task = $asTask.Invoke($null, @($op))
  $task.Wait(-1) | Out-Null
  $task.Result
}

$script:engines = @{}
function Get-OcrEngine([string]$lang) {
  if ([string]::IsNullOrWhiteSpace($lang) -or $lang -eq 'auto') {
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
    if ($null -eq $engine) { throw 'OCR_NO_ENGINE: no OCR language pack is installed for the current user' }
    return $engine
  }
  if ($script:engines.ContainsKey($lang)) { return $script:engines[$lang] }
  $wanted = [Windows.Globalization.Language]::new($lang)
  $available = @([Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages | Where-Object { $_.LanguageTag -like ($lang + '*') -or $_.LanguageTag -like ($lang.Split('-')[0] + '*') })
  if ($available.Count -eq 0) {
    $tags = (@([Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages | ForEach-Object { $_.LanguageTag }) -join ', ')
    throw ('OCR_LANG_UNAVAILABLE: ' + $lang + ' is not installed; available: ' + $tags)
  }
  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($available[0])
  if ($null -eq $engine) { throw ('OCR_LANG_UNAVAILABLE: could not create an engine for ' + $lang) }
  $script:engines[$lang] = $engine
  return $engine
}

function Invoke-Ocr([string]$png, [string]$lang, [int]$maxLines) {
  $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($png)) ([Windows.Storage.StorageFile])
  $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  try {
    $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $engine = Get-OcrEngine $lang
    $watch = [System.Diagnostics.Stopwatch]::StartNew()
    $recognized = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
    $watch.Stop()
    $lines = New-Object System.Collections.ArrayList
    foreach ($line in @($recognized.Lines)) {
      if ($lines.Count -ge $maxLines) { break }
      $words = @($line.Words)
      if ($words.Count -eq 0) { continue }
      $minX = [double]::MaxValue; $minY = [double]::MaxValue; $maxX = 0.0; $maxY = 0.0
      foreach ($word in $words) {
        $rect = $word.BoundingRect
        if ($rect.X -lt $minX) { $minX = $rect.X }
        if ($rect.Y -lt $minY) { $minY = $rect.Y }
        if (($rect.X + $rect.Width) -gt $maxX) { $maxX = $rect.X + $rect.Width }
        if (($rect.Y + $rect.Height) -gt $maxY) { $maxY = $rect.Y + $rect.Height }
      }
      [void]$lines.Add([pscustomobject]@{
        text = $line.Text
        words = $words.Count
        bounds = [pscustomobject]@{
          x = [int][Math]::Round($minX); y = [int][Math]::Round($minY)
          width = [int][Math]::Round($maxX - $minX); height = [int][Math]::Round($maxY - $minY)
        }
      })
    }
    $text = (@($lines | ForEach-Object { $_.text }) -join "`n")
    return [pscustomobject]@{
      engine = 'Windows.Media.Ocr'
      lang = $engine.RecognizerLanguage.LanguageTag
      text = $text
      lines = @($lines)
      elapsedMs = [int]$watch.ElapsedMilliseconds
    }
  } finally {
    $stream.Dispose()
  }
}

$profileEngine = $null
try { $profileEngine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() } catch { }
$langs = @()
try { $langs = @([Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages | ForEach-Object { $_.LanguageTag }) } catch { }
[Console]::Out.WriteLine((@{
  event = 'ready'
  result = @{
    ok = ($null -ne $profileEngine)
    engine = 'Windows.Media.Ocr'
    lang = $(if ($null -ne $profileEngine) { $profileEngine.RecognizerLanguage.LanguageTag } else { $null })
    languages = $langs
    maxDimension = $(if ($null -ne $profileEngine) { [Windows.Media.Ocr.OcrEngine]::MaxImageDimension } else { 0 })
    pid = $PID
  }
} | ConvertTo-Json -Compress -Depth 5))

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ([string]::IsNullOrWhiteSpace($line)) { continue }
  $id = $null
  try {
    $request = $line | ConvertFrom-Json
    $id = $request.id
    switch ($request.cmd) {
      'ocr' {
        $png = [string]$request.args.png
        $lang = if ($request.args.lang) { [string]$request.args.lang } else { 'auto' }
        $maxLines = if ($request.args.maxLines) { [int]$request.args.maxLines } else { 200 }
        if (-not (Test-Path -LiteralPath $png)) { throw ('OCR_NO_INPUT: ' + $png + ' does not exist') }
        $result = Invoke-Ocr $png $lang $maxLines
        [Console]::Out.WriteLine((@{ id = $id; ok = $true; result = $result } | ConvertTo-Json -Compress -Depth 8))
      }
      'shutdown' {
        [Console]::Out.WriteLine((@{ id = $id; ok = $true; result = @{ ok = $true } } | ConvertTo-Json -Compress -Depth 3))
        break
      }
      default { throw ('UNKNOWN_COMMAND: ' + $request.cmd) }
    }
    if ($request.cmd -eq 'shutdown') { break }
  } catch {
    $message = $_.Exception.Message
    $code = 'OCR_FAILED'
    if ($message -match '^([A-Z][A-Z_]+):') { $code = $Matches[1]; $message = $message.Substring($Matches[0].Length).Trim() }
    [Console]::Out.WriteLine((@{ id = $id; ok = $false; error = @{ code = $code; message = $message } } | ConvertTo-Json -Compress -Depth 5))
  }
}
