'use strict';

/**
 * CĂN GIỌNG ĐỌC VÀO KHUNG THỜI GIAN — BẢN CHÍNH XÁC.
 *
 * VẤN ĐỀ ĐÃ SỬA:
 *   Trước đây app dịch TỪNG ĐOẠN một (đoạn này -> 1 câu, đúng ánh xạ 1:1),
 *   nhưng đến lúc căn thì lại gộp tất cả thành một khối rồi chia tỉ lệ theo
 *   cả video. Việc đó phá hỏng đúng ánh xạ 1:1, nên câu thứ 3 của bản dịch
 *   không nằm ở khung của đoạn thứ 3 gốc. Đó là lý do bạn vẫn phải tự cắt ghép.
 *
 * CÁCH LÀM MỚI:
 *   Dịch nào giữ nguyên đoạn nào. Câu i của bản dịch được đặt vào ĐÚNG khung
 *   [start_i, end_i] của đoạn gốc thứ i. Nếu câu dịch dài hơn khung, nó được
 *   mở rộng vào khoảng im lặng phía sau — vì đó là khoảng trống thật, đang
 *   không có gì để mất. Chỉ khi vượt hẳn cả khoảng im lặng mới tua nhẹ.
 */

// Ngưỡng tua nhanh. 1.25 là mức người Việt vẫn chịu được khi tiếng Việt dài
// hơn tiếng Anh khoảng 25%; vượt quá thì nghe gượng và rất khó chịu.
// Khi bản dịch dài hơn mức này thì không còn cách nào giữ đồng bộ tuyệt đối —
// app sẽ báo rõ để người dùng tự rút gọn câu cho vừa.
const MAX_SPEEDUP = 1.25;

/**
 * Tốc độ ĐỒNG NHẤT cho cả bài.
 *
 * Quan trọng: nếu để mỗi câu tự tua theo sức chứa riêng, độ lệch sẽ CỘNG DỒN —
 * câu sau bị đẩy lùi thêm mỗi câu, đến cuối lệch hàng chục giây và hỏng đồng bộ
 * với hình. Tính một hệ số chung cho cả bài rồi áp đồng đều, sai số không tích
 * luỹ, và các câu vẫn giữ đúng khoảng cách với nhau.
 */
function globalSpeed(units, src, realDurations) {
  const span = src.length ? src[src.length - 1].end - src[0].start : 0;
  if (span <= 0) return 1;
  const need = units.reduce((a, u, i) => a + measured(u, realDurations, i), 0);
  if (need <= span) return 1;
  return Math.min(MAX_SPEEDUP, need / span);
}
const TAIL_PAD = 0.12;    // đuôi mỗi câu, giây

/**
 * Căn các câu đã dịch vào các đoạn gốc.
 *
 * @param {string[]} lines từng dòng bản dịch, theo thứ tự người dùng nhìn thấy
 * @param {Array<{start,end,text}>} segs các đoạn gốc, đã sắp xếp theo thời gian
 * @param {number[]|null} realDurations thời lượng THẬT của file voice (nếu đã tạo).
 *   Có rồi thì căn chính xác tuyệt đối; chưa có thì ước lượng theo độ dài chữ.
 * @returns {Array<{start,end,text,speed,overlap}>}
 */
function alignToSegments(lines, segs, realDurations = null) {
  const units = (lines || []).map((s) => String(s || '').trim()).filter(Boolean);
  const src = (segs || [])
    .map((s) => ({
      start: Number(s.start) || 0,
      end: Number(s.end) || 0,
      text: String(s.text || ''),
    }))
    .filter((s) => s.end > s.start)
    .sort((a, b) => a.start - b.start);

  if (!units.length || !src.length) return [];

  // Bỏ các đoạn gốc rỗng nhưng giữ đúng thứ tự để ánh xạ 1:1 không lệch.
  if (units.length === src.length) {
    return layout1to1(units, src, realDurations);
  }

  // Số câu lệch số đoạn (người dùng đã sửa/gộp/thêm câu): ánh xạ bằng
  // chỉ số theo tỉ lệ, rồi dùng chung bộ đặt xuống.
  const mapped = [];
  for (let i = 0; i < units.length; i++) {
    const j = units.length === 1 ? 0 : Math.round((i * (src.length - 1)) / (units.length - 1));
    mapped.push({ seg: src[j], segIndex: j, unitIndex: i });
  }
  return layoutManyToOne(units, src, mapped, realDurations);
}

/** Số câu = số đoạn: giữ đúng 1-1. */
function layout1to1(units, src, realDurations) {
  const g = globalSpeed(units, src, realDurations);
  const out = [];
  let prevEnd = -Infinity;
  for (let i = 0; i < units.length; i++) {
    const s = src[i];
    const need = measured(units[i], realDurations, i) / g;
    // Chỉ dồn khi thật sự cần (câu trước đã dài hơn khung của nó).
    let start = Math.max(s.start, prevEnd + 0.05);
    const dur = need;
    out.push({
      start: round3(start),
      end: round3(start + dur),
      text: units[i],
      speed: round3(g),
      segIndex: i,
    });
    prevEnd = start + dur;
  }
  return out;
}

/** Nhiều câu trên ít đoạn: dồn các câu vào từng đoạn, mở rộng vào khoảng im lặng. */
function layoutManyToOne(units, src, mapped, realDurations) {
  // Gom chỉ số đoạn của từng câu
  const bySeg = new Map();
  for (const m of mapped) {
    if (!bySeg.has(m.segIndex)) bySeg.set(m.segIndex, []);
    bySeg.get(m.segIndex).push(m.unitIndex);
  }
  const out = [];
  let prevEnd = -Infinity;
  for (let j = 0; j < src.length; j++) {
    const idxs = bySeg.get(j);
    if (!idxs || !idxs.length) continue;
    const s = src[j];
    const next = src[j + 1];
    const room = next ? Math.max(0, next.start - s.end) : Infinity;
    const allowed = Math.max(0.3, (s.end - s.start) + room * (next ? 0.85 : 1) + (next ? 0 : 1.5));

    let totalNeed = 0;
    for (const u of idxs) totalNeed += measured(units[u], realDurations, u);
    const gaps = idxs.length - 1;
    const speed = totalNeed > allowed ? Math.min(MAX_SPEEDUP, totalNeed / allowed) : 1;

    let cursor = Math.max(s.start, prevEnd + 0.05);
    idxs.forEach((u, k) => {
      const need = measured(units[u], realDurations, u) / speed;
      out.push({
        start: round3(cursor),
        end: round3(cursor + need),
        text: units[u],
        speed: round3(speed),
        segIndex: j,
      });
      cursor += need;
      if (k < gaps) cursor += Math.max(0.08, Math.min(0.5, (totalNeed / idxs.length) * 0.12));
    });
    prevEnd = cursor;
  }
  return out;
}

/** Thời lượng thật nếu có, ngược lại ước lượng theo số ký tự. */
function measured(unit, realDurations, i) {
  const d = Number(realDurations?.[i]);
  if (isFinite(d) && d > 0) return d;
  // Tiếng Việt đọc chậm hơn tiếng Anh, ước lượng ~14 ký tự/giây là hợp lý.
  return Math.max(0.5, unit.length / 14);
}

function round3(n) {
  return Math.round(n * 1000) / 1000;
}

/**
 * BƯỚC TINH CHÍNH: đo lại bằng thời lượng THẬT của file voice.
 *
 * Đây là bước quyết định độ khớp có đạt 95% hay không: khung đã đặt ở Bước 4
 * chỉ là ước lượng; tới đây mới biết chính xác từng file dài bao nhiêu giây.
 */
function refineWithRealDurations(planned, realDurations, originalSegments) {
  if (!Array.isArray(realDurations) || !realDurations.length) return planned;
  const src = (originalSegments || []).slice().sort((a, b) => a.start - b.start);
  const out = [];
  let prevEnd = -Infinity;

  // Tính hệ số chung từ TỔNG thời lượng thật, rồi áp đều cho mọi câu.
  const span = src.length ? src[src.length - 1].end - src[0].start : 0;
  let total = 0;
  for (let i = 0; i < planned.length; i++) {
    const d = Number(realDurations[i]);
    total += isFinite(d) && d > 0 ? d : Math.max(0.3, (planned[i].end - planned[i].start));
  }
  const g = span > 0 && total > span ? Math.min(MAX_SPEEDUP, total / span) : 1;

  for (let i = 0; i < planned.length; i++) {
    const p = planned[i];
    const raw = Number(realDurations[i]);
    const need = (isFinite(raw) && raw > 0 ? raw : p.end - p.start) / g;
    const seg = src[p.segIndex] || src[0];
    // Bám mốc gốc của đoạn; chỉ dồn ra nếu câu trước thực sự dài hơn.
    const start = Math.max(seg.start, prevEnd + 0.05);
    out.push({
      ...p,
      start: round3(start),
      end: round3(start + need),
      speed: round3(g),
    });
    prevEnd = start + need;
  }
  return out;
}

/** Báo cáo mức độ khớp: câu nào lệch bao nhiêu so với khung gốc. */
function alignmentReport(planned, originalSegments) {
  const segList = (originalSegments || []).slice().sort((a, b) => a.start - b.start);
  const drifts = planned.map((p) => {
    const seg = segList[p.segIndex];
    return seg ? Math.abs(p.start - seg.start) : 0;
  });
  const ok = drifts.filter((d) => d <= 0.75).length;
  const span = segList.length ? segList[segList.length - 1].end - segList[0].start : 0;
  const spoken = planned.reduce((a, p) => a + (p.end - p.start), 0);
  const speed = round3(planned[0]?.speed || 1);
  return {
    total: planned.length,
    onTarget: ok,
    percent: planned.length ? Math.round((ok / planned.length) * 100) : 0,
    maxDrift: drifts.length ? round3(Math.max(...drifts)) : 0,
    avgDrift: drifts.length ? round3(drifts.reduce((a, b) => a + b, 0) / drifts.length) : 0,
    // Cần người dùng rút gọn bản dịch tỉ lệ này thì mới khớp tuyệt đối.
    shortenBy: speed >= MAX_SPEEDUP - 0.001 && span > 0
      ? round3(spoken / span)
      : 0,
    speed,
  };
}

module.exports = {
  alignToSegments,
  globalSpeed,
  refineWithRealDurations,
  alignmentReport,
  MAX_SPEEDUP,
};
