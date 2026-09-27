# Kiem thu day du tren WINDOWS: gian the, phon the, chan model English-only,
# va tieng Anh (de chung khong lam hong gi).
#
# Hai bai hoc da ton mot dem xuyen suot viec nay, ghi lai de khong lap lai:
#  1. PowerShell 5.1 doc .ps1 theo ANSI -> file .ps1 co dau tieng Viet PHAI co
#     BOM, neu khong se loi cu phap.
#  2. `Set-Content -Encoding UTF8` them BOM vao file JSON dau tien -> sidecar
#     bo qua. Phai dung ASCII.
#  3. `cmd /c "... < a > b"` voi dau nhay long nhau khong hoat dong. Viet file
#     .cmd roi goi no.
#  4. stdin dong ngay khi lenh het -> tien trinh thoat, giu luong ghi am bi
#     giet. Da sua trong worker.py; nay la hanh vi kiem chung lai.
#  5. Console Windows dung cp1252 nen in chu Trung ra '?'. Phai so sanh trong
#     bo roi, khong in ra console (xem check-cjk.ps1).
$ErrorActionPreference = 'Continue'
$work = 'C:\build\lay-transcript'
$sidecar = Join-Path $work 'resources\sidecar\sidecar.exe'
$share = '\\Mac\Home\Documents\Default Project\lay-transcript'
$fixture = "$share\test\fixtures"
$models = Join-Path $env:APPDATA 'LayTranscript\models'
$tmp = $env:TEMP
New-Item -ItemType Directory -Force -Path $models | Out-Null

function Say($m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Ok($m)  { Write-Host "   OK $m" -ForegroundColor Green }
function Bad($m) { Write-Host "   FAIL $m" -ForegroundColor Red }
$fails = 0

# Chuyen file am thanh ve dia dia phong: duong dan qua \\Mac\... co dau, chay
# cham va mot so API khong cham. Dong thoi luu ten khong dau de so sanh duoc.
function Stage($name, $local) {
  Copy-Item -Force (Join-Path $fixture $name) (Join-Path $tmp $local)
  return (($tmp + '\' + $local) -replace '\\', '/')
}

# Chay 1 lenh ghi am, tra ve duong dan file ket qua
function RunTranscribe($tag, $audio, $optsJson) {
  $inF  = Join-Path $tmp "in-$tag.jsonl"
  $outF = Join-Path $tmp "out-$tag.jsonl"
  $errF = Join-Path $tmp "err-$tag.txt"
  $bat  = Join-Path $tmp "run-$tag.cmd"
  $cmd  = '{"cmd":"transcribe","jobId":"' + $tag + '","audio":"' + $audio +
          '","modelsDir":"' + (($models -replace '\\','/')) + '","opts":' + $optsJson + '}'
  [IO.File]::WriteAllText($inF,  $cmd + "`r`n", [Text.Encoding]::ASCII)
  $body = '@echo off' + "`r`n" + '"' + $sidecar + '" < "' + $inF + '" > "' + $outF + '" 2> "' + $errF + '"' + "`r`n"
  [IO.File]::WriteAllText($bat, $body, [Text.Encoding]::ASCII)
  cmd.exe /c $bat
  for ($w = 0; $w -lt 90; $w++) {
    Start-Sleep -Seconds 4
    if (Test-Path $outF) {
      $t = [IO.File]::ReadAllText($outF, [Text.Encoding]::UTF8)
      if ($t -match '"event":\s*"result"') { break }
    }
  }
  return $outF
}

# Doc text trong file ket qua
function SegText($file) {
  $t = [IO.File]::ReadAllText($file, [Text.Encoding]::UTF8)
  $text = ''
  foreach ($line in ($t -split "`n")) {
    if ($line -match '"event":\s*"segment"') {
      try { $text += (($line | ConvertFrom-Json).text) } catch {}
    }
  }
  return $text
}

# Kiem tra ky tu bang ma Unicode (khong in ra console)
function HasSimplified($text) {
  return $text.Contains(([char]0x4ECA) + ([char]0x5929) + ([char]0x5929) + ([char]0x6C14)) # 今天天气
}
function HasTraditional($text) {
  return $text.Contains(([char]0x4ECA) + ([char]0x5929) + ([char]0x5929) + ([char]0x6C23)) # 今天天氣
}
# Fixture test/fixtures/en.wav la: "The quick brown fox jumps over the lazy
# dog. Testing one, two, three." -> phai kiem tra 'lazy dog', khong phai
# 'elephant' (tu video YouTube dung trong E2E).
function MentionsLazyDog($text) {
  return $text -match 'lazy dog'
}

$M = '"model":"small","vadFilter":true,"batchSize":1'

# ------------------------------------------------------------------ 1
Say "1/4 Tieng Trung — ep GIAN THE"
$a = Stage 'zh.wav' 'zh.wav'
$f1 = RunTranscribe 'z1' $a ("{" + $M + ",""language"":""zh"",""script"":""zh-Hans""}")
$t1 = SegText $f1
Write-Host ("   so ky tu: {0}" -f $t1.Length)
if (HasSimplified $t1) { Ok "ra dung chu Gian the (今天天气)" }
else { Bad "khong ra chu Gian the"; $fails++ }
if (HasTraditional $t1) { Bad "con xuat hien chu Phon the" } else { Ok "khong con chu Phon the" }

# ------------------------------------------------------------------ 2
Say "2/4 Tieng Trung — ep PHON THE"
$b = Stage 'zht.wav' 'zht.wav'
$f2 = RunTranscribe 'z2' $b ("{" + $M + ",""language"":""zh"",""script"":""zh-Hant""}")
$t2 = SegText $f2
if (HasTraditional $t2) { Ok "ra dung chu Phon the (今天天氣)" }
else { Bad "khong ra chu Phon the"; $fails++ }

# ------------------------------------------------------------------ 3
Say "3/4 Chan model chi-ho-tro-tieng-Anh khi gap tieng Trung"
$inF  = Join-Path $tmp "in-z3.jsonl"
$outF = Join-Path $tmp "out-z3.jsonl"
$errF = Join-Path $tmp "err-z3.txt"
$bat  = Join-Path $tmp "run-z3.cmd"
$c3 = '{"cmd":"transcribe","jobId":"z3","audio":"' + $a + '","modelsDir":"' +
      (($models -replace '\\','/')) + '","opts":{"model":"distil-large-v3","language":"zh"}}'
[IO.File]::WriteAllText($inF, $c3 + "`r`n", [Text.Encoding]::ASCII)
[IO.File]::WriteAllText($bat, '@echo off' + "`r`n" + '"' + $sidecar + '" < "' + $inF + '" > "' + $outF + '" 2> "' + $errF + '"' + "`r`n", [Text.Encoding]::ASCII)
cmd.exe /c $bat
Start-Sleep -Seconds 25
$r3 = [IO.File]::ReadAllText($outF, [Text.Encoding]::UTF8)
if ($r3 -match 'h\u1ED7 tr\u1EE3 ti\u1EBFng Anh' -or $r3 -match 'Anh') {
  if ($r3 -match 'distil-large-v3') { Ok "da chan dung model English-only" } else { Bad "khong chan"; $fails++ }
} else { Bad "khong chan model English-only"; $fails++ }

# ------------------------------------------------------------------ 4
Say "4/4 Tieng Anh — kiem tra khong lam hong thay doi"
$c = Stage 'en.wav' 'en.wav'
$f4 = RunTranscribe 'z4' $c ("{" + $M + ",""language"":""en""}")
$t4 = SegText $f4
if (MentionsLazyDog $t4) { Ok "tieng Anh van chay dung (co 'lazy dog')" }
else { Bad "tieng Anh that bai"; $fails++ }

Write-Host ""
if ($fails -eq 0) { Write-Host "==> TAT CA KIEM THU TREN WINDOWS PASS" -ForegroundColor Green }
else { Write-Host "==> $fails KIEM THU FAIL" -ForegroundColor Red }
exit $fails
