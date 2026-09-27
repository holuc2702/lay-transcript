'use strict';

const { autoUpdater } = require('electron-updater');

/**
 * Tự cập nhật ứng dụng từ GitHub Releases.
 *
 * ĐÂY KHÁC VỚI cập nhật yt-dlp ở ytdlp.js: yt-ddl là công cụ ngoài, ta tải về
 * rồi tự kiểm chứng; còn ứng dụng thì lấy bản .dmg/.exe mới từ release.
 *
 * Vì sao vẫn cần cơ chế này: yt-dlp hỏng liên tục, mỗi lần sửa ta phải phát
 * hành một bản app mới — có cơ chế tự cập nhật thì người dùng không phải tải
 * lại thủ công.
 *
 * LƯU Ý QUAN TRỌNG:
 *   Trên macOS, auto-update CHỈ hoạt động với app đã ký bằng chứng thư Apple
 *   Developer (Developer ID). Bản build tại chỗ (ad-hoc) sẽ báo lỗi
 *   "Code signature validation failed" khi thay app — nên khi đó ta báo rõ cho
 *   người dùng biết và chỉ gợi ý tải thủ công, không để hiện lỗi kỹ thuật.
 */

const REPO = 'holuc2702/lay-transcript';

let inProgress = false;

/** Bật cập nhật tự động nếu đang chạy bản đóng gói. */
function init({ onEvent } = {}) {
  const emit = onEvent || (() => {});
  if (!app_isPackaged()) return null;

  try {
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.allowPrerelease = false;

    autoUpdater.on('checking-for-update', () =>
      emit({ phase: 'checking', message: 'Đang kiểm tra bản cập nhật…' })
    );
    autoUpdater.on('update-available', (info) =>
      emit({
        phase: 'available',
        version: info.version,
        message: `Có bản mới ${info.version}. Đang tải…`,
      })
    );
    autoUpdater.on('update-not-available', () =>
      emit({ phase: 'none', message: 'Bạn đang dùng bản mới nhất.' })
    );
    autoUpdater.on('download-progress', (p) =>
      emit({ phase: 'downloading', percent: p.percent, message: `Đang tải… ${Math.round(p.percent)}%` })
    );
    autoUpdater.on('update-downloaded', (info) =>
      emit({
        phase: 'ready',
        version: info.version,
        message: `Đã tải ${info.version}. Khởi động lại app để áp dụng.`,
      })
    );
    autoUpdater.on('error', (err) => {
      const msg = String(err?.message || err);
      emit({ phase: 'error', message: explainUpdateError(msg) });
    });

    return autoUpdater;
  } catch (err) {
    emit({ phase: 'error', message: `Không bật được tự cập nhật: ${err.message}` });
    return null;
  }
}

function app_isPackaged() {
  // Tránh require('electron') ở top-level để file này test được ngoài Electron.
  try {
    return require('electron').app.isPackaged;
  } catch {
    return false;
  }
}

/** Dịch lỗi kỹ thuật của electron-updater sang tiếng Việt dễ hiểu. */
function explainUpdateError(msg) {
  if (/signature|not signed|validation failed|Code signature/i.test(msg)) {
    return (
      'Không cài được bản cập nhật trên macOS vì bản này chưa được ký bằng ' +
      'chứng thư Apple Developer.\nHãy tải bản mới thủ công từ trang Releases.'
    );
  }
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|network|getaddrinfo/i.test(msg)) {
    return 'Không kết nối được tới GitHub. Kiểm tra mạng rồi thử lại.';
  }
  if (/404|no release|latest.*not found/i.test(msg)) {
    return 'Chưa có bản phát hành nào trên GitHub Releases.';
  }
  return `Không cập nhật được: ${msg.slice(0, 200)}`;
}

/** Kiểm tra thủ công. Trả về Promise<null> nếu không bật được (chạy dev). */
async function check({ onEvent } = {}) {
  const emit = onEvent || (() => {});
  if (inProgress) return null;
  if (!app_isPackaged()) {
    emit({
      phase: 'error',
      message: 'Chỉ kiểm tra cập nhật được khi app đã đóng gói (bản cài đặt).',
    });
    return null;
  }
  inProgress = true;
  try {
    return await autoUpdater.checkForUpdates();
  } catch (err) {
    emit({ phase: 'error', message: explainUpdateError(String(err?.message || err)) });
    return null;
  } finally {
    inProgress = false;
  }
}

/** Cài bản đã tải rồi, rồi khởi động lại app. */
function quitAndInstall() {
  if (!app_isPackaged()) return false;
  try {
    setImmediate(() => autoUpdater.quitAndInstall());
    return true;
  } catch {
    return false;
  }
}

module.exports = { init, check, quitAndInstall, REPO, explainUpdateError };
