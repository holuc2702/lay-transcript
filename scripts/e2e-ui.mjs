#!/usr/bin/env node
/**
 * Kiểm thử end-to-end qua UI THẬT, điều khiển Electron bằng Chrome DevTools
 * Protocol. Không mock gì: bấm nút thật, đọc DOM thật, chờ tiến trình thật.
 *
 * Chạy trên CÙNG máy với app (Node 22+ có sẵn WebSocket nên không cần gói gì):
 *     npx electron . --remote-debugging-port=9222 &
 *     node scripts/e2e-ui.mjs https://www.youtube.com/watch?v=jNQXAC9IVRw
 *
 * Ghi chú: Electron chỉ nghe CDP trên 127.0.0.1, nên script này phải chạy
 * trong cùng máy với app. Muốn điều khiển từ máy khác thì phải có đường
 * vào (port forward), chứ không dùng --remote-debugging-address được.
 */

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = process.env.E2E_PORT || '9222';
const URL_ARG = process.argv[2] || 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
const TIMEOUT_MS = Number(process.env.E2E_TIMEOUT || 1800) * 1000;

const say = (m) => console.log(m);
const die = (m) => {
  console.error(`\nTHAT BAI: ${m}`);
  process.exit(1);
};

async function findPage() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  const list = await res.json();
  const page = list.find((t) => t.type === 'page' && (t.url || '').includes('index.html'));
  if (!page) {
    die(`Khong tim thay cua so app. Cua so dang co:\n${list
      .map((t) => `  ${t.type} ${t.title} ${t.url}`)
      .join('\n')}`);
  }
  return page;
}

/** Client CDP toi gian. */
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        this.pending.get(m.id)(m);
        this.pending.delete(m.id);
      }
    });
  }

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', rej, { once: true });
    });
    return new CDP(ws);
  }

  /** Gọi một lệnh CDP bất kỳ (vd Page.bringToFront). */
  call(method, params, timeoutMs = 15000) {
    const id = ++this.id;
    const p = new Promise((res, rej) => {
      this.pending.set(id, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result)));
      setTimeout(() => rej(new Error(`CDP timeout: ${method}`)), timeoutMs);
    });
    this.ws.send(JSON.stringify({ id, method, params: params || {} }));
    return p;
  }

  /** Chạy biểu thức trong renderer, trả về giá trị thô (đã bóc 2 lớp). */
  async eval(expression, timeoutMs = 30000) {
    const id = ++this.id;
    const p = new Promise((res, rej) => {
      this.pending.set(id, (m) => {
        const payload = m.result || {};
        if (payload.exceptionDetails) {
          const ex = payload.exceptionDetails;
          rej(new Error(`Loi JS: ${ex.exception?.description || ex.text}`));
          return;
        }
        res(payload.result?.value);
      });
      setTimeout(() => rej(new Error(`CDP timeout: ${expression.slice(0, 60)}`)), timeoutMs);
    });
    this.ws.send(
      JSON.stringify({
        id,
        method: 'Runtime.evaluate',
        params: { expression, awaitPromise: true, returnByValue: true },
      })
    );
    return p;
  }
}

const main = async () => {
  const page = await findPage();
  say(`-> Dang dieu khien: ${page.title}`);

  const cdp = await CDP.connect(page.webSocketDebuggerUrl);

  // 1. preload phai noi duoc, neu khong moi nut nao cung chet am tham
  if ((await cdp.eval('typeof window.api')) !== 'object') {
    die('window.api chua san sang — preload loi?');
  }
  say('[ok] preload da noi');

  // 2. Dan link va bam nut, y het nguoi dung
  await cdp.eval(`(() => {
    document.querySelector('#urlInput').value = ${JSON.stringify(URL_ARG)};
    document.querySelector('#btnStart').click();
    return 1;
  })()`);
  say(`[..] da bam "Bat dau" voi ${URL_ARG}`);

  // 3. Theo doi den khi xong
  const deadline = Date.now() + TIMEOUT_MS;
  let last = '';
  let final = null;
  while (Date.now() < deadline) {
    const info = JSON.parse(
      (await cdp.eval(`(() => {
        const s = document.querySelector('.status');
        const e = document.querySelector('.job-error');
        const m = document.querySelector('.job-message');
        const p = document.querySelector('.job-meta');
        return JSON.stringify({
          state: s && s.textContent.trim(),
          err: e && e.textContent.trim().slice(0, 300),
          msg: m && m.textContent.trim().slice(0, 110),
          meta: p && p.textContent.trim().slice(0, 110),
        });
      })()`)) || '{}'
    );
    const line = `     ${info.state || '?'} | ${info.msg || ''}`;
    if (line !== last) {
      say(line);
      last = line;
    }
    if (info.err) {
      die(`App bao loi:\n${info.err}`);
    }
    if (info.state === 'Xong') {
      final = info;
      break;
    }
    await sleep(3000);
  }
  if (!final) die('Het thoi gian cho, app van chua xong');
  say(`[ok] Hoan tat. ${final.meta || ''}`);

  // 4. Bam "Xem transcript" va doc thu
  await cdp.eval(`(() => {
    const b = document.querySelector('[data-act=transcript]');
    if (b) b.click();
    return 1;
  })()`);
  await sleep(2500);

  const n = await cdp.eval("document.querySelectorAll('.seg').length");
  if (!n) die('Nut "Xem transcript" bam duoc nhung khong hien thi doan nao');
  say(`[ok] So doan hien thi: ${n}`);
  const first = await cdp.eval("document.querySelector('.seg-text').textContent");
  say(`[ok] Doan dau: ${String(first).slice(0, 140)}`);

  // 5. Kiem tra hai nut moi: sao chep van ban + luu .txt
  const hasCopy = await cdp.eval("!!document.querySelector('[data-act=copy]')");
  const hasSave = await cdp.eval("!!document.querySelector('[data-act=savetxt]')");
  if (!hasCopy) die('khong co nut "Sao chep van ban"');
  if (!hasSave) die('khong co nut "Luu thanh .txt"');
  say('[ok] Co nut Sao chep van ban va Luu thanh .txt');

  // Clipboard API chi doc duoc khi cua so co focus. Goi `Page.bringToFront`
  // truoc, neu khong thi thu tiep the se that bai "Document is not focused".
  try {
    await cdp.call('Page.bringToFront', {});
  } catch {
    /* bo qua: ban co the thu cach khac */
  }

  // Sao chep phai ra VAN BAN THUAN: co timestamp la FAIL
  await cdp.eval(`(() => {
    const b = document.querySelector('[data-act=copy]');
    b.click();
    return 1;
  })()`);
  await sleep(1500);
  let clip = null;
  try {
    clip = await cdp.eval('navigator.clipboard.readText()');
  } catch (e) {
    die(`doc clipboard that bai: ${e.message}`);
  }
  if (!clip) die('clipboard rong sau khi sao chep');
  if (/\[\d{2}:\d{2}/.test(clip)) {
    die(`van ban sao chep van con so phut/giay: ${clip.slice(0, 80)}`);
  }
  say(`[ok] Van ban thu san (khong co so phut): "${clip.slice(0, 70)}..."`);

  say('');
  say('[ok] E2E THANH CONG');
  process.exit(0);
};

main().catch((e) => {
  console.error('\nLOI:', e.message);
  process.exit(1);
});
