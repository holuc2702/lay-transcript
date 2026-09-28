'use strict';

/**
 * Căn một BẢN DỊCH CHƯA CÓ TIMESTAMP vào khung thời gian của bản gốc.
 *
 * Tình huống: bạn có sẵn bản dịch tiếng Việt (file .txt, hoặc .srt không có
 * số phút) nhưng không có số giây. Muốn lồng tiếng thì phải biết câu nào nằm
 * ở giây thứ mấy.
 *
 * THUẬT TOÁN — phân bổ theo trọng số:
 *   1. Tách bản dịch thành các đơn vị (câu theo dấu câu, hoặc theo dòng nếu
 *      bản dịch nhiều dòng — vì khi đó ranh giới câu đã rõ).
 *   2. Với mỗi đơn vị, tính "độ dài nói" xấp xỉ = số ký tự. Ngôn ngữ tiếng Việt
 *      đọc chậm hơn tiếng Anh, nên dùng thêm hệ số ngôn ngữ nếu biết.
 *   3. Chia tỉ lệ thời lượng của các đoạn gốc CHO CÁC ĐƠN VỊ dịch, sao cho:
 *          - tổng thời lượng khớp tổng thời lượng gốc
 *          - ranh giới giữa các câu dịch trùng ranh giới giữa các đoạn gốc
 *            (đây là điểm quan trọng nhất: câu dịch thứ N nên nằm đúng chỗ câu
 *             gốc thứ N)
 *   4. Trả về danh sách { start, end, text } dùng để tạo voice.
 *
 * Đây là phép nội suy, không phải forced alignment thật (dựa trên mô hình
 * acoustic). Nói cách khác: câu dịch sẽ rơi đúng vị trí nói của câu gốc tương
 * ứng — nghe khớp ở mức đoạn, không khớp từng từ. Với lồng tiếng thế này là đủ.
 */

/** Tách văn bản thành các câu, giữ dấu câu ở cuối. */
function splitSentences(text) {
  const t = String(text || '').replace(/\r/g, '').trim();
  if (!t) return [];
  // Nhiều dòng -> mỗi dòng là một đơn vị (người dùng đã ngắt sẵn, thường là
  // bản dịch đã khớp với cấu trúc câu gốc).
  const lines = t.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length > 1) return lines;

  // Một dòng -> tách theo dấu kết câu, nhưng dấu . ở giữa số (3.5) không tách.
  const out = [];
  let buf = '';
  for (let i = 0; i < t.length; i++) {
    buf += t[i];
    if (/[.!?。！？]/.test(t[i])) {
      // Không tách nếu sau dấu câu là chữ số (ví dụ "3.5")
      if (/[0-9]/.test(t[i + 1] || '')) continue;
      // Dấu đóng ngoặc/trích dẫn ngay sau vẫn thuộc câu này
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

/**
 * @param {string} translatedText bản dịch chưa có số phút
 * @param {Array<{start:number,end:number}>} originalSegments khung thời gian gốc
 * @returns {Array<{start:number,end:number,text:string}>}
 */
function alignTranslation(translatedText, originalSegments) {
  const segs = (originalSegments || [])
    .map((s) => ({ start: Number(s.start) || 0, end: Number(s.end) || 0 }))
    .filter((s) => s.end > s.start);
  const units = splitSentences(translatedText);
  if (!segs.length || !units.length) return [];

  const totalOrig = segs.reduce((a, s) => a + (s.end - s.start), 0);
  const weights = units.map((u) => Math.max(1, u.length));
  const totalW = weights.reduce((a, b) => a + b, 0);

  // Chọn cách chia.
  //
  // Số câu dịch và số đoạn Whisper THƯỜNG KHÔNG BẰNG NHAU: một câu tiếng Anh
  // có thể bị Whisper cắt thành 3-4 đoạn. Nếu cứ neo câu dịch thứ N vào đoạn
  // gốc thứ N, tất cả bản dịch sẽ dồn cục ở đầu video và phần cuối bị im lặng
  // (đã gặp: 5 câu dịch nằm trong 87s đầu của video 839s).
  //
  //   - Số câu và số đoạn cùng cỡ  -> neo theo ranh giới đoạn gốc (đồng bộ tốt).
  //   - Lệch nhiều                     -> chia đều theo trọng số trên TOÀN BỘ
  //                                        khoảng thời gian của video.
  const n = units.length;
  const m = segs.length;
  // Biên 2.0 quá rộng: 10 câu / 5 đoạn bị xếp vào nhánh "neo" rồi tràn ra
  // ngoài cuối video (142%). Dùng 1.4 cho cả hai phía.
  const anchored = n >= m * 0.7 && n <= m * 1.4;

  if (!anchored) {
    // Chia đều theo trọng số trên toàn bộ dải thời gian gốc.
    const first = segs[0].start;
    const out = [];
    let acc = 0;
    for (let i = 0; i < n; i++) {
      const dur = (weights[i] / totalW) * totalOrig;
      out.push({ start: round3(first + (acc / totalW) * totalOrig), end: round3(first + ((acc + weights[i]) / totalW) * totalOrig), text: units[i] });
      acc += weights[i];
    }
    return out.map((x, i) => ({ ...x, index: i }));
  }

  // Chia theo ranh giới đoạn gốc: giữ đồng bộ từng câu.
  const out = [];
  let unitIdx = 0;
  let wLeft = totalW;
  let tLeft = totalOrig;

  for (let i = 0; i < m; i++) {
    const segDur = segs[i].end - segs[i].start;
    // Khai báo TRƯỚC khối xử lý đoạn cuối — trước đây khai báo sau nên
    // nhánh cuối gặp "Cannot access 'cursor' before initialization".
    let cursor = Math.max(segs[i].start, out.length ? out[out.length - 1].end : segs[i].start);
    if (i === m - 1) {
      // Đoạn cuối: phần đơn vị còn lại phải VỪA khung còn trống, không được
      // tràn ra sau mốc cuối của video gốc.
      let room = Math.max(0, segs[i].end - Math.max(segs[i].start, cursor));
      const rest = units.slice(unitIdx);
      const restW = rest.reduce((a, _, k) => a + weights[unitIdx + k], 0) || 1;
      for (; unitIdx < n; unitIdx++) {
        if (room <= 0.01) break; // hết chỗ -> bỏ phần dư thay vì làm tràn
        const share = (weights[unitIdx] / restW) * Math.max(room, segDur);
        const dur = Math.min(share, room);
        out.push({ start: round3(cursor), end: round3(cursor + dur), text: units[unitIdx] });
        cursor += dur;
        room -= dur;
      }
      break;
    }
    const share = tLeft > 0 ? (segDur / tLeft) * wLeft : wLeft / (n - unitIdx);
    let acc = 0;
    while (unitIdx < n && acc < share - 1e-9) {
      const need = weights[unitIdx];
      const take = Math.min(need, share - acc);
      const frac = need > 0 ? take / need : 0;
      const pieceDur = segDur * frac;
      out.push({ start: round3(cursor), end: round3(cursor + pieceDur), text: units[unitIdx] });
      cursor += pieceDur;
      acc += take;
      unitIdx++;
    }
    tLeft -= segDur;
    wLeft -= acc;
  }

  // Bảo đảm start < end và không chồng lấn
  for (let i = 0; i < out.length; i++) {
    if (out[i].end <= out[i].start) out[i].end = out[i].start + 0.3;
    if (i > 0 && out[i].start < out[i - 1].end) {
      const shift = out[i - 1].end - out[i].start;
      out[i].start = round3(out[i].start + shift);
      out[i].end = round3(out[i].end + shift);
    }
  }
  return out;
}

function round3(n) {
  return Math.round(n * 1000) / 1000;
}

/**
 * Đọc file bản dịch: chấp nhận .txt, .srt, .vtt.
 * Nếu file CÓ số thời gian thì trả về null (báo người dùng dùng luôn bản đó).
 */
function parseTranslatedFile(content) {
  const text = String(content || '').replace(/^﻿/, '').trim();
  if (!text) return { text: '', hadTimestamps: false };

  // Nhận diện SRT/VTT: có dòng "00:00:00,000 --> 00:00:02,000"
  const hasTime = /^\s*\d{1,2}:\d{2}:\d{2}[.,]\d{1,3}\s*-->/m.test(text);
  if (hasTime) {
    // Bỏ số thứ tự và dòng thời gian, chỉ giữ lời thoại
    const lines = text
      .split(/\r?\n/)
      .filter((l) => !/^\s*\d+\s*$/.test(l))
      .filter((l) => !/-->/.test(l))
      .filter((l) => l.trim() && !/^WEBVTT/i.test(l));
    return { text: lines.join('\n'), hadTimestamps: true };
  }
  return { text, hadTimestamps: false };
}

module.exports = { splitSentences, alignTranslation, parseTranslatedFile };
