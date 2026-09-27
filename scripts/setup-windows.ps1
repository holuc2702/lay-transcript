# Chuẩn bị môi trường build Windows.
# Chạy trong Windows:  powershell -ExecutionPolicy Bypass -File setup-windows.ps1
#
# Cài Node x64 + Python 3.12 x64 vào C:\tools.
#
# VÌ SAO BẢN x64 MÀ KHÔNG PHẢI ARM:
#   faster-whper -> CTranslate2 KHÔNG có bản win_arm64 (chỉ có win_amd64).
#   Nên sidecar buộc phải là x64. May ao này la Windows ARM nên se chay sidecar
#   x64 qua che do tuong thich (emulation) cua Windows 11 ARM — dung de KIEM
#   TRA ban .exe x64, dung chinh xac nhu may that cua nguoi dung.

$ErrorActionPreference = 'Continue'   # khong duoc dung 'Stop': canh bao tren stderr cua lenh native se lam script dung giua chung
$ProgressPreference = 'SilentlyContinue'

$TOOLS = 'C:\tools'
New-Item -ItemType Directory -Force -Path $TOOLS | Out-Null

function Say($m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Ok($m)  { Write-Host "   OK $m" -ForegroundColor Green }
function Die($m)  { Write-Host "LOI: $m" -ForegroundColor Red; exit 1 }

# ---------------------------------------------------------------- Node x64
Say "Tim phien ban Node 22 LTS (x64)"
$releases = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json' -UseBasicParsing
$nodeVer = ($releases | Where-Object { $_.version -like 'v22.*' } | Select-Object -First 1).version
if (-not $nodeVer) { Die 'khong tim thay Node 22' }
Ok "Node $nodeVer"

$nodeZip = "$env:TEMP\node-x64.zip"
$nodeUrl = "https://nodejs.org/dist/$nodeVer/node-$nodeVer-win-x64.zip"
Say "Tai Node $nodeVer"
Invoke-WebRequest -Uri $nodeUrl -OutFile $nodeZip -UseBasicParsing
if (Test-Path "$TOOLS\node") { Remove-Item -Recurse -Force "$TOOLS\node" }
Expand-Archive -Path $nodeZip -DestinationPath "$TOOLS\node-tmp" -Force
Move-Item "$TOOLS\node-tmp\node-$nodeVer-win-x64" "$TOOLS\node"
Remove-Item -Recurse -Force "$TOOLS\node-tmp", $nodeZip -ErrorAction SilentlyContinue
$env:PATH = "$TOOLS\node;$env:PATH"
Ok ("node: " + (& "$TOOLS\node\node.exe" -v))

# ------------------------------------------------------------ Python 3.12 x64
#
# VÌ SAO DÙNG `uv` THAY VÌ BỘ CÀI PYTHON:
#   Bộ cài python-*-amd64.exe chạy lỗi (exit 3) khi thử trên Windows ARM.
#   `uv` là một file .exe duy nhất, tu tai mot ban CPython "dung ban" (relocatable,
#   tu astral-sh/python-build-standalone) — khong can cai dat, khong can
#   dang ky, khong can quyen Admin, va chay duoc qua emulation tren ARM.
#   Ban Python cua uv la ban portable that, dung kieu app Electron can.
Say "Cai uv (trinh quan ly Python)"
$uvVer = '0.12.19'
$uvZip = "$env:TEMP\uv.zip"
$uvUrl = "https://github.com/astral-sh/uv/releases/download/$uvVer/uv-x86_64-pc-windows-msvc.zip"
Invoke-WebRequest -Uri $uvUrl -OutFile $uvZip -UseBasicParsing
if (Test-Path "$TOOLS\uv") { Remove-Item -Recurse -Force "$TOOLS\uv" }
Expand-Archive -Path $uvZip -DestinationPath "$TOOLS\uv" -Force
Remove-Item $uvZip -ErrorAction SilentlyContinue
$uvExe = "$TOOLS\uv\uv.exe"
if (-not (Test-Path $uvExe)) {
  $uvExe = (Get-ChildItem "$TOOLS\uv" -Filter uv.exe -Recurse | Select-Object -First 1).FullName
}
if (-not $uvExe) { Die 'khong tim thay uv.exe sau khi giai nen' }
& $uvExe --version
Ok "uv: $uvExe"

Say "Tai CPython 3.12 x64 (ban portable)"
# Chi dinh ro thu muc cai: mac dinh uv cài vao thu muc profile cua nguoi dang
# chay (khi build tu dong lai se roi vao systemprofile — khu vuc khong nen).
$env:UV_PYTHON_INSTALL_DIR = "$TOOLS\python"
& $uvExe python install 3.12
if ($LASTEXITCODE -ne 0) { Die "uv python install that bai (exit $LASTEXITCODE)" }
# `uv python find` tra ve DUONG DAN day du cua python.exe, khong phai thu muc.
$pyExePath = (& $uvExe python find 3.12 | Select-Object -First 1)
$pyDir = Split-Path -Parent $pyExePath
if (-not (Test-Path $pyExePath)) { Die "khong tim thay python.exe tai $pyExePath" }
& $pyExePath -V
Ok "python: $pyExePath"

# Ghi ra file de cac buoc sau dung dung duong dan
Set-Content -Path "$TOOLS\env.txt" -Value @(
  "UV=$uvExe",
  "PYTHON=$pyExePath",
  "PYDIR=$pyDir",
  "NODE=$TOOLS\node\node.exe"
  "NODEDIR=$TOOLS\node"
)
Ok "ghi C:\tools\env.txt"

# ------------------------------------------------------------------ PATH
$userPath = [Environment]::GetEnvironmentVariable('PATH', 'User')
foreach ($p in @("$TOOLS\node", "$TOOLS\uv", $pyDir, (Join-Path $pyDir 'Scripts'))) {
  if ($userPath -notlike "*$p*") {
    [Environment]::SetEnvironmentVariable('PATH', "$userPath;$p", 'User')
  }
}
Ok "Da them Node + Python vao PATH cua user"

Say "Xong chuan bi moi truong"
& "$TOOLS\node\node.exe" -v
& $pyExePath -V
Write-Host "PYTHON=$pyExePath" -ForegroundColor Yellow
