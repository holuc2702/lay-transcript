'use strict';

/**
 * Kiểm thử tích hợp với sidecar Python ĐÃ ĐÓNG GÓI.
 *
 * Đây là tầng rủi ro cao nhất: nếu đóng gói sai, sidecar sẽ chết lúc chạy
 * chứ không phải lúc build. Ví dụ đã gặp:
 *   - model chỉ chạy tiếng Anh bị đưa vào danh sách hợp lệ
 *   - silero_vad.onnx không được đóng gói -> VAD chết lúc chạy
 *   - multiprocessing khởi động lại tiến trình -> lỗi model rác
 *
 * Các test này chạy BINARY THẬT trong resources/sidecar, không mock.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const readline = require('node:readline');

const ROOT = path.join(__dirname, '..');
const SIDECAR = path.join(
  ROOT,
  'resources',
  'sidecar',
  process.platform === 'win32' ? 'sidecar.exe' : 'sidecar'
);
const MODELS = path.join(require('node:os').tmpdir(), 'lay-transcript-test-models');

// Test nhanh (offline): chỉ kiểm tra app khởi động và báo cáo môi trường.
// Test chậm (cần mạng + tải model): chạy bằng LAY_SLOW=1
const SLOW = process.env.LAY_SLOW === '1';
const MODEL = process.env.LAY_TEST_MODEL || 'tiny';

/** Gọi sidecar, trả về toàn bộ sự kiện nhận được. */
function drive(commands, { timeout = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(SIDECAR)) {
      reject(
        new Error(
          `Chưa đóng gói sidecar: ${SIDECAR}\nHãy chạy: npm run build:sidecar`
        )
      );
      return;
    }
    const proc = spawn(SIDECAR, { stdio: ['pipe', 'pipe', 'pipe'] });
    const events = [];
    const stderr = [];
    const results = new Map();
    const rl = readline.createInterface({ input: proc.stdout });

    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error('Sidecar không phản hồi. stderr:\n' + stderr.join('\n')));
    }, timeout);

    rl.on('line', (line) => {
      let m;
      try {
        m = JSON.parse(line);
      } catch {
        return;
      }
      events.push(m);
      if (m.event === 'result') {
        results.set(m.jobId, m);
        if (results.size === commands.length) {
          clearTimeout(timer);
          proc.kill();
          resolve({ events, results, stderr });
        }
      }
    });
    proc.stderr.on('data', (d) => {
      for (const l of d.toString().split('\n')) if (l.trim()) stderr.push(l);
    });
    proc.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });

    for (const c of commands) proc.stdin.write(JSON.stringify(c) + '\n');
  });
}

test('sidecar đã được đóng gói và chạy được', async () => {
  const { results } = await drive([{ cmd: 'ping', jobId: 'p1' }], { timeout: 60_000 });
  const r = results.get('p1');
  assert.strictEqual(r.ok, true, `sidecar không phản hồi ping: ${JSON.stringify(r)}`);
  assert.strictEqual(r.pong, true);
});

test('sidecar báo đúng môi trường đã đóng gói', async () => {
  const { results } = await drive([{ cmd: 'env', jobId: 'e1' }], { timeout: 90_000 });
  const env = results.get('e1').env;
  assert.strictEqual(env.frozen, true, 'phải chạy bản đóng gói, không phải Python hệ thống');
  assert.ok(env.python, 'thiếu phiên bản Python');
  // int8 là kiểu tính duy nhất ta dùng -> phải nằm trong danh sách hỗ trợ
  assert.ok(
    env.computeTypes.includes('int8'),
    `máy này không hỗ trợ int8: ${JSON.stringify(env.computeTypes)}`
  );
  assert.ok(env.fasterWhisper, 'chưa đóng gói faster-whisper');
  assert.ok(env.ctranslate2, 'chưa đóng gói CTranslate2');
});

test('VAD đã được đóng gói (silero_vad .onnx phải tồn tại)', () => {
  // VAD được nạp theo ĐƯỜNG DẪN FILE, không phải bằng import. Nếu file .onnx
  // không được đóng gói, mọi lần ghi âm sẽ chết lúc chạy.
  const base = path.join(ROOT, 'resources', 'sidecar');
  const onnx = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.onnx')) onnx.push(p);
    }
  };
  if (fs.existsSync(base)) walk(base);
  assert.ok(onnx.length > 0, 'không tìm thấy file .onnx của VAD trong bản đóng gói');
  assert.ok(
    onnx.some((p) => /silero/i.test(p)),
    `file .onnx không phải silero: ${onnx.join(', ')}`
  );
});

test('onnxruntime đã được đóng gói (VAD cần, và không thấy qua import tĩnh)', () => {
  // faster-whisper import onnxruntime BÊN TRONG hàm, nên trình dò mã tĩnh của
  // PyInstaller bỏ sót. Đã từng xảy ra: app chạy được rồi mới chết lúc bật VAD
  // với thông báo "Applying the VAD filter requires the onnxruntime package".
  const base = path.join(ROOT, 'resources', 'sidecar', '_internal');
  if (!fs.existsSync(base)) return;
  const onnxPkg = path.join(base, 'onnxruntime');
  assert.ok(
    fs.existsSync(onnxPkg),
    'thiếu gói onnxruntime — phải khai báo hiddenimports trong sidecar.spec'
  );
  // DLL của onnxruntime cũng phải có (Windows cần nằm ở thư mục gốc)
  const dlls = fs
    .readdirSync(base)
    .filter((f) => /^onnxruntime.*\.dll$/i.test(f));
  if (process.platform === 'win32') {
    assert.ok(
      dlls.length > 0,
      'thiếu onnxruntime.dll ở thư mục gốc — Windows sẽ không nạp được'
    );
  }
});

test('pyarrow đã bị loại khỏi bản đóng gói (tiết kiệm ~120MB)', () => {
  const base = path.join(ROOT, 'resources', 'sidecar');
  if (!fs.existsSync(base)) return;
  const hasPyarrow = fs
    .readdirSync(path.join(base, '_internal'), { withFileTypes: true })
    .some((e) => e.name.startsWith('pyarrow'));
  assert.strictEqual(hasPyarrow, false, 'pyarrow không dùng mà vẫn bị đóng gói');
});

test('sidecar từ chối lệnh lạ thay vì treo', async () => {
  const { results } = await drive([{ cmd: 'khong-ton-tai', jobId: 'x1' }], { timeout: 60_000 });
  const r = results.get('x1');
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /không rõ/i);
});

test('sidecar bảo vệ khỏi việc dùng model chỉ-hỗ-trợ-tiếng-Anh cho tiếng Trung', async () => {
  // distil-* là model CHỈ tiếng Anh nhưng báo is_multilingual=True, nên
  // faster-whisper KHÔNG cảnh báo — nó sẽ ra rác âm thầm. Đây là lớp chặn
  // của chúng ta, phải chạy đúng.
  const { results } = await drive(
    [
      {
        cmd: 'transcribe',
        jobId: 'z1',
        audio: __filename, // sẽ bị chặn trước, không tới bước đọc file
        modelsDir: MODELS,
        opts: { model: 'distil-large-v3', language: 'zh' },
      },
    ],
    { timeout: 60_000 }
  );
  const r = results.get('z1');
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /chỉ hỗ trợ tiếng Anh/i);
});

// ---------------------------------------------------------------------------
// Test chậm: cần mạng để tải model và ghi âm thật
// ---------------------------------------------------------------------------

test('ghi âm tiếng Anh thật qua bản đóng gói', { skip: !SLOW }, async () => {
  const audio = path.join(__dirname, 'fixtures', 'en.wav');
  if (!fs.existsSync(audio)) return;
  const { events, results } = await drive(
    [
      {
        cmd: 'transcribe',
        jobId: 't1',
        audio,
        modelsDir: MODELS,
        opts: { model: MODEL, language: 'en', vadFilter: true, batchSize: 1 },
      },
    ],
    { timeout: 900_000 }
  );
  const r = results.get('t1');
  assert.strictEqual(r.ok, true, `ghi âm thất bại: ${r.error}`);
  const segs = events.filter((e) => e.event === 'segment');
  assert.ok(segs.length > 0, 'không có đoạn nào');
  const text = segs.map((s) => s.text).join(' ');
  assert.match(text, /lazy dog/i, `sai nội dung: ${text}`);
  const info = events.find((e) => e.event === 'transcribe_info');
  assert.strictEqual(info.language, 'en');
  // đoạn đầu phải có timestamp hợp lệ
  assert.ok(segs[0].start >= 0, 'timestamp bắt đầu âm');
  assert.ok(segs[segs.length - 1].end >= segs[segs.length - 1].start);
});

test('nhận diện tiếng Trung và ép kiểu chữ Giản thể', { skip: !SLOW }, async () => {
  const audio = path.join(__dirname, 'fixtures', 'zh.wav');
  if (!fs.existsSync(audio)) return;
  const { events, results } = await drive(
    [
      {
        cmd: 'transcribe',
        jobId: 't2',
        audio,
        modelsDir: MODELS,
        opts: { model: MODEL, language: 'zh', script: 'zh-Hans', vadFilter: true, batchSize: 1 },
      },
    ],
    { timeout: 900_000 }
  );
  const r = results.get('t2');
  assert.strictEqual(r.ok, true, `ghi âm thất bại: ${r.error}`);

  const info = events.find((e) => e.event === 'transcribe_info');
  assert.strictEqual(info.language, 'zh', `nhận diện sai ngôn ngữ: ${info.language}`);

  const text = events
    .filter((e) => e.event === 'segment')
    .map((s) => s.text)
    .join('');

  assert.ok(text.length > 0, 'không có chữ nào');
  // "今天天气很好" — với initial_prompt Giản thể, kỳ vọng ký tự giản thể.
  // Nếu không ép được, Whisper mặc định hay nhảy ra Phồn thể (今天天氣很好).
  assert.ok(
    text.includes('今天天气'),
    `ép Giản thể không có tác dụng, nhận được: ${text}`
  );
  assert.ok(
    !text.includes('天氣'),
    `vẫn còn ký tự Phồn thể dù đã ép Giản thể: ${text}`
  );
});

test('hủy giữa chừng thực sự dừng job', { skip: !SLOW }, async () => {
  // Gửi lệnh ghi âm một file dài, rồi gửi lệnh hủy ngay sau khi bắt đầu.
  if (!fs.existsSync(MODELS)) return;
  const proc = spawn(SIDECAR, { stdio: ['pipe', 'pipe', 'pipe'] });
  const rl = readline.createInterface({ input: proc.stdout });
  let started = false;
  let cancelled = false;

  const done = new Promise((resolve) => {
    rl.on('line', (line) => {
      let m;
      try {
        m = JSON.parse(line);
      } catch {
        return;
      }
      if (m.event === 'transcribe_start' && m.jobId === 'c1' && !started) {
        started = true;
        // targetJobId: job can dung (khop voi job dang chay).
        proc.stdin.write(JSON.stringify({ cmd: 'cancel', targetJobId: 'c1' }) + '\n');
      }
      if (m.event === 'cancelled' && m.jobId === 'c1') cancelled = true;
      if (m.event === 'result' && m.jobId === 'c1') {
        proc.kill();
        resolve({ cancelled, result: m });
      }
    });
  });

  proc.stdin.write(
    JSON.stringify({
      cmd: 'transcribe',
      jobId: 'c1',
      audio: path.join(__dirname, 'fixtures', 'long.wav'),
      modelsDir: MODELS,
      opts: { model: MODEL, language: 'en', batchSize: 1 },
    }) + '\n'
  );

  const { result } = await Promise.race([
    done,
    new Promise((_, rej) => setTimeout(() => rej(new Error('quá thời gian')), 600_000)),
  ]);
  assert.ok(
    result.cancelled || cancelled,
    `hủy không có tác dụng: ${JSON.stringify(result)}`
  );
});
