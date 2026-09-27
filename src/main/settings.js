'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const paths = require('./paths');
const C = require('./config');

/**
 * Cai dat nguoi dung, luu dang JSON trong userData.
 * Ghi atomically (ghi file.tam roi doi ten) de app bi tat dong hang
 * khong lam hoa cau hinh.
 */

const DEFAULTS = {
  model: C.DEFAULT_MODEL,
  translateTitle: true,
  language: 'auto',
  script: '',
  task: 'transcribe',
  beamSize: 5,
  vadFilter: true,
  wordTimestamps: true,
  batchSize: 8,
  hotwords: '',
  outputDir: '',
  autoOpenFolder: true,
  ytdlpChannel: 'stable',
  autoUpdateYtdlp: true,
  cookiesFile: '',
  useCookies: false,
  keepAudio: false,
};

function file() {
  return path.join(paths.userData(), 'settings.json');
}

function get() {
  try {
    const raw = JSON.parse(fs.readFileSync(file(), 'utf8'));
    // Giu nguyen key la moi, bo key da bi xoa khoi phien ban cu.
    return { ...DEFAULTS, ...raw };
  } catch {
    return { ...DEFAULTS };
  }
}

function set(patch) {
  const next = { ...get(), ...patch };
  const tmp = `${file()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, file());
  return next;
}

function getOutputDir() {
  const s = get();
  if (s.outputDir) return s.outputDir;
  const dir = paths.defaultOutputDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

module.exports = { get, set, getOutputDir, DEFAULTS, file: () => file(), app };
