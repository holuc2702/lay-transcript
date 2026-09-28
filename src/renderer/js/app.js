'use strict';

/* Lấy Transcript — logic giao diện */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const state = {
  settings: null,
  models: [],
  languages: [],
  formats: [],
  jobs: new Map(),      // id -> { ...job, segments: [] }
  autoStart: false,
  history: [],
};

// ---------------------------------------------------------------------------
// Tiện ích
// ---------------------------------------------------------------------------

function toast(message, level = 'info') {
  const el = $('#toast');
  el.textContent = message;
  el.className = 'toast' + (level === 'error' ? ' err' : level === 'ok' ? ' ok' : '');
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    el.hidden = true;
  }, level === 'error' ? 9000 : 4500);
}

const STATE_LABELS = {
  queued: 'Đang chờ',
  starting: 'Đang bắt đầu',
  downloading: 'Đang tải video',
  converting: 'Đang xử lý audio',
  transcribing: 'Đang ghi âm',
  saving: 'Đang lưu',
  done: 'Xong',
  error: 'Lỗi',
  cancelled: 'Đã dừng',
  cancelling: 'Đang dừng',
};

const BUSY_STATES = new Set([
  'queued', 'starting', 'downloading', 'converting', 'transcribing', 'saving', 'cancelling',
]);

/** Định dạng giây -> mm:ss hoặc h:mm:ss. */
function fmtDuration(sec) {
  if (!sec && sec !== 0) return '';
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
    : `${m}:${String(ss).padStart(2, '0')}`;
}

/** Định dạng byte -> KB/MB/GB. */
function fmtBytes(b) {
  if (!b) return '';
  if (b < 1024) return `${b} B`;
  if (b < 1048576) return `${(b / 1024).toFixed(0)} KB`;
  if (b < 1073741824) return `${(b / 1048576).toFixed(0)} MB`;
  return `${(b / 1073741824).toFixed(1)} GB`;
}

/** Rút gọn URL cho đẹp. */
function shortUrl(url) {
  const m = String(url).match(/(?:v=|youtu\.be\/|shorts\/)([\w-]{6,})/);
  if (m) return `youtube.com/watch?v=${m[1]}`;
  return String(url).replace(/^https?:\/\//, '').slice(0, 60);
}

/** Tên video đẹp từ URL, dùng làm tên file. */
function titleFromUrl(url) {
  const m = String(url).match(/(?:v=|youtu\.be\/|shorts\/)([\w-]{6,})/);
  return m ? `video-${m[1]}` : null;
}

function containsCjk(s) {
  return /[　-鿿＀-￯]/.test(String(s));
}

// ---------------------------------------------------------------------------
// Khởi tạo
// ---------------------------------------------------------------------------

// Đoán nền tảng NGAY LẬP TỨC, không chờ main process.
//
// Trước đây `document.body.dataset.platform` chỉ được gán SAU khi
// `await window.api.app.info()` trả về — lần chạy đầu mất 10-30 giây vì macOS
// xác minh chữ ký. Trong lúc đó CSS chưa chừa chỗ cho ba nút đỏ/vàng/xanh nên
// chúng đè lên logo, rồi 30 giây sau mới "thụt vào trong". Đúng như người dùng
// báo. `navigator` có sẵn ngay khi script chạy, dùng nó là xong.
(function detectPlatformEarly() {
  try {
    const ua = String(navigator.userAgent || '');
    const pf = String(navigator.platform || '');
    const isMac = /mac/i.test(pf) || /macintosh/i.test(ua);
    const isWin = /win/i.test(pf) || /windows/i.test(ua);
    document.body.dataset.platform = isMac ? 'darwin' : isWin ? 'win32' : 'unknown';
  } catch {
    /* DOM chưa sẵn sàng thì init() sẽ thử lại */
  }
})();

async function init() {
  // NỐI MỌI SỰ KIỆN TRƯỚC, MỌI `await` SAU.
  //
  // Đây là bài học đắt giá: trước đây có một `await window.api.app.info()` nằm
  // ở ĐẦU init(), trước cả việc nối tab. Lần chạy đầu, macOS phải xác minh chữ
  // ký từng binary (yt-dlp, sidecar...) nên lệnh đó mất 10-30 giây — trong lúc
  // đó toàn bộ tab và nút đều chết, trông như app bị treo. Người dùng báo đúng.
  //
  // Quy tắc: không một `await` nào được đứng trước việc nối sự kiện.

  // Tab — phải bấm được ngay khi cửa sổ hiện ra.
  $$('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      $$('.tab').forEach((t) => t.classList.toggle('active', t === tab));
      $$('.panel').forEach((p) =>
        p.classList.toggle('active', p.dataset.panel === tab.dataset.tab)
      );
      if (tab.dataset.tab === 'dubbing') void renderDubHistory();
      if (tab.dataset.tab === 'settings') void loadProviders();
    });
  });

  wireSettingsInputs();
  wireAllEvents();
  void initDubbing();

  // Logo: nạp icon thật (không cần await — chỉ là thao tác DOM).
  const mark = $('#brandMark');
  if (mark) {
    const img = document.createElement('img');
    img.src = 'icon.svg';
    img.alt = '';
    img.addEventListener(
      'error',
      () => {
        const fallback = document.createElement('span');
        fallback.textContent = 'LT';
        mark.replaceChildren(fallback);
      },
      { once: true }
    );
    mark.replaceChildren(img);
  }

  // Lấy lại nền tảng chính xác từ main process (không chặn). Thường sẽ trùng
  // với đoán ở trên; nếu khác thì ghi đè.
  window.api.app
    .info()
    .then((info) => {
      if (info && info.platform) document.body.dataset.platform = info.platform;
    })
    .catch(() => {});

  await loadCatalogs();
  void refreshSystemInfo();
  void checkYtdlp();
}

async function loadCatalogs() {
  state.settings = await window.api.settings.get();
  state.models = await window.api.catalog.models();
  state.languages = await window.api.catalog.languages();
  state.formats = await window.api.catalog.formats();

  buildModelSelect();
  buildLangSelect();
  buildFormatChecks();
  applySettingsToUi();
}

/** Gắn toàn bộ sự kiện. Phải chạy ngay, không phụ thuộc tải dữ liệu. */
function wireAllEvents() {
  // Sự kiện
  $('#btnStart').addEventListener('click', startJobs);
  $('#btnClear').addEventListener('click', () => {
    $('#urlInput').value = '';
    $('#urlInput').focus();
  });
  $('#autoStart').addEventListener('change', (e) => {
    state.autoStart = e.target.checked;
    if (state.autoStart) localStorage.setItem('autoStart', '1');
    else localStorage.removeItem('autoStart');
  });
  state.autoStart = localStorage.getItem('autoStart') === '1';
  $('#autoStart').checked = state.autoStart;

  // "Tự động bắt đầu khi dán link".
  //
  // TRƯỚC ĐÂY chỉ lưu cờ vào state.autoStart rồi không dùng đến — nên bật cũng
  // chẳng có tác dụng. Ở đây ta thực sự nối sự kiện dán vào hành động chạy.
  //
  // Dùng cả hai sự kiện 'paste' và 'input':
  //  - 'paste' bắt đúng thao tác Ctrl+V.
  //  - 'input' bắt trường hợp dán bằng chuột phải, hoặc gõ xong rồi bấm Enter
  //    (một số trình duyệt không bắn 'paste' cho thao tác không dùng bàn phím).
  let autoTimer = null;

  // `text` là nội dung vừa dán. Với sự kiện 'paste', trình duyệt CHƯA chèn
  // text vào ô khi handler chạy — nên phải đọc từ clipboardData, nếu không
  // sẽ đọc ra chuỗi rỗng và không bao giờ tự chạy.
  const maybeAutoStart = (immediate, text) => {
    if (!state.autoStart) return;
    const urls = parseUrls(text);
    if (!urls.length) return;   // mới dán dở / chưa có link -> chờ thêm
    clearTimeout(autoTimer);
    // Chờ một nhịp ngắn: người dùng có thể dán nhiều link, hoặc dán link vào
    // giữa lúc đang gõ tiếp.
    autoTimer = setTimeout(() => startJobs(), immediate ? 250 : 900);
  };

  $('#urlInput').addEventListener('paste', (e) => {
    // Ưu tiên dữ liệu trong sự kiện; nếu không có thì đọc ô nhập.
    const fromEvent = e.clipboardData?.getData('text/plain') || '';
    maybeAutoStart(true, fromEvent || $('#urlInput').value);
  });
  // 'input' bắt trường hợp dán bằng chuột phải, hoặc gõ xong bấm Enter.
  $('#urlInput').addEventListener('input', () => maybeAutoStart(false, $('#urlInput').value));

  // Bấm Enter trong ô link (Shift+Enter = xuống dòng) sẽ bắt đầu.
  $('#urlInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      startJobs();
    }
  });

  $('#btnPickDir').addEventListener('click', async () => {
    const dir = await window.api.settings.pickOutputDir();
    if (dir) {
      $('#outputDirInput').value = dir;
      toast(`Đã lưu vào: ${dir}`, 'ok');
    }
  });
  $('#btnOpenDir').addEventListener('click', () =>
    window.api.app.openPath($('#outputDirInput').value)
  );

  $('#btnPickCookies').addEventListener('click', async () => {
    const f = await window.api.settings.pickFile();
    if (f) {
      $('#cookiesPath').value = f;
      saveSettings({ cookiesFile: f });
    }
  });

  $('#channelSelect').addEventListener('change', (e) =>
    saveSettings({ ytdlpChannel: e.target.value })
  );

  $('#btnCheckUpdate').addEventListener('click', checkYtdlp);
  $('#btnUpdateNow').addEventListener('click', () => updateYtdlp($('#channelSelect').value));
  $('#btnTestYtdlp').addEventListener('click', testYtdlp);
  $('#btnRollback').addEventListener('click', rollbackYtdlp);

  // Lắng nghe sự kiện từ tiến trình chính.
  window.api.onPipelineEvent(handlePipelineEvent);
  window.api.history.onChanged(() => loadHistory());
  void loadHistory();

  $('#btnHistoryRefresh')?.addEventListener('click', () => loadHistory());
  $('#btnHistoryClear')?.addEventListener('click', async () => {
    if (!state.history.length) {
      toast('Lịch sử đang trống.', 'error');
      return;
    }
    if (!confirm(`Xóa toàn bộ ${state.history.length} mục khỏi lịch sử?\n(File kết quả vẫn còn nguyên.)`)) {
      return;
    }
    await window.api.history.clear();
    await loadHistory();
    toast('Đã xóa toàn bộ lịch sử.', 'ok');
  });
  // --- Cập nhật ứng dụng ---
  window.api.app.onUpdate((e) => {
    const box = $('#appUpdateLog');
    if (!box) return;
    const div = document.createElement('div');
    div.className = 'log-line ' + (e.phase === 'error' ? 'err' : e.phase === 'ready' ? 'ok' : '');
    div.textContent = e.message;
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;
    if (e.phase === 'ready') {
      $('#btnInstallUpdate').hidden = false;
      toast('Đã tải bản cập nhật. Khởi động lại app để áp dụng.', 'ok');
    } else if (e.phase === 'available') {
      toast(`Có bản mới ${e.version}. Đang tải…`, 'info');
    }
  });
  $('#btnCheckAppUpdate')?.addEventListener('click', async () => {
    const btn = $('#btnCheckAppUpdate');
    btn.disabled = true;
    try {
      await window.api.app.checkForUpdates();
    } catch (err) {
      // Bản app CŨ (trước khi có tính năng cập nhật) sẽ báo
      // "No handler registered for 'app:checkForUpdates'". Dịch ra tiếng Việt
      // và chỉ đường tải bản mới, thay vì hiện lỗi kỹ thuật.
      const msg = String(err?.message || err);
      if (/No handler registered/i.test(msg)) {
        toast(
          'Bản app này quá cũ, chưa có tính năng tự cập nhật. ' +
            'Hãy tải bản mới nhất từ trang Releases (nút bên cạnh).',
          'error'
        );
      } else {
        toast(msg, 'error');
      }
    } finally {
      btn.disabled = false;
    }
  });
  $('#btnInstallUpdate')?.addEventListener('click', () => window.api.app.quitAndInstall());
  // Nút "Trang Releases": PHẢI có handler click riêng.
  //
  // Trước đây đây là thẻ <a href="#"> mà không gắn sự kiện — bấm vào không có
  // gì xảy ra vì href="#" chỉ thêm dấu # vào URL hiện tại. Đã sửa: bấm là mở
  // trình duyệt ngoài qua IPC, không phụ thuộc điều hướng của Electron.
  window.api.app
    .repoUrl()
    .then((repo) => {
      const a = $('#btnReleases');
      if (!a) return;
      const url = `https://github.com/${repo}/releases`;
      a.href = url;
      a.addEventListener('click', (e) => {
        e.preventDefault();
        window.api.app.openExternal(url);
      });
    })
    .catch(() => {});

  wireDubbing();

  $('#mailLink')?.addEventListener('click', (e) => {
    e.preventDefault();
    window.api.app.openExternal('mailto:holuc1991@gmail.com');
  });
  window.api.onToast((t) => toast(t.message, t.level));
  window.api.onSettingsChanged((s) => {
    state.settings = s;
    applySettingsToUi();
  });
}

// ---------------------------------------------------------------------------
// Tạo danh sách chọn
// ---------------------------------------------------------------------------

function buildModelSelect() {
  const sel = $('#modelSelect');
  sel.innerHTML = '';
  for (const m of state.models) {
    const o = document.createElement('option');
    o.value = m.id;
    o.textContent = `${m.label} — ${m.id} · ${m.sizeMB} MB · ${m.speed}${m.recommended ? ' ★' : ''}`;
    sel.appendChild(o);
  }
  updateModelHint();
}

function updateModelHint() {
  const m = state.models.find((x) => x.id === $('#modelSelect').value);
  $('#modelHint').textContent = m ? m.note : '';
}

function buildLangSelect() {
  const sel = $('#langSelect');
  sel.innerHTML = '';
  for (const l of state.languages) {
    const o = document.createElement('option');
    o.value = l.code;
    o.textContent = l.code === 'auto' ? l.name : `${l.name} (${l.code})`;
    sel.appendChild(o);
  }
}

function buildFormatChecks() {
  const box = $('#formatChecks');
  box.innerHTML = '';
  // Bật sẵn 3 định dạng dùng nhiều nhất.
  const defaults = ['srt', 'txt', 'json'];
  for (const f of state.formats) {
    const label = document.createElement('label');
    label.className = 'checkbox';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = f.id;
    input.checked = defaults.includes(f.id);
    label.append(input, document.createTextNode(f.label));
    box.appendChild(label);
  }
}

function selectedFormats() {
  return $$('#formatChecks input:checked').map((i) => i.value);
}

function applySettingsToUi() {
  const s = state.settings;
  if (!s) return;
  $('#modelSelect').value = s.model;
  updateModelHint();
  $('#langSelect').value = s.language;
  $('#scriptSelect').value = s.script || '';
  $('#taskSelect').value = s.task;
  $('#vadFilter').checked = s.vadFilter;
  $('#translateTitle').checked = s.translateTitle !== false;
  $('#hotwordsInput').value = s.hotwords || '';
  $('#cookiesPath').value = s.cookiesFile || '';
  $('#useCookies').checked = s.useCookies;
  $('#keepAudio').checked = s.keepAudio;
  $('#channelSelect').value = s.ytdlpChannel;
  $('#outputDirInput').value = window.__outputDir || (window.__outputDir = s.outputDir) || '';
  if (!s.outputDir) {
    window.api.settings.outputDir().then((d) => {
      window.__outputDir = d;
      $('#outputDirInput').value = d;
    });
  }
  $('#scriptField').style.display = s.language === 'auto' || s.language === 'zh' ? '' : 'none';
}

// ---------------------------------------------------------------------------
// Lưu cài đặt
// ---------------------------------------------------------------------------

async function saveSettings(patch) {
  state.settings = await window.api.settings.set(patch);
  return state.settings;
}

// Gắn sự kiện cho các điều khiển trong Cài đặt.
function wireSettingsInputs() {
  $('#modelSelect').addEventListener('change', (e) => {
    saveSettings({ model: e.target.value });
    updateModelHint();
  });
  $('#langSelect').addEventListener('change', (e) => {
    saveSettings({ language: e.target.value });
    $('#scriptField').style.display =
      e.target.value === 'auto' || e.target.value === 'zh' ? '' : 'none';
  });
  $('#scriptSelect').addEventListener('change', (e) => saveSettings({ script: e.target.value }));
  $('#taskSelect').addEventListener('change', (e) => saveSettings({ task: e.target.value }));
  $('#translateTitle').addEventListener('change', (e) =>
    saveSettings({ translateTitle: e.target.checked })
  );
  $('#vadFilter').addEventListener('change', (e) => saveSettings({ vadFilter: e.target.checked }));
  $('#hotwordsInput').addEventListener('change', (e) => saveSettings({ hotwords: e.target.value }));
  $('#useCookies').addEventListener('change', (e) => saveSettings({ useCookies: e.target.checked }));
  $('#keepAudio').addEventListener('change', (e) => saveSettings({ keepAudio: e.target.checked }));
}

// ---------------------------------------------------------------------------
// Chạy video
// ---------------------------------------------------------------------------

function parseUrls(text) {
  return String(text)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => /^https?:\/\//i.test(l) || /^[\w-]{11}$/.test(l))
    .map((l) => (/^https?:\/\//i.test(l) ? l : `https://www.youtube.com/watch?v=${l}`));
}

async function startJobs() {
  const urls = parseUrls($('#urlInput').value);
  if (!urls.length) {
    toast('Hãy dán ít nhất một link YouTube.', 'error');
    $('#urlInput').focus();
    return;
  }

  const formats = selectedFormats();
  if (!formats.length) {
    toast('Hãy chọn ít nhất một định dạng để lưu.', 'error');
    return;
  }

  $('#btnStart').disabled = true;
  try {
    for (const url of urls) {
      const job = await window.api.jobs.add(url, { formats });
      state.jobs.set(job.id, { ...job, segments: [] });
      renderJob(job.id);
    }
    $('#urlInput').value = '';
    await saveSettings({ formats });
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    $('#btnStart').disabled = false;
    $('#emptyState').style.display = 'none';
  }
}

// ---------------------------------------------------------------------------
// Vẽ giao diện
// ---------------------------------------------------------------------------

function renderJob(id) {
  const j = state.jobs.get(id);
  if (!j) return;

  let el = document.getElementById(`job-${id}`);
  if (!el) {
    el = document.createElement('div');
    el.className = 'job';
    el.id = `job-${id}`;
    $('#jobsList').prepend(el);
  }

  const busy = BUSY_STATES.has(j.state);
  const canCancel = busy;
  const hasSegments = (j.segmentCount || 0) > 0;

  const langLine = j.info?.language
    ? `Ngôn ngữ: ${j.info.language}${
        j.info.languageProbability
          ? ` (${Math.round(j.info.languageProbability * 100)}%)`
          : ''
      }`
    : null;

  // Mỗi lần có sự kiện mới, thẻ việc được vẽ lại từ đầu (innerHTML), nên nội
  // dung transcript đang mở sẽ biến mất. Phải GIỮ LẠI trước khi ghi đè —
  // lấy sau khi innerHTML thì chỉ còn là ô rỗng mới.
  const oldBox = el.querySelector('[data-transcript]');
  const savedBox = oldBox && oldBox.childElementCount ? oldBox : null;
  const wasOpen = !!(savedBox && !savedBox.hidden);

  el.innerHTML = `
    <div class="job-header">
      <div class="job-info">
        <div class="job-title">${escapeHtml(
          j.title || titleFromUrl(j.url) || 'Video'
        )}</div>
        ${
          j.titleVi && j.titleVi !== j.title
            ? `<div class="job-title-vi">${escapeHtml(j.titleVi)}</div>`
            : ''
        }
        <div class="job-url" data-url="${escapeAttr(j.url)}" title="${escapeAttr(j.url)}">${escapeHtml(
          shortUrl(j.url)
        )}</div>
        ${
          j.uploader || j.videoDuration
            ? `<div class="job-sub">${[
                j.uploader ? escapeHtml(j.uploader) : null,
                j.videoDuration ? escapeHtml(fmtDuration(j.videoDuration)) : null,
              ]
                .filter(Boolean)
                .join(' · ')}</div>`
            : ''
        }
        ${j.message ? `<div class="job-message">${escapeHtml(j.message)}</div>` : ''}
      </div>
      <span class="status ${j.state}">
        ${busy ? '<span class="spinner"></span>' : ''}
        ${STATE_LABELS[j.state] || j.state}
      </span>
    </div>
    <div class="progress"><div class="progress-fill" data-fill></div></div>
    ${j.error ? `<div class="job-error">${escapeHtml(j.error)}</div>` : ''}
    <div class="job-footer">
      <span class="job-meta segment-count">${
        hasSegments ? `${j.segmentCount} đoạn` : langLine || ''
      }</span>
      ${
        j.result?.elapsed
          ? `<span class="job-meta">Xong trong ${fmtDuration(j.result.elapsed)}${
              j.result.rtf ? ` (${j.result.rtf}× thời gian thực)` : ''
            }</span>`
          : ''
      }
      ${
        canCancel
          ? `<button class="btn tiny" data-act="cancel">Dừng</button>`
          : ''
      }
      ${
        j.state === 'done'
          ? `<button class="btn tiny" data-act="transcript">Xem transcript (${j.segmentCount})</button>`
          : ''
      }
      ${
        j.state === 'done'
          ? `<button class="btn tiny" data-act="copy">Sao chép văn bản</button>
             <button class="btn tiny" data-act="savetxt">Lưu thành .txt</button>
             <button class="btn tiny" data-act="translate">Dịch sang tiếng Việt</button>`
          : ''
      }
      ${
        j.state === 'error' || j.state === 'cancelled'
          ? `<button class="btn tiny" data-act="retry">Thử lại</button>`
          : ''
      }
    </div>
    ${hasSegments ? `<div class="transcript" data-transcript${j.transcriptOpen ? '' : ' hidden'}></div>` : ''}
  `;

  // Rộng thanh tiến trình phải gán bằng CSSOM, KHÔNG nhét style="..." vào
  // innerHTML: CSP của app chặn style attribute nội tuyến (style-src 'self').
  // Gán trực tiếp qua .style thì CSP không can thiệp.
  const fill = el.querySelector('[data-fill]');
  if (fill) fill.style.width = `${Math.max(0, Math.min(100, j.progress || 0))}%`;

  // Dán lại ô transcript đã tải sẵn, giữ nguyên trạng thái mở/đóng.
  const newBox = el.querySelector('[data-transcript]');
  if (savedBox && newBox) {
    newBox.innerHTML = savedBox.innerHTML;
    newBox.hidden = !wasOpen;
    j.transcriptOpen = wasOpen;
  }

  el.querySelectorAll('[data-act]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const act = btn.dataset.act;
      if (act === 'cancel') {
        await window.api.jobs.cancel(id);
      } else if (act === 'retry') {
        const url = j.url;
        el.remove();
        state.jobs.delete(id);
        const nj = await window.api.jobs.add(url, { formats: selectedFormats() });
        state.jobs.set(nj.id, { ...nj, segments: [] });
        renderJob(nj.id);
      } else if (act === 'transcript') {
        toggleTranscript(id, el);
      } else if (act === 'copy') {
        await copyPlainText(id);
      } else if (act === 'savetxt') {
        await saveAsTxt(id);
      } else if (act === 'translate') {
        await translateScript(id, el);
      }
    });
  });

  el.querySelector('.job-url')?.addEventListener('click', (e) => {
    window.api.app.openExternal(e.currentTarget.dataset.url);
  });
}

/** Nạp (hoặc nạp lại) các đoạn transcript. */
async function loadSegments(id, box) {
  const segments = await window.api.jobs.segments(id);
  const j = state.jobs.get(id);
  if (j) j.segments = segments;
  if (!segments) {
    // Job đã bị gỡ khỏi bộ nhớ (app vừa khởi động lại chẳng hạn).
    box.innerHTML =
      '<div class="seg"><span class="seg-text" style="color:var(--text-faint)">' +
      'Không còn dữ liệu của phiên này. Hãy chạy lại video.</span></div>';
    return false;
  }
  if (!segments.length) return false;
  box.innerHTML = segments
    .map((s) => {
      const t = fmtDuration(s.start);
      const cn = containsCjk(s.text) ? ' cn' : '';
      return `<div class="seg${cn}"><span class="seg-time">${t}</span><span class="seg-text">${escapeHtml(
        s.text.trim()
      )}</span></div>`;
    })
    .join('');
  return true;
}

async function toggleTranscript(id, el) {
  const box = el.querySelector('[data-transcript]');
  if (!box) return;
  const j = state.jobs.get(id);
  if (!j) return;

  if (box.childElementCount && !box.dataset.failed) {
    j.transcriptOpen = !box.hidden;
    box.hidden = !j.transcriptOpen;
    if (!box.hidden) box.scrollTop = 0;
    return;
  }
  delete box.dataset.failed;
  const ok = await loadSegments(id, box);
  if (!ok) {
    box.dataset.failed = '1';
    box.hidden = false;
    return;
  }
  j.transcriptOpen = true;
  box.hidden = false;
  box.scrollTop = 0;
}

/**
 * Lấy toàn bộ transcript dưới dạng VĂN BẢN THUẦN — KHÔNG kèm số phút/giây.
 * Người dùng dán vào tài liệu, email, dịch thuật thì cần đúng thứ này.
 */
function plainTextOf(segments) {
  return segments
    .map((s) => String(s.text || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function copyPlainText(id) {
  const j = state.jobs.get(id);
  const segments = j?.segments || (await window.api.jobs.segments(id)) || [];
  if (!segments.length) {
    toast('Chưa có transcript để sao chép.', 'error');
    return;
  }
  const text = plainTextOf(segments);
  try {
    await navigator.clipboard.writeText(text);
    toast(`Đã sao chép ${text.length.toLocaleString('vi-VN')} ký tự.`, 'ok');
  } catch {
    // Một số môi trường Electron chặn clipboard API -> dùng cách cũ.
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    toast(ok ? 'Đã sao chép văn bản.' : 'Không sao chép được. Hãy dùng “Lưu thành .txt”.',
          ok ? 'ok' : 'error');
  }
}

/** Lưu transcript thành file .txt; TÊN FILE do người dùng tự đặt. */
async function saveAsTxt(id) {
  const j = state.jobs.get(id);
  const segments = j?.segments || (await window.api.jobs.segments(id)) || [];
  if (!segments.length) {
    toast('Chưa có transcript để lưu.', 'error');
    return;
  }
  const stem = j.title || `transcript-${id.slice(0, 8)}`;
  const saved = await window.api.transcript.saveTxt({
    segments,
    title: j.title,
    url: j.url,
    language: j.info?.language,
    model: j.opts?.model,
    defaultName: `${stem}.txt`,
  });
  if (saved) toast(`Đã lưu: ${saved.split(/[\\/]/).pop()}`, 'ok');
}

/**
 * Dịch toàn bộ transcript sang tiếng Việt — BẢN DỊCH TẠM bằng máy.
 * Hiển thị trong một khung riêng, gắn nhãn rõ ràng để người dùng biết đây
 * không phải bản dịch chuẩn.
 */
async function translateScript(id, el) {
  const j = state.jobs.get(id);
  const segments = j?.segments || (await window.api.jobs.segments(id)) || [];
  if (!segments.length) {
    toast('Chưa có transcript để dịch.', 'error');
    return;
  }

  // Mở khung chờ trước để người dùng thấy đang làm việc.
  let box = el.querySelector('[data-tsbox]');
  if (!box) {
    box = document.createElement('div');
    box.className = 'ts-box';
    box.dataset.tsbox = '1';
    el.appendChild(box);
  }
  box.innerHTML = `<div class="ts-head">
      <span class="ts-badge">Bản dịch tạm bằng máy — chỉ để hiểu đại khái</span>
      <button class="btn tiny ghost" data-tsclose>Đóng</button>
    </div>
    <div class="ts-body"><span class="spinner"></span> Đang dịch…</div>`;
  box.querySelector('[data-tsclose]').addEventListener('click', () => box.remove());

  const off = window.api.translate.onProgress((p) => {
    const b = box.querySelector('.ts-body');
    if (b) b.innerHTML = `<span class="spinner"></span> Đang dịch… ${p.done}/${p.total}`;
  });

  try {
    const r = await window.api.translate.script(segments);
    const text = String(r?.text || '').trim();
    if (!text) {
      box.querySelector('.ts-body').textContent =
        'Không dịch được: ' + (r?.reason || 'lỗi không rõ');
      return;
    }
    const esc = escapeHtml(text).replace(/\n/g, '<br>');
    const note = r.alreadyVietnamese
      ? '<div class="ts-note">Transcript vốn đã là tiếng Việt.</div>'
      : r.failed
        ? `<div class="ts-note">Có ${r.failed} đoạn dịch lỗi nên giữ nguyên tiếng gốc.</div>`
        : '';
    const body = box.querySelector('.ts-body');
    body.innerHTML =
      `<div class="ts-text">${esc}</div>${note}
       <div class="ts-actions">
         <button class="btn tiny" data-tscopy>Sao chép bản dịch</button>
       </div>`;
    body.querySelector('[data-tscopy]').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(text);
        toast('Đã sao chép bản dịch.', 'ok');
      } catch {
        toast('Không sao chép được.', 'error');
      }
    });
  } catch (err) {
    const b = box.querySelector('.ts-body');
    if (b) b.textContent = 'Không dịch được: ' + err.message;
  } finally {
    off();
  }
}

// ---------------------------------------------------------------------------
// Sự kiện từ tiến trình chính
// ---------------------------------------------------------------------------

function handlePipelineEvent(ev) {
  if (ev.type === 'job' && ev.job) {
    const prev = state.jobs.get(ev.job.id);
    state.jobs.set(ev.job.id, {
      ...ev.job,
      segments: prev?.segments ?? [],
      transcriptOpen: prev?.transcriptOpen,
    });
    renderJob(ev.job.id);
  }
}

// ---------------------------------------------------------------------------
// yt-dlp
// ---------------------------------------------------------------------------

function logLine(text, cls = '') {
  const box = $('#ytdlpLog');
  const div = document.createElement('div');
  div.className = 'log-line ' + cls;
  div.textContent = text;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

async function checkYtdlp() {
  const box = $('#ytdlpStatus');
  box.innerHTML = '<span class="pill">Đang kiểm tra…</span>';
  try {
    const r = await window.api.ytdlp.check($('#channelSelect').value);
    if (r.error) {
      box.innerHTML = `<span class="pill err">Không kiểm tra được: ${escapeHtml(r.error)}</span>`;
      return;
    }
    const outOfDate = r.latest && r.current && r.current !== r.latest.version;
    box.innerHTML = `
      <span class="pill">Đang dùng: ${escapeHtml(r.current || '?')}</span>
      ${
        r.latest
          ? `<span class="pill ${outOfDate ? 'err' : 'ok'}">Mới nhất: ${escapeHtml(
              r.latest.version
            )}${outOfDate ? ' — nên cập nhật' : ' ✓'}</span>`
          : ''
      }
    `;
  } catch (err) {
    box.innerHTML = `<span class="pill err">${escapeHtml(err.message)}</span>`;
  }
}

async function updateYtdlp(channel) {
  const btn = $('#btnUpdateNow');
  btn.disabled = true;
  btn.textContent = 'Đang cập nhật…';
  logLine('— Bắt đầu cập nhật —');
  const off = window.api.ytdlp.onProgress((p) => {
    if (p.message) logLine(p.message, p.phase === 'failed' ? 'err' : '');
  });
  try {
    const { result } = await window.api.ytdlp.update({ channel });
    if (result.ok) {
      logLine(`✓ Đã cập nhật lên ${result.version}.`, 'ok');
      toast(`yt-dlp đã cập nhật lên ${result.version}.`, 'ok');
    } else {
      logLine(`✗ Không dùng bản mới: ${result.message}`, 'warn');
      toast(result.message, 'error');
    }
  } catch (err) {
    logLine(`✗ ${err.message}`, 'err');
    toast(err.message, 'error');
  } finally {
    off();
    btn.disabled = false;
    btn.textContent = 'Cập nhật & kiểm chứng';
    checkYtdlp();
  }
}

async function testYtdlp() {
  const btn = $('#btnTestYtdlp');
  btn.disabled = true;
  btn.textContent = 'Đang thử…';
  logLine('Đang tải thử một video ngắn…');
  try {
    const r = await window.api.ytdlp.test();
    if (r.ok) {
      logLine(`✓ yt-dlp ${r.version} tải thử thành công.`, 'ok');
      toast('yt-dlp hoạt động bình thường.', 'ok');
    } else {
      logLine(`✗ ${r.message}`, 'err');
      toast(r.message, 'error');
    }
  } catch (err) {
    logLine(`✗ ${err.message}`, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Thử tải thử';
  }
}

async function rollbackYtdlp() {
  try {
    const r = await window.api.ytdlp.rollback();
    if (r.ok) {
      logLine(`✓ Đã quay lui về ${r.version}.`, 'ok');
      toast(`Đã quay lui về yt-dlp ${r.version}.`, 'ok');
    } else {
      toast(r.message, 'error');
    }
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    checkYtdlp();
  }
}

// ---------------------------------------------------------------------------
// Lịch sử
// ---------------------------------------------------------------------------

async function loadHistory() {
  try {
    state.history = await window.api.history.list();
  } catch (err) {
    console.error('không đọc được lịch sử:', err);
    state.history = [];
  }
  renderHistory();
}

function renderHistory() {
  const box = $('#historyList');
  const empty = $('#historyEmpty');
  const n = state.history.length;
  const cnt = $('#historyCount');
  if (cnt) cnt.textContent = String(n);

  if (!n) {
    if (box) box.innerHTML = '';
    if (empty) empty.hidden = false;
    return;
  }
  if (empty) empty.hidden = true;
  if (!box) return;

  // Giữ lại trạng thái đang mở của từng mục: loadHistory vẽ lại toàn bộ danh
  // sách, nên phải nhớ mục nào đang mở và nội dung đã tải để không mất.
  const savedOpen = new Map();
  box.querySelectorAll('.hist-item[data-id]').forEach((el) => {
    const id = el.dataset.id;
    const inner = el.querySelector('[data-hseg]');
    if (inner && inner.childElementCount && !inner.hidden) {
      savedOpen.set(id, inner.innerHTML);
    }
  });

  box.innerHTML = state.history
    .map((h) => {
      const when = h.createdAt ? new Date(h.createdAt).toLocaleString('vi-VN') : '';
      const titleVi =
        h.titleVi && h.titleVi !== h.title
          ? `<div class="hist-title-vi">${escapeHtml(h.titleVi)}</div>`
          : '';
      const gone = h.filesMissing ? '<span class="hist-warn">file đã bị xoá</span>' : '';
      const id = escapeAttr(h.id || '');
      return `<div class="hist-item" data-id="${id}">
        <div class="hist-top">
          <div class="hist-main">
            <div class="hist-title">${escapeHtml(h.title || 'Video')}</div>
            ${titleVi}
            <div class="hist-meta">
              ${h.uploader ? escapeHtml(h.uploader) + ' · ' : ''}${when}
              ${h.segmentCount ? ` · ${h.segmentCount} đoạn` : ''}
              ${h.model ? ` · ${escapeHtml(h.model)}` : ''}
              ${h.language ? ` · ${escapeHtml(h.language)}` : ''}
              ${gone}
            </div>
          </div>
          <div class="hist-actions">
            ${h.segmentCount
              ? `<button class="btn tiny" data-hact="view">Xem</button>`
              : ''}
            ${h.segmentCount
              ? `<button class="btn tiny" data-hact="copy">Sao chép văn bản</button>`
              : ''}
            <button class="btn tiny" data-hact="rerun" data-url="${escapeAttr(h.url)}">Chạy lại</button>
            <button class="btn tiny" data-hact="open" data-file="${escapeAttr((h.outputs || [])[0] || '')}"
              ${h.outputs && h.outputs.length ? '' : 'disabled'}>Mở file</button>
            <button class="btn tiny ghost" data-hact="remove" title="Xóa mục này">✕</button>
          </div>
        </div>
        <div class="transcript hist-seg" data-hseg hidden></div>
      </div>`;
    })
    .join('');

  // Khôi phục nội dung đang mở trước khi vẽ lại.
  box.querySelectorAll('.hist-item[data-id]').forEach((el) => {
    const html = savedOpen.get(el.dataset.id);
    if (html) {
      const inner = el.querySelector('[data-hseg]');
      if (inner) {
        inner.innerHTML = html;
        inner.hidden = false;
        const btn = el.querySelector('[data-hact="view"]');
        if (btn) btn.textContent = 'Thu gọn';
      }
    }
  });

  box.querySelectorAll('[data-hact]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const act = btn.dataset.hact;
      const item = btn.closest('.hist-item');
      const id = item.dataset.id;
      if (act === 'remove') {
        await window.api.history.remove(id);
        await loadHistory();
        toast('Đã xóa khỏi lịch sử.', 'ok');
      } else if (act === 'open') {
        const f = btn.dataset.file;
        if (f) {
          const ok = await window.api.app.openPath(f);
          if (!ok) toast('Không tìm thấy file — có thể bạn đã xoá.', 'error');
        }
      } else if (act === 'rerun') {
        const ta = $('#urlInput');
        ta.value = btn.dataset.url;
        $$('.tab').forEach((t) =>
          t.classList.toggle('active', t.dataset.tab === 'transcribe')
        );
        $$('.panel').forEach((p) =>
          p.classList.toggle('active', p.dataset.panel === 'transcribe')
        );
        startJobs();
      } else if (act === 'view') {
        toggleHistoryView(item, id, btn);
      } else if (act === 'copy') {
        await copyHistoryText(id);
      } else if (act === 'savetxt') {
        await saveHistoryTxt(id);
      }
    });
  });
}

/** Mở/đóng transcript của một mục lịch sử — đọc từ file .json trên đĩa. */
async function toggleHistoryView(item, id, btn) {
  const inner = item.querySelector('[data-hseg]');
  if (!inner) return;
  if (inner.childElementCount && !inner.hidden) {
    inner.hidden = true;
    if (btn) btn.textContent = 'Xem';
    return;
  }
  if (inner.childElementCount) {
    inner.hidden = false;
    if (btn) btn.textContent = 'Thu gọn';
    return;
  }
  if (btn) btn.disabled = true;
  try {
    const segments = await window.api.history.segments(id);
    if (!segments || !segments.length) {
      toast('Không còn dữ liệu transcript của mục này.', 'error');
      return;
    }
    const h = state.history.find((x) => x.id === id);
    inner.innerHTML =
      segments
        .map((s) => {
          const t = fmtDuration(s.start);
          const cn = containsCjk(s.text) ? ' cn' : '';
          return `<div class="seg${cn}"><span class="seg-time">${t}</span><span class="seg-text">${escapeHtml(
            String(s.text || '').trim()
          )}</span></div>`;
        })
        .join('') +
      `<div class="hist-seg-actions">
        <button class="btn tiny" data-hact="copy">Sao chép văn bản</button>
        <button class="btn tiny" data-hact="savetxt">Lưu thành .txt</button>
      </div>`;
    inner.hidden = false;
    if (btn) btn.textContent = 'Thu gọn';
    // Gắn sự kiện cho hai nút vừa sinh ra
    inner.querySelectorAll('[data-hact]').forEach((b) => {
      b.addEventListener('click', () => {
        if (b.dataset.hact === 'copy') copyHistoryText(id, segments);
        else if (b.dataset.hact === 'savetxt') saveHistoryTxt(id, segments);
      });
    });
    if (h) h._segments = segments;
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

/** Sao chép toàn bộ văn bản của một mục lịch sử (không kèm số phút). */
async function copyHistoryText(id, segments) {
  const h = state.history.find((x) => x.id === id);
  let segs = segments || h?._segments;
  if (!segs) {
    try {
      segs = await window.api.history.segments(id);
    } catch (err) {
      toast(err.message, 'error');
      return;
    }
  }
  if (!segs || !segs.length) {
    toast('Không còn dữ liệu transcript của mục này.', 'error');
    return;
  }
  const text = plainTextOf(segs);
  try {
    await navigator.clipboard.writeText(text);
    toast(`Đã sao chép ${text.length.toLocaleString('vi-VN')} ký tự.`, 'ok');
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    toast(ok ? 'Đã sao chép văn bản.' : 'Không sao chép được.', ok ? 'ok' : 'error');
  }
}

/** Lưu một mục lịch sử thành .txt, tên file do người dùng tự đặt. */
async function saveHistoryTxt(id, segments) {
  const h = state.history.find((x) => x.id === id);
  let segs = segments || h?._segments;
  if (!segs) {
    try {
      segs = await window.api.history.segments(id);
    } catch (err) {
      toast(err.message, 'error');
      return;
    }
  }
  if (!segs || !segs.length) {
    toast('Không còn dữ liệu transcript của mục này.', 'error');
    return;
  }
  const stem = h?.title || `transcript-${String(id).slice(0, 8)}`;
  const saved = await window.api.transcript.saveTxt({
    segments: segs,
    title: h?.title,
    url: h?.url,
    language: h?.language,
    model: h?.model,
    defaultName: `${stem}.txt`,
  });
  if (saved) toast(`Đã lưu: ${saved.split(/[\\/]/).pop()}`, 'ok');
}


// ---------------------------------------------------------------------------
// Nhà cung cấp dịch thuật
// ---------------------------------------------------------------------------

async function loadProviders() {
  const box = $('#providerList');
  if (!box) return;
  let list = [];
  try {
    list = await window.api.providers.list();
  } catch (err) {
    box.innerHTML = `<p class="hint warn">Không đọc được danh sách: ${escapeHtml(err.message)}</p>`;
    return;
  }
  box.innerHTML = list
    .map((p) => {
      const keyCount = p.keys.length;
      const canTest = p.noKey || keyCount > 0;
      return `<div class="prov" data-id="${escapeAttr(p.id)}">
        <div class="prov-head">
          <div>
            <b>${escapeHtml(p.label)}</b>
            <span class="prov-id">${escapeHtml(p.id)}</span>
          </div>
          <div class="row">
            <button class="btn tiny" data-pact="test" ${canTest ? '' : 'disabled'}>Thử</button>
            ${p.custom ? `<button class="btn tiny ghost" data-pact="remove">Xóa</button>` : ''}
          </div>
        </div>
        ${p.note ? `<div class="prov-note">${escapeHtml(p.note)}</div>` : ''}
        <div class="field">
          <label class="field-label">Base URL</label>
          <input type="text" data-pfield="baseUrl" value="${escapeAttr(p.baseUrl || '')}" />
        </div>
        ${
          p.kind === 'google-translate' || p.kind === 'mymemory'
            ? ''
            : `<div class="field"><label class="field-label">Model</label>
                 <input type="text" data-pfield="model" value="${escapeAttr(p.model || '')}" /></div>`
        }
        ${
          p.noKey
            ? '<div class="prov-note">Không cần API key.</div>'
            : `<div class="field">
                 <label class="field-label">API key — mỗi dòng một key (${keyCount} key)</label>
                 <textarea rows="3" data-pfield="keys" spellcheck="false" placeholder="sk-...">${escapeHtml(
                   p.keys.join('\n')
                 )}</textarea>
                 <p class="hint">Hết hạn mức key này → app tự xoay sang key kế tiếp.</p>
               </div>`
        }
        <button class="btn tiny" data-pact="save">Lưu</button>
      </div>`;
    })
    .join('');

  box.querySelectorAll('[data-pact]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const prov = btn.closest('.prov');
      const id = prov.dataset.id;
      const act = btn.dataset.pact;
      if (act === 'remove') {
        await window.api.providers.save({ id, remove: true });
        toast('Đã xóa.', 'ok');
        await loadProviders();
      } else if (act === 'save') {
        await window.api.providers.save({
          id,
          baseUrl: prov.querySelector('[data-pfield="baseUrl"]')?.value,
          model: prov.querySelector('[data-pfield="model"]')?.value,
          keys: prov.querySelector('[data-pfield="keys"]')?.value,
        });
        toast('Đã lưu.', 'ok');
        await loadProviders();
      } else if (act === 'test') {
        btn.disabled = true;
        btn.textContent = 'Đang thử…';
        try {
          const r = await window.api.providers.test(id);
          toast(`${r.providerLabel} (${r.model || '—'}): ${r.sample.slice(0, 70)}`, 'ok');
        } catch (err) {
          toast(String(err.message).split('\n')[0], 'error');
        } finally {
          btn.disabled = false;
          btn.textContent = 'Thử';
        }
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Lồng tiếng
// ---------------------------------------------------------------------------

const dubState = {
  segments: [],
  title: '',
  nameTouched: false,
  source: 'history',
  sourceSegments: [],   // khung thời gian gốc (dùng để căn bản dịch có sẵn)
  script: [],           // bản dịch đã duyệt, sẵn sàng tạo voice
  lastResult: null,     // file vừa ghép, để nghe thử
  textSource: 'original',// gốc | machine | own
  scriptEdited: false,
};


function markTtsLoggedIn() {
  const st = $('#ttsStatus');
  if (st) st.textContent = 'Đã đăng nhập.';
  const lo = $('#btnTtsLogout');
  if (lo) lo.hidden = false;
  const pw = $('#ttsPassword');
  if (pw) pw.disabled = true;
}

/**
 * Chuẩn bị xong nguồn -> mở khoá Bước 4 (dịch & xem lại).
 * Chưa mở khoá Bước 5 cho tới khi người dùng duyệt xong bản dịch.
 */

/**
 * Dịch TOÀN BỘ bằng API rồi đổ vào ô xem lại.
 * Đây là đường đi mặc định: chọn xong nguồn là app dịch luôn, không bắt
 * người dùng bấm thêm một nút.
 */
async function translateAllIntoBox() {
  if (!dubState.segments.length) {
    toast('Chưa có lời thoại để dịch.', 'error');
    return;
  }
  const btn = $('#btnDubTranslate');
  const info = $('#dubTransProgress');
  if (btn) btn.disabled = true;
  if (info) info.textContent = 'Đang dịch bằng máy…';
  try {
    const sel = $('#dubModelSel');
    const ids = sel && sel.value ? [sel.value] : [];
    const r = await window.api.dubbing.translateAll(dubState.segments, ids);
    setScriptBox(r.segments.join('\n'));
    const used = (r.providers || []).join(', ') || 'không rõ';
    if (info) {
      info.textContent = `Đã dịch ${r.segments.filter(Boolean).length}/${r.segments.length} đoạn bằng: ${used}.`;
    }
    if (r.fallback) {
      toast('Mô hình chính bị lỗi, app đã dùng phương án dự phòng — chất lượng có thể kém hơn.', 'error');
    }
    await autoResegment();
    dubLog(`Đã dịch bằng: ${used}.`);
  } catch (err) {
    if (info) info.textContent = 'Không dịch được: ' + err.message;
    toast(String(err.message).split('\n')[0], 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

/** Điền lời thoại sẽ đọc vào ô xem lại. */
function setScriptBox(text) {
  const ta = $('#dubScriptBox');
  if (ta) ta.value = text || '';
  dubState.scriptEdited = false;
  updateApplyBtn();
}

/** Cập nhật nút "Áp dụng & căn timing" theo tình trạng hiện tại. */
function updateApplyBtn() {
  const btn = $('#btnApplyScript');
  if (!btn) return;
  const hasBase = dubState.sourceSegments.length > 0;
  const hasText = !!($('#dubScriptBox')?.value || '').trim();
  // Nguồn "gốc" không cần căn lại — dùng thẳng khung gốc.
  btn.disabled = !hasBase || !hasText;
  const rs = $('#btnResegment');
  if (rs) rs.disabled = !hasBase || !hasText;
}

/** Cột lời thoại gốc, để đối chiếu cạnh bản dịch. */
function renderOriginalColumn() {
  const box = $('#dubOriginalBox');
  if (!box) return;
  const segs = dubState.sourceSegments.length ? dubState.sourceSegments : dubState.segments;
  if (!segs.length) {
    box.innerHTML = '<span class="hint">Chưa có lời thoại gốc.</span>';
    return;
  }
  box.innerHTML = segs
    .map(
      (s) => `<div class="orig-row">
        <span class="orig-time">${fmtDuration(s.start)}</span>
        <span>${escapeHtml(String(s.text || '').trim())}</span>
      </div>`
    )
    .join('');
}

function setDubSourceReady(title, count) {
  dubState.title = title || '';
  if (!dubState.nameTouched) {
    const box = $('#dubOutName');
    if (box) box.value = 'LỒNG TIẾNG - ' + (title || 'video');
  }
  const info = $('#dubSegmentsInfo');
  if (info) {
    info.textContent =
      `Đã có ${count} đoạn (${Math.round(
        dubState.segments.reduce((a, s) => a + (s.end - s.start), 0)
      )} giây). ` +
      'Xem lại bản dịch ở Bước 4 rồi mới tạo giọng đọc.';
  }
  if (!count) {
    const info2 = $('#dubSegmentsInfo');
    if (info2) info2.textContent = 'Chưa có lời thoại nào — hãy nhận diện hoặc chọn video khác.';
    return;
  }
  // Bước 4 mở khoá, Bước 5 thì chưa.
  const tr = $('#btnDubTranslate');
  if (tr) tr.disabled = false;
  const rb = $('#btnDubRun');
  if (rb) rb.disabled = true;  // chỉ mở sau khi bấm Áp dụng
  const card = $('#cardTranslate');
  if (card) card.hidden = false;
  dubState.script = []; // chưa chuốt thì chưa được tạo voice
  renderOriginalColumn();

  // Tự dịch ngay bằng API rồi hiện ra để người dùng sửa.
  // Đây là luồng mặc định: không bắt ai phải bấm thêm một nút.
  setScriptBox('');
  void translateAllIntoBox();
  dubLog(`Sẵn sàng: ${count} đoạn. Xem lại bản dịch ở Bước 4.`);
}

/** Người dùng đã duyệt bản dịch -> mở khoá Bước 5. */
function enableDubRun(msg) {
  const rb = $('#btnDubRun');
  if (rb) rb.disabled = false;
  const card = $('#cardPreview');
  if (card) card.hidden = false;
  const info = $('#dubSegmentsInfo');
  if (info && msg) info.textContent = msg;
  const si = $('#dubScriptInfo');
  if (si) si.textContent = msg || '';
}

/** Tách bản dịch người dùng nhập thành các đoạn, tôn trọng dấu '--'. */
function parseScriptBox(text) {
  const t = String(text || '').trim();
  if (!t) return [];
  // Dấu '--' là ranh giới thời gian do người dùng tự đánh dấu -> giữ nguyên vị trí.
  if (t.includes('--')) {
    return t
      .split('--')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return t
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Hiển thị kết quả: nghe thử + nút mở thư mục. */
async function showDubResult(r) {
  dubState.lastResult = r;
  const box = $('#dubPreviewBox');
  const card = $('#cardPreview');
  if (!box || !card) return;
  card.hidden = false;
  // Đăng ký file qua protocol ltmedia:// — không dùng file:// (bị CSP/CORS chặn).
  const urls = await window.api.dubbing.registerMedia({ mp3: r.mp3, wav: r.wav, srt: r.srt });
  // Chỉ player + một nút mở thư mục. Trước đây có 4 nút Mở .wav/.mp3/.srt
  // lặp với những nút ở thẻ phía trên, nhìn rối và thừa.
  const dir = r.dir || r.wav.replace(/[/\\][^/\\]*$/, '');
  box.innerHTML = `
    <div class="preview-row">
      <audio controls preload="metadata" src="${escapeAttr(urls.mp3 || urls.wav || '')}"></audio>
      <button class="btn tiny primary" data-dreveal="${escapeAttr(r.wav)}">Mở thư mục kết quả</button>
    </div>`;
  box.querySelector('[data-dreveal]')?.addEventListener('click', (e) => {
    window.api.dubbing.reveal(e.currentTarget.dataset.dreveal);
  });
  const info = $('#dubPreviewInfo');
  if (info) {
    info.textContent =
      `Thư mục: ${outDirPath}  ·  ${r.summary.sped}/${r.summary.total} đoạn được tua nhẹ ` +
      `(tối đa ${r.summary.maxSpeed}x), trôi nhiều nhất ${r.summary.maxDrift}s.`;
  }
}

function updateAlignBtn() {
  const hasText = !!(dubState.transText || '').trim();
  const hasBase = Array.isArray(dubState.sourceSegments) && dubState.sourceSegments.length > 0;
  const btn = $('#btnAlignTrans');
  if (btn) btn.disabled = !(hasText && hasBase);
}

/** Danh sách bản gốc dùng làm khung thời gian cho bản dịch có sẵn. */
async function refreshBaseSelect() {
  const sel = $('#dubTransBaseSel');
  if (!sel) return;
  await loadHistory();
  const done = state.history.filter((h) => h.segmentCount > 0);
  sel.innerHTML =
    '<option value="">— chọn video gốc —</option>' +
    done.map((h) => `<option value="${escapeAttr(h.id)}">${escapeHtml(h.title || 'Video')}</option>`).join('');
  if (done.length && !sel.value) sel.value = done[0].id;
  if (sel.value) sel.dispatchEvent(new Event('change'));
}

function dubLog(msg) {
  const box = $('#dubLog');
  if (!box) return;
  const div = document.createElement('div');
  div.className = 'log-line';
  div.textContent = msg;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

/** Nạp danh sách mô hình dịch vào ô chọn ở Bước 4. */
async function loadModelSelect() {
  const sel = $('#dubModelSel');
  if (!sel) return;
  let list = [];
  try {
    list = await window.api.providers.list();
  } catch {
    return;
  }
  // Chỉ hiện provider dùng được: có key, hoặc không cần key.
  const usable = list.filter((p) => p.noKey || (p.keys || []).length);
  if (!usable.length) {
    sel.innerHTML = '<option value="">Chưa cấu hình nhà cung cấp dịch</option>';
    sel.disabled = true;
    return;
  }
  sel.disabled = false;
  sel.innerHTML = usable
    .map((p) => {
      const name = p.model ? `${p.label} · ${p.model}` : p.label;
      return `<option value="${escapeAttr(p.id)}">${escapeHtml(name)}</option>`;
    })
    .join('');
  // Ưu tiên mô hình chất lượng cao nếu có: ollama-cloud, rồi openai, rồi gemini.
  const pref = ['ollama-cloud', 'openai', 'gemini', 'ollama-local'];
  for (const id of pref) {
    if (usable.some((p) => p.id === id)) {
      sel.value = id;
      break;
    }
  }
  dubState.providerId = sel.value;
  sel.addEventListener('change', () => {
    dubState.providerId = sel.value;
  });
}

async function initDubbing() {
  // Quyết định macOS CHỈ dựa vào navigator — không gọi app.info().
  // `app:info` phải xác minh chữ ký các binary (yt-dlp, sidecar) nên lần chạy
  // đầu mất 10-30 giây. Nếu chờ nó thì tự đăng nhập bị hoãn tới khi đó và
  // người dùng tưởng phải nhập mật khẩu.
  const mac = /Mac|iPhone|iPad/i.test(navigator.userAgent) || navigator.platform === 'MacIntel';
  if ($('#dubMac')) $('#dubMac').hidden = !mac;
  if ($('#dubUnsupported')) $('#dubUnsupported').hidden = mac;
  if (!mac) return;
  await loadModelSelect();

  // Tự đăng nhập nếu trước đó đã chọn "Ghi nhớ mật khẩu".
  let on = false;
  try {
    const r = await window.api.tts.autoLogin();
    if (r && r.ok) {
      on = true;
      markTtsLoggedIn();
      dubLog('Đã tự đăng nhập 3A bằng mật khẩu đã lưu.');
    } else if (r && r.reason && r.reason !== 'chưa lưu mật khẩu') {
      // Mật khẩu đã lưu nhưng không còn đúng -> báo để người dùng nhập lại
      const st = $('#ttsStatus');
      if (st) st.textContent = 'Mật khẩu đã lưu không còn đúng. Nhập lại nhé.';
    }
  } catch {
    /* bỏ qua */
  }
  if (!on) {
    try {
      const s = await window.api.tts.session();
      on = !!(s && (s.authenticated || s.ok));
      if (on) markTtsLoggedIn();
    } catch {
      /* bỏ qua */
    }
  }
  if ($('#ttsStatus') && !on) $('#ttsStatus').textContent = 'Chưa đăng nhập.';
  if ($('#btnTtsLogout')) $('#btnTtsLogout').hidden = !on;
  if ($('#ttsPassword')) $('#ttsPassword').disabled = on;
  await renderDubHistory();
}

async function renderDubHistory() {
  const box = $('#dubHistoryList');
  if (!box) return;
  await loadHistory();
  const done = state.history.filter((h) => h.segmentCount > 0);
  if (!done.length) {
    box.innerHTML = '<p class="hint">Chưa có video nào đã xong trong lịch sử.</p>';
    return;
  }
  box.innerHTML = done
    .map(
      (h) => `<div class="dub-pick" data-id="${escapeAttr(h.id)}" data-title="${escapeAttr(h.title || 'Video')}">
        <div>
          <b>${escapeHtml(h.title || 'Video')}</b>
          <small>${escapeHtml(h.createdAt ? new Date(h.createdAt).toLocaleString('vi-VN') : '')} · ${h.segmentCount} đoạn</small>
        </div>
        <button class="btn tiny" data-dpick="1">Chọn</button>
      </div>`
    )
    .join('');
  box.querySelectorAll('[data-dpick]').forEach((b) => {
    b.addEventListener('click', async () => {
      const row = b.closest('.dub-pick');
      const id = row.dataset.id;
      // Đọc tên từ data-title. Trước đây dùng biến `h` — nhưng `h` chỉ tồn
      // tại trong `.map()` dựng HTML, handler bấm nút không nhìn thấy nó ->
      // báo "h is not defined" và nút Chọn không bao giờ hoạt động.
      const title = row.dataset.title || '';
      const info = $('#dubSegmentsInfo');
      if (info) info.textContent = 'Đang tải transcript…';
      try {
        dubState.segments = await window.api.history.segments(id);
        dubState.title = title;
        // Tự điền tên file theo dạng "LỒNG TIẾNG - <tên video>", nhưng không
        // ghi đè nếu bạn đã sửa tay.
        const nameBox = $('#dubOutName');
        if (nameBox && !dubState.nameTouched) {
          nameBox.value = 'LỒNG TIẾNG - ' + (dubState.title || 'video');
        }
        // Lịch sử cũng là nguồn "khung thời gian gốc" cho bản dịch có sẵn.
        dubState.sourceSegments = dubState.segments;
        // Dùng chung một hàm để mọi nguồn đều mở Bước 4 giống nhau.
        setDubSourceReady(title, dubState.segments.length);
        box.querySelectorAll('.dub-pick').forEach((x) => x.classList.remove('sel'));
        b.closest('.dub-pick').classList.add('sel');
      } catch (err) {
        if (info) info.textContent = 'Không tải được: ' + err.message;
      }
    });
  });
}

function wireDubbing() {
  const mac = /Mac|iPhone|iPad/i.test(navigator.userAgent) || navigator.platform === 'MacIntel';
  if ($('#dubUnsupported')) $('#dubUnsupported').hidden = mac;
  if ($('#dubMac')) $('#dubMac').hidden = !mac;
  if (!mac) return;

  $('#btnTtsLogin')?.addEventListener('click', async () => {
    const pw = $('#ttsPassword').value.trim();
    if (!pw) {
      toast('Nhập mật khẩu 3A trước.', 'error');
      return;
    }
    const btn = $('#btnTtsLogin');
    btn.disabled = true;
    try {
      await window.api.tts.login(pw, $('#ttsRemember')?.checked !== false);
      markTtsLoggedIn();
      toast('Đăng nhập thành công.', 'ok');
    } catch (err) {
      $('#ttsStatus').textContent = 'Lỗi: ' + err.message;
      toast(err.message, 'error');
    } finally {
      btn.disabled = false;
    }
  });

  // Chuyển qua lại 3 nguồn ở Bước 3 (dạng thẻ chọn, dễ đọc hơn 3 tab)
  $$('input[name=dubSrc]').forEach((r) => {
    r.addEventListener('change', () => {
      $$('.src-opt').forEach((o) => o.classList.toggle('active', o.contains(r) && r.checked));
      $$('.src-body').forEach((b) => (b.hidden = b.dataset.srcbody !== r.value));
      dubState.source = r.value;
      // Đổi nguồn = xoá sạch mọi thứ đã chuẩn bị cho nguồn cũ. Nếu không,
      // chọn "file mới" khi chưa nhận diện xong vẫn dùng được dữ liệu cũ của
      // video lịch sử và nút Tạo giọng đọc bật lên một cách sai.
      dubState.segments = [];
      dubState.sourceSegments = [];
      dubState.script = [];
      dubState.title = '';
      setScriptBox('');
      const tp = $('#dubTransProgress');
      if (tp) tp.textContent = '';
      renderOriginalColumn();
      $('#cardTranslate').hidden = true;
      $('#btnDubRun').disabled = true;
      if (r.value === 'source') $('#btnAnalyzeSource').disabled = true;
    });
  });

  // Nguồn 2: chọn file gốc rồi nhận diện
  $('#btnPickSource')?.addEventListener('click', async () => {
    const f = await window.api.dubbing.pickSource();
    if (!f) return;
    dubState.sourcePath = f;
    $('#dubSourcePath').value = f.split('/').pop();
    $('#btnAnalyzeSource').disabled = false;
    $('#dubSourceInfo').textContent = 'Sẵn sàng. Bấm “Nhận dịch”.';
  });
  $('#btnAnalyzeSource')?.addEventListener('click', async () => {
    if (!dubState.sourcePath) return;
    const btn = $('#btnAnalyzeSource');
    btn.disabled = true;
    btn.textContent = 'Đang nhận diệch…';
    try {
      const r = await window.api.dubbing.analyzeSource(dubState.sourcePath, { model: 'small' });
      dubState.segments = r.segments || [];
      dubState.sourceSegments = r.segments || [];
      setDubSourceReady(r.name, r.segments.length);
    } catch (err) {
      $('#dubSourceInfo').textContent = 'Lỗi: ' + err.message;
      toast(err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Nhận dịch';
    }
  });

  // Nguồn 3: bản dịch có sẵn
  // Bấm "Dịch lại bằng máy" -> dịch toàn bộ bằng API rồi đổ vào ô xem lại.
  $('#btnDubTranslate')?.addEventListener('click', () => translateAllIntoBox());

  // Bấm "Dùng luôn lời gốc" -> chép thẳng lời gốc vào ô xem lại.
  $('#btnUseOriginal')?.addEventListener('click', () => {
    const txt = dubState.segments.map((x) => String(x.text || '').trim()).filter(Boolean).join('\n');
    setScriptBox(txt);
    const info = $('#dubScriptInfo');
    if (info) info.textContent = 'Đang dùng lời gốc, chưa dịch.';
    dubLog('Dùng lời gốc, bỏ qua bước dịch.');
  });

  $('#btnPickTrans')?.addEventListener('click', async () => {
    const r = await window.api.dubbing.pickTranslation();
    if (!r) return;
    $('#dubTransPath').value = r.file.split('/').pop();
    setScriptBox(r.text);
    if (r.hadTimestamps) {
      toast('File có sẵn số phút — app đã bỏ số phút đi và sẽ tự căn lại.', 'ok');
    }
    await autoResegment();
    toast('Đã nạp và tự tách câu theo bản gốc. Kiểm tra rồi bấm “Áp dụng & căn timing”.');
  });

  $('#dubScriptBox')?.addEventListener('input', () => {
    dubState.scriptEdited = true;
    updateApplyBtn();
  });

  // Tự tách câu theo nhịp câu của bản gốc.
  $('#btnResegment')?.addEventListener('click', async () => {
    const ta = $('#dubScriptBox');
    const info = $('#dubScriptInfo');
    if (!ta || !dubState.sourceSegments.length) return;
    const btn = $('#btnResegment');
    btn.disabled = true;
    btn.textContent = 'Đang tách…';
    try {
      const r = await window.api.dubbing.resegment(ta.value, dubState.sourceSegments);
      ta.value = r.text;
      if (info) {
        info.textContent = r.changed
          ? `Đã tách lại: ${r.before} → ${r.after} câu, theo nhịp của bản gốc.`
          : 'Bản dịch đã đúng nhịp câu, không cần tách thêm.';
      }
      dubLog(`Tự tách câu: ${r.before} → ${r.after} câu.`);
      updateApplyBtn();
    } catch (err) {
      toast(String(err.message).split('\n')[0], 'error');
    } finally {
      btn.textContent = 'Tự tách câu';
      btn.disabled = false;
    }
  });

  $('#btnTtsLogout')?.addEventListener('click', async () => {
    await window.api.tts.logout();
    $('#ttsStatus').textContent = 'Chưa đăng nhập.';
    $('#btnTtsLogout').hidden = true;
    $('#ttsPassword').disabled = false;
    $('#ttsPassword').value = '';
  });

  window.api.dubbing.onProgress(({ message }) => dubLog(message));

  $('#dubScriptBox')?.addEventListener('input', () => {
    if ($('#dubScriptBox').value.trim()) $('#btnApplyScript').disabled = false;
  });

  $('#btnApplyScript')?.addEventListener('click', async () => {
    const lines = parseScriptBox($('#dubScriptBox').value);
    if (!lines.length) {
      toast('Bản dịch trống.', 'error');
      return;
    }
    const btn = $('#btnApplyScript');
    btn.disabled = true;
    btn.textContent = 'Đang căn…';
    try {
      const segs = await window.api.dubbing.align(lines.join('\n'), dubState.sourceSegments);
      if (!segs.length) throw new Error('Không căn được bản dịch vào khung thời gian.');
      if (!segs.length) throw new Error('Bản dịch không có câu nào hợp lệ.');
      dubState.script = segs;
      enableDubRun(
        `Đã căn ${segs.length} câu vào khung thời gian. Bấm “Tạo giọng đọc” ở Bước 5.`
      );
      dubLog(`Căn xong ${segs.length} câu.`);
    } catch (err) {
      toast(String(err.message).split('\n')[0], 'error');
    } finally {
      btn.textContent = 'Áp dụng & căn timing';
    }
  });

  $('#dubOutName')?.addEventListener('input', () => {
    dubState.nameTouched = true;   // đã sửa tay -> không tự điền lại
  });

  $('#btnDubRun')?.addEventListener('click', async () => {
    // Chỉ dùng `script` — tức là bản ĐÃ qua bước duyệt ở Bước 4. Dùng
    // segments (dữ liệu thô) sẽ vô tình tạo voice cho bản chưa được sửa/xem.
    const payload = dubState.script;
    if (!payload.length) {
      toast('Chưa duyệt lời thoại ở Bước 4. Bấm “Áp dụng & căn timing” trước.', 'error');
      return;
    }
    const btn = $('#btnDubRun');
    btn.disabled = true;
    btn.textContent = 'Đang tạo…';
    $('#dubResult').hidden = true;
    try {
      // Dùng bản dịch ĐÃ DUYỆT ở Bước 4. Không tự dịch lần nữa ở đây — nếu không
      // thì mọi chỉnh sửa của người dùng ở Bước 4 sẽ bị bỏ qua.
      const r = await window.api.dubbing.run({
        segments: payload,
        voice: $('#dubVoice').value,
        translate: false,
        outName: $('#dubOutName').value,
        voiceDirName: dubState.title || 'video',
      });
      // Thẻ "Xong" và thẻ "Nghe thử" trước đây lặp lại cùng bộ nút Mở file —
      // gây rối. Nay chỉ giòn lại thẻ Nghe thử, thẻ này chỉ báo đã xong.
      const box = $('#dubResult');
      box.hidden = false;
      box.innerHTML = `<p class="hint" style="margin:0">✅ Đã xong — nghe thử bên dưới.</p>`;
      showDubResult(r);
      toast('Đã tạo xong file giọng đọc.', 'ok');
    } catch (err) {
      toast(String(err.message).split('\n')[0], 'error');
      dubLog('LỖI: ' + err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Tạo giọng đọc';
    }
  });

  $('#btnProviderAdd')?.addEventListener('click', async () => {
    const label = $('#providerAddLabel').value.trim();
    const kind = $('#providerAddKind').value;
    const baseUrl = $('#providerAddUrl').value.trim();
    const model = $('#providerAddModel').value.trim();
    const keys = $('#providerAddKeys').value;
    if (!label || !baseUrl) {
      toast('Cần ít nhất tên và đường dẫn gốc.', 'error');
      return;
    }
    const id = 'custom-' + Date.now().toString(36);
    await window.api.providers.save({ id, label, kind, baseUrl, model, keys, custom: true });
    $('#providerAddLabel').value = '';
    $('#providerAddUrl').value = '';
    $('#providerAddModel').value = '';
    $('#providerAddKeys').value = '';
    await loadProviders();
    toast('Đã thêm.', 'ok');
  });

  void loadProviders();
}

// ---------------------------------------------------------------------------
// Thông tin hệ thống
// ---------------------------------------------------------------------------

async function refreshSystemInfo() {
  const rows = [];
  try {
    const info = await window.api.app.info();
    rows.push(
      ['Phiên bản app', info.appVersion],
      ['Hệ điều hành', `${info.platform} ${info.arch}`],
      ['Electron', info.electron],
      ['Chrome', info.chrome],
      ['Node', info.node],
      ['yt-dlp', info.ytdlpVersion || 'chưa sẵn sàng'],
      ['Thư mục dữ liệu', info.userData],
      ['Thư mục model', info.modelsDir],
      ['Thư mục nhật ký', info.logsDir]
    );
  } catch (err) {
    rows.push(['Lỗi', err.message]);
  }
  try {
    const env = await window.api.app.sidecarEnv();
    rows.push(['Python', env.python]);
    ['faster-whisper', 'ctranslate2'].forEach((k) => {
      const name = k === 'ctranslate2' ? 'CTranslate2' : 'faster-whisper';
      rows.push([name, env[k] || '—']);
    });
    if (env.computeTypes?.length) {
      rows.push(['Kiểu tính toán', env.computeTypes.join(', ')]);
    }
  } catch (err) {
    rows.push(['Sidecar', `không khởi động được — ${err.message}`]);
  }

  const html = rows
    .map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(String(v))}</dd>`)
    .join('');
  const box1 = $('#sysInfo');
  const box2 = $('#sysInfo2');
  if (box1) box1.innerHTML = html;
  if (box2) box2.innerHTML = html;
}

// ---------------------------------------------------------------------------
// Escape — dữ liệu từ YouTube không tin được, phải escape trước khi chèn HTML
// ---------------------------------------------------------------------------

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeAttr(s) {
  return escapeHtml(s).replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------

init().catch((err) => {
  // Dùng class thay vì style="..." — CSP chặn style attribute nội tuyến.
  document.body.innerHTML =
    '<div class="card fatal"><h3>Không khởi động được</h3><p>' +
    escapeHtml(err.message) +
    '</p></div>';
});
