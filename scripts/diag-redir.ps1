$ErrorActionPreference = 'Continue'
$tmp = $env:TEMP
$sidecar = 'C:\build\lay-transcript\resources\sidecar\sidecar.exe'
$inF = Join-Path $tmp 'd-in.jsonl'
$outF = Join-Path $tmp 'd-out.txt'
$errF = Join-Path $tmp 'd-err.txt'
$bat = Join-Path $tmp 'd-run.cmd'

[IO.File]::WriteAllText($inF, "{`"cmd`":`"ping`",`"jobId`":`"p`"}`r`n", [Text.Encoding]::ASCII)
$batBody = "@echo off`r`n`"$sidecar`" < `"$inF`" > `"$outF`" 2> `"$errF`"`r`n"
[IO.File]::WriteAllText($bat, $batBody, [Text.Encoding]::ASCII)

Write-Host "--- noi dung .cmd ---" -ForegroundColor Cyan
Write-Host $batBody
Write-Host "--- chay ---"
cmd.exe /c $bat
Start-Sleep -Seconds 3

Write-Host "--- out ton tai: $(Test-Path $outF) ---" -ForegroundColor Cyan
if (Test-Path $outF) {
  $b = [IO.File]::ReadAllBytes($outF)
  Write-Host "kich thuoc: $($b.Length) byte"
  Write-Host "noi dung:"
  Write-Host ([Text.Encoding]::UTF8.GetString($b))
}
Write-Host "--- err ---" -ForegroundColor Cyan
if (Test-Path $errF) { Get-Content $errF | Select-Object -Last 8 | ForEach-Object { Write-Host "  $_" } }
