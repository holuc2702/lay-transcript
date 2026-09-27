'use strict';

const test = require('node:test');
const assert = require('node:assert');

const C = require('../src/main/config');

test('thang định dạng audio KHÔNG được hardcode một định dạng đơn lẻ', () => {
  // Đây là bảo vệ quan trọng nhất. Nếu còn lỡ tay sửa thành "140", app sẽ
  // chết ngay khi YouTube bỏ định dạng đó (đã xảy ra 3/2026 và 1/2026).
  const ladder = C.AUDIO_FORMAT_LADDER;
  assert.ok(ladder.includes('/'), 'phải là thang bậc có nhiều mức');
  const parts = ladder.split('/');
  assert.ok(parts.length >= 3, `cần ít nhất 3 mức, hiện có ${parts.length}`);
  assert.ok(parts.includes('bestaudio'), 'phải có mức cuối cùng bestaudio');
  // 140 (AAC) nên ở đầu: một file, không cần remux
  assert.strictEqual(parts[0], '140');
});

test('player_client dùng "default" chứ không hardcode tên client cụ thể', () => {
  // Client cụ thể (visionos, mweb...) bị YouTube đổi xoay. "default" để yt-dlp
  // tự chọn theo những gì còn hoạt động.
  assert.strictEqual(C.PLAYER_CLIENT, 'default');
});

test('model tiếng Anh-only đều nằm trong danh sách chặn', () => {
  for (const m of [
    'tiny.en',
    'base.en',
    'small.en',
    'medium.en',
    'distil-small.en',
    'distil-medium.en',
    'distil-large-v3',
    'distil-large-v3.5',
    'distil-large-v2',
  ]) {
    assert.ok(C.ENGLISH_ONLY_MODELS.has(m), `thiếu ${m} trong danh sách English-only`);
  }
});

test('mọi model trong bảng MODELS đều không phải English-only', () => {
  // Người dùng chọn được model trong UI -> không được chọn trúng model
  // tiếng Anh-only rồi âm thầm ra rác khi dùng tiếng Trung.
  for (const m of C.MODELS) {
    assert.ok(
      !C.ENGLISH_ONLY_MODELS.has(m.id),
      `model ${m.id} trong UI nhưng lại là English-only`
    );
  }
});

test('bảng MODELS: đủ thông tin và đánh dấu đúng model khuyên dùng', () => {
  for (const m of C.MODELS) {
    assert.ok(m.id && m.label && m.note, `model ${m.id} thiếu thông tin hiển thị`);
    assert.ok(m.sizeMB > 0, `model ${m.id} thiếu sizeMB`);
    assert.ok(m.speed, `model ${m.id} thiếu speed`);
    assert.ok(m.quality >= 1 && m.quality <= 5, `model ${m.id} quality sai`);
  }
  const rec = C.MODELS.filter((m) => m.recommended);
  assert.ok(rec.length >= 1, 'phải có ít nhất một model được khuyên dùng');
});

test('compute_type là int8 (CTranslate2 không có GPU trên macOS)', () => {
  // Trên Apple Silicon, int8 -> int8_float32. float16 sẽ lặng lẽ rơi về
  // float32: chậm hơn và tốn gấp đôi RAM.
  assert.strictEqual(C.COMPUTE_TYPE, 'int8');
});

test('model mặc định nằm trong bảng MODELS', () => {
  assert.ok(C.MODELS.some((m) => m.id === C.DEFAULT_MODEL));
});

test('script prompt đủ cả hai hướng Giản thể và Phồn thể', () => {
  assert.ok(C.SCRIPT_PROMPTS['zh-Hans'], 'thiếu prompt Giản thể');
  assert.ok(C.SCRIPT_PROMPTS['zh-Hant'], 'thiếu prompt Phồn thể');
  // Phải khác nhau, nếu giống nhau thì không ép được gì
  assert.notStrictEqual(C.SCRIPT_PROMPTS['zh-Hans'], C.SCRIPT_PROMPTS['zh-Hant']);
  // Phải chứa đúng câu tự thân, để Whisper bắt được bối cảnh
  for (const [k, v] of Object.entries(C.SCRIPT_PROMPTS)) {
    assert.ok(v.includes('。'), `prompt ${k} nên kết thúc bằng dấu câu`);
  }
});

test('danh sách ngôn ngữ: không trùng mã', () => {
  const seen = new Set();
  for (const l of C.LANGUAGES) {
    assert.ok(l.code, 'thiếu mã ngôn ngữ');
    assert.ok(l.name, `thiếu tên hiển thị cho ${l.code}`);
    assert.ok(!seen.has(l.code), `trùng mã ngôn ngữ: ${l.code}`);
    seen.add(l.code);
  }
});

test('danh sách ngôn ngữ: có auto, tiếng Anh và tiếng Trung ở nhóm chính', () => {
  const primary = C.LANGUAGES.filter((l) => l.primary).map((l) => l.code);
  for (const code of ['auto', 'en', 'zh']) {
    assert.ok(primary.includes(code), `thiếu ${code} trong nhóm ngôn ngữ chính`);
  }
});

test('mã ngôn ngữ đều ở dạng ISO 639-1 hợp lệ', () => {
  for (const l of C.LANGUAGES) {
    if (l.code === 'auto') continue;
    assert.match(l.code, /^[a-z]{2,3}$/, `mã ngôn ngữ sai định dạng: ${l.code}`);
  }
});

test('URL tải yt-dlp phải nhận MỐC PHIÊN BẢN, không nhận tên kênh', () => {
  // Đã mắc lỗi: dựng thẳng URL từ kênh cho ra
  //   .../releases/download/stable/yt-dlp_macos -> HTTP 404
  // nên nút "Cập nhật & kiểm chứng" không bao giờ chạy được. Chặn tái phát.
  const stub = require('./helpers/electron-stub');
  stub.install();
  const ytdlp = require('../src/main/ytdlp');
  for (const ch of ['stable', 'nightly', 'master']) {
    assert.throws(
      () => ytdlp.downloadUrlFor(ch),
      /mốc phiên bản/i,
      `phải từ chối tên kênh "${ch}"`
    );
  }
  // Mốc thật thì dựng URL hợp lệ
  const url = ytdlp.downloadUrlFor('2026.08.19');
  assert.match(url, /releases\/download\/2026\.08\.19\/yt-dlp_macos$/);
  assert.ok(!url.includes('stable'), 'URL không được chứa tên kênh');
});

test('có danh sách phiên bản yt-dlp đã biết là chạy được', () => {
  assert.ok(C.YTDLP_KNOWN_GOOD.length >= 1);
  for (const k of C.YTDLP_KNOWN_GOOD) {
    assert.match(k.version, /^\d{4}\.\d{2}\.\d{2}$/, `sai định dạng phiên bản: ${k.version}`);
    assert.ok(k.note, `thiếu ghi chú cho ${k.version}`);
  }
});

test('video kiểm chứng: phải có NHIỀU dự phòng, đều là URL hợp lệ', () => {
  // Bắt buộc có từ 2 video trở lên: một video kiểm chứng duy nhất có thể bị
  // gỡ bất kỳ lúc nào, lúc đó tính năng tự cập nhật chết vĩnh viễn.
  assert.ok(
    C.VERIFY_VIDEOS.length >= 2,
    'cần ít nhất 2 video kiểm chứng dự phòng'
  );
  for (const u of C.VERIFY_VIDEOS) {
    assert.match(u, /^https:\/\/www\.youtube\.com\/watch\?v=[\w-]{11}$/);
  }
  // Không được trùng nhau
  assert.strictEqual(new Set(C.VERIFY_VIDEOS).size, C.VERIFY_VIDEOS.length);
});

test('có asset yt-dlp cho cả ba nền tảng', () => {
  for (const p of ['darwin', 'win32', 'linux']) {
    assert.ok(C.YTDLP_ASSET[p], `thiếu asset cho ${p}`);
  }
  // macOS phải dùng bản universal để chạy được trên cả Intel và Apple Silicon
  assert.strictEqual(C.YTDLP_ASSET.darwin, 'yt-dlp_macos');
  assert.ok(C.YTDLP_ASSET.win32.endsWith('.exe'));
});

test('giới hạn nghỉ giữa request đủ để không bị giới hạn tốc độ', () => {
  assert.ok(Number(C.SLEEP_REQUESTS) >= 1, 'cần nghỉ ít nhất 1s giữa các request');
  assert.ok(Number(C.SLEEP_INTERVAL) >= 1);
});
