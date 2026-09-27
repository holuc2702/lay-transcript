'use strict';

const fs = require('fs');
const path = require('path');

const paths = require('./paths');

/**
 * Lịch sử các video đã xử lý.
 *
 * Trước đây job chỉ nằm trong RAM của tiến trình chính, nên đóng app là mất
 * hết — người dùng không xem lại được video hôm qua. Lịch sử được ghi xuống
 * đĩa ngay khi một job kết thúc, và nạp lại khi mở app.
 *
 * Lưu ý: chỉ lưu thông tin và ĐƯỜNG DẪN file đã xuất, KHÔNG lưu toàn bộ
 * transcript trong RAM app — transcript có thể vài MB, mỗi lần là 1 video.
 * Muốn xem lại thì mở file trong thư mục lưu.
 */

const LIMIT = 200;

function file() {
  return path.join(paths.writableDir('history'), 'history.json');
}

function read() {
  try {
    const data = JSON.parse(fs.readFileSync(file(), 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function write(entries) {
  const next = entries.slice(0, LIMIT);
  fs.writeFileSync(file(), JSON.stringify(next, null, 2), 'utf8');
  return next;
}

/** Thêm một mục. Cùng URL thì đưa lên đầu thay vì nhân bản. */
function add(entry) {
  if (!entry || !entry.url) return read();
  const entries = read().filter((e) => e.url !== entry.url);
  entries.unshift({
    id: entry.id,
    url: entry.url,
    title: entry.title || null,
    titleVi: entry.titleVi || null,
    uploader: entry.uploader || null,
    duration: entry.duration ?? null,
    language: entry.language || null,
    model: entry.model || null,
    segmentCount: entry.segmentCount ?? 0,
    rtf: entry.rtf ?? null,
    state: entry.state || 'done',
    error: entry.error || null,
    outputs: Array.isArray(entry.outputs) ? entry.outputs : [],
    createdAt: new Date().toISOString(),
  });
  return write(entries);
}

function remove(id) {
  return write(read().filter((e) => e.id !== id));
}

function clear() {
  return write([]);
}

function list() {
  return read();
}

/**
 * Các mục lịch sử mà file đã xuất còn tồn tại.
 * Nếu người dùng xoá file tay thì mục đó không còn dùng được.
 */
function pruneMissingFiles() {
  const entries = read();
  const kept = entries.map((e) => {
    const alive = (e.outputs || []).filter((f) => fs.existsSync(f));
    return alive.length ? { ...e, outputs: alive, filesMissing: alive.length !== (e.outputs || []).length } : e;
  });
  return write(kept);
}

module.exports = { add, remove, clear, list, pruneMissingFiles, LIMIT };
