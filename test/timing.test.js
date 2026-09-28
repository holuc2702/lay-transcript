'use strict';

const test = require('node:test');
const assert = require('node:assert');

const T = require('../src/main/timing');
const A = require('../src/main/align');

/**
 * Hồi quy cho lỗi "đọc liên tục, không khớp script".
 *
 * Nguyên nhân: dubbing:run đưa {file, duration} cho bộ căn mà QUÊN start/end.
 * Bộ căn thấy mọi đoạn là [0,0] -> khung chỉ 0.2s -> xếp từ giây 0 liền nhau,
 * không khoảng nghỉ, tổng thời lượng rút xuống còn ~ một nửa video.
 */

test('bộ căn GIỮ khoảng nghỉ khi có start/end thật', () => {
  // Video dài 200s, lời thoại xen kẽ khoảng nghỉ
  const items = [
    { start: 0, end: 5, duration: 4.5 },
    { start: 40, end: 45, duration: 4.5 },
    { start: 90, end: 95, duration: 4.5 },
    { start: 150, end: 155, duration: 4.5 },
  ];
  const f = T.fitSegments(items);

  // Không được dồn về đầu
  assert.ok(f[0].start < 2, `đoạn 1 phải bắt đầu gần 0, thực tế ${f[0].start}`);
  assert.ok(f[1].start > 30, `đoạn 2 phải ở khoảng 40s, thực tế ${f[1].start}`);
  assert.ok(f[3].start > 140, `đoạn 4 phải ở khoảng 150s, thực tế ${f[3].start}`);

  // Phải có khoảng nghỉ giữa các đoạn
  for (let i = 1; i < f.length; i++) {
    const gap = f[i].start - f[i - 1].end;
    assert.ok(gap > 1, `giữa đoạn ${i} và ${i + 1} phải có khoảng nghỉ, thực tế ${gap.toFixed(2)}s`);
  }
});

test('bộ căn tự dựng lại khung khi thiếu start/end (không xếp dồn)', () => {
  // Trường hợp đã gây lỗi: không có start/end
  const items = Array.from({ length: 8 }, () => ({ duration: 4 }));
  const f = T.fitSegments(items);

  // Trước khi sửa, tất cả nằm sát nhau trong ~30s. Nay phải giãn ra có nghỉ.
  for (let i = 1; i < f.length; i++) {
    const gap = f[i].start - f[i - 1].end;
    assert.ok(gap > 0.1, `đoạn ${i} phải có khoảng nghỉ, thực tế ${gap.toFixed(3)}s`);
  }
  const span = f[f.length - 1].end - f[0].start;
  assert.ok(span > 8 * 4 * 0.9, `tổng độ dài ${span}s phải lớn hơn tổng lời thoại`);
});

test('bộ căn không bao giờ tua vượt 1.15x và không chồng lấn', () => {
  const rnd = (i) => ({ start: i * 20, end: i * 20 + 12, duration: 3 + (i % 5) * 2 });
  const f = T.fitSegments(Array.from({ length: 30 }, (_, i) => rnd(i)));
  for (const x of f) {
    assert.ok(x.speed >= 1, `speed ${x.speed} phải >= 1`);
    assert.ok(x.speed <= 1.1501, `speed ${x.speed} vượt giới hạn`);
    assert.ok(x.end > x.start, 'end phải lớn hơn start');
  }
  for (let i = 1; i < f.length; i++) {
    assert.ok(f[i].start >= f[i - 1].end - 1e-6, `đoạn ${i} chồng đoạn ${i - 1}`);
  }
  assert.equal(T.summarize(f).overlapped, 0);
});

test('bản dịch ngắn hơn nhiều vẫn trải đều khắp video', () => {
  // 39 đoạn gốc trong 17 phút, bản dịch chỉ 10 câu
  const orig = Array.from({ length: 39 }, (_, i) => ({ start: i * 26.7, end: i * 26.7 + 24 }));
  const tend = orig[orig.length - 1].end;
  const al = A.alignTranslation(
    Array.from({ length: 10 }, (_, i) => `Câu ${i + 1}.`).join('\n'),
    orig
  );
  assert.equal(al.length, 10);
  const covered = al[al.length - 1].end / tend;
  assert.ok(covered > 0.7, `phải phủ >70% video, thực tế ${(covered * 100).toFixed(0)}%`);
  // Và khi đưa qua bộ căn, khoảng nghỉ vẫn còn
  const f = T.fitSegments(al.map((x) => ({ start: x.start, end: x.end, duration: 6 })));
  for (let i = 1; i < f.length; i++) {
    assert.ok(f[i].start - f[i - 1].end > 5, 'phải giữ khoảng nghỉ lớn giữa các câu');
  }
});

test('số câu dịch khớp số đoạn gốc thì neo đúng từng câu', () => {
  const orig = [
    { start: 0, end: 4 },
    { start: 5, end: 9 },
    { start: 10, end: 14 },
  ];
  const al = A.alignTranslation('Một. Hai. Ba.', orig);
  assert.equal(al.length, 3);
  assert.ok(al[0].start < 1.5, `câu 1 phải ở đoạn 1, thực tế ${al[0].start}`);
  assert.ok(al[1].start >= 4.5 && al[1].start < 9.5, `câu 2 phải ở đoạn 2, thực tế ${al[1].start}`);
  assert.ok(al[2].start >= 9.5, `câu 3 phải ở đoạn 3, thực tế ${al[2].start}`);
});
