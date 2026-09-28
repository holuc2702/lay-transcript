'use strict';

/**
 * Căn giọng đọc vào khung thời gian của từng đoạn transcript.
 *
 * BÀI TOÁN:
 *   Mỗi đoạn có khung [start, end] từ Whisper. Bản dịch tiếng Việt có độ dài
 *   thật khác bản gốc — tiếng Việt thường DÀI HƠN tiếng Anh.
 *
 *   - Thu nhỏ nhiều (tua 1.3x trở lên) -> méo tiếng, nghe gượng gạo, rất khó chịu.
 *   - Cắt bớt -> mất chữ, sai nghĩa.
 *   - Nên hướng: giữ tốc độ nói tự nhiên, chỉ tua nhẹ, phần dư thì DỒN các
 *     đoạn sau ra sau.
 *
 * THUẬT TOÁN (một lượt duyệt từ trái sang phải):
 *   Với đoạn i, đặt `place` = sớm nhất mà vẫn hợp lệ:
 *       place = max(start_gốc - trượt_đầu, đuôi_đoạn_trước + nghỉ)
 *   Rồi tính `room` = khoảng trống còn lại tới đầu đoạn kế tiếp.
 *     - Nếu lời thoại lấp đầy room -> tua nhẹ tối đa MAX_SPEEDUP cho vừa.
 *     - Nếu room <= 0 (đoạn trước đã tràn) -> giữ tốc độ tự nhiên, dồn tiếp.
 *   Ràng buộc bất biến: 1 <= speed <= MAX_SPEEDUP, và end luôn > start.
 */

const MAX_SPEEDUP = 1.15;   // tua nhanh tối đa — vẫn nghe tự nhiên
const GAP = 0.12;           // nghỉ giữa hai đoạn, giây
const HEAD_SLACK = 0.25;     // cho phép lấn trước mốc gốc một chút
const MIN_ROOM = 0.2;        // room nhỏ hơn thì thà đẩy lùi còn hơn tua

/**
 * @param {Array<{start:number,end:number,duration:number}>} items
 *   duration = thời lượng THẬT của file voice (đo bằng ffprobe)
 * @returns {Array} mỗi phần tử: { index, start, end, speed, drift, origStart, origEnd }
 */
function fitSegments(items) {
  const n = items.length;
  const out = [];
  let cursor = -Infinity;

  for (let i = 0; i < n; i++) {
    const it = items[i];
    const origStart = Number(it.start) || 0;
    const origEnd = Number(it.end) || origStart;
    const natural = Math.max(0.05, Number(it.duration) || 0.05);

    // Sớm nhất mà vẫn hợp lệ: không lấn quá xa trước mốc gốc, không đè đoạn trước.
    let place = Math.max(origStart - HEAD_SLACK, cursor + GAP);
    if (place < 0) place = Math.max(0, origStart - HEAD_SLACK);

    // Khoảng trống tới đầu đoạn kế tiếp (đoạn cuối thì không bị chặn).
    const nextOrig = i + 1 < n ? Number(items[i + 1].start) || 0 : Infinity;
    const room = nextOrig === Infinity ? Infinity : nextOrig - GAP - place;

    let speed = 1;
    if (room !== Infinity && room > MIN_ROOM && natural > room) {
      // Vừa khít chỗ trống -> tua nhẹ cho vừa, có giới hạn.
      speed = Math.min(MAX_SPEEDUP, natural / room);
    }
    speed = Math.max(1, speed); // không bao giờ tua chậm

    const need = natural / speed;
    out.push({
      index: i,
      origStart,
      origEnd,
      start: place,
      end: place + need,
      speed,
    });
    cursor = place + need;
  }

  return out.map((s) => ({
    index: s.index,
    start: round3(s.start),
    end: round3(s.end),
    origStart: round3(s.origStart),
    origEnd: round3(s.origEnd),
    speed: round3(s.speed),
    drift: round3(s.start - s.origStart),
  }));
}

function round3(n) {
  return Math.round(n * 1000) / 1000;
}

/** File sẽ dài bao lâu (tính tới đoạn cuối). */
function totalDuration(fitted) {
  return fitted.length ? round3(Math.max(...fitted.map((f) => f.end))) : 0;
}

/** Thống kê để hiển thị cho người dùng. */
function summarize(fitted) {
  if (!fitted.length) {
    return { total: 0, sped: 0, maxDrift: 0, avgDrift: 0, maxSpeed: 1, overlapped: 0 };
  }
  let overlapped = 0;
  for (let i = 1; i < fitted.length; i++) {
    if (fitted[i].start < fitted[i - 1].end - 1e-6) overlapped++;
  }
  const drifts = fitted.map((f) => Math.abs(f.drift));
  return {
    total: fitted.length,
    sped: fitted.filter((f) => f.speed > 1.001).length,
    maxDrift: round3(Math.max(...drifts)),
    avgDrift: round3(drifts.reduce((a, b) => a + b, 0) / drifts.length),
    maxSpeed: round3(Math.max(...fitted.map((f) => f.speed))),
    overlapped,
  };
}

module.exports = { fitSegments, totalDuration, summarize, MAX_SPEEDUP, GAP, HEAD_SLACK };
