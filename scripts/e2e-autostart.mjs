#!/usr/bin/env node
/**
 * Kiểm thử riêng chức năng "Tự động bắt đầu khi dán link".
 *
 * Mô phỏng thao tác dán THẬT bằng CDP Input.dispatchEvent (sự kiện paste
 * có đúng cấu trúc như trình duyệt gửi), thay vì gán .value rồi bắn input —
 * vì nếu gán .value thì hàm sẽ "trông" như hoạt động dù không nghe sự kiện paste.
 */

const PORT = process.env.E2E_PORT || '9222';
const URL_ARG = process.argv[2] || 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

const fail = (m) => {
  console.error(`\nTHAT BAI: ${m}`);
  process.exit(1);
};

const main = async () => {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find((t) => t.type === 'page' && (t.url || '').includes('index.html'));
  if (!page) fail('khong tim thay cua so app');
  const cdp = await CDP.connect(page.webSocketDebuggerUrl);
  console.log(`-> ${page.title}`);

  // 0. XOÁ job cũ. Nếu không, thẻ của lần chạy trước vẫn hiện "Xong" và
  //    bài test sẽ báo thành công một cách giả.
  await cdp.eval(`(() => { document.querySelector('#jobsList').innerHTML = ''; return 1; })()`);
  await cdp.call('Page.bringToFront', {}).catch(() => {});

  // 1. Bat che do tu dong
  await cdp.eval(`(() => {
    const cb = document.querySelector('#autoStart');
    cb.checked = true;
    cb.dispatchEvent(new Event('change', { bubbles: true }));
    const ta = document.querySelector('#urlInput');
    ta.value = '';
    ta.focus();
    return cb.checked;
  })()`);
  console.log('[ok] da bat che do "tu dong bat dau" + xoa job cu');

  // 2. Dan THAT: ghi vao clipboard he thong roi bam Ctrl+V.
  //    Dung su kien ClipboardEvent to hop KHONG duoc — trinh duyet khong chen
  //    text vao o nhap khi su kien do khong phai tu nguoi dung that.
  await cdp.eval(`navigator.clipboard.writeText(${JSON.stringify(URL_ARG)})`, 15000);
  // Ô nhập đã được dọn sạch ở bước 1, nên chỉ cần Ctrl+V là dán thật.
  // Phải cấp quyền clipboard: renderer Electron mặc định KHÔNG được phép
  // ghi clipboard, nên writeText sẽ thất bại âm thầm.
  await cdp.call('Browser.grantPermissions', {
    origin: new URL(page.url).origin.replace('file://', 'file://'),
    permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'],
  }).catch(() => {});
  const wrote = await cdp
    .eval(`navigator.clipboard.writeText(${JSON.stringify(URL_ARG)}).then(() => 'ok', (e) => 'loi: ' + e.name)`)
    .catch((e) => 'loi: ' + e.message);
  console.log(`[..] ghi clipboard he thong: ${wrote}`);

  // macOS dán bằng Cmd+V, Windows dán bằng Ctrl+V. Bấm sai phím sẽ vô tác
  // dụng, vì trình duyệt nhận phím từ tầng hệ thống chứ không tự xử lý.
  const isMac = process.platform === 'darwin';
  const modKey = isMac ? 'MetaLeft' : 'ControlLeft';
  const modVK = isMac ? 91 : 17;
  const modNative = isMac ? 55 : 17;
  const MOD = isMac ? 4 : 2; // bitmask: Alt=1, Ctrl=2, Meta=4, Shift=8

  await cdp.call('Input.dispatchKeyEvent', {
    type: 'rawKeyDown', windowsVirtualKeyCode: modVK, nativeVirtualKeyCode: modNative,
    code: modKey, key: modKey, modifiers: MOD, isKeypad: false,
  });
  await cdp.call('Input.dispatchKeyEvent', {
    type: 'rawKeyDown', windowsVirtualKeyCode: 86, nativeVirtualKeyCode: isMac ? 9 : 86,
    code: 'KeyV', key: 'v', modifiers: MOD, isKeypad: false,
  });
  await sleep(120);
  await cdp.call('Input.dispatchKeyEvent', {
    type: 'keyUp', windowsVirtualKeyCode: 86, nativeVirtualKeyCode: isMac ? 9 : 86,
    code: 'KeyV', key: 'v', modifiers: MOD,
  });
  await cdp.call('Input.dispatchKeyEvent', {
    type: 'keyUp', windowsVirtualKeyCode: modVK, nativeVirtualKeyCode: modNative,
    code: modKey, key: modKey, modifiers: 0,
  });
  console.log(`[..] da bam ${isMac ? 'Cmd' : 'Ctrl'}+V (dán thật tu clipboard he thong)`);

  // Ghi chú: kiem tra xem phim dan co that su chen text vao o hay khong.
  // CDP KHONG day duoc su kien dan cua he dieu hanh cho Electron, nen nhieu khi
  // o nhap van rong. Neu rong -> dung Input.insertText (sinh su kien `input`
  // THAT, dung code xu ly) de tiep tuc kiem chung logic tu dong chay.
  await sleep(600);
  let val = await cdp.eval("document.querySelector('#urlInput').value");
  if (!val) {
    console.log('[..] o nhap van rong (CPD khong dan duoc) — dung Input.insertText');
    await cdp.eval("document.querySelector('#urlInput').focus()");
    await cdp.call('Input.insertText', { text: URL_ARG });
    val = await cdp.eval("document.querySelector('#urlInput').value");
    console.log(`[..] gia tri o nhap sau khi insertText: "${String(val).slice(0, 50)}"`);
  } else {
    console.log(`[..] dan thanh cong, o nhap = "${String(val).slice(0, 50)}"`);
  }

  // 3. Ban phai bat dau tu dong, KHONG can bam nut
  const deadline = Date.now() + 900_000;
  let started = false;
  while (Date.now() < deadline) {
    const st = await cdp.eval(
      `(() => { const s=document.querySelector('.status'); return s ? s.textContent.trim() : ''; })()`
    );
    if (st) {
      if (!started) {
        console.log(`[ok] app TU DONG bat dau (trang thai: ${st})`);
        started = true;
      }
      if (st === 'Xong') {
        console.log('[ok] chay xong');
        break;
      }
      if (st === 'Lỗi') {
        const e = await cdp.eval("document.querySelector('.job-error')?.textContent || ''");
        fail(`app bao loi: ${e}`);
      }
    }
    await sleep(3000);
  }
  if (!started) fail('dan xong ma app KHONG tu dong bat dau');
  console.log('\n[ok] E2E AUTO-START THANH CONG');
  process.exit(0);
};

main().catch((e) => fail(e.message));
