'use strict';

const https = require('https');

/**
 * Dịch tiêu đề video sang tiếng Việt.
 *
 * VÌ SAO CẦN MỘT DỊCH VỤ NGOÀI:
 * Whisper chỉ dịch được sang TIẾNG ANH (task='translate' trong OpenAI Whisper), và
 * đó là cho phần lời thoại, không phải cho tiêu đề. Muốn có tiêu đề tiếng Việt
 * thì phải hỏi dịch vụ dịch.
 *
 * Vì sao Google trước, MyMemory sau: cùng một câu, Google dịch tự nhiên hơn hẳn
 * (có dấu câu và ngữ pháp đúng), MyMemory làm dự phòng khi Google lỗi.
 *
 * Không cần API key, không cần tài khoản. Người dùng có thể tắt trong Cài đặt.
 */

const TIMEOUT_MS = 15000;
const CACHE_LIMIT = 500;

/** Cache trong RAM + đọc lại từ đĩa để không dịch lại cùng một tiêu đề. */
let cache = new Map();

function loadCache() {
  try {
    const f = require('./paths').writableDir('cache');
    const fs = require('fs');
    const p = require('path').join(f, 'translations.json');
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    cache = new Map(Object.entries(raw));
  } catch {
    cache = new Map();
  }
}

function saveCache() {
  try {
    const fs = require('fs');
    const p = require('path');
    const dir = require('./paths').writableDir('cache');
    const entries = Array.from(cache.entries()).slice(-CACHE_LIMIT);
    fs.writeFileSync(p.join(dir, 'translations.json'), JSON.stringify(Object.fromEntries(entries)));
  } catch {
    /* cache hỏng không sao */
  }
}

function get(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: TIMEOUT_MS },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          buf += c;
          if (buf.length > 200_000) {
            req.destroy();
            reject(new Error('phản hồi quá dài'));
          }
        });
        res.on('end', () => resolve(buf));
      }
    );
    req.on('timeout', () => req.destroy(new Error('quá thời gian chờ')));
    req.on('error', reject);
  });
}

/** Tiêu đề đã là tiếng Việt thì không cần dịch. */
function looksVietnamese(text) {
  // Tiếng Việt dùng nhiều từ chỉ Việt Nam mới có; xem có từ nào không.
  return /\b(và|hoặc|nhưng|được|không|này|người|video|tiếng)\b/i.test(text);
}

async function viaGoogle(text) {
  const url =
    'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=vi&dt=t&q=' +
    encodeURIComponent(text);
  const raw = await get(url);
  const data = JSON.parse(raw);
  if (!Array.isArray(data) || !Array.isArray(data[0])) throw new Error('phản hồi lạ');
  const out = data[0]
    .map((chunk) => (Array.isArray(chunk) ? chunk[0] : ''))
    .join('')
    .trim();
  if (!out) throw new Error('bản dịch rỗng');
  return out;
}

async function viaMyMemory(text) {
  const url =
    'https://api.mymemory.translated.net/get?q=' +
    encodeURIComponent(text) +
    '&langpair=zh-CN|vi-VN';
  const raw = await get(url);
  const data = JSON.parse(raw);
  const out = (data?.responseData?.translatedText || '').trim();
  if (!out) throw new Error('bản dịch rỗng');
  return out;
}

/**
 * Dịch một chuỗi sang tiếng Việt.
 * Trả về { text } nếu thành công, hoặc { text: null, reason } nếu không —
 * người dùng vẫn thấy tiêu đề gốc, không mất gì.
 */
async function toVietnamese(text) {
  const original = String(text || '').trim();
  if (!original) return { text: null, reason: 'Tiêu đề rỗng' };
  if (original.length > 480) return { text: null, reason: 'Tiêu đề quá dài' };
  if (looksVietnamese(original)) return { text: original, reason: 'đã là tiếng Việt' };

  const key = original.toLowerCase();
  if (cache.has(key)) return { text: cache.get(key), cached: true };

  let lastErr = null;
  for (const fn of [viaGoogle, viaMyMemory]) {
    try {
      const out = await fn(original);
      cache.set(key, out);
      if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
      saveCache();
      return { text: out };
    } catch (err) {
      lastErr = err;
    }
  }
  return { text: null, reason: lastErr ? lastErr.message : 'dịch thất bại' };
}

/**
 * Dịch TOÀN BỘ transcript sang tiếng Việt (bản dịch TẠM bằng máy).
 *
 * Mục đích: giúp người dùng HIỂU ĐẠI KHÁI nội dung, không phải để xuất bản.
 * Trả về văn bản thuần (không timestamp), người dùng phải hiểu rõ đây chỉ là
 * bản dịch máy và có thể sai — giao diện sẽ gắn nhãn rõ ràng.
 *
 * Chia nhỏ theo ký tự (~2800/request) để không vượt giới hạn URL, dịch từng
 * khúc rồi nối lại. Có cache theo hash nội dung để không dịch lại.
 */
const SCRIPT_CACHE_LIMIT = 100;
const scriptCache = new Map();

function hashText(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return String(h >>> 0);
}

function splitIntoChunks(segments, maxChars = 2800) {
  const chunks = [];
  let cur = [];
  let len = 0;
  for (const s of segments) {
    const t = String(s.text || '').trim();
    if (!t) continue;
    if (len + t.length + 1 > maxChars && cur.length) {
      chunks.push(cur);
      cur = [];
      len = 0;
    }
    cur.push(t);
    len += t.length + 1;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

async function scriptToVietnamese(segments, onProgress) {
  const texts = (Array.isArray(segments) ? segments : [])
    .map((s) => String(s?.text || '').trim())
    .filter(Boolean);
  if (!texts.length) return { text: null, reason: 'Không có nội dung để dịch' };

  const joined = texts.join('\n');
  if (looksVietnamese(joined.slice(0, 2000))) {
    return { text: joined, reason: 'đã là tiếng Việt', alreadyVietnamese: true };
  }

  const key = 'script:' + hashText(joined);
  if (scriptCache.has(key)) return { text: scriptCache.get(key), cached: true };

  const chunks = splitIntoChunks(segments);
  const out = [];
  let failed = 0;
  for (let i = 0; i < chunks.length; i++) {
    const piece = chunks[i].join('\n');
    try {
      const t = await viaGoogle(piece);
      out.push(t);
    } catch (err) {
      // Thử MyMemory cho khúc này, hỏng thì giữ nguyên tiếng gốc và đánh dấu.
      try {
        out.push(await viaMyMemory(piece));
      } catch {
        failed++;
        out.push(piece);
      }
    }
    if (onProgress) {
      try { onProgress({ done: i + 1, total: chunks.length }); } catch { /* kệ */ }
    }
  }
  const text = out.join('\n\n');
  if (out.length) {
    scriptCache.set(key, text);
    if (scriptCache.size > SCRIPT_CACHE_LIMIT) scriptCache.delete(scriptCache.keys().next().value);
  }
  return { text, failed, chunkCount: chunks.length };
}

module.exports = { toVietnamese, loadCache, looksVietnamese, scriptToVietnamese };
