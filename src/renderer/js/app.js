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

async function init() {
  // Nền tảng: dùng để chừa chỗ cho ba nút cửa sổ trên macOS (xem app.css)
  try {
    const info = await window.api.app.info();
    document.body.dataset.platform = info.platform;
  } catch {
    document.body.dataset.platform = 'unknown';
  }

  // Logo: nạp icon thật. Nếu hỏng (chạy dev chưa có file) thì chèn chữ "LT"
  // dự phòng — không dùng thuộc tính onerror nội tuyến vì CSP chặn.
  const mark = $('#brandMark');
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

  // Tab
  $$('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      $$('.tab').forEach((t) => t.classList.toggle('active', t === tab));
      $$('.panel').forEach((p) =>
        p.classList.toggle('active', p.dataset.panel === tab.dataset.tab)
      );
    });
  });

  // NỐI SỰ KIỆN TRƯỚC, nạp dữ liệu sau.
  //
  // Trước đây các nút ở tab Cài đặt được nối SAU `await renderSysInfo()`, mà hàm
  // đó phải khởi động sidecar Python (10-30 giây lần chạy đầu). Trong khoảng thời
  // gian đó toàn bộ nút bấm không phản ứng, trông như app bị treo.
  wireSettingsInputs();
  wireAllEvents();

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
      toast(err.message, 'error');
    } finally {
      btn.disabled = false;
    }
  });
  $('#btnInstallUpdate')?.addEventListener('click', () => window.api.app.quitAndInstall());
  window.api.app
    .repoUrl()
    .then((repo) => {
      const a = $('#btnReleases');
      if (a) a.href = `https://github.com/${repo}/releases`;
    })
    .catch(() => {});

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
             <button class="btn tiny" data-act="savetxt">Lưu thành .txt</button>`
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
