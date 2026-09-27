# Doc ket qua sidecar va kiem tra KY TU TIENG TRUNG ma khong in ra console
# (console Windows dung cp1252 nen in chu Trung ra thanh '?' — phai so sanh
# trong bo roi moi danh).
$ErrorActionPreference = 'Continue'
$outFile = $args[0]
$expect  = $args[1]   # 'simp' | 'trad' | 'any'

$t = [IO.File]::ReadAllText($outFile, [Text.Encoding]::UTF8)
$text = ''
foreach ($line in ($t -split "`n")) {
  if ($line -match '"event":\s*"segment"') {
    try { $text += (($line | ConvertFrom-Json).text) } catch {}
  }
}
Write-Host ("so ky tu: {0}" -f $text.Length)

# Mã Unicode của các ký tự cần kiểm tra (dùng [char] để không phụ thuộc encoding)
$JIN  = [char]0x4ECA   # 今
$TIAN = [char]0x5929   # 天
$QI   = [char]0x6C14   # 气  (giản thể)
$QI_T = [char]0x6C23   # 氣  (phồn thể)

$hasJinTianQi   = $text.Contains($JIN + $TIAN + $TIAN + $QI)     # 今天天气 giản thể
$hasJinTianQiT  = $text.Contains($JIN + $TIAN + $TIAN + $QI_T)   # 今天天氣 phồn thể

Write-Host ("co '今天天气' (gia the): {0}" -f $hasJinTianQi)
Write-Host ("co '今天天氣' (phon the): {0}" -f $hasJinTianQiT)

switch ($expect) {
  'simp' { if ($hasJinTianQi) { Write-Host 'PASS' -ForegroundColor Green }
           else { Write-Host 'FAIL' -ForegroundColor Red } }
  'trad' { if ($hasJinTianQiT) { Write-Host 'PASS' -ForegroundColor Green }
           else { Write-Host 'FAIL' -ForegroundColor Red } }
  default { if ($hasJinTianQi -or $hasJinTianQiT) { Write-Host 'PASS' -ForegroundColor Green }
            else { Write-Host 'FAIL' -ForegroundColor Red } }
}
