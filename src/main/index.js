'use strict';

const { app, BrowserWindow, ipcMain, shell, dialog, Menu } = require('electron');
const path = require('path');
const fs = require('fs');

const C = require('./config');
const paths = require('./paths');
const settings = require('./settings');
const ytdlp = require('./ytdlp');
const jobsLib = require('./jobs');
const exporters = require('./exporters');
const { Pipeline, setHistoryBroadcaster } = require('./pipeline');
const history = require('./history');
const translate = require('./translate');
const updater = require('./updater');

const isDev = !app.isPackaged;

let mainWindow = null;
let pipeline = null;
let ytdlpVersion = null;

/**
 * Thư mục dữ liệu dùng TÊN KHÔNG CÓ DẤU.
 *
 * Đây là sửa lỗi bắt buộc trên Windows, không phải chuyện thẩm mỹ:
 * ffmpeg.exe (bản gyan.dev) đọc đường dẫn bằng ANSI code page chứ không phải
 * Unicode, nên "Lấy Transcript" bị biến thành "L???y Transcript" và ffmpeg báo
 * "Error opening input: No such file or directory" dù file có thật. Đã tái hiện
 * và xác nhận trên Windows 11 ARM.
 *
 * Cách sửa an toàn nhất: giữ tên hiển thị có dấu, nhưng đặt thư mục dữ liệu là
 * tên ASCII. Như vậy mọi đường dẫn mà ta đưa cho chương trình ngoài (ffmpeg)
 * đều sạch, còn tên file kết quả vẫn giữ tiếng Việt vì Node tự ghi bằng Unicode.
 *
 * Phải gọi TRƯỚC khi app sẵn sàng, và trước khi bất kỳ thứ gì đọc userData.
 */
const DATA_DIR_NAME = 'LayTranscript';
try {
  app.setPath('userData', path.join(app.getPath('appData'), DATA_DIR_NAME));
} catch (err) {
  console.error('[main] khong doi duoc userData:', err.message);
}

/** Gui su kien ve cho renderer. */
function broadcast(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

// ---------------------------------------------------------------------------
// Cua so
// ---------------------------------------------------------------------------

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 900,
    minHeight: 620,
    backgroundColor: '#0f1115',
    title: 'Lấy Transcript',
    show: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // Mo link ngoai bang trinh duyet, khong mo trong app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) {
      e.preventDefault();
      if (/^https?:\/\//.test(url)) shell.openExternal(url);
    }
  });

  if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' });
}

function buildMenu() {
  const template = [
    ...(process.platform === 'darwin'
      ? [{ role: 'appMenu' }]
      : []),
    {
      label: 'Tệp',
      submenu: [
        {
          label: 'Mở thư mục lưu kết quả',
          click: () => shell.openPath(settings.getOutputDir()),
        },
        {
          label: 'Chọn thư mục lưu kết quả…',
          click: async () => {
            const r = await dialog.showOpenDialog(mainWindow, {
              properties: ['openDirectory', 'createDirectory'],
              title: 'Chọn thư mục lưu transcript',
            });
            if (!r.canceled && r.filePaths[0]) {
              settings.set({ outputDir: r.filePaths[0] });
              broadcast('settings:changed', settings.get());
            }
          },
        },
        { type: 'separator' },
        process.platform === 'darwin' ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: 'Giới thiệu',
      submenu: [
        {
          label: 'Về Lấy Transcript',
          click: () => {
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: 'Lấy Transcript',
              message: `Lấy Transcript ${app.getVersion()}`,
              detail:
                'Tạo transcript từ video YouTube bằng Whisper, chạy hoàn toàn trên máy bạn.\n\n' +
                'Electron ' + process.versions.electron + ' · Chrome ' + process.versions.chrome + '\n' +
                'yt-dlp ' + (ytdlpVersion || '—') + '\n' +
                'faster-whisper + CTranslate2 (CPU)\n\n' +
                'Liên hệ: holuc1991@gmail.com',
              buttons: ['Đóng'],
            });
          },
        },
        {
          label: 'Kiểm tra cập nhật ứng dụng',
          click: async () => {
            const r = await updater.check({
              onEvent: (e) => broadcast('toast', { level: e.phase === 'error' ? 'error' : 'info', message: e.message }),
            });
            if (r) broadcast('toast', { level: 'info', message: 'Đã kiểm tra xong cập nhật.' });
          },
        },
        {
          label: 'Mở thư mục dữ liệu',
          click: () => shell.openPath(paths.userData()),
        },
        {
          label: 'Mở nhật ký (log)',
          click: () => shell.openPath(paths.logsDir()),
        },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'Xem',
      submenu: [
        {
          label: 'Mở nhật ký (log)',
          click: () => shell.openPath(paths.logsDir()),
        },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------------------
// Khoi dong
// ---------------------------------------------------------------------------

app.whenReady().then(async () => {
  buildMenu();
  createWindow();

  pipeline = new Pipeline((ev) => broadcast('pipeline:event', ev));
  setHistoryBroadcaster(() => broadcast('history:changed', history.list()));
  translate.loadCache();
  try {
    history.pruneMissingFiles();
  } catch {
    /* không sao */
  }

  // Chuan bi tools: copy ffmpeg + yt-dlp tu installer sang thu muc ghi duoc.
  try {
    jobsLib.installFfmpeg();
    await ytdlp.ensureInstalled();
  } catch (err) {
    console.error('[main] chuẩn bị tools thất bại:', err.message);
  }

  // Tự cập nhật ứng dụng (khác với cập nhật yt-dlp).
  updater.init({ onEvent: (e) => broadcast('app:update', e) });

  if (settings.get().autoUpdateYtdlp) {
    // Khong chan giao dien: cap nhat chay nen, that bai thi im lang bo qua.
    ytdlp
      .update({ channel: settings.get().ytdlpChannel })
      .then((r) => {
        if (r.ok) broadcast('toast', { level: 'info', message: `yt-dlp đã cập nhật lên ${r.version}.` });
      })
      .catch(() => {});
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  pipeline?.cancelAll();
  pipeline?.worker.kill();
});

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

/** Boc moi handler trong try/catch va tra loi du nhat, de renderer khong phai
 *  tu xu ly loi chuoi. */
function handle(name, fn) {
  ipcMain.handle(name, async (_evt, ...args) => {
    try {
      return { ok: true, data: await fn(...args) };
    } catch (err) {
      return { ok: false, error: err.message, stack: err.stack };
    }
  });
}

// --- Cai dat ---
handle('settings:get', () => settings.get());
handle('settings:set', (patch) => settings.set(patch));
handle('settings:outputDir', () => settings.getOutputDir());
handle('settings:pickOutputDir', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
    title: 'Chọn thư mục lưu transcript',
    defaultPath: settings.getOutputDir(),
  });
  if (r.canceled) return null;
  settings.set({ outputDir: r.filePaths[0] });
  return r.filePaths[0];
});
handle('settings:pickFile', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    title: 'Chọn file cookies.txt',
    filters: [{ name: 'Netscape cookies', extensions: ['txt', 'cookies'] }],
  });
  return r.canceled ? null : r.filePaths[0];
});

// --- He thong / chan doan ---
handle('app:info', async () => {
  const { path: bin } = await ytdlp.ensureInstalled();
  let version = null;
  try {
    version = await ytdlp.currentVersion(bin);
    ytdlpVersion = version;   // cho menu "Giới thiệu"
  } catch {
    version = null;
  }
  return {
    appVersion: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    resourcesPath: paths.resourcesDir(),
    userData: paths.userData(),
    modelsDir: paths.modelsDir(),
    outputDir: settings.getOutputDir(),
    logsDir: paths.logsDir(),
    ytdlpPath: bin,
    ytdlpVersion: version,
  };
});

handle('app:sidecarEnv', async () => {
  const r = await pipeline.worker.send({ cmd: 'env' }, { timeout: 30_000 });
  return r.env;
});

handle('app:openPath', async (p) => {
  if (p && fs.existsSync(p)) {
    shell.openPath(p);
    return true;
  }
  return false;
});

handle('app:showItemInFolder', (p) => {
  if (p && fs.existsSync(p)) shell.showItemInFolder(p);
  return true;
});

// --- yt-dlp ---
handle('ytdlp:check', async (channel = 'stable') => {
  const { path: bin } = await ytdlp.ensureInstalled();
  const current = await ytdlp.currentVersion(bin);
  let latest = null;
  let error = null;
  try {
    latest = await ytdlp.latestRelease(channel);
  } catch (e) {
    error = e.message;
  }
  return {
    current,
    latest,
    error,
    channel,
    knownGood: C.YTDLP_KNOWN_GOOD,
    backups: ytdlp.listBackups(),
  };
});

handle('ytdlp:update', async (opts) => {
  // CHỈ giữ lại các sự kiện có thông điệp, bỏ qua mọi tick tiến trình.
  // `download` bắn ra hàng nghìn sự kiện (mỗi ~0.3%); gom hết vào bộ nhớ rồi
  // trả về renderer thì vô ích và nặng.
  const messages = [];
  const result = await ytdlp.update({
    ...opts,
    onProgress: (p) => {
      if (p.message) messages.push(p.message);
      broadcast('ytdlp:progress', p);
    },
  });
  return { result, messages };
});

handle('ytdlp:rollback', () => ytdlp.rollback());
handle('ytdlp:test', async () => {
  const { path: bin } = await ytdlp.ensureInstalled();
  const version = await ytdlp.currentVersion(bin);
  const check = await ytdlp.verifyBinary(bin);
  return { version, ...check };
});

// --- Model ---
handle('model:download', async (model) =>
  pipeline.worker.send({ cmd: 'download_model', model, modelsDir: ytdlp.modelsPath() })
);

// --- Viec ---
handle('job:add', (url, overrides) => pipeline.add(url, overrides));
handle('job:list', () => pipeline.list());
handle('job:get', (id) => pipeline.get(id));
handle('job:cancel', (id) => pipeline.cancel(id));
handle('job:cancelAll', () => pipeline.cancelAll());
handle('job:segments', (id) => {
  const j = pipeline.findJob(id);
  return j ? j.segments : null;
});

/** Xuat lai transcript cua mot job theo dinh dang nguoi dung chon. */
handle('job:export', async (id, formats) => {
  const job = pipeline.findJob(id);
  if (!job) throw new Error('Không tìm thấy việc này nữa.');
  if (!job.segments.length) throw new Error('Việc này chưa có transcript nào.');

  const dir = settings.getOutputDir();
  fs.mkdirSync(dir, { recursive: true });
  const meta = {
    title: job.title || null,
    url: job.url,
    language: job.info?.language || null,
    model: job.opts.model,
    createdAt: new Date().toISOString(),
  };
  const base = exporters.safeFilename(job.title || `transcript-${job.id.slice(0, 8)}`);

  const written = [];
  for (const fmt of formats) {
    const spec = exporters.FORMATS[fmt];
    if (!spec) continue;
    const ext = fmt === 'txtPlain' ? 'txt' : spec.ext;
    let full = path.join(dir, `${base}.${ext}`);
    let n = 2;
    while (fs.existsSync(full)) {
      full = path.join(dir, `${base} (${n}).${ext}`);
      n += 1;
    }
    fs.writeFileSync(full, spec.fn(job.segments, {}, meta), 'utf8');
    written.push(full);
  }
  return written;
});

/** Luu transcript hien tai (tu ban trong giao dien) ra file. */
handle('transcript:save', async ({ segments, title, formats, url, language, model }) => {
  const r = await dialog.showSaveDialog(mainWindow, {
    title: 'Luu transcript',
    defaultPath: path.join(
      settings.getOutputDir(),
      `${exporters.safeFilename(title || 'transcript')}.srt`
    ),
  });
  if (r.canceled) return null;

  const ext = path.extname(r.filePath).slice(1).toLowerCase();
  const fmt = formats.find((f) => {
    const e = f === 'txtPlain' ? 'txt' : exporters.FORMATS[f]?.ext;
    return e === ext;
  }) || (ext === 'srt' ? 'srt' : ext === 'vtt' ? 'vtt' : ext === 'json' ? 'json' : 'txt');

  const content = exporters.exportAs(fmt, segments, {}, { title, url, language, model });
  fs.writeFileSync(r.filePath, content, 'utf8');
  return r.filePath;
});

/** Lưu transcript thành file .txt, TÊN FILE DO NGƯỜI DÙNG TỰ ĐẶT. */
handle('transcript:saveTxt', async ({ segments, title, url, language, model, defaultName }) => {
  if (!Array.isArray(segments) || !segments.length) {
    throw new Error('Chưa có transcript để lưu.');
  }
  const r = await dialog.showSaveDialog(mainWindow, {
    title: 'Lưu transcript thành văn bản',
    defaultPath: path.join(settings.getOutputDir(), defaultName || 'transcript.txt'),
    filters: [{ name: 'Văn bản', extensions: ['txt'] }],
    properties: ['createDirectory', 'showOverwriteConfirmation'],
  });
  if (r.canceled) return null;

  // Ghi bằng UTF-8 kèm BOM: Windows Notepad cũ và nhiều trình soạn thảo vẫn
  // mở sai tiếng Việt/Trung nếu thiếu BOM.
  const header = [
    title ? `Nguồn: ${title}` : null,
    url ? `Link: ${url}` : null,
    language ? `Ngôn ngữ: ${language}` : null,
    model ? `Model: ${model}` : null,
    `Ngày: ${new Date().toLocaleString('vi-VN')}`,
  ].filter(Boolean);
  const body = segments
    .map((s) => String(s.text || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ');

  fs.writeFileSync(r.filePath, `\\uFEFF${header.join('\\n')}\\n\\n${body}\\n`, 'utf8');
  return r.filePath;
});

// --- Lich su ---
handle('history:list', () => history.list());
handle('history:remove', (id) => history.remove(id));
handle('history:clear', () => history.clear());
handle('history:prune', () => history.pruneMissingFiles());

/** Dịch một chuỗi bất kỳ sang tiếng Việt (dùng để dịch lại tiêu đề cũ). */
handle('translate:toVi', (text) => translate.toVietnamese(text));

// --- Danh muc tinh ---
handle('catalog:models', () => C.MODELS);
handle('catalog:languages', () => C.LANGUAGES);
handle('catalog:formats', () =>
  Object.entries(exporters.FORMATS).map(([id, f]) => ({ id, label: f.label, ext: f.ext }))
);

// Yeu cau link ben ngoai (cho nut "Huong dan").
handle('shell:open', (url) => {
  if (/^https?:\/\//.test(url)) {
    shell.openExternal(url);
    return true;
  }
  return false;
});
