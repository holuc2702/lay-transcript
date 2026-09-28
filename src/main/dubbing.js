'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

/**
 * Ghép các file voice thành MỘT file audio, căn theo timing đã tính.
 *
 * Đầu ra CHỈ CÓ GIỌNG ĐỌC — không trộn giọng gốc của video, đúng như bạn yêu cầu.
 * (Sau này nếu muốn trộn, chỉ cần thêm audio gốc làm nhánh thứ hai trong filter.)
 *
 * Cách làm: dùng filter `adelay` của ffmpeg để đẩy từng đoạn tới đúng mốc thời
 * gian, rồi `amix`. Cách này KHÔNG tua tốc độ (không méo tiếng) — tốc độ đã
 * được quyết định khi tạo file, ta chỉ chèn khoảng lặng.
 */

function run(bin, args, timeout = 15 * 60_000) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => (err += d.toString()));
    const t = setTimeout(() => {
      p.kill('SIGKILL');
      reject(new Error('ffmpeg quá thời gian chạy'));
    }, timeout);
    p.on('error', (e) => {
      clearTimeout(t);
      reject(new Error(`Không chạy được ${bin}: ${e.message}`));
    });
    p.on('close', (code) => {
      clearTimeout(t);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg thất bại (mã ${code}): ${err.split('\n').slice(-6).join('\n')}`));
    });
  });
}

/**
 * @param {Array<{file:string, start:number, speed:number}>} parts
 * @param {string} outFile
 * @param {string} ffmpegPath
 * @param {object} opts { workDir, onProgress }
 */
async function merge(parts, outFile, ffmpegPath, { workDir, onProgress } = {}) {
  const valid = parts.filter((p) => p.file && fs.existsSync(p.file) && Number.isFinite(p.start));
  if (!valid.length) throw new Error('Không có file voice nào để ghép.');

  const tmpDir = workDir || path.dirname(outFile);
  fs.mkdirSync(tmpDir, { recursive: true });

  const total = Math.max(...valid.map((p) => p.start + (p.duration || 0))) + 2;
  const inputs = [];
  const filters = [];
  const labels = [];

  valid.forEach((p, i) => {
    const raw = path.join(tmpDir, `raw-${i}.wav`);
    inputs.push('-i', p.file);
    labels.push(`[${i}:a]`);

    // Chuẩn hoá về 44.1kHz mono 16-bit để amix không bị lệch.
    let chain = `[${i}:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo[pre${i}]`;
    filters.push(chain);
    filters.push(`[pre${i}]aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo[v${i}]`);

    // Nếu cần tua (chỉ khi người dùng bật) thì dùng atempo, giới hạn 1.15x
    const speed = Number(p.speed) || 1;
    if (speed > 1.001) {
      filters.push(`[v${i}]atempo=${speed.toFixed(4)}[s${i}]`);
    } else {
      filters.push(`[v${i}]anull[s${i}]`);
    }
    const delay = Math.max(0, Math.round(p.start * 1000));
    filters.push(`[s${i}]adelay=${delay}|${delay}[d${i}]`);
  });

  const mixIn = valid.map((_, i) => `[d${i}]`).join('');
  filters.push(
    `${mixIn}amix=inputs=${valid.length}:duration=longest:dropout_transition=0:normalize=0[mixed]`,
    `[mixed]apad=whole_dur=${Math.ceil(total)}[out]`
  );

  const args = [
    '-hide_banner', '-nostdin', '-y',
    ...inputs,
    '-filter_complex', filters.join(';'),
    '-map', '[out]',
    '-ar', '44100',
    '-ac', '2',
    '-c:a', 'pcm_s16le',
    outFile,
  ];

  onProgress && onProgress({ phase: 'merge', message: `Đang ghép ${valid.length} đoạn giọng đọc…` });
  await run(ffmpegPath, args);

  const stat = fs.statSync(outFile);
  if (!stat.size) throw new Error('File ghép ra rỗng.');
  return { file: outFile, size: stat.size, expected: total };
}

/** Xuất bản mp3 cho dễ nghe/chia sẻ. */
async function toMp3(srcWav, outMp3, ffmpegPath, bitrate = '192k') {
  await run(ffmpegPath, [
    '-hide_banner', '-nostdin', '-y',
    '-i', srcWav,
    '-c:a', 'libmp3lame',
    '-b:a', bitrate,
    outMp3,
  ]);
  return outMp3;
}

module.exports = { merge, toMp3 };
