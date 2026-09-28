'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * Cau noi duy nhat giua giao dien va tien trinh chinh.
 * Renderer khong co quyen truy cap Node, chi goi duoc cac ham duoi day.
 *
 * Moi ham tra { ok, data } hoac { ok:false, error } de renderer
 * kiem tra duoc nhieu quyet dinh mot cach deu dac.
 */

async function call(channel, ...args) {
  const res = await ipcRenderer.invoke(channel, ...args);
  if (!res || res.ok !== true) {
    throw new Error(res?.error || 'Không kết nối được với ứng dụng.');
  }
  return res.data;
}

contextBridge.exposeInMainWorld('api', {
  settings: {
    get: () => call('settings:get'),
    set: (patch) => call('settings:set', patch),
    outputDir: () => call('settings:outputDir'),
    pickOutputDir: () => call('settings:pickOutputDir'),
    pickFile: () => call('settings:pickFile'),
  },
  app: {
    info: () => call('app:info'),
    sidecarEnv: () => call('app:sidecarEnv'),
    openPath: (p) => call('app:openPath', p),
    showItemInFolder: (p) => call('app:showItemInFolder', p),
    openExternal: (url) => call('shell:open', url),
    checkForUpdates: () => call('app:checkForUpdates'),
    quitAndInstall: () => call('app:quitAndInstall'),
    repoUrl: () => call('app:repoUrl'),
    onUpdate: (cb) => subscribe('app:update', cb),
  },
  ytdlp: {
    check: (channel) => call('ytdlp:check', channel),
    update: (opts) => call('ytdlp:update', opts),
    rollback: () => call('ytdlp:rollback'),
    test: () => call('ytdlp:test'),
    onProgress: (cb) => subscribe('ytdlp:progress', cb),
  },
  model: {
    download: (model) => call('model:download', model),
  },
  jobs: {
    add: (url, overrides) => call('job:add', url, overrides),
    list: () => call('job:list'),
    get: (id) => call('job:get', id),
    cancel: (id) => call('job:cancel', id),
    cancelAll: () => call('job:cancelAll'),
    segments: (id) => call('job:segments', id),
    export: (id, formats) => call('job:export', id, formats),
  },
  transcript: {
    save: (payload) => call('transcript:save', payload),
    saveTxt: (payload) => call('transcript:saveTxt', payload),
  },
  providers: {
    list: () => call('providers:list'),
    save: (patch) => call('providers:save', patch),
    translate: (text, opts) => call('providers:translate', text, opts),
    test: (id) => call('providers:test', id),
  },
  tts: {
    login: (password, remember) => call('tts:login', password, remember),
    session: () => call('tts:session'),
    logout: () => call('tts:logout'),
    autoLogin: () => call('tts:autoLogin'),
    hasSavedPassword: () => call('tts:savedPassword'),
  },
  dubbing: {
    run: (payload) => call('dubbing:run', payload),
    pickTranslation: () => call('dubbing:pickTranslation'),
    pickSource: () => call('dubbing:pickSource'),
    analyzeSource: (file, opts) => call('dubbing:analyzeSource', file, opts),
    align: (text, segs) => call('dubbing:align', text, segs),
    resegment: (text, segs) => call('dubbing:resegment', text, segs),
    translateAll: (segments, providerIds) => call('dubbing:translateAll', segments, providerIds),
    reveal: (file) => call('dubbing:reveal', file),
    registerMedia: (files) => call('media:register', files),
    readFile: (file) => call('dubbing:readFile', file),
    onProgress: (cb) => subscribe('dubbing:progress', cb),
  },
  history: {
    list: () => call('history:list'),
    remove: (id) => call('history:remove', id),
    clear: () => call('history:clear'),
    prune: () => call('history:prune'),
    onChanged: (cb) => subscribe('history:changed', cb),
    segments: (id) => call('history:segments', id),
  },
  translate: {
    toVi: (text) => call('translate:toVi', text),
    script: (segments) => call('translate:script', segments),
    onProgress: (cb) => subscribe('translate:progress', cb),
  },
  catalog: {
    models: () => call('catalog:models'),
    languages: () => call('catalog:languages'),
    formats: () => call('catalog:formats'),
  },
  onPipelineEvent: (cb) => subscribe('pipeline:event', cb),
  onSettingsChanged: (cb) => subscribe('settings:changed', cb),
  onToast: (cb) => subscribe('toast', cb),
});

/** Dang ky lang nghe; tra ve ham de huy. */
function subscribe(channel, cb) {
  const listener = (_evt, payload) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}
