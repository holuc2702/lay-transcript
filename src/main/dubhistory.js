'use strict';

const fs = require('fs');
const path = require('path');

const paths = require('./paths');

/**
 * Lịch sử lồng tiếng.
 *
 * Không có lịch sử thì sau vài tuần không tìm được "file lồng tiếng video đó
 * nằm ở đâu" — trong khi thư mục kết quả lại chia theo tên video.
 *
 * Lưu: thời điểm, video, giọng, model dịch, thư mục chứa file, và danh sách
 * file. Cũng ghi nhận thư mục voice từng câu để sau này lấy lại khỏi tạo voice.
 */

const LIMIT = 100;

function file() {
  return path.join(paths.writableDir('cache'), 'dubbing-history.json');
}

function read() {
  try {
    const d = JSON.parse(fs.readFileSync(file(), 'utf8'));
    return Array.isArray(d) ? d : [];
  } catch {
    return [];
  }
}

function write(entries) {
  const next = entries.slice(0, LIMIT);
  fs.writeFileSync(file(), JSON.stringify(next, null, 2), 'utf8');
  return next;
}

function add(entry) {
  if (!entry) return read();
  const entries = read().filter((e) => e.dir !== entry.dir);
  entries.unshift({
    dir: entry.dir || '',
    name: entry.name || '',
    url: entry.url || '',
    title: entry.title || '',
    titleVi: entry.titleVi || '',
    voice: entry.voice || '',
    translator: entry.translator || '',
    segmentCount: entry.segmentCount ?? 0,
    duration: entry.duration ?? 0,
    files: entry.files || {},
    voiceDir: entry.voiceDir || '',
    voiceCount: entry.voiceCount ?? 0,
    createdAt: new Date().toISOString(),
  });
  return write(entries);
}

function remove(dir) {
  return write(read().filter((e) => e.dir !== dir));
}

function clear() {
  return write([]);
}

function list() {
  // Gắn cờ file còn tồn tại không, để người dùng biết mục nào đã bị xoá.
  return read().map((e) => ({
    ...e,
    missing: e.dir ? !fs.existsSync(e.dir) : true,
  }));
}

module.exports = { add, remove, clear, list, file };
