#!/usr/bin/env node
/** Kiểm tra nút "Dịch sang tiếng Việt" hiển thị bản dịch tạm có nhãn rõ. */
const PORT = process.env.E2E_PORT || '9222';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const die = (m) => {
  console.error(`THAT BAI: ${m}`);
  process.exit(1);
};
class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) { this.pending.get(m.id)(m); this.pending.delete(m.id); }
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
  call(method, params = {}, t = 30000) {
    const id = ++this.id;
    const p = new Promise((res, rej) => {
      this.pending.set(id, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result)));
      setTimeout(() => rej(new Error(`timeout ${method}`)), t);
    });
    this.ws.send(JSON.stringify({ id, method, params }));
    return p;
  }
  async eval(x, t = 90000) {
    const r = await this.call('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }, t);
    if (r.exceptionDetails) throw new Error('Loi JS');
    return r.result?.value;
  }
}
const main = async () => {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find((x) => x.type === 'page' && (x.url || '').includes('index.html'));
  if (!page) die('khong thay app');
  const cdp = await CDP.connect(page.webSocketDebuggerUrl);
  console.log('->', page.title);

  if (!(await cdp.eval("!!document.querySelector('[data-act=translate]')"))) {
    die('khong co nut Dich (can 1 video da xong)');
  }
  console.log('[ok] co nut Dich sang tieng Viet');
  await cdp.eval("document.querySelector('[data-act=translate]').click()");

  const deadline = Date.now() + 240000;
  let badge = '', text = '';
  while (Date.now() < deadline) {
    badge = (await cdp.eval("document.querySelector('.ts-badge')?.textContent || ''")) || '';
    text = (await cdp.eval("document.querySelector('.ts-text')?.textContent?.slice(0,200) || ''")) || '';
    if (badge && text && !/Đang dịch/.test(text)) break;
    await sleep(4000);
  }
  if (!badge) die('khong hien nhan ban dich tam');
  if (!text || /Đang dịch/.test(text)) die('khong co ban dich: ' + text.slice(0, 80));
  console.log('[ok] nhan:', badge);
  console.log('[ok] ban dich:', text.slice(0, 150));
  console.log('\n[ok] E2E TRANSLATE THANH CONG');
  process.exit(0);
};
main().catch((e) => die(e.message));
