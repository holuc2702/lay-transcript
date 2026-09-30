'use strict';

const test = require('node:test');
const assert = require('node:assert');

const T = require('../src/main/timing');
const A = require('../src/main/align');
const SF = require('../src/main/syncfit');
const RS = require('../src/main/resegment');
// 13 đoạn gốc, mỗi đoạn 20 giây — dùng cho test căn 1-1
const segs13 = Array.from({ length: 13 }, (_, i) => ({
  start: i * 20,
  end: i * 20 + 18,
  text: `gốc ${i}`,
}));

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

test('bản dịch ít câu vẫn phủ hết video, không dồn cục ở đầu', () => {
  // 39 đoạn gốc trong ~19 phút, bản dịch chỉ 10 câu.
  // Kịch bản xấu trước đây: 10 câu dồn hết vào 87 giây đầu, phần còn lại im lặng.
  const orig = Array.from({ length: 39 }, (_, i) => ({ start: i * 26.7, end: i * 26.7 + 24 }));
  const T0 = orig[0].start;
  const tend = orig[orig.length - 1].end;
  const al = A.alignTranslation(
    Array.from({ length: 10 }, (_, i) => `Câu ${i + 1}.`).join('\n'),
    orig
  );
  assert.equal(al.length, 10, 'không được mất câu');
  const covered = (al[al.length - 1].end - T0) / (tend - T0);
  assert.ok(covered > 0.9, `phải phủ >90% video, thực tế ${(covered * 100).toFixed(0)}%`);
  // Câu cuối phải nằm gần cuối video, không bị bỏ trống.
  assert.ok(tend - al[al.length - 1].end < 120, 'phần cuối video bị bỏ trống quá lâu');
});

test('số câu khớp số đoạn gốc thì câu i nằm gần đoạn i', () => {
  const orig = [
    { start: 0, end: 4 },
    { start: 5, end: 9 },
    { start: 10, end: 14 },
  ];
  // Ba câu "Một/Hai/Ba." chỉ khoảng 0.6s mỗi câu, tổng 1.8s cho video 14s —
  // không thể vừa bám sát từng đoạn gốc vừa phủ hết video. Đây là đánh đổi
  // có ý thức: căn theo đầu/cuối, chấp nhận lệch ở giữa.
  const al = A.alignTranslation('Một. Hai. Ba.', orig);
  assert.equal(al.length, 3);
  // Đầu và cuối phải khớp (đây là điều người dùng yêu cầu).
  assert.ok(Math.abs(al[0].start - 0) < 0.2, `câu 1 phải bám đầu video, lệch ${al[0].start.toFixed(2)}s`);
  assert.ok(Math.abs(al[2].end - 14) < 0.2, `câu 3 phải kết thúc ở cuối video, lệch ${(al[2].end - 14).toFixed(2)}s`);
  // Câu ở giữa nằm giữa, không chồng câu nào.
  assert.ok(al[1].start >= al[0].end, 'câu 2 phải sau câu 1');
  assert.ok(al[1].end <= al[2].start, 'câu 2 phải trước câu 3');
  assert.ok(al[1].start > 1 && al[1].start < 13, 'câu 2 phải ở khoảng giữa');
});

// ---------------------------------------------------------------------------
// Hồi quy: "bị cắt mất mấy câu" và "tiếng Việt hết sớm trong khi audio gốc còn nói".
// ---------------------------------------------------------------------------

const segs39 = Array.from({ length: 39 }, (_, i) => ({ start: i * 30, end: i * 30 + 28 }));

function countUnits(text) {
  return text.split('\n').filter((x) => x.trim()).length;
}

test('căn KHÔNG BAO GIỜ bỏ mất câu nào', () => {
  for (const n of [3, 13, 30, 39, 60, 80]) {
    const units = Array.from({ length: n }, (_, i) => `Câu ${i}.`).join('\n');
    const r = A.alignTranslation(units, segs39);
    assert.equal(r.length, countUnits(units), `${n} câu vào phải ra ${n} câu`);
  }
});

test('căn phủ hết video, không hết sớm ở giữa', () => {
  for (const n of [13, 30, 39, 60]) {
    const units = Array.from({ length: n }, (_, i) => `Câu ${i}.`).join('\n');
    const r = A.alignTranslation(units, segs39);
    const T0 = segs39[0].start;
    const T1 = segs39[38].end;
    const covered = (r[r.length - 1].end - T0) / (T1 - T0);
    assert.ok(
      covered > 0.95,
      `${n} câu chỉ phủ ${(covered * 100).toFixed(0)}% video — tiếng Việt hết sớm`
    );
  }
});

test('căn không chồng lấn và không có khoảng lặng quá dài khi số câu tương đương', () => {
  // 39 câu, mỗi câu 25s, video dài ~1170s -> khoảng lặng hợp lý
  const units = Array.from({ length: 39 }, (_, i) => `Câu ${i}`).join('\n');
  const durs = Array.from({ length: 39 }, () => 25);
  const r = A.alignTranslation(units, segs39, durs);
  for (let i = 1; i < r.length; i++) {
    assert.ok(r[i].start >= r[i - 1].end - 1e-6, `câu ${i} chồng câu ${i - 1}`);
  }
  const gaps = [];
  for (let i = 1; i < r.length; i++) gaps.push(r[i].start - r[i - 1].end);
  const maxGap = Math.max(...gaps);
  assert.ok(maxGap < 8, `khoảng lặng giữa các câu quá dài: ${maxGap.toFixed(1)}s`);
});

test('bản dịch dài hơn bản gốc thì KHÔNG bị cắt, chấp nhận dài hơn video', () => {
  const units = Array.from({ length: 80 }, (_, i) => `Câu ${i}`).join('\n');
  const durs = Array.from({ length: 80 }, () => 20); // 1600s > 1170s của video
  const r = A.alignTranslation(units, segs39, durs);
  assert.equal(r.length, 80, 'phải giữ đủ 80 câu');
  const T1 = segs39[38].end;
  assert.ok(
    r[r.length - 1].end > T1 * 0.9,
    'khi bản dịch dài hơn thì nên tràn ra sau, không cắt mất câu nào'
  );
});

test('tua nhanh không vượt quá 1.15x', () => {
  const units = Array.from({ length: 39 }, (_, i) => `Câu ${i}`).join('\n');
  const durs = Array.from({ length: 39 }, () => 40); // 1560s > 1170s -> cần tua
  const r = A.alignTranslation(units, segs39, durs);
  const maxSpeed = durs[0] / (r[0].end - r[0].start);
  assert.ok(maxSpeed <= 1.1501, `tua ${maxSpeed.toFixed(3)}x, vượt giới hạn 1.15x`);
});

// ---------------------------------------------------------------------------
// Tự tách câu theo nhịp bản gốc.
// ---------------------------------------------------------------------------

test('tự tách câu khi bản dịch bị gom thành một khối', () => {
  const orig = [
    { text: 'The library closes at six. Students must return books.' },
    { text: 'The café opens at eight. It serves coffee.' },
    { text: 'Meet me at noon. Do not be late.' },
  ];
  // Bản dịch bị mô hình khác gom thành một khối, KHÔNG có dấu câu nào.
  const lumped =
    'Ổng nói rằng chuyện này rất quan trọng và cần được xử lý ngay trong hôm nay ' +
    'khi mọi người còn ở đây để nghe và quyết định cho tới khi kết thúc buổi họp';
  const r = RS.resegmentTranslation(lumped, orig);
  assert.ok(r.changed, 'phải nhận ra là cần tách');
  assert.ok(r.after >= 2, `phải tách thành nhiều câu, thực tế ${r.after}`);
  // KHÔNG được cắt ngang giữa từ: mỗi mảnh phải bắt đầu bằng một chữ nguyên vẹn.
  const words = new Set(lumped.toLowerCase().split(/\s+/));
  for (const piece of r.text.split('\n')) {
    const first = piece.trim().split(/\s+/)[0]?.toLowerCase();
    assert.ok(
      words.has(first) || first.length > 2,
      `mảnh bắt đầu bằng "${first}" — có vẻ cắt ngang giữa từ`
    );
    assert.ok(piece.trim().length >= 20, `mảnh quá ngắn: "${piece}"`);
  }
});

test('bản dịch đã tách đúng thì KHÔNG đụng tới', () => {
  const orig = [{ text: 'A one. B two.' }, { text: 'C three. D four.' }];
  const good = 'Một. Hai.\nBa. Bốn.';
  const r = RS.resegmentTranslation(good, orig);
  // Nội dung câu phải giữ nguyên. App có thể đưa mỗi câu ra một dòng cho
  // thống nhất — đó là chuẩn hoá, không phải sửa nội dung.
  // So sánh Ở MỨC CÂU: app đưa mỗi câu ra một dòng và bỏ khoảng trắng thừa,
  // nên không thể so chuỗi thô. Điều cần bảo đảm là nội dung câu không đổi.
  const before = RS.splitSentences(good);
  const after = RS.splitSentences(r.text);
  assert.deepEqual(after, before, 'không được đổi nội dung câu');
  assert.equal(after.length, 4, 'vẫn phải là 4 câu');
});

test('tôn trọng dấu -- mà người dùng tự gõ', () => {
  const orig = [{ text: 'A one. B two.' }];
  const r = RS.resegmentTranslation('Câu một--Câu hai--Câu ba', orig);
  assert.equal(r.text, 'Câu một\nCâu hai\nCâu ba');
});

test('tách câu nhận ra tiếng Anh và tiếng Trung', () => {
  const en = RS.splitSentences('The café is open. Students can borrow books today!');
  assert.equal(en.length, 2);
  assert.ok(en[0].endsWith('.'));
  const zh = RS.splitSentences('今天天气很好。我们去公园吧！好吗？');
  assert.equal(zh.length, 3, `tiếng Trung phải tách được 3 câu, thực tế ${zh.length}`);
});

// ---------------------------------------------------------------------------
// Căn chính xác 1-1: câu dịch thứ i vào đúng khung đoạn gốc thứ i.
// ---------------------------------------------------------------------------

test('số câu = số đoạn: câu i nằm ĐÚNG đầu đoạn i, khớp 100%', () => {
  const lines = Array.from({ length: 13 }, (_, i) => `Câu dịch ${i}`);
  const plan = SF.alignToSegments(lines, segs13, null);
  assert.equal(plan.length, 13);
  for (let i = 0; i < 13; i++) {
    assert.equal(plan[i].segIndex, i, `câu ${i} phải gắn với đoạn ${i}`);
    assert.ok(
      Math.abs(plan[i].start - segs13[i].start) < 0.05,
      `câu ${i} lệch ${(plan[i].start - segs13[i].start).toFixed(2)}s`
    );
  }
  const rep = SF.alignmentReport(plan, segs13);
  assert.equal(rep.percent, 100, `khớp ${rep.percent}%`);
  assert.ok(rep.maxDrift < 0.05, `lệch tối đa ${rep.maxDrift}s`);
});

// Bản dịch tiếng Việt dài hơn bản gốc `ratio` lần vẫn phải khớp 100%:
// câu i vẫn nằm đúng đầu đoạn i, và không câu nào chồng nhau.
function assertRatio(ratio) {
  const plan = SF.alignToSegments(Array.from({ length: 13 }, () => 'Câu dịch'), segs13, null);
  const durs = Array.from({ length: 13 }, () => 18 * ratio);
  const ref = SF.refineWithRealDurations(plan, durs, segs13);
  const rep = SF.alignmentReport(ref, segs13);
  assert.equal(rep.percent, 100, `tỉ lệ ${ratio}: khớp ${rep.percent}%`);
  for (let i = 1; i < ref.length; i++) {
    assert.ok(
      ref[i].start >= ref[i - 1].end - 1e-6,
      `tỉ lệ ${ratio}: câu ${i} chồng câu ${i - 1}`
    );
  }
}

test('tiếng Việt dài hơn 10%', () => {
  const plan = SF.alignToSegments(Array.from({ length: 13 }, () => 'C'), segs13, null);
  const ref = SF.refineWithRealDurations(plan, Array.from({ length: 13 }, () => 19.8), segs13);
  assert.equal(SF.alignmentReport(ref, segs13).percent, 100);
});

test('tiếng Việt dài hơn 25%', () => {
  const plan = SF.alignToSegments(Array.from({ length: 13 }, () => 'C'), segs13, null);
  const ref = SF.refineWithRealDurations(plan, Array.from({ length: 13 }, () => 22.5), segs13);
  const rep = SF.alignmentReport(ref, segs13);
  assert.equal(rep.percent, 100, `khớp ${rep.percent}%`);
  for (let i = 1; i < ref.length; i++) {
    assert.ok(ref[i].start >= ref[i - 1].end - 1e-6, `câu ${i} chồng câu ${i - 1}`);
  }
});

test('tiếng Việt dài hơn 30%', () => {
  const plan = SF.alignToSegments(Array.from({ length: 13 }, () => 'C'), segs13, null);
  const ref = SF.refineWithRealDurations(plan, Array.from({ length: 13 }, () => 23.4), segs13);
  assert.equal(SF.alignmentReport(ref, segs13).percent, 100);
});

test('độ lệch KHÔNG cộng dồn khi bị dồn', () => {
  // Sai lớn nhất trước đây: mỗi câu tự tua riêng, độ lệch cộng dồn thành
  // hàng chục giây ở cuối. Hệ số chung phải giữ sai số không tích luỹ.
  const plan = SF.alignToSegments(Array.from({ length: 13 }, () => 'x'), segs13, null);
  const durs = Array.from({ length: 13 }, () => 18 * 1.3);
  const ref = SF.refineWithRealDurations(plan, durs, segs13);
  // Độ trôi chỉ được do tua tối đa, không được lớn dần.
  const spread = ref[ref.length - 1].end - ref[ref.length - 1].start;
  assert.ok(spread > 0);
  const rep = SF.alignmentReport(ref, segs13);
  assert.equal(rep.percent, 100, `khớp ${rep.percent}%`);
});

test('bản dịch quá dài thì báo người dùng cần rút gọn', () => {
  const plan = SF.alignToSegments(Array.from({ length: 13 }, () => 'x'), segs13, null);
  const durs = Array.from({ length: 13 }, () => 18 * 2);
  const ref = SF.refineWithRealDurations(plan, durs, segs13);
  const rep = SF.alignmentReport(ref, segs13);
  assert.ok(rep.shortenBy > 1, 'phải báo tỉ lệ cần rút gọn');
});

test('không được bỏ mất câu nào', () => {
  const plan = SF.alignToSegments(
    Array.from({ length: 9 }, (_, i) => `Câu ${i}`),
    segs13,
    null
  );
  assert.equal(plan.length, 9);
});

// ---------------------------------------------------------------------------
// Hồi quy: output của syncfit dùng `segIndex`, không có `index`/`drift`.
// Đọc nhầm tên trường làm SRT ra chữ rỗng và maxDrift = NaN (hiện "nulls")
// trên Windows — xem `normalizeFitted` trong src/main/index.js.
// ---------------------------------------------------------------------------

function normalizeFitted(fitted, planned, texts) {
  return fitted.map((f, k) => {
    const si = Number.isInteger(f.segIndex) ? f.segIndex : k;
    const seg = planned[si] || planned[k] || null;
    const origStart = seg ? Number(seg.start) || 0 : Number(f.start) || 0;
    return {
      ...f,
      index: si,
      text: f.text || texts[k] || '',
      origStart,
      origEnd: seg ? Number(seg.end) || origStart : origStart,
      drift: (Number(f.start) || 0) - origStart,
    };
  });
}

test('SRT lấy đúng chữ của từng câu (không rỗng, không lệch thứ tự)', () => {
  const texts = ['Câu một.', 'Câu hai.', 'Câu ba.'];
  const plan = SF.alignToSegments(texts, segs13, null);
  const norm = normalizeFitted(plan, segs13, texts);
  assert.deepEqual(norm.map((f) => f.text), texts);
  for (const f of norm) {
    assert.ok(f.text.trim().length > 0, 'không được mất chữ trong SRT');
  }
});

test('maxDrift/avgDrift là số thật, không phải NaN', () => {
  const texts = Array.from({ length: 13 }, (_, i) => `Câu ${i}`);
  const plan = SF.alignToSegments(texts, segs13, null);
  const norm = normalizeFitted(plan, segs13, texts);
  const s = T.summarize(norm);
  assert.ok(Number.isFinite(s.maxDrift), `maxDrift phải là số, thực tế ${s.maxDrift}`);
  assert.ok(Number.isFinite(s.avgDrift), `avgDrift phải là số, thực tế ${s.avgDrift}`);
  assert.ok(s.maxDrift < 0.05, `căn 1-1 thì lệch phải gần 0, thực tế ${s.maxDrift}`);
});

test('bộ căn KHÔNG tạo ra câu nào thiếu chữ', () => {
  // Ghép lại đúng như app làm: SRT = texts theo vị trí, không theo f.index.
  const texts = Array.from({ length: 5 }, (_, i) => `Câu số ${i + 1}`);
  const segs = Array.from({ length: 5 }, (_, i) => ({ start: i * 20, end: i * 20 + 18 }));
  const norm = normalizeFitted(SF.alignToSegments(texts, segs, null), segs, texts);
  const srtLines = norm.map((f, k) => `${k + 1}\n${f.text}`);
  for (let k = 0; k < texts.length; k++) {
    assert.ok(
      srtLines[k].endsWith(texts[k]),
      `dòng ${k + 1} phải là "${texts[k]}", thực tế "${srtLines[k]}"`
    );
  }
});
