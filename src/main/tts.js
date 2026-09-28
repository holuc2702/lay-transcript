'use strict';

const fs = require('fs');
const path = require('path');
const { URL } = require('url');

/**
 * Tạo giọng đọc AI qua trang 3aproduction.io.vn và ghép theo timestamp.
 *
 * CÁCH LÀM:
 *   1. Đăng nhập 1 lần (mật khẩu) -> cookie phiên được lưu.
 *   2. Với mỗi đoạn transcript, gọi POST /api/create { text, voice }.
 *   3. Theo dõi job đến khi xong, tải file mp3 về.
 *   4. Căn thời lượng thật của từng file mp3 vào khung thời gian của đoạn.
 *
 * VÌ SAO PHẢI CĂN THỜI LƯỢNG THẬT:
 *   Tiếng Việt dài hơn tiếng Anh — cùng một câu, bản tiếng Việt có thể dài
 *   1,2-1,5 lần. Nếu cứ ép vào đúng khung thời gian gốc thì hoặc là bị cắt cụt,
 *   hoặc phải tua nhanh đến mức méo tiếng. Nên:
 *     - Nếu lời thoại vừa khung -> giữ nguyên, có chèn khoảng lặng ngắn.
 *     - Nếu lời thoại dài hơn khung một chút -> tua nhẹ (tối đa 1,15x) vẫn tự nhiên.
 *     - Nếu dài hơn nhiều -> KHÔNG tua, mà kéo dài khung của đoạn (nhường chỗ cho
 *       đoạn sau), đánh lại từ đầu. Cách này giữ giọng tự nhiên.
 */

const BASE = 'https://3aproduction.io.vn';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';
const POLL_MS = 2500;
const MAX_POLL_MS = 20 * 60 * 1000;

// ---------------------------------------------------------------------------
// Cookie phiên
// ---------------------------------------------------------------------------

function cookieFile() {
  return path.join(require('./paths').writableDir('cache'), '3a-cookies.txt');
}

function loadCookies() {
  try {
    return fs.readFileSync(cookieFile(), 'utf8').trim();
  } catch {
    return '';
  }
}

function saveCookies(setCookieHeaders) {
  // Gom nhiều header Set-Cookie thành một chuỗi "k=v; k2=v2"
  const pairs = setCookieHeaders
    .map((h) => (Array.isArray(h) ? h : [h]))
    .flat()
    .map((c) => c.split(';')[0])
    .filter(Boolean);
  if (pairs.length) fs.writeFileSync(cookieFile(), pairs.join('; '), 'utf8');
  return pairs.join('; ');
}

/** Số lần chuyển hướng tối đa. */
const MAX_REDIRECT = 5;

/**
 * Gọi HTTP có theo redirect.
 *
 * Bắt buộc phải có: server trả `audio_url` dạng http:// (không mã hoá), Cloudflare
 * trả 301 sang https://. Không theo redirect thì tải về đúng trang HTML 301 —
 * file 534 bytes, nghe như file rác.
 */
function request(url, opts = {}, redirectsLeft = MAX_REDIRECT) {
  const { method = 'GET', headers = {}, body = null, timeout = 60_000, raw = false } = opts;
  return new Promise((resolve, reject) => {
    const https = require('https');
    const http = require('http');
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
      { method, headers: { 'User-Agent': UA, ...headers }, timeout },
      (res) => {
        if (res.headers['set-cookie']) saveCookies(res.headers['set-cookie']);

        // Theo chuyển hướng (301/302/307/308).
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume(); // bỏ nội dung trang chuyển hướng
          if (redirectsLeft <= 0) {
            reject(new Error('quá nhiều lần chuyển hướng'));
            return;
          }
          const next = new URL(res.headers.location, url).toString();
          request(next, { ...opts, method: res.statusCode === 303 ? 'GET' : method }, redirectsLeft - 1).then(
            resolve,
            reject
          );
          return;
        }

        if (raw) {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () =>
            resolve({
              status: res.statusCode,
              buffer: Buffer.concat(chunks),
              headers: res.headers,
            })
          );
          return;
        }
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (buf += c));
        res.on('end', () => {
          let json = null;
          try {
            json = buf ? JSON.parse(buf) : {};
          } catch {
            json = null;
          }
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ status: res.statusCode, json, text: buf });
          } else {
            const err = new Error(`HTTP ${res.statusCode}: ${buf.slice(0, 300)}`);
            err.status = res.statusCode;
            err.body = buf;
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

function authHeaders(extra = {}) {
  const c = loadCookies();
  return { ...extra, ...(c ? { Cookie: c } : {}) };
}

// ---------------------------------------------------------------------------
// Đăng nhập
// ---------------------------------------------------------------------------

/** Phiên có còn sống không. Server dùng cờ `authenticated` (không phải `ok`). */
function sessionOk(s) {
  return !!(s && (s.authenticated === true || s.ok === true));
}

async function login(password) {
  try {
    await request(`${BASE}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
      body: JSON.stringify({ password }),
    });
    const s = await session();
    if (sessionOk(s)) {
      return { ok: true, nickname: s.nickname || null, isAdmin: !!s.is_admin };
    }
    // Server trả 200 nhưng không cấp phiên -> mật khẩu sai
    throw new Error('Mật khẩu không đúng');
  } catch (err) {
    if (/Mật khẩu không đúng/.test(err.message)) throw err;
    throw new Error(`Không đăng nhập được: ${err.message}`);
  }
}

/** Kiểm tra phiên hiện tại còn sống không. */
async function session() {
  try {
    const r = await request(`${BASE}/api/session`, { headers: authHeaders() });
    return r.json;
  } catch {
    return null;
  }
}

async function logout() {
  try {
    await request(`${BASE}/api/logout`, { method: 'POST', headers: authHeaders() });
  } catch {
    /* không sao */
  }
  try {
    fs.unlinkSync(cookieFile());
  } catch {
    /* không sao */
  }
}

// ---------------------------------------------------------------------------
// Tạo voice
// ---------------------------------------------------------------------------

/** Gom mọi id job mà API trả về (payload có thể lồng nhau). */
function collectJobIds(data) {
  const ids = new Set();
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    for (const k of ['task_id', 'task_id2', 'job_id', 'id']) {
      if (node[k]) ids.add(String(node[k]));
    }
    for (const k of ['payload', 'tasks', 'items', 'data', 'result']) {
      if (node[k]) walk(node[k]);
    }
  };
  walk(data);
  return Array.from(ids);
}

function isDoneStatus(s) {
  return ['done', 'completed', 'success', 'finished', 'ok'].includes(String(s || '').toLowerCase());
}
function isErrorStatus(s) {
  return ['error', 'failed', 'fail'].includes(String(s || '').toLowerCase());
}

/** Lấy URL file âm thanh từ mọi hình dạng payload mà server có thể trả. */
function extractAudioUrl(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const keys = [
    'audio_url', 'audioUrl', 'result_url', 'resultUrl', 'download_url', 'downloadUrl',
    'url', 'file_url', 'fileUrl', 'mp3_url', 'output_url', 'audio', 'mp3', 'output',
  ];
  for (const k of keys) {
    const v = payload[k];
    if (typeof v === 'string' && /^https?:\/\//.test(v) && !/\.html?($|\?)/i.test(v)) return v;
  }
  for (const v of Object.values(payload)) {
    if (v && typeof v === 'object') {
      const r = extractAudioUrl(v);
      if (r) return r;
    }
  }
  return null;
}

function extractStatus(payload) {
  for (const k of ['status', 'state', 'task_status', 'job_status']) {
    if (payload?.[k]) return String(payload[k]).toLowerCase();
  }
  if (payload?.error || payload?.message) return 'error';
  return '';
}

/** Độ dài file âm thanh (giây) đọc từ payload nếu server có báo. */
function extractDuration(payload) {
  for (const k of ['duration', 'audio_duration', 'length', 'length_sec']) {
    const v = payload?.[k];
    if (typeof v === 'number' && isFinite(v)) return v;
    if (typeof v === 'string' && /^\d+(\.\d+)?$/.test(v)) return Number(v);
  }
  return null;
}

/**
 * Tạo một file voice cho đoạn văn bản.
 * @returns {{ url: string, duration: number|null, jobId: string }}
 */
async function synthesize(text, voice, { onStatus, appDir, ffmpegPath } = {}) {
  if (!loadCookies()) {
    throw new Error('Chưa đăng nhập 3A. Mở Cài đặt → Lồng tiếng và đăng nhập trước.');
  }
  const say = (s) => onStatus && onStatus(s);

  say(`Đang gửi yêu cầu tạo voice (${text.length} ký tự)…`);
  const created = await request(`${BASE}/api/create`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ text, voice, auto_split: false, target_tasks: 1 }),
  });
  const jobIds = collectJobIds(created.json);
  if (!jobIds.length) throw new Error('Server không trả về mã job.');
  const jobId = jobIds[0];

  // Theo dõi tới khi xong
  let lastStatus = '';
  const deadline = Date.now() + MAX_POLL_MS;
  let payload = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    let res;
    try {
      res = await request(`${BASE}/api/history`, { headers: authHeaders() });
    } catch {
      continue;
    }
    const found = findJobInHistory(res.json, jobId);
    if (found) {
      const st = extractStatus(found);
      if (st && st !== lastStatus) {
        lastStatus = st;
        say(`Trạng thái: ${translateStatus(st)}`);
      }
      if (isErrorStatus(st)) {
        throw new Error(`Tạo voice thất bại: ${found.error || found.message || st}`);
      }
      if (isDoneStatus(st) || extractAudioUrl(found)) {
        payload = found;
        break;
      }
    }
  }
  if (!payload) throw new Error('Quá thời gian chờ tạo voice.');

  const url = extractAudioUrl(payload);
  if (!url) throw new Error('Xong nhưng không tìm thấy đường dẫn file âm thanh trong kết quả.');

  say('Đang tải file voice về…');
  const abs = url.startsWith('http') ? url : `${BASE}${url.startsWith('/') ? '' : '/'}${url}`;
  const dl = await request(abs, { headers: authHeaders(), raw: true });
  if (!dl.buffer || dl.buffer.length < 512) throw new Error('File voice tải về quá nhỏ, có thể lỗi.');

  fs.mkdirSync(appDir, { recursive: true });
  const file = path.join(appDir, `voice-${jobId}.mp3`);
  fs.writeFileSync(file, dl.buffer);

  // Đo thời lượng thật bằng ffprobe (ffmpeg đi kèm app)
  let duration = extractDuration(payload);
  if (duration == null) {
    duration = await probeDuration(file, ffmpegPath).catch(() => null);
  }
  return { url: abs, file, duration, jobId };
}

function translateStatus(s) {
  return (
    {
      pending: 'đang chờ',
      queued: 'đang xếp hàng',
      running: 'đang tạo',
      processing: 'đang xử lý',
      done: 'xong',
      error: 'lỗi',
    }[s] || s
  );
}

/** Tìm một job trong payload /api/history (nhiều tầng). */
function findJobInHistory(payload, jobId) {
  let found = null;
  const walk = (n) => {
    if (found || !n || typeof n !== 'object') return;
    if (Array.isArray(n)) {
      for (const x of n) walk(x);
      return;
    }
    for (const k of ['task_id', 'task_id2', 'job_id', 'id']) {
      if (String(n[k] ?? '') === jobId) {
        found = n;
        return;
      }
    }
    for (const v of Object.values(n)) if (v && typeof v === 'object') walk(v);
  };
  walk(payload);
  return found;
}

/** Đo thời lượng mp3 bằng ffprobe đi kèm ffmpeg. */
async function probeDuration(file, ffmpegPath) {
  const { execFile } = require('child_process');
  const probe = ffmpegPath
    ? ffmpegPath.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1')
    : 'ffprobe';
  return new Promise((resolve, reject) => {
    execFile(
      probe,
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file],
      { timeout: 30_000 },
      (err, stdout) => {
        if (err) return reject(err);
        const d = parseFloat(String(stdout).trim());
        if (!isFinite(d) || d <= 0) return reject(new Error('không đọc được thời lượng'));
        resolve(d);
      }
    );
  });
}

module.exports = {
  BASE,
  login,
  logout,
  session,
  synthesize,
  collectJobIds,
  extractAudioUrl,
  extractStatus,
  extractDuration,
  isDoneStatus,
  isErrorStatus,
  findJobInHistory,
  probeDuration,
};
