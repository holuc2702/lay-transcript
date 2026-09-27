#!/usr/bin/env bash
#
# Tao file audio mau cho test cham (LAY_SLOW=1).
#
# File mau sinh bang macOS `say` nen khong phai tai gi tu Internet, va rat
# nhanh. Nhan biet: day la giong tong hop sach, khong co nhieu nen CER do duoc
# thap hon tieng nguoi that. Dung de KIEM TRA TINH DUNG, khong dung de do chat
# luong cuoi cung.
#
#   bash scripts/make-test-fixtures.sh

set -euo pipefail
cd "$(dirname "$0")/.."
OUT="test/fixtures"
mkdir -p "$OUT"

step() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }

# --- Tieng Anh ---
# "lazy dog" + cac con so de kiem tra Whisper ghi dung chu so
step "Sinh test/fixtures/en.wav (tieng Anh)"
say -v Samantha --data-format=LEI16@16000 -o "$OUT/en.wav" \
  "The quick brown fox jumps over the lazy dog. Testing one, two, three."

# --- Tieng Trung gian the ---
# Chu "zhe" de kiem tra initial_prompt co ep dung khong
step "Sinh test/fixtures/zh.wav (tieng Trung gian the)"
say -v Tingting --data-format=LEI16@16000 -o "$OUT/zh.wav" \
  "今天天气很好，我们打算去公园散步。互联网上的新闻很有意思。"

# --- Tieng Trung phon the ---
step "Sinh test/fixtures/zht.wav (tieng Trung phon the)"
say -v Meijia --data-format=LEI16@16000 -o "$OUT/zht.wav" \
  "今天天氣很好，我們打算去公園散步。"

# --- File dai de kiem tra huy ---
# Khoang 5 phut: du de job chay du kip thi huy co tac dung khong
step "Sinh test/fixtures/long.wav (khoang 5 phut)"
LONG_TXT=""
for i in $(seq 1 12); do
  LONG_TXT="$LONG_TXT This is sentence number $i in a long audio clip used to test cancellation. "
done
say -v Samantha --data-format=LEI16@16000 -o "$OUT/long.wav" "$LONG_TXT"

step "Xong:"
ls -la "$OUT"
