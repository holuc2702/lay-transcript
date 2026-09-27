'use strict';

const path = require('path');
const fs = require('fs');
const { app } = require('electron');

/**
 * Mọi đường dẫn trong app đều đi qua đây.
 *
 * Nguyên tắc quan trọng: những thứ CẦN GHI (yt-dlp, cache) không được nằm trong
 * thư mục cài đặt. Trên macOS, /Applications là read-only và code-signed; nếu
 * yt-dlp nằm ở đó thì `yt-dlp -U` sẽ báo "Insufficient permissions to write" và
 * im lặng không làm gì. Vì vậy binary luôn được copy sang userData rồi mới cập nhật.
 */

function userData() {
  return app.getPath('userData');
}

/** Thư mục ghi được, nằm ngoài thư mục cài đặt. */
function writableDir(...parts) {
  const dir = path.join(userData(), ...parts);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Thư mục chứa tool có thể thay thế: yt-dlp, ffmpeg. */
function toolsDir() {
  return writableDir('tools');
}

/** Cache model Whisper (rất lớn, không bao giờ nằm trong installer). */
function modelsDir() {
  return writableDir('models');
}

/** Bản sao lưu các phiên bản yt-dlp đã từng chạy tốt (để quay lui). */
function ytdlpVersionsDir() {
  return writableDir('tools', 'yt-dlp-versions');
}

/** File log để người dùng copy khi báo lỗi. */
function logsDir() {
  return writableDir('logs');
}

function logFile() {
  return path.join(logsDir(), 'app.log');
}

/**
 * Thư mục lưu kết quả mặc định.
 *
 * KHÔNG được gọi thẳng app.getPath('videos'): Electron ném lỗi "Failed to get
 * 'videos' path" nếu thư mục Videos đó không tồn tại hoặc không xác định được —
 * đã gặp thật trên Windows (tài khoản không có thư mục Videos). Vì vậy thử lần
 * lượt, và luôn có một chỗ chắc chắn ghi được là thư mục dữ liệu của app.
 */
function defaultOutputDir() {
  for (const name of ['videos', 'downloads', 'documents', 'desktop']) {
    try {
      const p = app.getPath(name);
      if (p) {
        const dir = path.join(p, 'Lấy Transcript');
        fs.mkdirSync(dir, { recursive: true });
        return dir;
      }
    } catch {
      /* thử mục tiếp theo */
    }
  }
  const dir = path.join(writableDir('output'), 'Lấy Transcript');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Thư mục tài nguyên đi kèm app (read-only).
 * - dev:  <project>/resources
 * - prod: <app>/Contents/Resources  (macOS) hoặc <app>/resources (Windows)
 */
function resourcesDir() {
  return app.isPackaged
    ? process.resourcesPath
    : path.join(__dirname, '..', '..', 'resources');
}

/** Thư mục chứa sidecar Python đã freeze bằng PyInstaller. */
function sidecarDir() {
  return path.join(resourcesDir(), 'sidecar');
}

module.exports = {
  userData,
  writableDir,
  toolsDir,
  modelsDir,
  ytdlpVersionsDir,
  logsDir,
  logFile,
  defaultOutputDir,
  resourcesDir,
  sidecarDir,
};
