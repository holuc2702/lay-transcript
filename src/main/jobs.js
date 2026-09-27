'use strict';

const { spawn, execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

const C = require('./config');
const paths = require('./paths');

/**
 * Đường ống xử lý một video:
 *   1. yt-dlp tải audio -> file .m4a/.webm
 *   2. ffmpeg chuẩn hoá -> wav 16kHz mono
 *   3. sidecar Whisper -> transcript có timestamp
 *
 * Bước 2 không thừa: PyAV đọc được mp4/webm nhưng không đọc được mọi thứ
 * yt-dlp tải về (m3u8/HLS, một số container lạ). Chuẩn hoá về wav 16kHz mono
 * là đúng định dạng Whisper mong đợi, giúp tốc độ ổn định và tránh lỗi
 * khó chẩn đoán về sau.
 */

const FFMPEG_TIMEOUT = 15 * 60_000;

function ffmpegPath() {
  return path.join(paths.toolsDir(), process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
}

function ffprobePath() {
  return path.join(paths.toolsDir(), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
}

/** Cài ffmpeg/ffprobe tu thu muc resources vao userData (de goi duoc tu PATH cua app). */
function installFfmpeg() {
  const src = path.join(paths.resourcesDir(), 'bin');
  const dest = paths.toolsDir();
  for (const name of process.platform === 'win32'
    ? ['ffmpeg.exe', 'ffprobe.exe']
    : ['ffmpeg', 'ffprobe']) {
    const from = path.join(src, name);
    if (!fs.existsSync(from)) {
      throw new Error(
        `Không tìm thấy ${name} trong app.\n` +
          'Hãy chạy: npm run fetch-deps để tải về phụ thuộc.'
      );
    }
    const to = path.join(dest, name);
    if (process.platform !== 'win32') fs.chmodSync(from, 0o755);
    fs.copyFileSync(from, to);
    if (process.platform !== 'win32') fs.chmodSync(to, 0o755);
  }
}

// ---------------------------------------------------------------------------
// yt-dlp: tai audio
// ---------------------------------------------------------------------------

/** [download]  12.3% of 17.92MiB at 3.00MiB/s ETA 00:05 */
const DOWNLOAD_RE =
  /\[download\]\s+(\d+(?:\.\d+)?)% of\s+~?\s*([\d.]+)(\w+)/i;

// Đơn vị yt-dlp in ra, đã chuyển sang chữ thường. Phải khớp với
// `m[3].toLowerCase()` bên dưới — trước đây khoá để HOA CHỮ nên tra cứu
// luôn trượt và tổng số byte luôn bằng số thô.
// yt-dlp dùng cả MiB (nhị phân) và MB (thập phân), nên cần đủ cả hai.
const UNIT = {
  b: 1,
  k: 1000,
  m: 1000 ** 2,
  g: 1000 ** 3,
  // biến thể 2 chữ cái: yt-dlp có lúc in "MB" thay vì "MiB"
  kb: 1000,
  mb: 1000 ** 2,
  gb: 1000 ** 3,
  kib: 1024,
  mib: 1024 ** 2,
  gib: 1024 ** 3,
};

function parseDownloadLine(line) {
  const m = line.match(DOWNLOAD_RE);
  if (!m) return null;
  const pct = parseFloat(m[1]);
  const mult = UNIT[m[3].toLowerCase()];
  if (!mult) return null;
  return { percent: pct, totalBytes: Math.round(parseFloat(m[2]) * mult) };
}

/**
 * Chay yt-dlp de tai audio. `onProgress` nhan {percent, phase, message, ...}.
 */
function downloadAudio(binPath, url, { onProgress = () => {}, cookiesFile = null, extraArgs = [] } = {}) {
  return new Promise((resolve, reject) => {
    const workDir = paths.writableDir('work');
    const outTpl = path.join(workDir, '%(id)s.%(ext)s');

    const args = [
      '--no-config',
      '--no-update',
      '--newline',
      '--no-playlist',
      '--no-warnings',
      '--progress',
      '--socket-timeout', '30',
      '--retries', '10',
      '--fragment-retries', '10',
      // Nghi giua cac request: khach khong dang nhap chi tai duoc ~300 video/gio.
      '--sleep-requests', C.SLEEP_REQUESTS,
      '--sleep-interval', C.SLEEP_INTERVAL,
      '--extractor-args', `youtube:player_client=${C.PLAYER_CLIENT}`,
      // Thang bac dinh dang — KHONG hardcode mot dinh dang don le.
      '-f', C.AUDIO_FORMAT_LADDER,
      '-o', outTpl,
    ];
    if (cookiesFile) args.push('--cookies', cookiesFile);
    args.push(...extraArgs, url);

    onProgress({ phase: 'download', percent: 0, message: 'Đang tải audio từ YouTube…' });

    const proc = spawn(binPath, args, { windowsHide: true });
    let stderr = '';
    let lastPct = 0;
    let title = null;

    const onLine = (raw) => {
      const line = raw.trim();
      if (!line) return;

      // "[download] Destination: xxx.140.m4a" -> biet duoc ten file phat sinh
      const dest = line.match(/^\[download\]\s+Destination:\s+(.+)$/);
      if (dest) {
        title = path.basename(dest[1]);
        onProgress({ phase: 'download', filename: title });
      }

      const m = line.match(/^\[info\]\s+([A-Za-z0-9_-]{6,}):\s+Downloading (?:m3u8 )?information/);
      if (m) title = m[1];

      const d = parseDownloadLine(line);
      if (d) {
        lastPct = d.percent;
        onProgress({
          phase: 'download',
          percent: d.percent,
          totalBytes: d.totalBytes,
        });
      }

      if (/^\[error\]/i.test(line)) {
        stderr += line + '\n';
        onProgress({ phase: 'download', message: line });
      }
      if (/^\[youtube\]\s+\S+:\s+Video unavailable|This video is unavailable/i.test(line)) {
        stderr += line + '\n';
      }
    };

    let buf = '';
    proc.stdout.on('data', (d) => {
      buf += d.toString();
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const l of lines) onLine(l);
    });
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
    });

    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(translateYtError(stderr, code)));
        return;
      }
      onProgress({ phase: 'download', percent: 100 });
      resolve(findAudioFile(workDir));
    });
  });
}

/**
 * Lấy thông tin video (tên, thời lượng) mà KHÔNG tải audio.
 *
 * Gọi thêm một lần trước khi tải, đổi lại:
 *   - tên file output đẹp thay vì "transcript-a1b2c3d4"
 *   - biết trước thời lượng để hiện "dài 1 giờ 12 phút" ngay từ đầu
 *   - phát hiện sớm video không còn truy cập được, thay vì tải xong mới biết
 */
function fetchMetadata(binPath, url) {
  return new Promise((resolve) => {
    const args = [
      '--no-config',
      '--no-update',
      '--no-warnings',
      '--no-playlist',
      '--skip-download',
      '--socket-timeout', '20',
      '--extractor-args', `youtube:player_client=${C.PLAYER_CLIENT}`,
      '-J',
      url,
    ];
    execFile(
      binPath,
      args,
      { timeout: 90_000, windowsHide: true, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout) => {
        // Hỏng metadata KHÔNG được làm hỏng cả việc tải -> trả về rỗng.
        if (err || !stdout) {
          resolve(null);
          return;
        }
        try {
          const j = JSON.parse(stdout);
          resolve({
            title: j.title || null,
            uploader: j.uploader || j.channel || null,
            duration: typeof j.duration === 'number' ? j.duration : null,
            webpageUrl: j.webpage_url || url,
          });
        } catch {
          resolve(null);
        }
      }
    );
  });
}

/** Sau khi tải xong, tìm file audio mới nhất trong thư mục. */
function findAudioFile(dir) {
  const entries = fs
    .readdirSync(dir)
    .map((f) => path.join(dir, f))
    .filter((f) => /\.(m4a|webm|mp4|opus|ogg|mp3|aac|mka|mpga|flac|wav)$/i.test(f))
    .map((f) => ({ f, mtime: fs.statSync(f).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (!entries.length) {
    throw new Error('Tải xong nhưng không tìm thấy file audio nào.');
  }
  return entries[0].f;
}

/** Đổi lỗi của yt-dlp sang tiếng Việt để người dùng đọc hiểu. */
function translateYtError(stderr, code) {
  const s = String(stderr);
  const t = s.trim().split('\n').filter(Boolean).slice(-6).join('\n');

  if (/Sign in to confirm|not a bot/i.test(s)) {
    return (
      'YouTube đang chặn IP này và yêu cầu xác minh.\n' +
      'Cách xử lý: đổi mạng (dùng 4G thay WiFi), hoặc chờ 10–15 phút rồi thử lại.\n' +
      'Đây KHÔNG phải lỗi của app hay của yt-dlp.'
    );
  }
  if (/429|Too Many Requests/i.test(s)) {
    return 'Tải quá nhiều lần trong thời gian ngắn. Hãy nghỉ 10–15 phút rồi thử lại.';
  }
  if (/Video unavailable|Private video|This video has been removed/i.test(s)) {
    return 'Video không truy cập được: có thể đã bị xoá, bị khoá riêng tư, hoặc không còn công khai.';
  }
  if (/age.?restricted|inappropriate for some users/i.test(s)) {
    return 'Video bị giới hạn độ tuổi. Hãy chọn video khác.';
  }
  if (/Requested format is not available/i.test(s)) {
    return (
      'Không lấy được định dạng audio nào cho video này.\n' +
      'Cách xử lý: bấm “Cập nhật & kiểm chứng” trong phần Cài đặt → yt-dlp.'
    );
  }
  if (/unable to download (webpage|API page)|Failed to resolve|getaddrinfo|Connection refused|ETIMEDOUT|Could not connect/i.test(s)) {
    return 'Không kết nối được tới YouTube. Kiểm tra mạng của bạn rồi thử lại.';
  }
  if (/No space left on device/i.test(s)) {
    return 'Ổ đĩa đã hết chỗ. Hãy dọn vài GB rồi thử lại.';
  }
  if (/HTTP Error 403/i.test(s)) {
    return (
      'YouTube trả về lỗi 403.\n' +
      'Cách xử lý: đổi mạng, hoặc bấm “Cập nhật & kiểm chứng” trong phần Cài đặt → yt-dlp.'
    );
  }
  return `Tải thất bại (mã lỗi ${code}).\n${t}`;
}

// ---------------------------------------------------------------------------
// ffmpeg: chuan hoa audio
// ---------------------------------------------------------------------------

/** Chuyen audio ve wav 16kHz mono — dinh dang Whisper mong doi. */
function normalizeAudio(input, output, onProgress = () => {}) {
  return new Promise((resolve, reject) => {
    onProgress({ phase: 'convert', percent: 0, message: 'Đang chuẩn hoá audio…' });
    const args = [
      '-hide_banner',
      '-nostdin',
      '-y',
      '-i', input,
      '-vn',                 // bo video
      '-ac', '1',            // mono
      '-ar', '16000',        // 16 kHz
      '-acodec', 'pcm_s16le',
      '-progress', 'pipe:1',
      output,
    ];
    const proc = spawn(ffmpegPath(), args, { windowsHide: true });
    let err = '';
    let buf = '';

    const done = () => {
      if (!fs.existsSync(output) || fs.statSync(output).size === 0) {
        reject(new Error(`ffmpeg không tạo được file audio. ${err.split('\n').slice(-4).join('\n')}`));
        return;
      }
      onProgress({ phase: 'convert', percent: 100 });
      resolve(output);
    };

    proc.stdout.on('data', (d) => {
      buf += d.toString();
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const l of lines) {
        const m = l.match(/^out_time_ms=(\d+)/);
        if (m) {
          // -progress cho ra micro-giay
          onProgress({ phase: 'convert', seconds: Number(m[1]) / 1_000_000 });
        }
      }
    });
    proc.stderr.on('data', (d) => {
      err += d.toString();
    });
    proc.on('error', (e) => reject(new Error('Không chạy được ffmpeg: ' + e.message)));
    proc.on('close', (code) => {
      if (code !== 0 && code !== null) {
        reject(new Error(`ffmpeg kết thúc với mã lỗi ${code}. ${err.split('\n').slice(-4).join('\n')}`));
        return;
      }
      done();
    });

    setTimeout(() => {
      if (proc.exitCode === null) {
        proc.kill('SIGKILL');
        reject(new Error('ffmpeg quá thời gian chạy'));
      }
    }, FFMPEG_TIMEOUT).unref();
  });
}

module.exports = {
  ffmpegPath,
  ffprobePath,
  installFfmpeg,
  downloadAudio,
  fetchMetadata,
  normalizeAudio,
  parseDownloadLine,
  translateYtError,
  findAudioFile,
};
