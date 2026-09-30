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
 * @param {object} opts { workDir, onProgress, probeDuration }
 */
async function merge(parts, outFile, ffmpegPath, { workDir, onProgress, probeDuration } = {}) {
  const valid = parts.filter((p) => p.file && fs.existsSync(p.file) && Number.isFinite(p.start));
  if (!valid.length) throw new Error('Không có file voice nào để ghép.');

  const tmpDir = workDir || path.dirname(outFile);
  fs.mkdirSync(tmpDir, { recursive: true });

  // ---------------------------------------------------------- chống chồng tiếng
  //
  // Lớp bảo vệ thứ hai, độc lập với bộ căn: dù cho thứ tự hay số liệu có sai,
  // mỗi file vẫn được dời sang sau mốc kết thúc THẬT của file trước. Nhờ vậy
  // không bao giờ có hai đoạn phát cùng lúc.
  const placed = [];
  let guard = 0;
  for (const p of valid) {
    let start = Math.max(0, p.start);
    let dur = Number(p.duration);
    if ((!isFinite(dur) || dur <= 0) && probeDuration) {
      dur = await probeDuration(p.file, ffmpegPath).catch(() => 0);
    }
    if (!isFinite(dur) || dur <= 0) {
      onProgress?.({ phase: 'merge', message: `Bỏ qua một đoạn (không đo được thời lượng).` });
      continue;
    }
    const prev = placed[placed.length - 1];
    if (prev) {
      const minStart = prev.start + prev.realDuration + 0.05; // +50ms chống chạm mép
      if (start < minStart) {
        if (guard++ < 3) {
          onProgress?.({
            phase: 'merge',
            message: 'Phát hiện hai đoạn chồng nhau — đã tự dời đoạn sau ra sau.',
          });
        }
        start = minStart;
      }
    }
    placed.push({ ...p, start, realDuration: dur });
  }
  if (!placed.length) throw new Error('Không đo được thời lượng của đoạn nào.');

  const total = Math.max(...placed.map((p) => p.start + p.realDuration)) + 2;
  const inputs = [];
  const filters = [];

  placed.forEach((p, i) => {
    inputs.push('-i', p.file);
    // Chuẩn hoá về 44.1 kHz stereo để amix không bị lệch.
    filters.push(`[${i}:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo[n${i}]`);
    // Áp hệ số tua mà bộ căn đã quyết định (atempo). Không có bước này thì
    // file dài hơn khung đã căn -> đoạn sau tràn vào đuôi đoạn trước, nghe
    // chồng tiếng và lệch dần về cuối video.
    const sp = Number(p.speed);
    const tempo = isFinite(sp) && sp > 1.001 ? Math.min(2, sp) : 1;
    filters.push(tempo === 1 ? `[n${i}]anull[t${i}]` : `[n${i}]atempo=${tempo.toFixed(4)}[t${i}]`);
    const delay = Math.max(0, Math.round(p.start * 1000));
    filters.push(`[t${i}]adelay=${delay}|${delay}[d${i}]`);
  });

  const mixIn = placed.map((_, i) => `[d${i}]`).join('');
  filters.push(
    `${mixIn}amix=inputs=${placed.length}:duration=longest:dropout_transition=0:normalize=0[mixed]`,
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

  onProgress?.({ phase: 'merge', message: `Đang ghép ${placed.length} đoạn giọng đọc…` });
  await run(ffmpegPath, args);

  const stat = fs.statSync(outFile);
  if (!stat.size) throw new Error('File ghép ra rỗng.');
  return { file: outFile, size: stat.size, expected: total, placed: placed.length };
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
