# Kiem tra trang thai sau khi app chay that bai (dung de chan doan).
$ErrorActionPreference = 'Continue'
$d = Join-Path $env:APPDATA 'Lấy Transcript'

Write-Host "userData: $d" -ForegroundColor Cyan
if (-not (Test-Path $d)) { Write-Host "KHONG TON TAI thu muc app" -ForegroundColor Red; exit 1 }

Write-Host "`n--- noi dung thu muc app ---"
Get-ChildItem $d | Select-Object Mode, Length, Name | Format-Table -Auto | Out-String | Write-Host

Write-Host "--- tools (ffmpeg, ffprobe, yt-dlp) ---"
$tools = Join-Path $d 'tools'
if (Test-Path $tools) {
  Get-ChildItem $tools | Select-Object Length, Name | Format-Table -Auto | Out-String | Write-Host
} else { Write-Host "  (chua co)" -ForegroundColor Red }

Write-Host "--- work (audio tam) ---"
$work = Join-Path $d 'work'
if (Test-Path $work) {
  Get-ChildItem $work -Recurse -File | Select-Object Length, FullName | Format-Table -Auto | Out-String | Write-Host
} else { Write-Host "  (khong con)" }

Write-Host "--- models ---"
$models = Join-Path $d 'models'
if (Test-Path $models) {
  Get-ChildItem $models | Select-Object Name | Format-Table -Auto | Out-String | Write-Host
} else { Write-Host "  (chua co)" }

Write-Host "--- Videos\Lay Transcript (ket qua) ---"
$vids = Join-Path ([Environment]::GetFolderPath('MyVideos')) 'Lấy Transcript'
if (Test-Path $vids) { Get-ChildItem $vids | Select-Object Length, Name | Format-Table -Auto | Out-String | Write-Host }
else { Write-Host "  (khong co)" -ForegroundColor Yellow }
