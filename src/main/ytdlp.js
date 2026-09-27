'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const https = require('https');

const C = require('./config');
const paths = require('./paths');

/**
 * Quản lý phiên bản yt-dlp.
 *
 * Bối cảnh: YouTube đổi giao thức liên tục và mỗi lần đổi là một bản yt-dlp mới
 * "hỏng" (3/2026 mất toàn bộ DASH audio-only, 1/2026 mất format 140, 8/2026 mất
 * android_vr). Ngược lại, bản quá mới cũng có thể hỏng. Người dùng cần đúng
 * một thứ: bản nào cũng chạy được.
 *
 * Vì vậy chiến lược KHÔNG phải "ghim một phiên bản", mà là:
 *   1. Cập nhật vào file TẠM, không đụng file đang chạy.
 *   2. Tải thật một video thật bằng file tạm đó.
 *   3. Chỉ khi tải được mới chuyển file tạm thành bản đang dùng, giữ lại bản cũ.
 *   4. Nếu hỏng thì giữ nguyên bản cũ và báo lý do.
 *
 * Nhờ vậy app "tự cập nhật" nhưng không bao giờ để người dùng rơi vào
 * trạng thái không tải được video.
 */

const EXEC_TIMEOUT = 60_000;

// ---------------------------------------------------------------------------
// Tiện ích
// ---------------------------------------------------------------------------

function isWindows() {
  return process.platform === 'win32';
}

/** Tên file binary theo nền tảng. */
function assetName() {
  const a = C.YTDLP_ASSET[process.platform];
  if (!a) throw new Error(`Chưa hỗ trợ nền tảng: ${process.platform}`);
  return a;
}

/** Đường dẫn tới binary đang dùng (nằm ở userData để ghi được). */
function activePath() {
  return path.join(paths.toolsDir(), assetName());
}

/** Đường dẫn tới binary trong installer (read-only, chỉ để sao chép lần đầu). */
function bundledPath() {
  return path.join(paths.resourcesDir(), 'bin', assetName());
}

/** Đường dẫn cache mô hình Whisper, truyền xuống sidecar. */
function modelsPath() {
  return paths.modelsDir();
}

function chmodIfNeeded(p) {
  if (!isWindows()) fs.chmodSync(p, 0o755);
}

function fileExists(p) {
  try {
    fs.accessSync(p, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function runYtdlp(binPath, args, { timeout = EXEC_TIMEOUT } = {}) {
  return new Promise((resolve) => {
    execFile(
      binPath,
      args,
      { timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        resolve({
          code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
          stdout: String(stdout || ''),
          stderr: String(stderr || ''),
        });
      }
    );
  });
}

/** Tải file theo URL, báo tiến độ (bytes đã nhận / tổng). */
function download(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const tmp = `${dest}.part`;
    const req = https.get(
      url,
      { headers: { 'User-Agent': 'lay-transcript' }, timeout: 60_000 },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          download(res.headers.location, dest, onProgress).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`Tải thất bại (HTTP ${res.statusCode}): ${url}`));
          return;
        }
        const total = Number(res.headers['content-length'] || 0);
        let got = 0;
        const out = fs.createWriteStream(tmp);
        res.on('data', (c) => {
          got += c.length;
          if (onProgress) onProgress(got, total);
        });
        res.pipe(out);
        out.on('error', reject);
        out.on('finish', () => {
          out.close(() => {
            try {
              fs.renameSync(tmp, dest);
              resolve(dest);
            } catch (e) {
              reject(e);
            }
          });
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('Tải quá thời gian chờ')));
    req.on('error', reject);
  });
}

/** Đọc JSON từ GitHub API (không cần token, chỉ dùng để hỏi phiên bản mới nhất). */
function getJson(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { 'User-Agent': 'lay-transcript', Accept: 'application/vnd.github+json' }, timeout: 20_000 },
        (res) => {
          if (res.statusCode === 403) {
            res.resume();
            reject(new Error('GitHub giới hạn số lần gọi. Hãy thử lại sau một lát.'));
            return;
          }
          if (res.statusCode !== 200) {
            res.resume();
            reject(new Error(`HTTP ${res.statusCode}`));
            return;
          }
          let buf = '';
          res.on('data', (c) => (buf += c));
          res.on('end', () => {
            try {
              resolve(JSON.parse(buf));
            } catch (e) {
              reject(e);
            }
          });
        })
      .on('error', reject)
      .on('timeout', function () {
        this.destroy(new Error('Quá thời gian chờ'));
      });
  });
}

// ---------------------------------------------------------------------------
// Trạng thái
// ---------------------------------------------------------------------------

function stateFile() {
  return path.join(paths.toolsDir(), 'yt-dlp-state.json');
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
  } catch {
    return {};
  }
}

function writeState(patch) {
  const next = { ...readState(), ...patch, updatedAt: new Date().toISOString() };
  fs.writeFileSync(stateFile(), JSON.stringify(next, null, 2));
  return next;
}

// ---------------------------------------------------------------------------
// Cài đặt & phiên bản
// ---------------------------------------------------------------------------

/**
 * Đảm bảo có binary yt-dlp để dùng.
 * Lần chạy đầu sẽ copy từ installer sang userData. Những lần sau giữ nguyên
 * bản đang có — nghĩa là khi app cập nhật, yt-dlp KHÔNG bị hạ về bản cũ trong installer.
 */
async function ensureInstalled() {
  const active = activePath();

  if (fileExists(active)) {
    return { path: active, restored: false };
  }
  const bundled = bundledPath();
  if (!fileExists(bundled)) {
    throw new Error(
      'Không tìm thấy yt-dlp trong app. Thư mục resources/bin có thể đã bị hỏng — hãy cài lại app.'
    );
  }
  fs.copyFileSync(bundled, active);
  chmodIfNeeded(active);
  writeState({ version: C.YTDLP_BUNDLED_VERSION, source: 'bundled' });
  return { path: active, restored: true };
}

/** Đọc phiên bản hiện tại, ví dụ "2026.08.19". */
async function currentVersion(binPath = activePath()) {
  const r = await runYtdlp(binPath, ['--version']);
  if (r.code !== 0) return null;
  return r.stdout.trim().split('\n')[0].trim() || null;
}

/** Hỏi GitHub xem bản mới nhất của kênh `stable` hoặc `nightly` là gì. */
async function latestRelease(channel = 'stable') {
  const repo = channel === 'nightly' ? C.YTDLP_NIGHTLY_REPO : C.YTDLP_REPO;
  const data = await getJson(`https://api.github.com/repos/${repo}/releases/latest`);
  return {
    version: data.tag_name,
    url: data.html_url,
    publishedAt: data.published_at,
  };
}

/**
 * URL tải binary của một MỐC PHIÊN BẢN (tag), ví dụ 2026.08.19.
 *
 * `tag` PHẢI là tag thật. Kênh (stable/nightly/master) chỉ là tên rút gọn, dùng
 * để tra cứu qua latestRelease() — đưa thẳng kênh vào đây sẽ ra 404.
 */
function downloadUrlFor(tag, asset = assetName()) {
  if (['stable', 'nightly', 'master'].includes(tag)) {
    throw new Error(
      `downloadUrlFor nhận mốc phiên bản, không nhận tên kênh ("${tag}"). ` +
        'Hãy tra cứu latestRelease() trước rồi mới gọi hàm này.'
    );
  }
  const repo =
    tag.startsWith('nightly') || tag.startsWith('master')
      ? C.YTDLP_NIGHTLY_REPO
      : C.YTDLP_REPO;
  return `https://github.com/${repo}/releases/download/${tag}/${asset}`;
}

// ---------------------------------------------------------------------------
// Kiểm tra sống — dùng để quyết định có dùng bản mới không
// ---------------------------------------------------------------------------

/**
 * Tải THẬT một video bằng binary đang xét.
 * Đây là bước quan trọng nhất: chỉ bản nào tải được video thật mới được dùng.
 *
 * Thử lần lượt các video dự phòng. Chỉ khi TẤT CẢ đều thất bại mới kết luận
 * là bản yt-dlp hỏng — vì "một video bị gỡ" và "yt-dlp hỏng" là hai chuyện
 * hoàn toàn khác nhau, mà nhầm lẫn chúng sẽ khiến app đổ oan một bản đang
 * chạy tốt.
 */
async function verifyBinary(binPath, { timeout = 240_000 } = {}) {
  let lastCombined = '';
  let lastCode = 0;
  let lastUrl = '';

  for (const url of C.VERIFY_VIDEOS) {
    const args = [
      '--no-config',
      '--no-update',
      '--no-warnings',
      '--no-playlist',
      '--socket-timeout', '20',
      '--extractor-retries', '2',
      '--retries', '2',
      '--extractor-args', `youtube:player_client=${C.PLAYER_CLIENT}`,
      '-f', C.AUDIO_FORMAT_LADDER,
      '--max-filesize', '8M',
      '-o', path.join(paths.writableDir('tmp'), 'verify.%(ext)s'),
      url,
    ];
    const r = await runYtdlp(binPath, args, { timeout });
    lastCombined = `${r.stdout}\n${r.stderr}`;
    lastCode = r.code;
    lastUrl = url;

    if (r.code === 0) {
      return {
        ok: true,
        reason: 'ok',
        url,
        message: `Tải thử thành công (${C.VERIFY_VIDEOS.indexOf(url) + 1}/${C.VERIFY_VIDEOS.length} video kiểm tra).`,
      };
    }

    // Lỗi ở tầng mạng/IP thì thử video tiếp cũng vô ích -> dừng luôn.
    if (/Sign in to confirm|not a bot|429|Too Many Requests|getaddrinfo|Could not connect|ETIMEDOUT|Connection refused/i.test(lastCombined)) {
      break;
    }
  }

  const isRateLimit = /Sign in to confirm|not a bot|429|Too Many Requests/i.test(lastCombined);
  const isNetwork =
    /getaddrinfo|Could not connect|ETIMEDOUT|Connection refused|Temporary failure|Network is unreachable|SSL/i.test(
      lastCombined
    );
  const allUnavailable = /This video is unavailable|Video unavailable|Private video/i.test(lastCombined);

  return {
    ok: false,
    reason: isRateLimit ? 'ip-blocked' : isNetwork ? 'network' : 'broken',
    url: lastUrl,
    message: isRateLimit
      ? 'YouTube đang chặn IP này (yêu cầu xác minh). Đây không phải lỗi của yt-dlp — hãy thử lại sau vài phút hoặc đổi mạng.'
      : isNetwork
        ? 'Không kết nối được tới YouTube. Hãy kiểm tra mạng rồi thử lại.'
        : allUnavailable
          ? 'Các video kiểm tra đều không truy cập được. Hãy bấm “Thử tải thử” thủ công để biết kết quả thật.'
          : `Phiên bản này không tải được video.\n${lastMeaningfulLine(lastCombined)}`,
  };
}

function lastMeaningfulLine(text) {
  const lines = String(text)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/^\[download\]/.test(l) && !/^\[info\]/.test(l));
  return lines.length ? lines[lines.length - 1].slice(0, 300) : '';
}

// ---------------------------------------------------------------------------
// Cập nhật có kiểm chứng + tự quay lui
// ---------------------------------------------------------------------------

/**
 * Cập nhật yt-dlp theo kênh ('stable' | 'nightly') hoặc tới phiên bản cụ thể.
 *
 * Quy trình:
 *   1. tải vào file tạm
 *   2. tải thử video thật bằng file tạm
 *   3. thành công -> giữ lại bản cũ trong thư mục versions/, đổi file tạm vào chỗ
 *   4. thất bại -> xoá file tạm, giữ nguyên bản cũ
 */
async function update({ channel = 'stable', version = null, onProgress = () => {} } = {}) {
  const { path: active } = await ensureInstalled();

  // PHẢI phân biệt "kênh" với "mốc phiên bản".
  //
  // Tag thật của release yt-dlp là NGÀY (2026.08.19), không phải tên kênh. Nếu
  // dựng thẳng URL từ kênh sẽ ra
  //     .../releases/download/stable/yt-dlp_macos   -> HTTP 404
  // và nút cập nhật không bao giờ chạy được. Đã bắt lỗi này khi kiểm thử
  // end-to-end trên giao diện thật.
  //
  // Vì vậy: có `version` -> tải thẳng mốc đó. Chỉ có `channel` -> hỏi GitHub
  // phiên bản mới nhất của kênh rồi mới tải.
  let tag = version;
  if (!tag) {
    onProgress({ phase: 'resolve', message: `Đang tìm bản mới nhất của kênh ${channel}…` });
    const latest = await latestRelease(channel);
    tag = latest.version;
  }

  const staging = path.join(paths.ytdlpVersionsDir(), `staging-${assetName()}`);

  onProgress({ phase: 'download', message: `Đang tải yt-dlp (${tag})…` });
  await download(downloadUrlFor(tag), staging, (got, total) => {
    if (total) onProgress({ phase: 'download', percent: (got / total) * 100 });
  });
  chmodIfNeeded(staging);

  const stagingVersion = await currentVersion(staging);
  if (!stagingVersion) {
    fs.rmSync(staging, { force: true });
    throw new Error('File vừa tải về không chạy được — có thể tải dở. Hãy thử lại.');
  }

  onProgress({ phase: 'verify', message: `Đang kiểm tra bản ${stagingVersion} bằng cách tải video thật…` });
  const check = await verifyBinary(staging);

  if (!check.ok) {
    fs.rmSync(staging, { force: true });
    // Không tự quay lui khi nguyên nhân là mạng/IP — bản cũ cũng sẽ hỏng
    // theo. Chỉ quay lui khi bản cũ thực sự tốt còn bản mới thực sự hỏng.
    if (check.reason === 'broken') {
      const oldVersion = await currentVersion(active);
      onProgress({
        phase: 'failed',
        message: `Bản ${stagingVersion} không tải được video, nên đã giữ nguyên bản đang chạy${oldVersion ? ` (${oldVersion})` : ''}.`,
      });
      return {
        ok: false,
        kept: oldVersion,
        reason: check.reason,
        message: check.message,
      };
    }
    onProgress({ phase: 'failed', message: check.message });
    return { ok: false, reason: check.reason, message: check.message };
  }

  // Thành công -> lưu bản cũ để quay lui được, rồi chuyển file tạm vào chỗ.
  onProgress({ phase: 'promote', message: 'Bản mới đã vượt kiểm tra. Đang cài đặt…' });
  const previousVersion = await currentVersion(active);
  if (previousVersion && previousVersion !== stagingVersion) {
    const kept = path.join(paths.ytdlpVersionsDir(), `${previousVersion}-${assetName()}`);
    try {
      fs.copyFileSync(active, kept);
      chmodIfNeeded(kept);
    } catch {
      /* giữ bản cũ là tiện ích, hỏng thì không sao */
    }
  }

  // windows hơi đặc biệt: không thể ghi đè file đang chạy.
  if (isWindows()) {
    fs.rmSync(active, { force: true });
  }
  fs.renameSync(staging, active);
  chmodIfNeeded(active);

  writeState({
    version: stagingVersion,
    previousVersion: previousVersion || null,
    verifiedAt: new Date().toISOString(),
    source: 'update',
  });

  onProgress({ phase: 'done', message: `Đã cập nhật yt-dlp lên ${stagingVersion}.` });
  return { ok: true, version: stagingVersion, previousVersion };
}

/** Quay lui về bản đã lưu gần nhất. */
async function rollback() {
  const active = activePath();
  const dir = paths.ytdlpVersionsDir();
  const asset = assetName();

  const backups = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(`-${asset}`) && !f.startsWith('staging-'))
    .map((f) => ({ file: f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);

  if (!backups.length) {
    return { ok: false, message: 'Chưa có bản nào đã lưu để quay lại.' };
  }

  const target = path.join(dir, backups[0].file);
  const version = await currentVersion(target);
  if (!version) {
    return { ok: false, message: 'Bản lưu không chạy được.' };
  }

  if (isWindows()) fs.rmSync(active, { force: true });
  fs.copyFileSync(target, active);
  chmodIfNeeded(active);
  writeState({ version, source: 'rollback' });
  return { ok: true, version };
}

/** Danh sách bản đã lưu, để hiển thị trong màn hình Cài đặt. */
function listBackups() {
  const dir = paths.ytdlpVersionsDir();
  const asset = assetName();
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(`-${asset}`) && !f.startsWith('staging-'))
      .map((f) => {
        const full = path.join(dir, f);
        return {
          version: f.replace(`-${asset}`, ''),
          sizeMB: Math.round(fs.statSync(full).size / 1048576),
          mtime: fs.statSync(full).mtime.toISOString(),
        };
      })
      .sort((a, b) => b.mtime.localeCompare(a.mtime));
  } catch {
    return [];
  }
}

module.exports = {
  activePath,
  bundledPath,
  modelsPath,
  ensureInstalled,
  currentVersion,
  latestRelease,
  update,
  rollback,
  listBackups,
  verifyBinary,
  downloadUrlFor,
  isWindows,
};
