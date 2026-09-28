'use strict';

const { app, BrowserWindow, ipcMain, shell, dialog, Menu, protocol, net } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

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
const providers = require('./providers');
const tts = require('./tts');
const timing = require('./timing');
const dubbing = require('./dubbing');
const align = require('./align');
const resegment = require('./resegment');

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
// Đăng ký protocol ltmedia:// để phát file âm thanh trong app.
//
// Vì sao không dùng file:// trực tiếp:
//   1. CSP của app đang đặt `default-src 'none'` -> trình duyệt chặn media.
//   2. Ngay cả khi mở khoá CSP, tải file:// từ trang file:// vẫn bị CORS chặn
//      trong Electron, nên player hiện "0:00 / 0:00" và không phát được.
// Protocol riêng đi qua net.fetch của Electron nên không dính hai lỗi trên.
protocol.registerSchemesAsPrivileged([
  { scheme: 'ltmedia', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

const DATA_DIR_NAME = 'LayTranscript';

// Bảng tra cứu file media cho protocol ltmedia:// (khai báo ở scope module vì
// cả handler protocol lẫn IPC đều dùng).
const mediaFiles = new Map();
let mediaSeq = 0;
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
  protocol.handle('ltmedia', async (request) => {
    try {
      const id = new URL(request.url).host;
      const file = mediaFiles.get(id);
      if (!file || !fs.existsSync(file)) return new Response('Not found', { status: 404 });
      return net.fetch(pathToFileURL(file).toString());
    } catch {
      return new Response('Error', { status: 500 });
    }
  });

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

// --- Cập nhật ứng dụng ---
handle('app:checkForUpdates', async () => {
  const events = [];
  const r = await updater.check({ onEvent: (e) => events.push(e) });
  return { result: r ? { version: r.updateInfo?.version } : null, events };
});
handle('app:quitAndInstall', () => updater.quitAndInstall());
handle('app:repoUrl', () => updater.REPO);

// --- Lich su ---
// --- Dịch thuật: nhiều nhà cung cấp ---
handle('providers:list', () => providers.listProviders());
handle('providers:save', (patch) => {
  const cur = providers.loadUserProviders();
  cur.providers = cur.providers || {};
  const { id, keys, model, baseUrl, label, kind, noKey, remove, defaults } = patch || {};
  if (remove) {
    delete cur.providers[id];
  } else if (id) {
    cur.providers[id] = {
      ...(cur.providers[id] || {}),
      keys: providers.normalizeKeys(keys),
      ...(model ? { model } : {}),
      ...(baseUrl ? { baseUrl } : {}),
      ...(label ? { label } : {}),
      ...(kind ? { kind } : {}),
      ...(noKey != null ? { noKey: !!noKey } : {}),
    };
  }
  if (defaults) cur.defaults = { ...(cur.defaults || {}), ...defaults };
  return providers.saveUserProviders(cur);
});
handle('providers:translate', (text, opts) => providers.translate(text, opts || {}));
handle('providers:test', async (id) => {
  const p = providers.listProviders().find((x) => x.id === id);
  if (!p) throw new Error('Không tìm thấy nhà cung cấp này.');
  // Câu thử dùng TIẾNG ANH. Nếu dùng tiếng Việt thì bản dịch trả về y hệt
  // câu gốc, người dùng nhìn tưởng API chưa chạy. Câu tiếng Anh cho kết quả
  // khác rõ ràng -> thấy được là kết nối thật sự hoạt động.
  const probe = 'The connection works. Please reply in Vietnamese.';
  const r = await providers.translate(probe, { providerIds: [id] });
  return {
    ok: true,
    providerLabel: p.label,
    model: p.model,
    sample: r.text,
    changed: r.text.trim() !== probe,
  };
});

// --- Lồng tiếng (TTS + căn timing) ---
handle('tts:login', async (password, remember) => {
  const r = await tts.login(password);
  if (remember) tts.savePassword(password);
  return r;
});
handle('tts:session', () => tts.session());
handle('tts:logout', async () => {
  await tts.logout();
  tts.forgetPassword();
  return true;
});
/** Mật khẩu đã lưu — dùng để tự đăng nhập lúc mở app. */
handle('tts:savedPassword', () => tts.loadPassword());
/** Tự đăng nhập nếu có mật khẩu đã lưu. */
handle('tts:autoLogin', async () => {
  const pw = tts.loadPassword();
  if (!pw) return { ok: false, reason: 'chưa lưu mật khẩu' };
  try {
    return await tts.login(pw);
  } catch (err) {
    return { ok: false, reason: err.message };
  }
});

/** Chọn file bản dịch có sẵn (txt/srt/vtt, chưa cần số phút). */
handle('dubbing:pickTranslation', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    title: 'Chọn file bản dịch (txt hoặc srt)',
    properties: ['openFile'],
    filters: [{ name: 'Bản dịch', extensions: ['txt', 'srt', 'vtt', 'md'] }],
  });
  if (r.canceled) return null;
  const file = r.filePaths[0];
  const parsed = align.parseTranslatedFile(fs.readFileSync(file, 'utf8'));
  return {
    file,
    text: parsed.text,
    hadTimestamps: parsed.hadTimestamps,
    name: path.basename(file, path.extname(file)),
  };
});

/** Chọn video/audio gốc chưa có trong lịch sử. */
handle('dubbing:pickSource', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    title: 'Chọn video hoặc audio gốc',
    properties: ['openFile'],
    filters: [
      { name: 'Video / Audio', extensions: ['mp4', 'mkv', 'mov', 'avi', 'webm', 'm4a', 'mp3', 'wav', 'aac', 'flac', 'opus', 'ogg', 'm4v'] },
    ],
  });
  return r.canceled ? null : r.filePaths[0];
});

/**
 * Nhận dạng giọng nói từ một file cục bộ (video/audio gốc chưa có trong lịch sử).
 * Dùng chung sidecar Whisper với tab Tạo transcript.
 */
handle('dubbing:analyzeSource', async (filePath, opts) => {
  if (process.platform !== 'darwin') throw new Error('Chỉ hỗ trợ trên macOS.');
  if (!filePath || !fs.existsSync(filePath)) throw new Error('Không thấy file.');
  const ffmpegPath = jobsLib.ffmpegPath();
  const work = paths.writableDir('dubbing-src', Date.now().toString(36));
  const wav = path.join(work, 'src16k.wav');
  const jobId = `src-${Date.now().toString(36)}`;
  const log = (m) => broadcast('dubbing:progress', { message: m });
  log('Đang chuẩn hoá audio…');
  await jobsLib.normalizeAudio(filePath, wav, () => {});
  log('Đang nhận diện giọng nói (Whisper)…');
  // Các đoạn transcript đến qua SỰ KIỆN, không nằm trong kết quả trả về.
  // Phải gom bằng listener rồi gỡ đi, nếu không sẽ tích tụ listener mỗi lần gọi.
  const collected = [];
  const off = pipeline.worker.on((ev) => {
    if (ev.event === 'segment' && ev.jobId === jobId) {
      collected.push({ start: ev.start, end: ev.end, text: ev.text, words: ev.words });
    }
  });
  let res;
  try {
    res = await pipeline.worker.send(
      {
        cmd: 'transcribe',
        jobId,
        audio: wav,
        modelsDir: paths.modelsDir(),
        opts: { model: opts?.model || 'small', language: 'auto', vadFilter: true, batchSize: 1 },
      },
      { timeout: 0 }
    );
  } finally {
    off();
  }
  log(`Xong: ${collected.length} đoạn.`);
  return {
    segments: collected,
    total: res?.elapsed ?? 0,
    name: path.basename(filePath, path.extname(filePath)),
  };
});

/** Căn bản dịch (chưa có số phút) vào khung thời gian của bản gốc. */
handle('dubbing:align', (translatedText, originalSegments) =>
  align.alignTranslation(translatedText, originalSegments)
);

/**
 * Dịch toàn bộ các đoạn, để người dùng XEM LẠI và sửa trước khi tạo voice.
 * Trả về mảng văn bản đã dịch, giữ nguyên thứ tự.
 */
handle('dubbing:translateAll', async (segments, providerIds) => {
  if (!Array.isArray(segments) || !segments.length) throw new Error('Chưa có nội dung.');
  const log = (message) => broadcast('dubbing:progress', { message });
  const out = [];
  const used = new Set();
  let failed = 0;
  for (let i = 0; i < segments.length; i++) {
    const src = String(segments[i].text || '').trim();
    if (!src) {
      out.push('');
      continue;
    }
    try {
      const r = await providers.translate(src, { providerIds });
      out.push(r.text);
      if (r.providerLabel) used.add(r.providerLabel);
    } catch {
      failed++;
      out.push(src); // dịch lỗi thì giữ nguyên, người dùng tự sửa
    }
    if ((i + 1) % 3 === 0 || i === segments.length - 1) {
      log(`  đã dịch ${i + 1}/${segments.length} đoạn${failed ? ` (${failed} lỗi)` : ''}`);
    }
  }
  if (failed) log(`Có ${failed} đoạn không dịch được, giữ nguyên tiếng gốc.`);
  // Báo rõ đã dùng nhà cung cấp nào. Nếu có nhiều hơn một, nghĩa là đã phải
  // lùi xuống nhà cung cấp dự phòng — người dùng cần biết để không tưởng
  // mình đang dùng mô hình mình chọn.
  const list = Array.from(used);
  if (list.length > 1) {
    log(`Lưu ý: dịch bằng nhiều nguồn (${list.join(', ')}) — nguồn chính có thể đã lỗi.`);
  }
  return { segments: out, providers: list, fallback: list.length > 1, failed };
});

/** Đăng ký file âm thanh để renderer phát được, trả về URL ltmedia://… */
handle('media:register', (files) => {
  const out = {};
  for (const [key, file] of Object.entries(files || {})) {
    if (!file || !fs.existsSync(file)) continue;
    const id = `${(++mediaSeq).toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    mediaFiles.set(id, file);
    out[key] = `ltmedia://${id}`;
  }
  return out;
});

/** Mở thư mục chứa file vừa ghép. */
handle('dubbing:reveal', (file) => {
  if (!file) return false;
  shell.showItemInFolder(file);
  return true;
});

/** Tự tách câu bản dịch theo nhịp câu của bản gốc. */
handle('dubbing:resegment', (translatedText, originalSegments) => {
  const r = resegment.resegmentTranslation(translatedText, originalSegments);
  return r;
});

/** Đọc nội dung một file .srt đã tạo để xem lại. */
handle('dubbing:readFile', (file) => {
  if (!file || !fs.existsSync(file)) return null;
  const n = fs.statSync(file).size;
  if (n > 4 * 1024 * 1024) throw new Error('File quá lớn để xem trong app.');
  return fs.readFileSync(file, 'utf8');
});

/** Dịch -> tạo voice từng đoạn -> căn timing -> ghép thành 1 file. */
handle('dubbing:run', async (payload) => {
  const {
    segments,
    voice = 'HOÀNG',
    providerIds = [],
    outName = 'lồng tiếng',
    voiceDir,
    translate = true,
  } = payload || {};
  if (!Array.isArray(segments) || !segments.length) throw new Error('Chưa có transcript.');
  if (process.platform !== 'darwin') {
    throw new Error('Tính năng lồng tiếng hiện chỉ dành cho macOS.');
  }

  // Thư mục lưu voice, đặt theo tên video để sau này dễ tìm lại và không phải
  // tạo voice từ đầu. Tên thư mục kèm thời lượng để dễ đoán.
  const safeName = (n) =>
    String(n || '')
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 90) || 'video';
  const totalSec = Math.round(
    segments.reduce((a, x) => a + Math.max(0, (Number(x.end) || 0) - (Number(x.start) || 0)), 0)
  );
  const mins = Math.round(totalSec / 60);
  // Thư mục GIỮ lại các file voice đã tạo (để sau không phải tạo lại), đặt
  // theo tên video. File tải từ 3A tạm ở thư mục riêng, xoá sau khi copy xong
  // để thư mục lưu chỉ còn file có tên dễ đọc.
  const keepDir = paths.writableDir(
    'dubbing-voice',
    `${safeName(payload.voiceDirName || '')}_${mins}ph`
  );
  const jobDir = paths.writableDir('dubbing-tmp', Date.now().toString(36));
  const outDir = voiceDir || paths.writableDir('dubbing-out');
  const ffmpegPath = jobsLib.ffmpegPath();
  const log = (message) => broadcast('dubbing:progress', { message });

  // ---- 1. Dịch từng đoạn ----
  let texts = segments.map((s) => String(s.text || '').trim());
  if (translate) {
    log(`Đang dịch ${texts.length} đoạn…`);
    const done = [];
    for (let i = 0; i < texts.length; i++) {
      if (!texts[i]) {
        done.push('');
        continue;
      }
      try {
        const r = await providers.translate(texts[i], { providerIds });
        done.push(r.text);
      } catch (err) {
        log(`Đoạn ${i + 1}: dịch lỗi, giữ nguyên tiếng gốc. (${String(err.message).split('\n')[0]})`);
        done.push(texts[i]);
      }
      if ((i + 1) % 5 === 0 || i === texts.length - 1) {
        log(`  đã dịch ${i + 1}/${texts.length} đoạn`);
      }
    }
    texts = done;
  }

  // ---- 2. Tạo voice cho từng đoạn có nội dung ----
  const parts = [];
  let made = 0;
  let want = 0;
  for (let i = 0; i < segments.length; i++) {
    if ((texts[i] || '').trim()) want++;
  }
  for (let i = 0; i < segments.length; i++) {
    const text = (texts[i] || '').trim();
    if (!text) continue;
    let v;
    try {
      v = await tts.synthesize(text, voice, {
        onStatus: (m) => log(`  đoạn ${i + 1}: ${m}`),
        appDir: jobDir,
        ffmpegPath,
      });
    } catch (err) {
      log(`  đoạn ${i + 1} tạo voice lỗi: ${err.message}`);
      continue;
    }
    // ĐO LẠI bằng ffprobe, không tin giá trị API trả về.
    //
    // Đây là nguyên nhân làm ÂM THANH BỊ ĐÈ NHAU: nếu ffprobe hỏng thì
    // duration = null. Trước đây null biến thành 0, bộ căn cho mỗi đoạn khung
    // 0.05 giây, nhưng file mp3 thực tế dài 3-6 giây -> các file chồng lên
    // nhau khi trộn. Nay: đo lại chính file, đo hỏng thì BỎ QUA đoạn đó
    // (mất một câu còn hơn nghe chồng tiếng).
    const realDur = await tts.probeDuration(v.file, ffmpegPath).catch(() => null);
    if (!realDur || !isFinite(realDur) || realDur <= 0) {
      log(`  đoạn ${i + 1}: không đo được thời lượng, bỏ qua đoạn này.`);
      continue;
    }
    parts.push({
      i,
      file: v.file,
      duration: realDur,
      start: Number(segments[i].start) || 0,
      end: Number(segments[i].end) || Number(segments[i].start) || 0,
    });

    // Đặt lại tên file cho dễ nhìn: 01_00m12s_Mot-Trong-video.mp3
    const st = Number(segments[i].start) || 0;
    const mm = String(Math.floor(st / 60)).padStart(2, '0');
    const ss = String(Math.floor(st % 60)).padStart(2, '0');
    const head = safeName(texts[i] || '').slice(0, 34).replace(/[.,;!?]+$/, '');
    const nice = path.join(
      jobDir,
      `${String(i + 1).padStart(3, '0')}_${mm}m${ss}s_${head || 'doan'}.mp3`
    );
    try {
      fs.copyFileSync(v.file, nice);
      parts[parts.length - 1].saved = nice;
    } catch {
      /* không copy được thì vẫn ghép bình thường */
    }
    made++;
  }
  if (!parts.length) throw new Error('Không tạo được file voice nào.');

  // ---- 3. Căn timing ----
  const fitted = timing.fitSegments(parts);
  const sum = timing.summarize(fitted);
  log(
    `Đã tạo ${made}/${want} đoạn voice. ` +
      `Tua nhẹ ${sum.sped} đoạn (tối đa ${sum.maxSpeed}x), trôi tối đa ${sum.maxDrift}s.`
  );

  // ---- 4. Ghép ----
  const base =
    String(outName).replace(/[<>:"/\|?*\x00-\x1f]/g, ' ').trim() || 'lồng tiếng';
  // MỖI VIDEO MỘT THƯ MỤC RIÊNG, và thư mục đó chỉ có đúng 3 file
  // (.wav .mp3 .srt). Trước đây tất cả đổ chung một thư mục nên mở ra nhiều
  // video là thấy đống file lẫn lộn.
  const videoDir = path.join(outDir, base);
  fs.mkdirSync(videoDir, { recursive: true });
  const wav = path.join(videoDir, `${base}.wav`);
  const mp3 = path.join(videoDir, `${base}.mp3`);
  await dubbing.merge(
    fitted.map((f) => {
      const p = parts.find((x) => x.i === f.index);
      return { file: p.file, start: f.start, speed: 1, duration: f.end - f.start };
    }),
    wav,
    ffmpegPath,
    {
      workDir: jobDir,
      onProgress: ({ message }) => log(message),
      probeDuration: (f) => tts.probeDuration(f, ffmpegPath),
    }
  );
  log('Đang xuất mp3…');
  await dubbing.toMp3(wav, mp3, ffmpegPath).catch(() => null);

  // ---- 5. SRT bản dịch để đối chiếu ----
  const srtFile = path.join(videoDir, `${base}.srt`);
  const fmt = (sec) => {
    const ms = Math.max(0, Math.round(sec * 1000));
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    return (
      String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' +
      String(s).padStart(2, '0') + ',' + String(ms % 1000).padStart(3, '0')
    );
  };
  const srt = fitted
    .map((f, k) => `${k + 1}\n${fmt(f.start)} --> ${fmt(f.end)}\n${texts[f.index] || ''}\n`)
    .join('\n');
  fs.writeFileSync(srtFile, srt, 'utf8');

  return {
    dir: videoDir,
    wav,
    mp3: fs.existsSync(mp3) ? mp3 : null,
    srt: srtFile,
    voiceDir: keepDir,
    voices: parts.filter((p) => p.saved).map((p) => p.saved),
    summary: sum,
  };
});

handle('history:list', () => history.list());
handle('history:remove', (id) => history.remove(id));
handle('history:clear', () => history.clear());
handle('history:prune', () => history.pruneMissingFiles());

/**
 * Đọc lại các đoạn transcript của một mục lịch sử.
 *
 * File .json do app xuất ra chứa đủ: start/end/text/words từng đoạn. Đọc lại
 * từ đĩa thay vì giữ trong RAM — vì transcript có thể vài MB và lịch sử giữ
 * tối đa 200 mục.
 */
handle('history:segments', async (id) => {
  const entry = history.list().find((e) => e.id === id);
  if (!entry) throw new Error('Không tìm thấy mục này trong lịch sử nữa.');
  const files = entry.outputs || [];
  const found = files.find((f) => f.toLowerCase().endsWith('.json') && fs.existsSync(f));
  if (!found) {
    throw new Error(
      'Không còn file .json của video này trên đĩa.\n' +
        'App chỉ giữ file kết quả, không giữ transcript trong bộ nhớ — ' +
        'nếu bạn xoá file tay hoặc chuyển ra chỗ khác thì không còn để hiển thị.'
    );
  }
  try {
    const data = JSON.parse(fs.readFileSync(found, 'utf8'));
    const segs = Array.isArray(data.segments) ? data.segments : data;
    if (!segs.length) throw new Error('File rỗng.');
    return segs.map((s, i) => ({
      index: i,
      start: Number(s.start) || 0,
      end: Number(s.end) || 0,
      text: String(s.text || ''),
      words: Array.isArray(s.words)
        ? s.words.map((w) => ({ start: Number(w.start) || 0, end: Number(w.end) || 0, word: String(w.word || '') }))
        : [],
    }));
  } catch (e) {
    throw new Error(`Không đọc được file ${found}: ${e.message}`);
  }
});

/** Dịch một chuỗi bất kỳ sang tiếng Việt (dùng để dịch lại tiêu đề cũ). */
handle('translate:toVi', (text) => translate.toVietnamese(text));

/**
 * Dịch TOÀN BỘ transcript sang tiếng Việt — BẢN DỊCH TẠM bằng máy.
 * Không hứa độ chính xác; giao diện phải gắn nhãn "dịch tạm" khi hiển thị.
 */
handle('translate:script', async (segments) => {
  const parts = [];
  const r = await translate.scriptToVietnamese(segments, (p) => {
    parts.push(p);
    broadcast('translate:progress', p);
  });
  return r;
});

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
