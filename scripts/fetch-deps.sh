#!/usr/bin/env bash
#
# Tai ve cac phu thuoc ngoai (ffmpeg, ffprobe, yt-dlp) vao thu muc resources/bin
# de bo cuc chung cho ca macOS va Windows.
#
# Chay:  bash scripts/fetch-deps.sh
#
# Moi lan build app deu nen chay lai script nay: giu ffmpeg/yt-dlp dinh ban
# trong installer, dung thu muc nay de cap nhat ma khong phai dung lai app.

set -euo pipefail

cd "$(dirname "$0")/.."
BIN="resources/bin"
mkdir -p "$BIN"

YTDLP_VERSION="2026.08.19"

say() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m  %s\n' "$*"; }
die() { printf '\033[1;31mXX\033[0m  %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# yt-dlp
# ---------------------------------------------------------------------------
fetch_ytdlp() {
  local name
  case "$1" in
    darwin) name="yt-dlp_macos" ;;   # universal: chay duoc Intel lan Apple Silicon
    win32)  name="yt-dlp.exe" ;;
    *)      name="yt-dlp" ;;
  esac

  if [ -f "$BIN/$name" ]; then
    say "yt-dlp da co san — bo qua"
    return
  fi

  say "Tai yt-dlp $YTDLP_VERSION ($1)"
  local url="https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/${name}"
  curl -fL --retry 3 --progress-bar -o "$BIN/$name.tmp" "$url" \
    || die "Khong tai duoc yt-dlp tu $url"
  mv "$BIN/$name.tmp" "$BIN/$name"
  [ "$1" = "win32" ] || chmod +x "$BIN/$name"
  say "yt-dlp OK"
}

# ---------------------------------------------------------------------------
# ffmpeg + ffprobe
# ---------------------------------------------------------------------------
# Giai nen zip mac, tai .zip cho Windows.
extract_zip_member() {
  # $1 = file zip, $2 = ten can lay, $3 = dich den
  unzip -o -j -q "$1" "$2" -d "$3"
}

fetch_ffmpeg_macos() {
  # osxexperts.net chia rieng ffmpeg/ffprobe cho ARM va Intel.
  # Chon theo kien truc cua may dang build.
  if [ "$(uname -m)" = "arm64" ]; then
    FF_URL="https://www.osxexperts.net/ffmpeg7arm.zip"
    FP_URL="https://www.osxexperts.net/ffprobe7arm.zip"
    ARCH="arm64"
  else
    FF_URL="https://www.osxexperts.net/ffmpeg80intel.zip"
    FP_URL="https://www.osxexperts.net/ffprobe80intel.zip"
    ARCH="x86_64"
  fi

  if [ -f "$BIN/ffmpeg" ] && [ -f "$BIN/ffprobe" ]; then
    say "ffmpeg da co san — bo qua"
    return
  fi

  say "Tai ffmpeg/ffprobe cho macOS $ARCH"
  local tmp; tmp=$(mktemp -d)
  curl -fL --retry 3 --progress-bar -o "$tmp/ff.zip"  "$FF_URL"  || die "Khong tai duoc $FF_URL"
  curl -fL --retry 3 --progress-bar -o "$tmp/fp.zip" "$FP_URL" || warn "Khong tai duoc ffprobe ($FP_URL) — se dung PyAV lam du phong"

  extract_zip_member "$tmp/ff.zip"  "ffmpeg"  "$BIN"
  [ -f "$tmp/fp.zip" ] && extract_zip_member "$tmp/fp.zip" "ffprobe" "$BIN" || true
  chmod +x "$BIN/ffmpeg" 2>/dev/null || true
  chmod +x "$BIN/ffprobe" 2>/dev/null || true
  rm -rf "$tmp"

  [ -f "$BIN/ffmpeg" ] || die "Khong tim thay ffmpeg sau khi giai nen"
  say "ffmpeg OK ($("$BIN/ffmpeg" -version 2>/dev/null | head -1))"
}

fetch_ffmpeg_windows() {
  if [ -f "$BIN/ffmpeg.exe" ] && [ -f "$BIN/ffprobe.exe" ]; then
    say "ffmpeg da co san — bo qua"
    return
  fi

  say "Tai ffmpeg/ffprobe cho Windows x64"
  local url="https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip"
  local tmp; tmp=$(mktemp -d)
  curl -fL --retry 3 --progress-bar -o "$tmp/ff.zip" "$url" || die "Khong tai duoc $url"

  # File nam trong thu muc con, vi du bin/ffmpeg.exe
  unzip -o -q "$tmp/ff.zip" -d "$tmp/x"
  local f; f=$(find "$tmp/x" -name ffmpeg.exe -type f | head -1)
  local p; p=$(find "$tmp/x" -name ffprobe.exe -type f | head -1)
  [ -n "$f" ] && cp "$f" "$BIN/ffmpeg.exe" || die "Khong tim thay ffmpeg.exe trong zip"
  [ -n "$p" ] && cp "$p" "$BIN/ffprobe.exe" || warn "Khong co ffprobe.exe trong zip"
  rm -rf "$tmp"
  say "ffmpeg OK"
}

# ---------------------------------------------------------------------------
# Trinh tuong thich (mac + linux) — goi y khong bat buoc
# ---------------------------------------------------------------------------
# yt-dlp can mot JS runtime de giai thu thach cua YouTube. KHONG bat buoc:
# client mac dinh (visionos) van chay duoc khi khong co runtime nao. Nhung
# neu may nguoi dung da co deno/node thi app se dung, tang kha nang ket noi.
# Vi vay KHONG dem vao dung luong tai cua app.
check_js_runtime() {
  if command -v deno >/dev/null 2>&1; then
    say "Tim thay deno — yt-dlp se dung de giai thu thach YouTube"
  elif command -v node >/dev/null 2>&1; then
    local v; v=$(node -v | sed 's/v//')
    if [ "${v%%.*}" -ge 22 ] 2>/dev/null; then
      say "Tim thay node $v — yt-dlp se dung de giai thu thach YouTube"
    else
      say "Node $v qua cu (can >= 22) — app van chay binh thuong"
    fi
  else
    say "Khong co deno/node — app van chay binh thuong (khong bat buoc can JS runtime)"
  fi
}

# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Chon nen tang. Mac dinh la nen tang dang chay; co the ghi de khi build
# cross-platform (vi du CI de dong goi ban Windows tren may macOS).
# ---------------------------------------------------------------------------
detect_platform() {
  if [ -n "${PLATFORM_OVERRIDE:-}" ]; then
    echo "$PLATFORM_OVERRIDE"
    return
  fi
  case "$(uname -s)" in
    Darwin) echo "darwin" ;;
    Linux)  echo "linux" ;;
    *)      die "Khong ho tro nen tang nay: $(uname -s)" ;;
  esac
}

PLATFORM="$(detect_platform)"

fetch_ytdlp "$PLATFORM"

if [ "$PLATFORM" = "darwin" ]; then
  fetch_ffmpeg_macos
elif [ "$PLATFORM" = "win32" ]; then
  fetch_ffmpeg_windows
else
  warn "Linux: dung ffmpeg he thong (apt install ffmpeg)"
fi

check_js_runtime

say "Xong. resources/bin hien chua:"
ls -la "$BIN"
