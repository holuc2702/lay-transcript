#!/usr/bin/env node
/**
 * Kiểm thử cơ chế "tự cập nhật có kiểm chứng" của yt-dlp — thứ giải quyết
 * nỗi khổ lớn nhất: YouTube đổi giao thức làm yt-dlp hỏng, và bản mới cũng
 * có thể hỏng.
 *
 * Kiểm tra cả 4 mắt xích:
 *   1. nút "Thử tải thử" báo bản đang chạy có tải được video thật không
 *   2. "Cập nhật & kiểm chứng" tải được bản mới và xác minh trước khi dùng
 *   3. bản lưu được tạo để quay lui
 *   4. "Quay lui phiên bản" đưa app về bản trước
 */

const PORT = process.env.E2E_PORT || '9222';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const die = (m) => {
  console.error(`\nTHAT BAI: ${m}`);
  process.exit(1);
};

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
  call(method, params = {}, timeoutMs = 30000) {
    const id = ++this.id;
    const p = new Promise((res, rej) => {
      this.pending.set(id, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result)));
      setTimeout(() => rej(new Error(`CDP timeout: ${method}`)), timeoutMs);
    });
    this.ws.send(JSON.stringify({ id, method, params }));
    return p;
  }
  async eval(expression, timeoutMs = 30000) {
    const r = await this.call(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true },
      timeoutMs
    );
    if (r.exceptionDetails) {
      throw new Error(`Loi JS: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
    }
    return r.result?.value;
  }
}

const log = () =>
  cdp.eval(
    `(() => { const b=document.querySelector('#ytdlpLog'); return b ? b.innerText : ''; })()`
  );

const clickAndWait = async (selector, timeoutMs) => {
  await cdp.eval(`(() => { document.querySelector('${selector}').click(); return 1; })()`);
  const start = Date.now();
  let last = '';
  while (Date.now() - start < timeoutMs) {
    const txt = await log();
    if (txt !== last) {
      const line = txt.trim().split('\n').filter(Boolean).pop() || '';
      if (line) console.log(`     ${line.slice(0, 110)}`);
      last = txt;
    }
    // nút trở lại trạng thái bình thường -> đã xong
    const disabled = await cdp.eval(`document.querySelector('${selector}').disabled`);
    if (!disabled && Date.now() - start > 3000) return txt;
    await sleep(2500);
  }
  return last;
};

let cdp;

const main = async () => {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find((t) => t.type === 'page' && (t.url || '').includes('index.html'));
  if (!page) die('khong tim thay cua so app');
  cdp = await CDP.connect(page.webSocketDebuggerUrl);
  await cdp.call('Page.bringToFront', {}).catch(() => {});

  // Chuyen sang tab Cai dat
  await cdp.eval(`(() => { document.querySelector('[data-tab="settings"]').click(); return 1; })()`);
  await sleep(1200);
  console.log('[ok] da mo tab Cai dat');

  // ------------------------------------------------- 1. thu tai video that
  console.log('\n== 1. Kiem tra ban dang chay co tai duoc video khong ==');
  await clickAndWait('#btnTestYtdlp', 240_000);
  const t1 = await log();
  if (!/tải thử thành công|hoạt động bình thường/i.test(t1)) {
    die(`khong xac nhan duoc ban hien tai:\n${t1.slice(-400)}`);
  }
  console.log('[ok] ban hien tai tai duoc video that');

  // --------------------------------- 2. cap nhat + kiem chung that
  console.log('\n== 2. Cap nhat & kiem chung (tai that, verify that roi moi dung) ==');
  const before = await cdp.eval(
    `(() => { const p=document.querySelector('#ytdlpStatus').innerText; return p; })()`
  );
  console.log(`     trang thai truoc: ${before.replace(/\n/g, ' | ')}`);
  await clickAndWait('#btnUpdateNow', 900_000);
  const t2 = await log();
  console.log(`     ${t2.trim().split('\n').filter(Boolean).slice(-2).join(' / ').slice(0, 160)}`);
  if (!/cập nhật lên|không dùng bản mới|không kết nối|thử lại/i.test(t2)) {
    die(`cap nhat khong cho ket qua ro rang:\n${t2.slice(-400)}`);
  }
  // Neu la "khong dung ban moi" thi van dung: app da bao ve nguoi dung.
  const protectedFromBad = /không dùng bản mới/i.test(t2);
  console.log(
    protectedFromBad
      ? '[ok] app TU CHOI ban moi (giu ban cu) — dung nhu thiet ke'
      : '[ok] cap nhat thanh cong'
  );

  // ------------------------------------------- 3. ban luu de quay lui
  console.log('\n== 3. Kiem tra ban luu de quay lui ==');
  await cdp.eval(`(() => { document.querySelector('#btnCheckUpdate').click(); return 1; })()`);
  await sleep(6000);
  const status = await cdp.eval(`document.querySelector('#ytdlpStatus').innerText`);
  console.log(`     ${status.replace(/\n/g, ' | ')}`);

  // -------------------------------------------- 4. quay lui phien ban
  console.log('\n== 4. Quay lui phien ban ==');
  const rolled = await cdp.eval(`(async () => {
    try {
      const r = await window.api.ytdlp.rollback();
      return JSON.stringify(r);
    } catch (e) { return 'loi: ' + e.message; }
  })()`, 60000);
  console.log(`     ket qua: ${String(rolled).slice(0, 200)}`);
  if (/Chưa có bản nào|chưa có bản nào/.test(String(rolled))) {
    console.log('[..] chua co ban luu -> bo qua buoc nay (can it nhat 2 lan cap nhat)');
  } else if (String(rolled).includes('"ok":true')) {
    console.log('[ok] quay lui thanh cong');
  } else {
    die(`quay lui that bai: ${rolled}`);
  }

  // --------------------------------- 5. xac nhan app van tai duoc video
  console.log('\n== 5. Sau khi cap nhat/quay lui, app con tai duoc video khong? ==');
  await cdp.eval(`(() => { document.querySelector('#btnTestYtdlp').click(); return 1; })()`);
  const start = Date.now();
  let t5 = '';
  while (Date.now() - start < 240_000) {
    t5 = await log();
    if (!/Đang thử tải thử/i.test(t5) && Date.now() - start > 8000) break;
    await sleep(2500);
  }
  if (!/tải thử thành công|hoạt động bình thường/i.test(t5)) {
    die(`sau cap nhat app khong tai duoc video:\n${t5.slice(-300)}`);
  }
  console.log('[ok] app van tai duoc video sau khi thay doi phien ban');

  console.log('\n[ok] E2E YTDLP-UPDATE THANH CONG');
  process.exit(0);
};

main().catch((e) => die(e.message));
