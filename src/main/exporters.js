'use strict';

/**
 * Xuat transcript ra nhieu dang.
 *
 * Luu y ve timestamp: khi cat nhat thoi gian theo phien ban, SRT/VTT phai lam
 * tron XUONG (floor) chu khong phai lam tron thuong. Neu lam tron thuong,
 * hai dong lien nhiep se co cung timestamp, phan mem pha video se bao loi.
 */

const WINDOWS_NEWLINE = { SRT: true, VTT: false };

/** '00:01:23,456' cho SRT, '00:01:23.456' cho VTT. */
function formatTimestamp(totalSeconds, comma = true) {
  // Chống NaN/Infinity: Math.max(0, NaN) vẫn ra NaN, và NaN sẽ in ra
  // chuỗi "NaN:NaN:NaN,NaN" trong file phụ đề. Whisper có thể trả về
  // timestamp hỏng khi đoạn bị cắt bằng VAD, nên phải chặn.
  const n = Number(totalSeconds);
  if (!Number.isFinite(n) || n <= 0) return `00:00:00${comma ? ',' : '.'}000`;
  const ms = Math.floor(n * 1000);
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const milli = ms % 1000;
  const sep = comma ? ',' : '.';
  return (
    String(h).padStart(2, '0') +
    ':' +
    String(m).padStart(2, '0') +
    ':' +
    String(s).padStart(2, '0') +
    sep +
    String(milli).padStart(3, '0')
  );
}

/** Loai khoang trang thua va noi cac dong lai cho de doc. */
function cleanText(t) {
  return String(t ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

function toSrt(segments) {
  const nl = WINDOWS_NEWLINE.SRT ? '\r\n' : '\n';
  return (
    segments
      .map((seg, i) => {
        const text = cleanText(seg.text);
        if (!text) return '';
        return (
          String(i + 1) +
          nl +
          `${formatTimestamp(seg.start, true)} --> ${formatTimestamp(seg.end, true)}` +
          nl +
          text
        );
      })
      .filter(Boolean)
      .join(nl + nl) + nl
  );
}

function toVtt(segments) {
  return (
    'WEBVTT\n\n' +
    segments
      .map((seg) => {
        const text = cleanText(seg.text);
        if (!text) return '';
        return `${formatTimestamp(seg.start, false)} --> ${formatTimestamp(seg.end, false)}\n${text}`;
      })
      .filter(Boolean)
      .join('\n\n') +
    '\n'
  );
}

function toPlainText(segments, { withTimestamps = true } = {}) {
  if (!withTimestamps) {
    return segments.map((s) => cleanText(s.text)).filter(Boolean).join(' ') + '\n';
  }
  return (
    segments
      .map((seg) => {
        const text = cleanText(seg.text);
        if (!text) return '';
        const ts = formatTimestamp(seg.start, false);
        return `[${ts}] ${text}`;
      })
      .filter(Boolean)
      .join('\n') + '\n'
  );
}

/** Markdown co timestamp — doc tuyet voi khi sua bai. */
function toMarkdown(segments, meta = {}) {
  const lines = [];
  if (meta.title) lines.push(`# ${meta.title}`, '');
  const head = [];
  if (meta.url) head.push(`- Nguon: ${meta.url}`);
  if (meta.language) head.push(`- Ngon ngu: ${meta.language}`);
  if (meta.model) head.push(`- Model: ${meta.model}`);
  if (meta.createdAt) head.push(`- Thoi gian tao: ${meta.createdAt}`);
  if (head.length) lines.push(head.join('\n'), '');
  lines.push('---', '');
  for (const seg of segments) {
    const text = cleanText(seg.text);
    if (text) lines.push(`**[${formatTimestamp(seg.start, false)}]** ${text}`, '');
  }
  return lines.join('\n');
}

function toJson(segments, meta = {}) {
  return JSON.stringify(
    {
      ...meta,
      segmentCount: segments.length,
      segments: segments.map((s) => ({
        start: s.start,
        end: s.end,
        text: cleanText(s.text),
        ...(s.words?.length
          ? {
              words: s.words.map((w) => ({
                start: w.start,
                end: w.end,
                word: w.word,
              })),
            }
          : {}),
      })),
    },
    null,
    2
  );
}

const FORMATS = {
  srt: { ext: 'srt', label: 'Phu de SRT', fn: (s) => toSrt(s) },
  vtt: { ext: 'vtt', label: 'Phu de VTT', fn: (s) => toVtt(s) },
  txt: { ext: 'txt', label: 'Van ban thuan (co gioi hanh)', fn: (s, o) => toPlainText(s, o) },
  txtPlain: { ext: 'txt', label: 'Van ban thuan (khong gioi hanh)', fn: (s) => toPlainText(s, { withTimestamps: false }) },
  md: { ext: 'md', label: 'Markdown', fn: (s, o, m) => toMarkdown(s, m) },
  json: { ext: 'json', label: 'JSON (co duong danh tu)', fn: (s, o, m) => toJson(s, m) },
};

function exportAs(format, segments, opts = {}, meta = {}) {
  const f = FORMATS[format];
  if (!f) throw new Error(`Không hỗ trợ định dạng: ${format}`);
  return f.fn(segments, opts, meta);
}

/** Chuan hoac ten file, loai ky tu khong hop le tren Windows. */
function safeFilename(name, fallback = 'transcript') {
  const cleaned = String(name || '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return cleaned || fallback;
}

module.exports = {
  formatTimestamp,
  cleanText,
  toSrt,
  toVtt,
  toPlainText,
  toMarkdown,
  toJson,
  exportAs,
  safeFilename,
  FORMATS,
};
