# Cài thật bằng bộ cài NSIS rồi chạy bản đã cài — KHÔNG phải bản win-unpacked.
# Đây là bước kiểm chứng mà trước đó chưa làm: NSIS tạo shortcut, ghi
# registry, chép vào Program Files, và bản cài KHÔNG nằm trong thư mục dự án
# nên rất dễ phụ thuộc vào đường dẫn tương đối sai.
$ErrorActionPreference = 'Continue'
$work = 'C:\build\lay-transcript'
$exe = Join-Path $work 'release\Lay-Transcript-1.0.0-x64.exe'
$dest = 'C:\Program Files\Lấy Transcript'

if (-not (Test-Path $exe)) { Write-Host "LOI: khong thay file cai dat" -ForegroundColor Red; exit 1 }

Write-Host "==> Goi bo cai dat (chay im)" -ForegroundColor Cyan
# /S = silent, /D = thu muc dich (phai LA CUOI, khong trich dayau)
$p = Start-Process -FilePath $exe -ArgumentList @('/S', "/D=$dest") -Wait -PassThru
Write-Host "   ma thoat: $($p.ExitCode)"

Start-Sleep -Seconds 6
Write-Host "`n==> Kiem tra ket qua cai dat" -ForegroundColor Cyan
if (-not (Test-Path $dest)) { Write-Host "   LOI: thu muc dich khong ton tai" -ForegroundColor Red; exit 1 }
Get-ChildItem $dest | Select-Object Mode, Length, Name | Format-Table -Auto | Out-String | Write-Host

$appExe = Join-Path $dest 'Lấy Transcript.exe'
Write-Host "file chinh: $(Test-Path $appExe)"
if (-not (Test-Path $appExe)) {
  $found = Get-ChildItem $dest -Filter '*.exe' -Recurse -ErrorAction SilentlyContinue |
           Where-Object { $_.Name -notlike '*uninstall*' } | Select-Object -First 1
  if ($found) { $appExe = $found.FullName; Write-Host "   tim thay: $appExe" }
}
Write-Host "`n==> Kiem tra tai nguyen ben trong ban cai" -ForegroundColor Cyan
foreach ($p2 in @('resources\bin\yt-dlp.exe', 'resources\bin\ffmpeg.exe', 'resources\sidecar\sidecar.exe')) {
  $full = Join-Path $dest $p2
  $ok = Test-Path $full
  $sz = if ($ok) { [math]::Round((Get-Item $full).Length / 1MB, 1) } else { 0 }
  Write-Host ("   {0,-42} {1} {2} MB" -f $p2, $(if ($ok) { 'OK  ' } else { 'THIEU' }), $sz)
}
Write-Host "`nHOAN TAT KIEM TRA CAI DAT"
Write-Host "APPEXE=$appExe"
