# Build ban Windows (.exe).
# Chay:  powershell -ExecutionPolicy Bypass -File scripts\build-windows.ps1
#
# Toan bo quy trinh, tu cho den file .exe:
#   1. chep ma nguon vao C:\build (khong build tren thu muc chia se \Mac\Home
#      — qua mang chia se se rat cham va node_modules hay loi)
#   2. npm install
#   3. tai ffmpeg + yt-dlp
#   4. build sidecar Python bang PyInstaller voi wheel win_amd64
#   5. electron-builder --win --x64
#
# BUOC 4 LA MAY CHOT. Sidecar phai build tren Windows vi CTranslate2 / onnxruntime
# / PyAV chi co wheel cho dung nen tang, va PyInstaller khong cross-compile duoc.

$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

$src = '\\Mac\Home\Documents\Default Project\lay-transcript'
if (-not (Test-Path $src)) { $src = $PSScriptRoot | Split-Path -Parent }
$work = 'C:\build\lay-transcript'

$envFile = 'C:\tools\env.txt'
if (-not (Test-Path $envFile)) { Write-Host "LOI: chua chay setup-windows.ps1 truoc" -ForegroundColor Red; exit 1 }
$envMap = @{}
Get-Content $envFile | ForEach-Object {
  if ($_ -match '^([^=]+)=(.*)$') { $envMap[$Matches[1]] = $Matches[2] }
}
$node = $envMap['NODE']; $python = $envMap['PYTHON']; $uv = $envMap['UV']

function Say($m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Ok($m)  { Write-Host "   OK $m" -ForegroundColor Green }
function Die($m)  { Write-Host "LOI: $m" -ForegroundColor Red; exit 1 }

# ---------------------------------------------------------------- 1. chep ma nguon
Say "Chep ma nguon vao $work"
New-Item -ItemType Directory -Force -Path $work | Out-Null
$copy = @('src', 'sidecar', 'scripts', 'build', 'resources', 'package.json', 'electron-builder.yml')
foreach ($item in $copy) {
  $from = Join-Path $src $item
  if (-not (Test-Path $from)) { continue }
  $to = Join-Path $work $item
  if (Test-Path $to) { Remove-Item -Recurse -Force $to }
  Copy-Item -Recurse -Force $from $to
}
# Khong chep ban build cua macOS (khong dung duoc tren Windows)
foreach ($junk in @('resources\bin\yt-dlp_macos', 'resources\bin\ffmpeg', 'resources\bin\ffprobe', 'resources\sidecar')) {
  $j = Join-Path $work $junk
  if (Test-Path $j) { Remove-Item -Recurse -Force $j }
}
Ok "ma nguon da chep"

# Node phai nam tren PATH TRUOC khi chay npm: nhieu goi (electron-winstaller)
# co script postinstall goi `node ...` bang ten loi, khong dung duong dan day du.
$nodeDir = Split-Path -Parent $node
$env:PATH = "$nodeDir;$env:PATH"

Set-Location $work

# ---------------------------------------------------------------- 2. npm install
# Xoa ban build cu: electron-builder co cache va da tung dung lai app.asar cu
# sau khi ma nguon da doi -> app chay LAI MA CU.
$stale = @("$work\release", "$work\node_modules\.cache", "$work\dist")
foreach ($s in $stale) { if (Test-Path $s) { Remove-Item -Recurse -Force $s -ErrorAction SilentlyContinue } }

Say "npm install (Electron + electron-builder)"
# dung npm.cmd di kem Node thay vi 'npm' tren PATH: phien can chay tu dong
# (prlctl exec / lenh len) khong co PATH cua user, nen se khong tim thay npm.
$nodeDir = Split-Path -Parent $node
$npm = Join-Path $nodeDir 'npm.cmd'
if (-not (Test-Path $npm)) { Die "khong tim thay npm.cmd canh $nodeDir" }
& node -v
& $npm install --no-audit --no-fund 2>&1 | Select-Object -Last 4 | Out-String | Write-Host
if (-not (Test-Path "$work\node_modules\electron")) { Die 'npm install that bai' }
Ok "node_modules OK"

# ---------------------------------------------------------------- 3. phu thuoc ngoai
Say "Tai ffmpeg + yt-dlp"
& powershell -NoProfile -ExecutionPolicy Bypass -File "$work\scripts\fetch-deps.ps1" 2>&1 |
  Select-Object -Last 8 | Out-String | Write-Host
if (-not (Test-Path "$work\resources\bin\ffmpeg.exe")) { Die 'thieu ffmpeg.exe' }
Ok "resources/bin OK"

# ---------------------------------------------------------------- 4. sidecar Python
Say "Build sidecar Python (PyInstaller, wheel win_amd64) — buoc quan trong nhat"
Say "  Python: $python"
& $python "$work\scripts\build-sidecar.py" 2>&1 |
  Where-Object { $_ -notmatch '^\s*\d+ INFO: (checking|building|analyzing|looking|hook|adding|searching|Processing|Copying)' } |
  Select-Object -Last 14 | Out-String | Write-Host

if (-not (Test-Path "$work\resources\sidecar\sidecar.exe")) {
  Die 'build sidecar that bai (khong co sidecar.exe)'
}
$sidecarMB = [math]::Round((Get-ChildItem "$work\resources\sidecar" -Recurse -File |
  Measure-Object Length -Sum).Sum / 1MB, 0)
Ok "sidecar.exe OK ($sidecarMB MB)"

# ---------------------------------------------------------------- 5. electron-builder
Say "electron-builder --win --x64"
$env:CSC_IDENTITY_AUTO_DISCOVERY = 'false'
$npx = Join-Path $nodeDir 'npx.cmd'

# electron-builder tai Electron/NSIS ve may. Mang tre tu lam build that bai
# (read ECONNRESET / ETIMEDOUT) - loi tam thoi, thu lai la du.
$built = $false
for ($attempt = 1; $attempt -le 3 -and -not $built; $attempt++) {
  Say "electron-builder --win --x64 (lan $attempt/3)"
  $out = & $npx electron-builder --win --x64 --publish never 2>&1
  $out | Select-Object -Last 10 | Out-String | Write-Host
  $built = (Test-Path "$work\release\Lay-Transcript-*.exe") -or
           ((Get-ChildItem "$work\release" -Filter '*.exe' -ErrorAction SilentlyContinue).Count -gt 0)
  if (-not $built -and $attempt -lt 3) { Start-Sleep -Seconds 12 }
}
if (-not $built) { Die 'electron-builder that bai ca 3 lan' }

# ---------------------------------------------------------------- 6. ket qua
Say "Ket qua"
$exes = Get-ChildItem "$work\release" -Filter '*.exe' -ErrorAction SilentlyContinue
if (-not $exes) { Die 'khong tim thay file .exe trong release' }
foreach ($e in $exes) {
  Ok ("{0}  ({1} MB)" -f $e.Name, [math]::Round($e.Length / 1MB, 1))
}
Write-Host ""
Write-Host "FILE .EXE:" -ForegroundColor Yellow
$exes | ForEach-Object { Write-Host "  $($_.FullName)" }
exit 0
