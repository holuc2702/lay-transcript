# Lấy Transcript

Ứng dụng máy tính tạo transcript từ video YouTube bằng **Whisper**, chạy hoàn toàn
trên máy của bạn. Thiết kế cho đúng nhu cầu: **video không có phụ đề**.

Dán link → bấm một nút → có file `.srt` / `.vtt` / `.txt` / `.json`. Không cài
Python, không cài ffmpeg, không gõ lệnh.

---

## Cài đặt

| Nền tảng | Yêu cầu | File cài đặt |
|---|---|---|
| **macOS** (Apple Silicon) | macOS 12 trở lên | `release/Lấy Transcript-<phiên bản>-arm64.dmg` |
| **Windows** (x64) | Windows 10 trở lên | `release/Lay-Transcript-<phiên bản>-x64.exe` |

Kéo ứng dụng vào `Applications` (macOS) hoặc chạy file `.exe` (Windows).

> **Lần chạy đầu** sẽ tải model Whisper về máy (mặc định khoảng 486 MB) — chỉ
> một lần duy nhất. Thanh tiến trình ngay dưới ô nhập link sẽ hiện rõ.

### Trên macOS, app có thể báo "không xác minh được"

Bản build này **chưa được ký bằng chứng thư Apple Developer**, nên Gatekeeper
sẽ chặn khi mở từ Downloads. Cách xử lý:

```bash
xattr -cr ~/Downloads/Lấ\ Transcript-1.0.0-arm64.dmg
```

hoặc mở app, bấm chu phải → **Mở** → **Mở** một lần nữa.

---

## Cách dùng

1. Dán link YouTube vào ô lên trên (mỗi dòng một video, dán nhiều link cùng lúc
   được — app xử lý lần lượt).
2. Bấm **Bắt đầu**.
3. Xong thì bấm **Xem transcript** để đọc, hoặc dùng:
   - **Sao chép văn bản** — chép **toàn bộ lời thoại, không kèm số phút/giây**
     (để dán vào tài liệu, email, dịch thuật)
   - **Lưu thành .txt** — hộp thoại hiện ra để bạn **tự đặt tên file**

Bật **Tự động bắt đầu khi dán link** thì chỉ cần dán là app tự chạy.

File kết quả mặc định nằm trong `Videos/Lấy Transcript/` (đổi được ở tab
**Cài đặt**).

---

## Chọn model

Model quyết định tốc độ và độ chính xác. Mặc định là **small**.

| Model | Dung lượng | 1 giờ video mất | Ghi chú |
|---|---|---|---|
| `tiny` | 78 MB | ~2 phút | Rất nhanh, tiếng Trung sai nhiều. Chỉ để thử. |
| `base` | 148 MB | ~3 phút | Nhẹ, chạy mượt máy yếu. |
| `small` | 486 MB | ~9 phút | Nhỏ nhất trong nhóm dùng được. Chọn nếu máy yếu. |
| **`medium`** | **1.5 GB** | **~24 phút** | **Mặc định. Cân bằng độ chính xác và tốc độ.** |
| `large-v3-turbo` | 1.6 GB | ~15 phút | Chất lượng tốt nhất, nhất là tiếng Trung. Cần ~2.5 GB RAM trống. |
| `large-v3` | 3.1 GB | >1 giờ | Chuyên sâu, chậm. |

> Mặc định là `medium` (chất lượng cao). Nếu thấy nặng, chuyển xuống `small`.

Số liệu tốc độ đo trên **M1 Pro 8 nhân**, model nén `int8`, có bật lọc khoảng
im lặng. Máy của bạn có thể nhanh hoặc chậm hơn — xem mục **Thông tin hệ
thống** trong Cài đặt.

> Whisper chạy trên **CPU**, kể cả trên máy Mac có chip Apple Silicon. Đó là đặc
> tính của thư viện CTranslate2, không phải lỗi của app.

---

## Tiếng Trung: chọn đúng kiểu chữ

Whisper thường **tự nhảy giữa Giản thể và Phồn thể** giữa chừng. Nếu bạn cần
một kiểu chữ cụ thể, chọn ở tab **Cài đặt**:

- **Giản thể** → `今天天气很好` (dùng cho video Mainland)
- **Phồn thể** → `今天天氣很好` (dùng cho video Đài Loan / Hồng Kông)

Có thể thêm **Từ khóa ưu tiên** khi video hay dùng thuật ngữ riêng mà Whisper
ghi sai (ví dụ `Kubernetes`, `张量`).

### Khi transcript ra rác hoặc bị lặp

1. **Bật "Lọc khoảng im lặng"** (mặc định đã bật) — nguyên nhân phổ biến nhất.
2. Chọn đúng kiểu chữ.
3. Nâng lên `large-v3-turbo`.
4. Thêm từ khóa.

---

## Lịch sử

Mọi video đã xử lý được lưu lại (tối đa 200 mục) và **không mất khi đóng app**.
Ở tab **Lịch sử** bạn có:

- **Chạy lại** — dán lại link vào ô nhập
- **Mở file** — mở thẳng file kết quả
- **✕** — xóa một mục
- **Xóa tất cả** — xóa toàn bộ lịch sử (file kết quả vẫn còn nguyên)

## Dịch tiêu đề tự động

Mặc định **bật**: tiêu đề tiếng Trung/Anh sẽ hiện kèm bản dịch tiếng Việt ngay
bên dưới (màu xanh). Tắt trong **Cài đặt → Tự động dịch tiêu đề sang tiếng Việt**.

Dùng dịch vụ dịch của Google, không cần tài khoản. Không có mạng thì giữ nguyên
tiêu đề gốc — app không bị lỗi.

> Lưu ý: phần *lời thoại* thì **không** dịch. Whisper chỉ dịch được sang tiếng
> Anh, và việc đó không nằm trong phạm vi app này. Chọn chế độ **Dịch sang tiếng
> Anh** nếu bạn cần bản tiếng Anh của lời thoại.

## Cập nhật ứng dụng

Tab **Cài đặt → Cập nhật ứng dụng** có nút kiểm tra bản mới từ
[GitHub Releases](https://github.com/holuc2702/lay-transcript/releases).

> **Trên macOS, tự cập nhật chỉ chạy với app đã ký bằng chứng thư Apple
> Developer.** Bản build tại chỗ (ký ad-hoc) sẽ báo không cài được và gợi ý tải
> thủ công — đó là giới hạn của macOS, không phải lỗi app.

## Định dạng xuất

| Định dạng | Dùng để |
|---|---|
| `.srt` | Phụ đề (mọi trình phát video đều nhận) |
| `.vtt` | Phụ đề web |
| `.txt` | Văn bản thuần, có giờ hiện |
| `.txt` (không giờ) | Văn bản thuần, không giờ hiện |
| `.md` | Markdown |
| `.json` | Có timestamp từng từ, để xử lý tiếp |

Tích vào những định dạng bạn muốn ở Cài đặt. App không ghi đè file cũ — trùng
tên sẽ tự thêm `(2)`, `(3)`.

---

## Về yt-dlp (công cụ tải video)

YouTube liên tục đổi giao thức khiến yt-dlp hỏng. App xử lý việc này theo cách
**tự kiểm chứng**:

1. Tải bản mới về một **file tạm**, không đụng bản đang chạy.
2. **Tải thật một video** bằng bản tạm đó.
3. Chỉ khi tải được mới chuyển sang bản đang dùng, giữ lại bản cũ.
4. Nếu hỏng → giữ nguyên bản cũ và báo bạn biết.

Nên app có thể tự cập nhật mà không bao giờ để bạn rơi vào trạng thái không tải
được video. Ở tab **Cài đặt** có nút:

- **Cập nhật & kiểm chứng** — tải bản mới và kiểm tra như trên
- **Thử tải thử** — kiểm tra bản đang chạy có tải được video không
- **Quay lui phiên bản** — trở về bản đã lưu

Nên dùng kênh **Hằng đêm**: chính dự án yt-dlp khuyến nghị kênh này, vì bản
phát hành hằng tháng thường bị YouTube chặn trước.

### Báo lỗi "YouTube đang chặn IP này"

Đây là **YouTube chặn IP**, không phải lỗi của app hay của yt-dlp. Cách xử lý:
đổi mạng (dùng 4G thay WiFi), hoặc chờ 10–15 phút rồi thử lại. Nếu tải nhiều
video liên tục, hãy nghỉ giữa các lần.

---

## Liên hệ

Góp ý, báo lỗi, hoặc muốn thêm tính năng: **holuc1991@gmail.com**

## Dữ liệu của bạn

Whisper chạy hoàn toàn trên máy bạn. App chỉ liên hệ với:

- **YouTube** — để tải audio
- **GitHub** — để kiểm tra bản cập nhật yt-dlp
- **Hugging Face** — để tải model Whisper (một lần duy nhất)

Không tài khoản, không telemetry, không gửi audio đi đâu.

---

## Dành cho người muốn tự build

### Yêu cầu

- macOS: Node 22+, Python 3.12 (qua `uv` hoặc Homebrew), `rsvg-convert` + `magick`
  (để tạo icon)
- Windows: Node 22+, Python 3.12, PowerShell

### Build macOS

```bash
npm install
bash scripts/fetch-deps.sh      # ffmpeg, ffprobe, yt-dlp
bash scripts/build-sidecar.sh   # đóng gói sidecar Python
bash scripts/build-mac.sh       # tạo .app + .dmg
```

### Build Windows

```powershell
powershell -ExecutionPolicy Bypass -File scripts\setup-windows.ps1    # Node + Python
powershell -ExecutionPolicy Bypass -File scripts\build-windows.ps1   # tạo .exe
```

**Bắt buộc phải build trên Windows.** Sidecar Python cần wheel `win_amd64` của
CTranslate2 / onnxruntime / PyAV, mà các wheel đó không cài được trên macOS và
PyInstaller không cross-compile được. Ngoài ra CTranslate2 **không có bản
`win_arm64`** — nên app chỉ chạy được trên Windows x64 (máy Windows ARM vẫn chạy
được nhờ chế độ tương thích của Windows 11).

### Chạy test

```bash
npm test                 # 58 test: định dạng file, cấu hình, dịch lỗi
node --test test/sidecar.test.js   # kiểm thử sidecar đã đóng gói

# kiểm thử end-to-end qua giao diện thật (cần app đang chạy)
npx electron . --remote-debugging-port=9222 &
node scripts/e2e-ui.mjs https://www.youtube.com/watch?v=jNQXAC9IVRw
node scripts/e2e-autostart.mjs    # kiểm tra tự động bắt đầu khi dán
```

Trên Windows có thêm:

```powershell
powershell -File scripts\test-installer.ps1   # cài thật rồi kiểm tra
powershell -File scripts\test-chinese.ps1     # 4 test tiếng Trung/tiếng Anh
```

---

## Ghi chú kỹ thuật

Những chỗ dễ hỏng đã được xử lý, ghi lại để sau này không phá:

**Định dạng audio không hardcode.** App dùng thang `140/251/233/234/bestaudio`
chứ không ghim một định dạng. YouTube đã bỏ DASH audio-only hàng loạt (3/2026)
và bỏ format 140 với một số video (1/2026) — ghim cứng nghĩa là app chết đúng
lúc đó.

**Thư mục dữ liệu đặt tên không dấu.** `ffmpeg.exe` trên Windows đọc đường dẫn
bằng ANSI, nên `Lấy Transcript` thành `L???y Transcript` và ffmpeg không tìm
thấy file. Tên hiển thị vẫn có dấu, chỉ thư mục dữ liệu là ASCII.

**DLL Visual C++ đi kèm app.** Nhiều máy không có sẵn bộ runtime này, thiếu thì
CTranslate2 không nạp được. App tự mang theo, không cần cài gì thêm.

**Sidecar nói chuyện qua JSON trên stdio.** Nếu sidecar lỗi, app vẫn sống và báo
lỗi bằng tiếng Việt; chỉ chết khi bạn đóng app. Nút **Dừng** hoạt động vì lệnh
huỷ được xử lý trên luồng riêng, không bị ghi âm chặn.

**Sidecar ép UTF-8 cho stdout.** Trên Windows, stdout mặc định là cp1252 — ghi
ký tự tiếng Trung là tiến trình chết. Đã cấp hẳn UTF-8 ngay từ đầu.

**macOS build bằng `@electron/packager`, không dùng `electron-builder`.**
electron-builder 26.15.3 tạo ra app chết ngay khi mở (`SIGTRAP`, mã 133) — đã
xác nhận bằng một app Electron tối giảu, nên lỗi ở electron-builder chứ không ở
app này. Windows vẫn dùng electron-builder vì cần NSIS.
