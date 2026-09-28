'use strict';

/**
 * Tự tách bản dịch thành câu, BÁM THEO CẤU TRÚC CÂU CỦA BẢN GỐC.
 *
 * VÌ SAO CẦN:
 *   Bản dịch từ Whisper vốn đã đúng ranh giới câu. Nhưng khi bạn đưa bản dịch
 *   lên một mô hình khác dịch lại toàn bộ, mô hình đó thường trả về MỘT khối
 *   văn bản dài, gom nhiều câu vào nhau và đánh dấu câu bị bỏ. Nếu đưa thẳng
 *   khối đó vào, app sẽ đọc liền một mạch, nghe rất khó chịu.
 *
 * CÁCH LÀM:
 *   Bản gốc có N đoạn, trong đó có các dấu kết câu. Ta tách bản gốc thành các
 *   "mẫu số câu" (V1, V2, ... theo số ký tự), rồi cắt bản dịch sao cho câu
 *   thứ i của bản dịch có độ dài gần câu thứ i của bản gốc.
 *
 *   Nếu bản dịch vốn ĐÃ tách câu đúng, kết quả gần như giữ nguyên.
 *   Nếu bản dịch gom thành khối, nó được cắt lại theo đúng nhịp bản gốc.
 */

const SENT_END = /[.!?。！？…]["'”’)\]]*\s*/g;
// Dấu phẩy / chấm phẩy + từ nối tiếp: dùng làm ranh giới phụ khi không có
// dấu kết câu nào trong một khoảng dài.
const SOFT_BREAK = /[,;:，、；：—–]\s*/g; // KHÔNG có '-': dấu '--' là ký hiệu tách câu do người dùng gõ

/** Tách văn bản thành câu, giữ dấu kết câu. */
function splitSentences(text) {
  const t = String(text || '').replace(/\r/g, '').trim();
  if (!t) return [];
  const out = [];
  let buf = '';
  let last = 0;
  let m;
  SENT_END.lastIndex = 0;
  while ((m = SENT_END.exec(t)) !== null) {
    // Phần chữ GIỮA hai dấu câu cũng phải vào buf. Trước đây chỉ nối m[0]
    // nên toàn bộ nội dung biến mất, chỉ còn lại dấu chấm.
    buf += t.slice(last, m.index) + m[0];
    last = m.index + m[0].length;
    // "3.5" không phải kết câu
    if (/^\s*\d/.test(t.slice(last, last + 1))) continue;
    const piece = buf.trim();
    if (piece) out.push(piece);
    buf = '';
  }
  buf += t.slice(last);
  if (buf.trim()) out.push(buf.trim());
  return out;
}

/** Nhịp cắt mong muốn, lấy từ câu của bản gốc. */
function rhythmFromOriginal(originalSegments) {
  const texts = (originalSegments || [])
    .map((s) => String(s.text || '').trim())
    .filter(Boolean);
  if (!texts.length) return [];

  // Bản gốc đã có sẵn ranh giới: dùng luôn độ dài từng câu của nó.
  const sentences = [];
  for (const t of texts) {
    const parts = splitSentences(t);
    if (parts.length) sentences.push(...parts);
    else sentences.push(t);
  }
  return sentences.map((s) => s.length).filter((n) => n > 0);
}

/** Tách câu của bản gốc (dùng để hiển thị đối chiếu). */
function originalSentences(originalSegments) {
  const out = [];
  for (const s of originalSegments || []) {
    const t = String(s.text || '').trim();
    if (!t) continue;
    const parts = splitSentences(t);
    out.push(...(parts.length ? parts : [t]));
  }
  return out;
}

/**
 * Cắt bản dịch theo nhịp của bản gốc.
 *
 * @param {string} translatedText bản dịch (có thể là một khối dài)
 * @param {Array<{text:string}>} originalSegments bản gốc
 * @returns {{ text: string, changed: boolean, before: number, after: number }}
 */
function resegmentTranslation(translatedText, originalSegments) {
  const raw = String(translatedText || '').replace(/\r/g, '').trim();
  if (!raw) return { text: '', changed: false, before: 0, after: 0 };

  // Người dùng gõ dấu '--' để tự tách câu -> TÔN TRỌNG TUYỆT ĐỐI, không
  // được đụng tới. (Trước đây regex dấu câu nuốt mất '--' và phá nát bản dịch.)
  if (raw.includes('--')) {
    const parts = raw.split('--').map((x) => x.trim()).filter(Boolean);
    return { text: parts.join('\n'), changed: false, before: parts.length, after: parts.length };
  }

  const before = splitSentences(raw).length;
  const rhythm = rhythmFromOriginal(originalSegments);

  // Bản gốc không có nhịp dùng được -> chỉ tách bằng dấu câu.
  if (rhythm.length < 2) {
    const parts = splitSentences(raw);
    return { text: parts.join('\n'), changed: parts.length !== 1, before, after: parts.length };
  }

  const totalLen = raw.length;
  const totalRhythm = rhythm.reduce((a, b) => a + b, 0);

  // Bản dịch đã có số câu tương đương bản gốc -> không cần cắt thêm.
  if (Math.abs(before - rhythm.length) <= Math.max(1, Math.round(rhythm.length * 0.15))) {
    const kept = splitSentences(raw).join('\n');
    return { text: kept, changed: kept.replace(/\s*\n\s*/g, '\n') !== raw.replace(/\s*\n\s*/g, '\n'), before, after: before };
  }

  // Số nhịp cắt bị giới hạn bởi độ dài tối thiểu của một mệnh đề.
  //
  // Không giới hạn thì bản dịch ngắn sẽ bị chém thành các mảnh 6-8 ký tự,
  // cắt ngang giữa tiếng Việt ("rằng chu" + "yện này"). Một mệnh đề đọc được
  // cần khoảng 24 ký tự trở lên.
  const MIN_PIECE = 24;
  const maxCuts = Math.max(1, Math.floor(totalLen / MIN_PIECE));
  const cutsWanted = Math.min(rhythm.length, maxCuts);

  const out = [];
  let pos = 0;
  for (let i = 0; i < cutsWanted && pos < totalLen; i++) {
    const want = Math.max(
      MIN_PIECE,
      Math.round((rhythm[i] / totalRhythm) * totalLen * 1.6)
    );
    let end = Math.min(totalLen, pos + want);

    if (end < totalLen) {
      // Ưu tiên dấu kết câu gần điểm cắt (trong cửa sổ ±40%).
      const lo = Math.max(pos + 5, Math.round(pos + want * 0.6));
      const hi = Math.min(totalLen - 1, Math.round(pos + want * 1.4));
      const window = raw.slice(lo, hi);
      let cut = -1;
      for (const re of [SENT_END, SOFT_BREAK]) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(window)) !== null) {
          if (m[0].trim()) {
            cut = lo + m.index + m[0].length;
            break;
          }
        }
        if (cut > 0) break;
      }
      if (cut < 0) {
        // Không có dấu câu: cắt tại KHOẢNG TRẮNG phía SAU điểm cắt, để không
        // chém ngang giữa từ. Cắt ra sau khi khoảng trắng.
        const fwd = raw.indexOf(' ', end);
        const back = raw.lastIndexOf(' ', end);
        if (fwd > 0 && fwd - end <= 14) cut = fwd + 1;
        else if (back > pos + 5) cut = back + 1;
        else cut = end;
      }
      const piece = raw.slice(pos, cut).trim();
      if (piece) out.push(piece);
      pos = cut;
    } else {
      const rest = raw.slice(pos).trim();
      if (rest) out.push(rest);
      pos = totalLen;
    }
  }
  if (pos < totalLen) {
    const rest = raw.slice(pos).trim();
    if (rest) out.push(rest);
  }

  const clean = out.filter(Boolean);
  return { text: clean.join('\n'), changed: true, before, after: clean.length };
}

module.exports = { splitSentences, resegmentTranslation, originalSentences, rhythmFromOriginal };
