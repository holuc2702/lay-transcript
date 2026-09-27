'use strict';

/**
 * Gia lap module `electron` cho test.
 *
 * Nhiieu file trong src/main can `electron` (app.getPath...), nhung chay test
 * thi khong co Electron that. Ta nhung mot module gia lap vao require.cache
 * TRUOC kho layout module can no, nen khong can cai them gi them.
 */

const path = require('path');
const Module = require('module');

// Thu muc tam de gia lap thu muc du lieu nguoi dung.
const FAKE_USER_DATA = path.join(require('os').tmpdir(), 'lay-transcript-test-data');

const paths = {
  home: FAKE_USER_DATA,
  userData: FAKE_USER_DATA,
  videos: path.join(FAKE_USER_DATA, 'Videos'),
  downloads: path.join(FAKE_USER_DATA, 'Downloads'),
  desktop: path.join(FAKE_USER_DATA, 'Desktop'),
  appData: FAKE_USER_DATA,
  temp: require('os').tmpdir(),
};

const fakeElectron = {
  app: {
    isPackaged: false,
    getPath: (name) => paths[name] || path.join(FAKE_USER_DATA, name),
    getVersion: () => '1.0.0-test',
    getName: () => 'lay-transcript-test',
    whenReady: () => Promise.resolve(),
    on: () => {},
    quit: () => {},
  },
  ipcMain: { handle: () => {} },
  BrowserWindow: class {
    static getAllWindows() {
      return [];
    }
  },
  dialog: {},
  shell: {},
  Menu: { setApplicationMenu: () => {}, buildFromTemplate: () => ({}) },
  contextBridge: { exposeInMainWorld: () => {} },
  ipcRenderer: { invoke: async () => ({}), on: () => {}, removeListener: () => {} },
};

function install() {
  // Khong dung require.cache: Module._resolveFilename se nem loi vi chua cai
  // dat electron (no chi la devDependency, va test phai chay duoc ca tren may
  // CI chua cai gi). Chan Module._load thi dinh nghia duoc, dung khi module
  // co that la chua ton tai.
  const Module = require('module');
  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return fakeElectron;
    return origLoad.apply(this, arguments);
  };
  return fakeElectron;
}

module.exports = { install, fakeElectron, FAKE_USER_DATA, paths };
