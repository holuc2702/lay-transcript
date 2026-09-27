# Kiem tra ffmpeg co ghi duoc file vao duong dan co dau tieng Viet khong.
$ErrorActionPreference = 'Continue'
$appDir = Join-Path $env:APPDATA 'Lấy Transcript'
$tools  = Join-Path $appDir 'tools'
$ffmpeg = Join-Path $tools 'ffmpeg.exe'

Write-Host "ffmpeg: $ffmpeg" -ForegroundColor Cyan
if (-not (Test-Path $ffmpeg)) { Write-Host "KHONG CO ffmpeg" -ForegroundColor Red; exit 1 }

# --- 1. Tao file audio nguon don gian (bo voi ffmpeg) ---
$src = Join-Path $appDir 'probe-src.wav'
$byteCount = 32000 * 2          # ~1 giay mono 16kHz 16-bit
$bytes = New-Object byte[] $byteCount
for ($i = 0; $i -lt $byteCount; $i += 2) {
  $v = [int](8000 * [math]::Sin($i / 12))
  $bytes[$i]     = $v -band 0xFF
  $bytes[$i + 1] = ($v -shr 8) -band 0xFF
}
[IO.File]::WriteAllBytes($src, $bytes)
Write-Host "tao nguon: $src ($($bytes.Length) bytes)"

# --- 2. Chay dung lenh ma app dung ---
$work  = Join-Path $appDir ('work\probe-' + [guid]::NewGuid().ToString('N').Substring(0,8))
$null  = New-Item -ItemType Directory -Force -Path $work
$out   = Join-Path $work 'audio16k.wav'

Write-Host "`nchay: ffmpeg -i src -vn -ac 1 -ar 16000 -acodec pcm_s16le out" -ForegroundColor Cyan
$args = @('-hide_banner','-nostdin','-y','-i',$src,'-vn','-ac','1','-ar','16000',
          '-acodec','pcm_s16le',$out)
$p = Start-Process -FilePath $ffmpeg -ArgumentList $args -NoNewWindow -Wait -PassThru `
       -RedirectStandardError (Join-Path $work 'ff.err') -RedirectStandardOutput (Join-Path $work 'ff.out')
Write-Host "exit code: $($p.ExitCode)"

Write-Host "`n--- stderr cua ffmpeg ---"
Get-Content (Join-Path $work 'ff.err') -ErrorAction SilentlyContinue | Select-Object -Last 12 |
  ForEach-Object { Write-Host "  $_" }

Write-Host "`n--- file trong thu muc ---"
Get-ChildItem $work | Select-Object Length, Name | Format-Table -Auto | Out-String | Write-Host

Write-Host "Ton tai '$out' : $(Test-Path $out)"
if (Test-Path $out) { Write-Host "Kich thuoc: $((Get-Item $out).Length)" }
