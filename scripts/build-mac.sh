#!/usr/bin/env bash
#
# Build ban macOS.
#
# VI SAO KHONG DUNG electron-builder:
#   electron-builder 26.15.3 tao ra app chet ngay khi mo (SIGTRAP, ma loi 133).
#   Da xac nhan bang cac buoi kiem chung:
#     - mot app Electron "xin chao" trong, build bang electron-builder 26.15.3
#       + Electron 44.4.5, cung chet.
#     - chinh app nay, build bang @electron/packager, chay binh thuong.
#   => Loi nam o electron-builder, khong nam o code cua app. Vi vay macOS dung
#      @electron/packager (don gian, it thuoc ke), con Windows van dung
#      electron-builder de sinh file .exe.
#
# Cac buoc:
#   1. tai phu thuoc (ffmpeg, ffprobe, yt-dlp) vao resources/bin
#   2. dong goi sidecar Python bang PyInstaller vao resources/sidecar
#   3. @electron/packager tao .app
#   4. chep bin + sidecar vao trong .app
#   5. ky ad-hoc + hardened runtime (bat buoc, xem build/entitlements.mac.plist)
#   6. tao file .dmg
#
# Chay:  bash scripts/build-mac.sh

set -euo pipefail
cd "$(dirname "$0")/.."

APP_NAME="Lấy Transcript"
BUNDLE_ID="vn.laytranscript.app"
VERSION="$(node -p "require('./package.json').version")"
OUT="release"
STAGE="$OUT/mac-stage"

step()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn()  { printf '\033[1;33m!! \033[0m %s\n' "$*"; }
ok()    { printf '\033[1;32m  ✓\033[0m %s\n' "$*"; }
die()   { printf '\033[1;31mLỖI:\033[0m %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------
step "1/6 Phụ thuộc ngoài (ffmpeg, ffprobe, yt-dlp)"
bash scripts/fetch-deps.sh >/dev/null 2>&1 || die "fetch-deps thất bại"
[ -f resources/bin/ffmpeg ] || die "thiếu ffmpeg"
ok "resources/bin OK"

# ---------------------------------------------------------------------------
step "2/6 Đóng gói sidecar Python (PyInstaller)"
# Phải so với CẢ worker.py LẪN sidecar.spec. Trước đây chỉ so với worker.py,
# nên khi sửa spec (làm mất dòng datas=...) app vẫn dùng sidecar cũ và VAD chết
# lúc chạy. So sánh cả hai thì luôn khớp với mã nguồn đang chạy.
if [ ! -x resources/sidecar/sidecar ] \
   || [ sidecar/worker.py -nt resources/sidecar/sidecar ] \
   || [ scripts/sidecar.spec -nt resources/sidecar/sidecar ] \
   || [ scripts/build-sidecar.py -nt resources/sidecar/sidecar ] \
   || [ sidecar/requirements.txt -nt resources/sidecar/sidecar ]; then
  bash scripts/build-sidecar.sh 2>&1 | tail -3
else
  step "  sidecar đã mới hơn cả worker.py lẫn spec — bỏ qua"
fi
[ -x resources/sidecar/sidecar ] || die "thiếu sidecar"
ok "resources/sidecar OK"

# ---------------------------------------------------------------------------
step "3/6 @electron/packager"
rm -rf "$STAGE"
npx electron-packager . "$APP_NAME" \
  --platform=darwin \
  --arch="$(node -p "process.arch")" \
  --out="$STAGE" \
  --overwrite \
  --app-bundle-id="$BUNDLE_ID" \
  --icon=build/icon.icns \
  --app-version="$VERSION" \
  --ignore='^/release($|/)' \
  --ignore='^/\.sidecar-build($|/)' \
  --ignore='^/test($|/)' \
  --ignore='^/scripts($|/)' \
  --ignore='^/build($|/)' \
  --ignore='^/resources($|/)' \
  --ignore='^/\.git($|/)' \
  >/dev/null 2>&1 || die "electron-packager thất bại"

APP="$STAGE/$APP_NAME-darwin-arm64/$APP_NAME.app"
# Tên thư mục có thể kèm hậu tố kiến trúc khác -> tìm bằng glob cho chắc.
if [ ! -d "$APP" ]; then
  APP=$(find "$STAGE" -maxdepth 2 -name "$APP_NAME.app" -type d | head -1)
fi
[ -d "$APP" ] || die "không tìm thấy .app sau khi đóng gói"

# electron-updater phải nằm trong app. Nếu để nhầm ở devDependencies thì bản
# đóng gói sẽ không có nó và require() lúc khởi động làm sập app — đã mắc lỗi này.
if [ ! -d "$APP/Contents/Resources/app.asar.unpacked" ] && [ ! -d "$APP/Contents/Resources/app/node_modules/electron-updater" ]; then
  warn "Không thấy electron-updater trong app — tự cập nhật sẽ không chạy."
  warn "Kiểm tra nó nằm trong 'dependencies' của package.json."
fi
ok "tạo được: ${APP#$OUT/}"

# ---------------------------------------------------------------------------
step "4/6 Chép ffmpeg + yt-dlp + sidecar vào trong .app"
# electron-packager đặt file dự án vào Contents/Resources theo đúng cấu trúc.
# Ta chép thủ công vào đúng vị trí mà src/main/paths.js trỏ tới, thay vì để
# packager đặt ở Resources/resources/ (sai chỗ).
RES="$APP/Contents/Resources"
mkdir -p "$RES/bin"
cp -R resources/bin/. "$RES/bin/"
chmod +x "$RES/bin/ffmpeg" "$RES/bin/ffprobe" "$RES/bin/yt-dlp_macos" 2>/dev/null || true
cp -R resources/sidecar "$RES/sidecar"
chmod +x "$RES/sidecar/sidecar"
ok "Resources/bin + Resources/sidecar"

# ---------------------------------------------------------------------------
step "5/6 Ký ad-hoc + hardened runtime"
# hardenedRuntime mà không ký -> app chết ngay. Ký ad-hoc không cần tài khoản
# Apple Developer. disable-library-validation là bắt buộc để app nạp được
# sidecar Python (một binary riêng chưa cùng team id).
codesign --deep --force --sign - \
  --options runtime \
  --timestamp=none \
  --entitlements build/entitlements.mac.plist \
  "$APP" 2>&1 | tail -2 || die "codesign thất bại"
codesign --verify --deep --strict "$APP" || die "xác minh chữ ký thất bại"
ok "đã ký và xác minh"

# ---------------------------------------------------------------------------
step "6/6 Tạo file .dmg"
DMG="$OUT/Lay-Transcript-$VERSION-arm64.dmg"
rm -f "$DMG"
DMG_STAGE="$OUT/dmg-stage"
rm -rf "$DMG_STAGE"
mkdir -p "$DMG_STAGE"
cp -R "$APP" "$DMG_STAGE/"
ln -s /Applications "$DMG_STAGE/Applications"

# Khung cửa sổ: app lệch trái, biểu tượng Applications lệch phải.
cat > "$OUT/dmg-set-apple.scpt" <<APPLESCRIPT
on run argv
  tell application "Finder"
    tell disk "DISK_NAME"
      open
      set current view of container window to icon view
      set toolbar visible of container window to false
      set statusbar visible of container window to false
      set the bounds of container window to {200, 180, 800, 560}
      set theViewOptions to the icon view options of container window
      set arrangement of theViewOptions to not arranged
      set icon size of theViewOptions to 96
      set position of item "APP_NAME" of container window to {170, 200}
      set position of item "Applications" of container window to {470, 200}
      close
      open
      update without registering applications
      delay 1
    end tell
  end tell
end run
APPLESCRIPT

sed -i '' "s/DISK_NAME/$APP_NAME/g; s/APP_NAME/$APP_NAME/g" "$OUT/dmg-set-apple.scpt"

hdiutil create \
  -srcfolder "$DMG_STAGE" \
  -volname "$APP_NAME" \
  -fs HFS+ \
  -format ULFO \
  -attach "$DMG" >/dev/null 2>&1 || die "hdiutil create thất bại"
sleep 2
osascript "$OUT/dmg-set-apple.scpt" >/dev/null 2>&1 || true
sleep 2
hdiutil detach "$DMG" >/dev/null 2>&1 || true

# Nén lại để tải cho nhẹ hơn
ZIP="$OUT/Lay-Transcript-$VERSION-arm64-mac.zip"
rm -f "$ZIP"
ditto -c -k --sequesterRsrc --keepParent "$APP" "$ZIP"

rm -rf "$DMG_STAGE" "$OUT/dmg-set-apple.scpt"

printf '\n\033[1;32mXong!\033[0m\n'
ls -lh "$DMG" "$ZIP" 2>/dev/null | awk '{print "  " $9 "  (" $5 ")"}'
du -sh "$APP" | awk '{print "  app: " $1}'
