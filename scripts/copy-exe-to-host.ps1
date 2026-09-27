# Copy file .exe tu may ao Windows ve may that macOS.
# Dung \\Mac\Home (thu muc chia se cua Parallels) lam trung gian.
$ErrorActionPreference = 'Continue'
$src = 'C:\build\lay-transcript\release'
$dst = '\\Mac\Home\Documents\Default Project\lay-transcript\release'

Write-Host "==> Copy tu $src" -ForegroundColor Cyan
New-Item -ItemType Directory -Force -Path $dst | Out-Null

$files = Get-ChildItem $src -File | Where-Object { $_.Extension -in '.exe', '.blockmap', '.yml', '.yaml' }
if (-not $files) { Write-Host "   khong co file .exe nao" -ForegroundColor Red; exit 1 }

foreach ($f in $files) {
  $out = Join-Path $dst $f.Name
  $t0 = Get-Date
  Write-Host ("   dang chep {0} ({1} MB)..." -f $f.Name, [math]::Round($f.Length/1MB,1)) -NoNewline
  Copy-Item -Force $f.FullName $out
  $sec = [math]::Round(((Get-Date) - $t0).TotalSeconds, 1)
  $ok = (Test-Path $out) -and ((Get-Item $out).Length -eq $f.Length)
  if ($ok) { Write-Host (" xong ({0}s)" -f $sec) -ForegroundColor Green }
  else { Write-Host " THAT BAI" -ForegroundColor Red }
}

Write-Host "`n==> Ket qua tren may that:" -ForegroundColor Cyan
Get-ChildItem $dst -File | ForEach-Object {
  Write-Host ("   {0,-46} {1,8} MB" -f $_.Name, [math]::Round($_.Length/1MB,1))
}
