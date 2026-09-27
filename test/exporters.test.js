'use strict';

const test = require('node:test');
const assert = require('node:assert');

const E = require('../src/main/exporters');

test('formatTimestamp: định dạng mm:ss và h:mm:ss', () => {
  assert.strictEqual(E.formatTimestamp(0), '00:00:00,000');
  assert.strictEqual(E.formatTimestamp(61.5), '00:01:01,500');
  assert.strictEqual(E.formatTimestamp(3661.25), '01:01:01,250');
});

test('formatTimestamp: dấu phân cách cho SRT và VTT', () => {
  assert.strictEqual(E.formatTimestamp(61.5, true), '00:01:01,500');
  assert.strictEqual(E.formatTimestamp(61.5, false), '00:01:01.500');
});

test('formatTimestamp: LUÔN làm tròn xuống, không bao giờ làm tròn lên', () => {
  // Đây là điểm then chốt: nếu làm tròn lên, timestamp của đoạn sau có thể
  // trùng (hoặc nhỏ hơn) đoạn trước -> phần mềm phụ đề báo lỗi.
  assert.strictEqual(E.formatTimestamp(1.9999), '00:00:01,999');
  assert.strictEqual(E.formatTimestamp(0.0001), '00:00:00,000');
  assert.strictEqual(E.formatTimestamp(59.9999), '00:00:59,999');
  // 1.0000 -> 1.000, KHÔNG phải 1.001
  assert.strictEqual(E.formatTimestamp(1.0001), '00:00:01,000');
});

test('formatTimestamp: âm số không được sinh chuỗi rác', () => {
  assert.strictEqual(E.formatTimestamp(-5), '00:00:00,000');
  assert.strictEqual(E.formatTimestamp(NaN), '00:00:00,000');
});

test('toSrt: đánh số từ 1, CRLF, bỏ dòng rỗng', () => {
  const segs = [
    { start: 0, end: 1.5, text: ' Xin chào ' },
    { start: 1.5, end: 3, text: '' },        // rỗng -> phải bị bỏ
    { start: 3, end: 4.5, text: 'Xin chào' },
  ];
  const srt = E.toSrt(segs);
  const lines = srt.split('\r\n');
  assert.ok(srt.includes('\r\n'), 'SRT phải dùng CRLF (yêu cầu của đặc tả SRT)');
  // đoạn 2 rỗng nên số thứ tự vẫn liên tục theo chỉ số gốc
  assert.ok(srt.includes('00:00:00,000 --> 00:00:01,500'));
  assert.ok(srt.includes('00:00:03,000 --> 00:00:04,500'));
  assert.ok(!srt.includes('--> 00:00:01,500 --> '), 'không được sinh dòng rỗng');
});

test('toSrt: timestamp của đoạn sau không bao giờ nhỏ hơn đoạn trước', () => {
  // Mô phỏng trường hợp làm tròn sai: các mốc rất sát nhau
  const segs = [
    { start: 0.0, end: 0.0004, text: 'a' },
    { start: 0.0004, end: 0.0008, text: 'b' },
    { start: 0.0008, end: 0.001, text: 'c' },
  ];
  const times = [...E.toSrt(segs).matchAll(/(\d{2}:\d{2}:\d{2},\d{3}) -->/g)].map((m) => m[1]);
  for (let i = 1; i < times.length; i++) {
    assert.ok(times[i] >= times[i - 1], `dòng ${i}: ${times[i]} < ${times[i - 1]}`);
  }
});

test('toVtt: có header WEBVTT và dùng dấu chấm', () => {
  const vtt = E.toVtt([{ start: 1, end: 2, text: 'Chào' }]);
  assert.ok(vtt.startsWith('WEBVTT'));
  assert.ok(vtt.includes('00:00:01.000 --> 00:00:02.000'));
  assert.ok(!vtt.includes(','), 'VTT dùng dấu chấm, không dùng dấu phẩy');
});

test('toPlainText: có và không có timestamp', () => {
  const segs = [
    { start: 0, end: 1, text: 'Một' },
    { start: 1, end: 2, text: 'Hai' },
  ];
  assert.ok(E.toPlainText(segs).includes('[00:00:00.000] Một'));
  const plain = E.toPlainText(segs, { withTimestamps: false });
  assert.ok(!plain.includes('['), 'bản không timestamp không được có dấu [');
  assert.ok(plain.includes('Một Hai'));
});

test('toPlainText: gộp khoảng trắng thừa, giữ tiếng Trung nguyên vẹn', () => {
  const segs = [{ start: 0, end: 1, text: '  今天   天气  很好  ' }];
  assert.ok(E.toPlainText(segs, { withTimestamps: false }).includes('今天 天气 很好'));
});

test('toJson: có đủ metadata và timestamp từng từ', () => {
  const segs = [
    {
      start: 0,
      end: 1,
      text: 'Hello',
      words: [{ start: 0, end: 0.5, word: 'Hello' }],
    },
  ];
  const o = JSON.parse(E.toJson(segs, { title: 'T', url: 'u', model: 'small' }));
  assert.strictEqual(o.segmentCount, 1);
  assert.strictEqual(o.title, 'T');
  assert.strictEqual(o.segments[0].words.length, 1);
});

test('toJson: đoạn không có từ thì không sinh khoá words', () => {
  const o = JSON.parse(E.toJson([{ start: 0, end: 1, text: 'x' }], {}));
  assert.ok(!('words' in o.segments[0]), 'không nên sinh mảng words rỗng');
});

test('toMarkdown: có tiêu đề và khối thông tin', () => {
  const md = E.toMarkdown([{ start: 0, end: 1, text: 'Nội dung' }], {
    title: 'Tiêu đề',
    url: 'https://x',
  });
  assert.ok(md.startsWith('# Tiêu đề'));
  assert.ok(md.includes('https://x'));
  assert.ok(md.includes('**[00:00:00.000]** Nội dung'));
});

test('cleanText: xử lý null và undefined', () => {
  assert.strictEqual(E.cleanText(null), '');
  assert.strictEqual(E.cleanText(undefined), '');
  assert.strictEqual(E.cleanText('  a  b '), 'a b');
});

test('safeFilename: loại bỏ ký tử cấm trên Windows', () => {
  // Windows KHÔNG cho phép: < > : " / \ | ? *
  const out = E.safeFilename('a<b>c:d"e/f\\g|h?i*j');
  assert.ok(!/[<>:"/\\|?*]/.test(out), `còn ký tự cấm trong: ${out}`);
});

test('safeFilename: xử lý tên rỗng và tên quá dài', () => {
  assert.strictEqual(E.safeFilename(''), 'transcript');
  assert.strictEqual(E.safeFilename('   '), 'transcript');
  assert.strictEqual(E.safeFilename(null), 'transcript');
  assert.ok(E.safeFilename('a'.repeat(500)).length <= 120);
});

test('safeFilename: giữ lại tiếng Trong và dấu tiếng Việt', () => {
  assert.strictEqual(E.safeFilename('Hội nghị Tiếng Trung'), 'Hội nghị Tiếng Trung');
  assert.ok(E.safeFilename('视频标题').includes('视频'));
});

test('exportAs: ném lỗi rõ ràng khi định dạng không hợp lệ', () => {
  assert.throws(() => E.exportAs('khong-ton-tai', []), /Không hỗ trợ định dạng/);
});

test('exportAs: txtPlain và txt cùng phần mở rộng nhưng nội dung khác', () => {
  const segs = [{ start: 0, end: 1, text: 'Xin chào' }];
  const withTs = E.exportAs('txt', segs);
  const without = E.exportAs('txtPlain', segs);
  assert.notStrictEqual(withTs, without);
  assert.ok(withTs.includes('['));
  assert.ok(!without.includes('['));
});
