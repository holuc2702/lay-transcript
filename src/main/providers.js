'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { URL } = require('url');

const paths = require('./paths');

/**
 * Dịch văn bản qua nhiều nhà cung cấp, tự xoay API key khi hết hạn mức.
 *
 * THIẾT KẾ:
 *   - Mỗi provider có: tên, model, base URL, và DANH SÁCH key (mỗi dòng một key).
 *   - Gọi thử từng key cho tới khi còn key sống. Key bị lỗi 401/403/429 thì
 *     tạm ẩn đi (mặc định 30 phút) rồi thử key tiếp theo — đây là cơ chế
 *     "xoay key" bạn cần.
 *   - Bản dịch được cache theo hash nội dung + provider + model để không gọi
 *     lại cùng một câu.
 *
 * BẢO MẬT: key chỉ nằm trong máy người dùng, ghi vào
 * <userData>/providers.json. Không gửi đi đâu ngoài chính API của nhà cung cấp.
 */

const KEY_COOLDOWN_MS = 30 * 60 * 1000; // ẩn key hết hạn mức 30 phút
const CACHE_LIMIT = 400;
const TIMEOUT_MS = 120_000; // model lớn (gpt-oss:20b) có thể suy nghĩ lâu

// key bị ẩn: Map "providerId:key" -> thời điểm hết ẩn
const keyCooldown = new Map();
// cache bản dịch: Map key -> { text, at }
const cache = new Map();

/**
 * Provider tích hợp sẵn. Người dùng thêm/copy thêm bao nhiêu cũng được.
 * `kind` quyết định cách dựng request và cách đọc kết quả.
 */
const BUILTIN_PROVIDERS = [
  {
    id: 'ollama-cloud',
    label: 'Ollama Cloud',
    kind: 'ollama',
    baseUrl: 'https://ollama.com/api',
    model: 'gpt-oss:20b-cloud',
    note: 'Dịch chất lượng cao bằng mô hình mở. Bản dịch dài, dùng tốt cho lồng tiếng.',
  },
  {
    id: 'ollama-local',
    label: 'Ollama (máy của bạn)',
    kind: 'ollama',
    baseUrl: 'http://localhost:11434',
    model: 'qwen2.5:7b',
    note: 'Chạy hoàn toàn offline nếu bạn đã cài Ollama.',
    noKey: true,
  },
  {
    id: 'openai',
    label: 'OpenAI',
    kind: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    note: 'Cần API key trả phí của OpenAI.',
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    kind: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    model: 'gemini-2.0-flash',
    note: 'Có gói miễn phí, ưu tiên dịch Trung <-> Việt.',
  },
  {
    id: 'google-free',
    label: 'Google Dịch (không cần key)',
    kind: 'google-translate',
    baseUrl: 'https://translate.googleapis.com',
    model: '',
    note: 'Dịch nhanh, miễn phí, không cần key. Chất lượng ổn cho câu ngắn.',
  },
  {
    id: 'mymemory',
    label: 'MyMemory (dự phòng)',
    kind: 'mymemory',
    baseUrl: 'https://api.mymemory.translated.net',
    model: '',
    note: 'Dự phòng khi Google dịch lỗi.',
    noKey: true,
  },
];

// ---------------------------------------------------------------------------
// Lưu trữ
// ---------------------------------------------------------------------------

function configFile() {
  return path.join(paths.writableDir('cache'), 'providers.json');
}

function loadUserProviders() {
  try {
    return JSON.parse(fs.readFileSync(configFile(), 'utf8'));
  } catch {
    return { providers: {}, defaults: { scriptProviderId: 'google-free', titleProviderId: 'google-free' } };
  }
}

function saveUserProviders(data) {
  fs.writeFileSync(configFile(), JSON.stringify(data, null, 2), 'utf8');
  return data;
}

/** Chuẩn hoá danh sách key: tách theo dòng, bỏ rỗng, bỏ trùng. */
function normalizeKeys(text) {
  return String(text || '')
    .split(/[\r\n,;]+/)
    .map((k) => k.trim())
    .filter(Boolean)
    .filter((k, i, a) => a.indexOf(k) === i);
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function request(url, { method = 'POST', headers = {}, body = null, timeout = TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch (e) {
      reject(new Error(`URL không hợp lệ: ${url}`));
      return;
    }
    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.request(
      url,
      { method, headers, timeout },
      (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          buf += c;
          if (buf.length > 8 * 1024 * 1024) req.destroy(new Error('phản hồi quá lớn'));
        });
        res.on('end', () => {
          const text = buf;
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve({ status: res.statusCode, json: text ? JSON.parse(text) : {}, text });
            } catch {
              resolve({ status: res.statusCode, json: {}, text });
            }
          } else {
            const err = new Error(`HTTP ${res.statusCode}: ${text.slice(0, 300)}`);
            err.status = res.statusCode;
            err.body = text;
            reject(err);
          }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('quá thời gian chờ')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/** Lỗi này có nghĩa là key hết hạn mức / sai -> nên xoay sang key khác. */
function isKeyProblem(err) {
  const s = err.status || 0;
  return s === 401 || s === 403 || s === 429;
}

// ---------------------------------------------------------------------------
// Các kiểu provider
// ---------------------------------------------------------------------------

const PROMPT = [
  'Bạn là chuyên gia dịch thuật phụ đề.',
  'Dịch văn bản người dùng đưa sang tiếng Việt.',
  'Quy tắc: trả về DUY NHẤT bản dịch, không giải thích, không thêm dấu ngoặc kép, giữ nguyên số và tên riêng.',
  'Nếu văn bản đã là tiếng Việt thì trả về nguyên văn.',
].join(' ');

async function callOllama(p, key, text) {
  const url = `${p.baseUrl.replace(/\/+$/, '')}/chat`;
  const body = JSON.stringify({
    model: p.model,
    stream: false,
    messages: [{ role: 'user', content: `${PROMPT}\n\nVăn bản:\n${text}` }],
  });
  const res = await request(url, {
    headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    body,
  });
  return String(res.json?.message?.content || '').trim();
}

async function callOpenAI(p, key, text) {
  const url = `${p.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const body = JSON.stringify({
    model: p.model,
    temperature: 0.2,
    messages: [{ role: 'user', content: `${PROMPT}\n\nVăn bản:\n${text}` }],
  });
  const res = await request(url, {
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body,
  });
  return String(res.json?.choices?.[0]?.message?.content || '').trim();
}

async function callGemini(p, key, text) {
  const url = `${p.baseUrl.replace(/\/+$/, '')}/models/${encodeURIComponent(p.model)}:generateContent?key=${encodeURIComponent(key)}`;
  const body = JSON.stringify({
    contents: [{ parts: [{ text: `${PROMPT}\n\nVăn bản:\n${text}` }] }],
    generationConfig: { temperature: 0.2 },
  });
  const res = await request(url, { headers: { 'Content-Type': 'application/json' }, body });
  return String(
    res.json?.candidates?.[0]?.content?.parts?.map((x) => x.text).join('') || ''
  ).trim();
}

async function callGoogleTranslate(p, key, text) {
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=vi&dt=t&q=${encodeURIComponent(text)}`;
  const res = await request(url, { method: 'GET', headers: key ? { Authorization: `Bearer ${key}` } : {} });
  if (!Array.isArray(res.json?.[0])) throw new Error('phản hồi Google dịch không đúng format');
  return res.json[0]
    .map((c) => (Array.isArray(c) ? c[0] : ''))
    .join('')
    .trim();
}

async function callMyMemory(p, key, text) {
  const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=zh-CN|vi-VN`;
  const res = await request(url, { method: 'GET' });
  return String(res.json?.responseData?.translatedText || '').trim();
}

const KINDS = {
  ollama: callOllama,
  openai: callOpenAI,
  gemini: callGemini,
  'google-translate': callGoogleTranslate,
  mymemory: callMyMemory,
};

// ---------------------------------------------------------------------------
// Dịch
// ---------------------------------------------------------------------------

function hashKey(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return String(h >>> 0);
}

/** Lấy cấu hình provider đã lưu, gộp với provider mặc định. */
function listProviders() {
  const user = loadUserProviders();
  const all = BUILTIN_PROVIDERS.map((p) => ({
    ...p,
    keys: normalizeKeys(user.providers?.[p.id]?.keys),
    model: user.providers?.[p.id]?.model || p.model,
    baseUrl: user.providers?.[p.id]?.baseUrl || p.baseUrl,
    label: user.providers?.[p.id]?.label || p.label,
    builtin: true,
  }));
  // Provider do người dùng tự thêm
  for (const [id, p] of Object.entries(user.providers || {})) {
    if (p.custom) {
      all.push({
        id,
        label: p.label || id,
        kind: p.kind || 'openai',
        baseUrl: p.baseUrl || '',
        model: p.model || '',
        keys: normalizeKeys(p.keys),
        note: 'Do bạn thêm',
        custom: true,
        noKey: !!p.noKey,
      });
    }
  }
  return all;
}

async function translateWithProvider(provider, text) {
  const fn = KINDS[provider.kind];
  if (!fn) throw new Error(`Chưa hỗ trợ loại provider "${provider.kind}"`);

  const keys = provider.noKey ? [''] : provider.keys;
  if (!keys.length) {
    throw new Error(`Chưa có API key cho "${provider.label}"`);
  }

  const order = keys
    .filter((k) => {
      const until = keyCooldown.get(`${provider.id}:${k}`);
      if (until && until > Date.now()) return false;
      if (until) keyCooldown.delete(`${provider.id}:${k}`);
      return true;
    })
    .concat(keys.filter((k) => keyCooldown.get(`${provider.id}:${k}`) > Date.now()));

  let lastErr = null;
  for (const key of order) {
    if (provider.noKey && key !== '') continue;
    try {
      const out = await fn(provider, key, text);
      if (out) return { text: out, providerId: provider.id, providerLabel: provider.label };
      lastErr = new Error('provider trả về rỗng');
    } catch (err) {
      lastErr = err;
      if (isKeyProblem(err)) {
        // Hết hạn mức / sai key -> ẩn key này, thử key tiếp theo.
        keyCooldown.set(`${provider.id}:${key}`, Date.now() + KEY_COOLDOWN_MS);
      } else if (err.status === 404) {
        // Sai model hoặc sai base URL -> thử key sau cũng vô ích.
        throw new Error(
          `Không tìm thấy model "${provider.model}" tại ${provider.baseUrl} (HTTP 404). ` +
            'Kiểm tra lại tên model và đường dẫn trong Cài đặt.'
        );
      }
    }
  }
  throw lastErr || new Error('thất bại');
}

/**
 * Dịch một đoạn văn bản. Thử lần lượt các provider theo thứ tự ưu tiên.
 * @param {string} text
 * @param {object} opts { providerIds?: string[] } — rỗng = dùng mặc định
 */
async function translate(text, opts = {}) {
  const src = String(text || '').trim();
  if (!src) return { text: '' };
  // Đã là tiếng Việt thì khỏi gọi API, tiết kiệm quota.
  if (/\b(và|hoặc|nhưng|được|không|này|người|tiếng Việt)\b/i.test(src.slice(0, 300))) {
    return { text: src, skipped: 'đã là tiếng Việt' };
  }

  const all = listProviders();
  const wanted = opts.providerIds?.length ? all.filter((p) => opts.providerIds.includes(p.id)) : all;
  const list = wanted.length ? wanted : all;

  for (const p of list) {
    const ck = `${p.id}:${p.model}:${hashKey(src)}`;
    if (cache.has(ck)) return { text: cache.get(ck), providerId: p.id, providerLabel: p.label, cached: true };
    try {
      const r = await translateWithProvider(p, src);
      cache.set(ck, r.text);
      if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
      return r;
    } catch (err) {
      // provider này hỏng -> thử provider tiếp theo, không làm hỏng cả luồng.
      lastTranslateError = `${p.label}: ${err.message}`;
    }
  }
  throw new Error(
    `Không dịch được. Lỗi cuối: ${lastTranslateError || 'không rõ'}\n` +
      'Kiểm tra API key / model / đường dẫn trong Cài đặt → Dịch thuật.'
  );
}
let lastTranslateError = '';

/** Dịch nhiều khúc, có báo tiến độ và dừng ngay khi gặp lỗi. */
async function translateChunks(chunks, { onProgress, signal } = {}) {
  const out = [];
  for (let i = 0; i < chunks.length; i++) {
    if (signal?.aborted) throw new Error('đã huỷ');
    const r = await translate(chunks[i]);
    out.push(r.text);
    if (onProgress) onProgress({ done: i + 1, total: chunks.length });
  }
  return out;
}

module.exports = {
  BUILTIN_PROVIDERS,
  listProviders,
  loadUserProviders,
  saveUserProviders,
  normalizeKeys,
  translate,
  translateChunks,
  isKeyProblem,
  hashKey,
};
