'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const readline = require('readline');

const paths = require('./paths');

/**
 * Giám sát tiến trình sidecar Python.
 *
 * Sidecar được giữ sống suốt phiên làm việc để không phải nạp model lại mỗi
 * lần (nạp model mất vài giây và vài trăm MB RAM). Nếu nó chết, lần gọi
 * tiếp theo sẽ tự khởi động lại.
 */
class Worker {
  constructor(onEvent) {
    // Nhieu job co the chay song song, nen giu danh sach listener
    // thay vi mot callback de doi cho tung job.
    this.listeners = new Set();
    if (onEvent) this.listeners.add(onEvent);
    this.proc = null;
    this.pending = new Map();
    this.nextId = 1;
    this.startPromise = null;
    this.stderrTail = [];
  }

  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  #emit(ev) {
    for (const fn of this.listeners) {
      try {
        fn(ev);
      } catch (e) {
        process.stderr.write(`[worker] loi listener: ${e.message}\n`);
      }
    }
  }

  binaryPath() {
    const name = process.platform === 'win32' ? 'sidecar.exe' : 'sidecar';
    return path.join(paths.sidecarDir(), name);
  }

  isAlive() {
    return !!(this.proc && this.proc.exitCode === null && !this.proc.killed);
  }

  stderrText() {
    return this.stderrTail.slice(-15).join('\n');
  }

  /** Bat dau sidecar neu chua chay. Moi lenh deu di qua day truoc khi gui. */
  ensureStarted() {
    if (this.isAlive()) return Promise.resolve();
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.#spawn();
    // Sau khi xong, dat startPromise = null de lan sau co the bat dau lai.
    this.startPromise.catch(() => {}).then(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  #spawn() {
    return new Promise((resolve, reject) => {
      const bin = this.binaryPath();
      if (!fs.existsSync(bin)) {
        reject(
          new Error(
            `Không tìm thấy sidecar tại: ${bin}\n` +
              'App chưa được đóng gói đúng cách. Hãy chạy: npm run build:sidecar'
          )
        );
        return;
      }

      const proc = spawn(bin, [], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: {
          ...process.env,
          PYTHONUTF8: '1',
          PYTHONIOENCODING: 'utf-8',
          HF_HUB_DISABLE_TELEMETRY: '1',
        },
      });
      this.proc = proc;

      let ready = false;
      const settle = (err) => {
        if (ready) return;
        ready = true;
        clearTimeout(timer);
        if (err) reject(err);
        else resolve();
      };

      const timer = setTimeout(
        () => settle(new Error('Sidecar không phản hồi trong 30 giây.\n' + this.stderrText())),
        30_000
      );

      const rl = readline.createInterface({ input: proc.stdout });
      rl.on('line', (line) => this.#onLine(line, settle));

      proc.stderr.on('data', (d) => {
        for (const l of d.toString().split('\n')) {
          if (!l.trim()) continue;
          this.stderrTail.push(l);
          if (this.stderrTail.length > 300) this.stderrTail.shift();
        }
      });

      proc.once('exit', (code, signal) => {
        this.proc = null;
        for (const p of this.pending.values()) {
          clearTimeout(p.timer);
          p.reject(new Error(`Sidecar đã dừng (mã ${code}). ${this.stderrText()}`));
        }
        this.pending.clear();
        this.#emit({ event: 'sidecar_exit', code, signal, stderr: this.stderrText() });
        settle(new Error(`Sidecar đã dừng ngay khi khởi động (mã ${code}).\n` + this.stderrText()));
      });

      proc.once('error', (err) => {
        settle(new Error(`Không chạy được sidecar: ${err.message}`));
      });
    });
  }

  #onLine(line, onReady) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }

    if (msg.event === 'ready') {
      if (onReady) onReady(null);
      return;
    }

    // Ket qua co jobId -> tra ve cho request dang cho.
    if (msg.event === 'result' && msg.jobId != null && this.pending.has(msg.jobId)) {
      const p = this.pending.get(msg.jobId);
      this.pending.delete(msg.jobId);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg);
      else p.reject(new Error(msg.error || 'Sidecar bao loi'));
      return;
    }

    this.#emit(msg);
  }

  /** Gui lenh va cho dau ket qua cua lenh do. */
  async send(msg, { timeout = 0 } = {}) {
    await this.ensureStarted();
    // Job da duoc dinh danh boi tang tren (jobs.js) nen giu nguyen.
    const id = msg.jobId ?? this.nextId++;

    return new Promise((resolve, reject) => {
      const timer =
        timeout > 0
          ? setTimeout(() => {
              this.pending.delete(id);
              reject(new Error('Sidecar quá thời gian chờ'));
            }, timeout)
          : null;
      this.pending.set(id, { resolve, reject, timer });
      this.proc.stdin.write(JSON.stringify({ ...msg, jobId: id }) + '\n');
    });
  }

  kill() {
    if (this.isAlive()) {
      this.proc.kill();
      this.proc = null;
    }
  }
}

module.exports = { Worker };
