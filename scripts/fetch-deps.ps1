# Tai phu thuoc ngoai cho Windows: ffmpeg, ffprobe, yt-dlp.
# Chay:  powershell -ExecutionPolicy Bypass -File scripts\fetch-deps.ps1
#
# Tuong duong scripts/fetch-deps.sh, nhung cho Windows.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$root = Split-Path -Parent $PSScriptRoot
$bin = Join-Path $root 'resources\bin'
New-Item -ItemType Directory -Force -Path $bin | Out-Null

$YTDLP_VERSION = '2026.08.19'

function Say($m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Warn($m) { Write-Host "!!  $m" -ForegroundColor Yellow }
function Die($m)  { Write-Host "LOI: $m" -ForegroundColor Red; exit 1 }

# ------------------------------------------------------------------ yt-dlp
Say "Tai yt-dlp $YTDLP_VERSION"
$ytdlp = Join-Path $bin 'yt-dlp.exe'
if (Test-Path $ytdlp) {
  Say "yt-dlp da co san — bo qua"
} else {
  $url = "https://github.com/yt-dlp/yt-dlp/releases/download/$YTDLP_VERSION/yt-dlp.exe"
  $tmp = "$ytdlp.$([guid]::NewGuid().ToString('N').Substring(0,8)).part"
  Invoke-WebRequest -Uri $url -OutFile $tmp -UseBasicParsing
  Move-Item -Force $tmp $ytdlp
  Write-Host "   OK yt-dlp.exe"
}

# ------------------------------------------------- ffmpeg + ffprobe (win x64)
$ff = Join-Path $bin 'ffmpeg.exe'
$fp = Join-Path $bin 'ffprobe.exe'
if ((Test-Path $ff) -and (Test-Path $fp)) {
  Say "ffmpeg da co san — bo qua"
} else {
  Say "Tai ffmpeg/ffprobe cho Windows x64 (gyan.dev)"
  # Tên file tạm phải DUY NHẤT theo lần chạy. Dùng tên cố định thì lần chạy
  # bị hủy giữa chừng để lại file đang bị Windows Defender hoặc một tiến trình
  # khác giữ khóa, và lần sau ghi đè sẽ báo "cannot access the file because it is
  # being used by another process".
  $tag = [guid]::NewGuid().ToString('N').Substring(0, 8)
  $zip = Join-Path $env:TEMP "ffmpeg-$tag.zip"
  $url = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip'
  $got = $false
  for ($i = 1; $i -le 3 -and -not $got; $i++) {
    try {
      Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
      $got = $true
    } catch {
      Write-Host "   tai that bai (lan $i/3): $($_.Exception.Message)" -ForegroundColor Yellow
      Remove-Item $zip -ErrorAction SilentlyContinue
      Start-Sleep -Seconds 5
    }
  }
  if (-not $got) { Die 'khong tai duoc ffmpeg.zip' }
  $ex = Join-Path $env:TEMP "ffmpeg-x-$tag"
  if (Test-Path $ex) { Remove-Item -Recurse -Force $ex }
  Expand-Archive -Path $zip -DestinationPath $ex -Force
  Remove-Item $zip -ErrorAction SilentlyContinue

  $f = Get-ChildItem $ex -Filter 'ffmpeg.exe' -Recurse | Select-Object -First 1
  $p = Get-ChildItem $ex -Filter 'ffprobe.exe' -Recurse | Select-Object -First 1
  if (-not $f) { Remove-Item -Recurse -Force $ex; Die 'khong tim thay ffmpeg.exe trong zip' }
  Copy-Item -Force $f.FullName $ff
  if ($p) { Copy-Item -Force $p.FullName $fp } else { Warn 'khong co ffprobe.exe' }
  Remove-Item -Recurse -Force $ex
  Write-Host "   OK ffmpeg.exe / ffprobe.exe"
}

# ------------------------------------------------------------------ kiem tra
Say "Kiem tra ket qua"
foreach ($n in @('yt-dlp.exe', 'ffmpeg.exe')) {
  $path = Join-Path $bin $n
  if (-not (Test-Path $path)) { Die "thieu $n" }
  $mb = [math]::Round((Get-Item $path).Length / 1MB, 1)
  Write-Host ("   {0,-14} {1,8} MB" -f $n, $mb)
}
$v = & $ytdlp --version
Write-Host "   yt-dlp version: $v"
$fv = (& $ff -version 2>&1 | Select-Object -First 1)
Write-Host "   $fv"
Write-Host "   Xong."
