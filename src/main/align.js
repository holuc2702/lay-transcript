'use strict';

/**
 * Căn giọng đọc vào khung thời gian của bản gốc.
 *
 * NGUYÊN TẮC (theo yêu cầu: căn đầu và cuối, không cần chính xác từng từ):
 *   1. Câu đầu neo vào đoạn gốc ĐẦU TIÊN, câu cuối neo vào đoạn gốc CUỐI CÙNG.
 *      -> không bỏ trống phần đầu lẫn phần cuối video.
 *   2. Tuyệt đối KHÔNG bỏ câu nào. Trước đây thuật toán bỏ qua các câu vượt quá
 *      khung -> mất nội dung, nghe dính lúc đó.
 *   3. Nếu bản dịch nói LÂU hơn bản gốc thì tua nhẹ tối đa 1.15x, phần còn
 *      lại thì kéo dài khoảng nghỉ thay vì cắt. Audio dài hơn video một chút
 *      vẫn hơn là mất câu.
 *   4. Nếu bản dịch nói NGẮN hơn, phần thời gian dư được rải đều thành khoảng
 *      nghỉ giữa các câu, thay vì dồn hết lên đầu.
 */

/** Tách văn bản thành các câu, giữ dấu câu ở cuối. */
function splitSentences(text) {
  const t = String(text || '').replace(/\r/g, '').trim();
  if (!t) return [];
  // Nhiều dòng -> mỗi dòng là một câu (người dùng đã ngắt sẵn).
  const lines = t.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length > 1) return lines;

  // Dấu '--' do người dùng tự đánh dấu ranh giới thời gian -> tôn trọng tuyệt đối.
  if (t.includes('--')) {
    return t.split('--').map((l) => l.trim()).filter(Boolean);
  }

  const out = [];
  let buf = '';
  for (let i = 0; i < t.length; i++) {
    buf += t[i];
    if (/[.!?。！？]/.test(t[i])) {
      if (/[0-9]/.test(t[i + 1] || '')) continue; // "3.5" không phải kết câu
      while (/[)\]"'\u201d\u2019]/.test(t[i + 1] || '')) {
        i++;
        buf += t[i];
      }
      out.push(buf.trim());
      buf = '';
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out.filter(Boolean);
}

function round3(n) {
  return Math.round(n * 1000) / 1000;
}

const MAX_SPEEDUP = 1.15; // tua nhanh toi da, van chua me
const GAP = 0.15;        // nghi giua hai cau, giay
const HEAD_SLACK = 0.3;   // duoc len truoc moc goc mot chut
const MAX_TAIL_DRIFT = 2.0; // cho phep tran toi da 2 giay o cuoi

/**
 * @param {string} translatedText ban dich (chua co so phut)
 * @param {Array<{start:number,end:number}>} originalSegments khung thoi gian goc
 * @param {number[]} realDurations do dai THAT cua file voice tung cau (neu biet).
 *   Biet thi dung de uu tien phan bo thoi gian cho doi thoai dai hon.
 * @returns {Array<{start:number,end:number,text:string}>}
 */
function alignTranslation(translatedText, originalSegments, realDurations = null) {
  const segs = (originalSegments || [])
    .map((s) => ({ start: Number(s.start) || 0, end: Number(s.end) || 0 }))
    .filter((s) => s.end > s.start)
    .sort((a, b) => a.start - b.start);
  const units = splitSentences(translatedText);
  if (!segs.length || !units.length) return [];

  const m = segs.length;
  const n = units.length;
  const T0 = segs[0].start;
  const T1 = segs[m - 1].end;
  const totalSpan = Math.max(0.2, T1 - T0);

  // Thời lượng cần đọc mỗi câu. Ưu tiên số đo thật; nếu chưa có thì ước lượng
  // theo số ký tự (tiếng Việt đọc chậm hơn tiếng Anh một chút).
  const need = units.map((u, i) => {
    const d = Number(realDurations?.[i]);
    if (isFinite(d) && d > 0) return d;
    return Math.max(0.6, (u.length / 14) * 1.0);
  });
  const totalNeed = need.reduce((a, b) => a + b, 0);

  // ------------------------------------------------------------------
  // Tua nếu bản dịch nói dài hơn khung gốc (có giới hạn 1.15x).
  // Vượt quá mức đó thì thà kéo dài ra, KHÔNG cắt bớt.
  // ------------------------------------------------------------------
  const fit = totalNeed / (totalSpan * (1 + 0.08)); // chừa 8% cho khoảng nghỉ
  const speed = fit > MAX_SPEEDUP ? MAX_SPEEDUP : Math.max(1, fit);
  const spoken = need.map((d) => d / speed);
  const totalSpoken = spoken.reduce((a, b) => a + b, 0);

  // Thời gian nghỉ còn dư để rải giữa các câu.
  const spare = Math.max(0, totalSpan - totalSpoken);

  // ------------------------------------------------------------------
  // Bố trí theo TỈ LỆ trên toàn bộ khoảng thời gian gốc.
  //
  // Công thức: câu i bắt đầu ở T0 + (tiền tích đã nói / tổng kế hoạch) * tổng dải.
  // Nhờ vậy: câu đầu neo đúng đầu video, câu cuối kết thúc gần cuối video, và
  // phần thời gian dư được rải đều thành khoảng nghỉ vừa phải — không dồn cục
  // ở đầu, cũng không để audio hết sớm hàng phút ở cuối.
  // ------------------------------------------------------------------
  // ------------------------------------------------------------------
  // Bố trí: câu đầu neo ở T0, câu cuối KẾT THÚC ở T1, các câu giữa rải đều theo
  // thời lượng nói của chúng.
  //
  // Nhờ vậy audio luôn phủ hết video (không hết sớm khi bản dịch ngắn hơn), và
  // khoảng lặng được chia đều thay vì dồn cục. Trần 12s cho khoảng lặng giữa các
  // câu; phần dư ngoài trần đẩy sang cuối để vẫn phủ hết video.
  // ------------------------------------------------------------------
  const out = [];
  const nSlots = Math.max(1, n - 1);
  // Toàn bộ phần thời gian dư chia đều ra các khe GIỮA các câu; đầu neo chặt
  // vào T0, cuối neo chặt vào T1. Nhờ vậy audio luôn phủ hết video.
  //
  // Không đặt trần cho khoảng lặng: nếu bản dịch ngắn hơn hẳn bản gốc thì
  // khoảng lặng dài là điều không tránh khỏi, và thà khoảng lặng còn hơn là
  // bỏ trống đuôi video. Muốn khoảng lặng vừa phải thì bản dịch cần đủ số câu.
  const gapInterior = Math.max(0, spare) / nSlots;

  let acc = 0;
  for (let i = 0; i < n; i++) {
    let start;
    if (i === n - 1) {
      // Câu cuối: kết thúc đúng ở cuối video, không bỏ trống đuôi.
      start = T1 - spoken[i];
    } else {
      // Vị trí = T0 + (thời gian đã nói xong / tổng kế hoạch) * tổng dải.
      // Dùng `acc` TRƯỚC khi cộng khoảng nghỉ, nếu không câu đầu sẽ bị đẩy
      // lệch đúng một khoảng nghỉ.
      const share = acc / Math.max(0.001, totalSpoken + gapInterior * nSlots);
      start = T0 + share * totalSpan;
      // Nhẹ nhàng bám theo đoạn gốc khi đã rất gần — nghe khớp hình, nhưng chỉ
      // khi gần, để không hình thành khoảng lặng dài ở giữa.
      const seg = segs[Math.round((i * (m - 1)) / nSlots)];
      if (seg && Math.abs(seg.start - start) < 0.5) start = seg.start;
    }
    if (i > 0 && start < out[i - 1].end + 0.05) start = out[i - 1].end + 0.05;
    const end = start + spoken[i];
    out.push({ start: round3(start), end: round3(end), text: units[i] });
    acc += spoken[i] + gapInterior;
  }

  // Bảo đảm bất biến: không chồng, không âm, không mất câu nào.
  let c = -Infinity;
  for (let i = 0; i < out.length; i++) {
    if (out[i].start < c) out[i].start = c;
    if (out[i].end <= out[i].start) out[i].end = out[i].start + 0.3;
    c = out[i].end + (i < out.length - 1 ? GAP : 0);
  }
  return out;
}

/**
 * Đọc file bản dịch: chấp nhận .txt, .srt, .vtt.
 * File có sẵn số phút thì bỏ số phút đi, chỉ giữ lời thoại.
 */
function parseTranslatedFile(content) {
  const text = String(content || '').replace(/^﻿/, '').trim();
  if (!text) return { text: '', hadTimestamps: false };

  const hasTime = /^\s*\d{1,2}:\d{2}:\d{2}[.,]\d{1,3}\s*-->/m.test(text);
  if (hasTime) {
    const lines = text
      .split(/\r?\n/)
      .filter((l) => !/^\s*\d+\s*$/.test(l))
      .filter((l) => !/-->/.test(l))
      .filter((l) => l.trim() && !/^WEBVTT/i.test(l));
    return { text: lines.join('\n'), hadTimestamps: true };
  }
  return { text, hadTimestamps: false };
}

module.exports = { splitSentences, alignTranslation, parseTranslatedFile, MAX_SPEEDUP, GAP };
