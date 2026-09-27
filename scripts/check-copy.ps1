$ErrorActionPreference = 'Continue'
$p = 'C:\build\lay-transcript\src\main\paths.js'
Write-Host "ton tai: $(Test-Path $p)" -ForegroundColor Cyan
if (Test-Path $p) {
  $t = [IO.File]::ReadAllText($p)
  Write-Host "co ham defaultOutputDir : $($t.Contains('function defaultOutputDir'))"
  Write-Host "co vong lap du phong   : $($t.Contains("'videos', 'downloads'"))"
  Write-Host "co getPath('videos') thang: $($t.Contains("app.getPath('videos')"))"
  Write-Host "--- nghiaa doan defaultOutputDir ---"
  $m = [regex]::Match($t, 'function defaultOutputDir[\s\S]{0,700}')
  Write-Host $m.Value
}
Write-Host "`n--- app co dang chay khong ---"
Get-Process | Where-Object { $_.ProcessName -like '*Transcript*' } | Select-Object Id, ProcessName | Format-Table -Auto | Out-String | Write-Host
