'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const stub = require('./helpers/electron-stub');
stub.install();

const jobs = require('../src/main/jobs');

// ---------------------------------------------------------------------------
// Tien do tai video
// ---------------------------------------------------------------------------

test('parseDownloadLine: cac bien the dau bang tieng Viet', () => {
  assert.deepStrictEqual(jobs.parseDownloadLine('[download]  42.5% of 17.92MiB at 3.00MiB/s ETA 00:05'), {
    percent: 42.5,
    totalBytes: Math.round(17.92 * 1024 ** 2),
  });
  assert.deepStrictEqual(jobs.parseDownloadLine('[download]   0.0% of 3.29MiB at  Unknown B/s ETA Unknown'), {
    percent: 0,
    totalBytes: Math.round(3.29 * 1024 ** 2),
  });
});

test('parseDownloadLine: hỗ trợ dấu ~ và đơn vị thập phân', () => {
  // yt-dlp dùng "17.9MiB" ở một chỗ và "~3.29MiB" ở chỗ khác.
  const a = jobs.parseDownloadLine('[download]  10.0% of 1.00MiB at 1MiB/s ETA 00:01');
  const b = jobs.parseDownloadLine('[download]  10.0% of ~1.00MiB at 1MiB/s ETA 00:01');
  assert.deepStrictEqual(a, b);
  const c = jobs.parseDownloadLine('[download]  10.0% of 1.50MB at 1MB/s ETA 00:01');
  assert.strictEqual(c.totalBytes, Math.round(1.5 * 1000 ** 2));
});

test('parseDownloadLine: bỏ qua dòng không phải tiến độ', () => {
  for (const line of [
    '[youtube] abc: Downloading webpage',
    '[info] abc: Downloading 1 format(s): 140',
    '[download] Destination: x.m4a',
    'random text',
    '',
  ]) {
    assert.strictEqual(jobs.parseDownloadLine(line), null, `không nên parse: ${line}`);
  }
});

// ---------------------------------------------------------------------------
// Dịch lỗi yt-dlp sang tiếng Việt
// ---------------------------------------------------------------------------

test('translateYtError: nhận diện IP bị YouTube chặn', () => {
  const msg = jobs.translateYtError('ERROR: Sign in to confirm you\'re not a bot', 1);
  assert.match(msg, /IP/);
  assert.match(msg, /KHÔNG phải lỗi của app/i);
  // Thông điệp phải chỉ ra cách xử lý
  assert.match(msg, /đổi mạng|4G|thử lại/i);
});

test('translateYtError: nhận diện giới hạn tốc độ', () => {
  const msg = jobs.translateYtError('ERROR: HTTP Error 429: Too Many Requests', 1);
  assert.match(msg, /10–15 phút|nghỉ/i);
});

test('translateYtError: nhận diện video không truy cập được', () => {
  for (const raw of ['ERROR: Video unavailable', 'ERROR: Private video. Sign in if you\'ve been granted access']) {
    const msg = jobs.translateYtError(raw, 1);
    assert.match(msg, /không truy cập được|bị xoá|bị khoá|bị giới hạn/i);
  }
});

test('translateYtError: nhận diện lỗi mạng', () => {
  const msg = jobs.translateYtError('ERROR: Unable to download webpage: <urlopen error [Errno 8] nodename nor servname provided>', 1);
  assert.match(msg, /mạng|Không kết nối/i);
});

test('translateYtError: định dạng không còn tồn tại thì chỉ đường cập nhật yt-dlp', () => {
  const msg = jobs.translateYtError('ERROR: Requested format is not available', 1);
  assert.match(msg, /yt-dlp/i);
  assert.match(msg, /Cài đặt/);
});

test('translateYtError: hết dung lượng đĩa', () => {
  const msg = jobs.translateYtError('ERROR: No space left on device', 1);
  assert.match(msg, /Ổ đĩa|dung lượng|hết/i);
});

test('translateYtError: lỗi 403 gợi ý đổi mạng hoặc cập nhật', () => {
  const msg = jobs.translateYtError('ERROR: HTTP Error 403: Forbidden', 1);
  assert.match(msg, /403/);
  assert.match(msg, /đổi mạng|cập nhật/i);
});

test('translateYtError: lỗi lạ vẫn phải có giải thích + giữ nguyên log', () => {
  const msg = jobs.translateYtError('ERROR: some totally unknown failure detail', 7);
  assert.match(msg, /thất bại/);
  assert.ok(msg.includes('7'), 'phải nêu mã lỗi để tra cứu');
  assert.ok(msg.includes('some totally unknown failure detail'), 'phải giữ lại log gốc');
});

test('translateYtError: luôn trả về chuỗi tiếng Việt có dấu', () => {
  const msg = jobs.translateYtError('ERROR: boom', 1);
  // Không được trả về chuỗi rỗng khiến UI hiện trống
  assert.ok(msg.length > 10);
});

// ---------------------------------------------------------------------------
// Cài ffmpeg
// ---------------------------------------------------------------------------

test('installFfmpeg: chép ffmpeg/ffprobe từ resources sang thư mục ghi được', () => {
  // Lý do: yt-dlp và app phải gọi được ffmpeg mà không phụ thuộc PATH của
  // hệ điều hành (người dùng có thể chưa cài ffmpeg).
  jobs.installFfmpeg();
  const { toolsDir } = require('../src/main/paths');
  const name = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const probe = process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe';
  assert.ok(fs.existsSync(path.join(toolsDir(), name)), 'thiếu ffmpeg');
  if (process.platform !== 'win32') {
    assert.ok(fs.existsSync(path.join(toolsDir(), probe)), 'thiếu ffprobe');
  }
});

test('findAudioFile: chọn file mới nhất, bỏ qua file không phải audio', () => {
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'lt-audio-'));
  fs.writeFileSync(path.join(dir, 'a.m4a'), 'x');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'x');
  fs.writeFileSync(path.join(dir, 'b.webm'), 'x');
  const found = jobs.findAudioFile(dir);
  assert.ok(/b\.webm$/.test(found), `phải chọn file mới nhất, thực tế: ${found}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('findAudioFile: báo lỗi rõ ràng khi không có audio', () => {
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'lt-empty-'));
  assert.throws(() => jobs.findAudioFile(dir), /không tìm thấy file audio/);
  fs.rmSync(dir, { recursive: true, force: true });
});
