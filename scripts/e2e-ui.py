#!/usr/bin/env python3
"""
Kiểm thử end-to-end qua UI thật, điều khiển Electron bằng Chrome DevTools Protocol.

Đây là bài test sát thực tế nhất: bấm nút thật, đọc DOM thật, chờ tiến trình
thật. Không mock gì cả.

Cách dùng:
    npx electron . --remote-debugging-port=9222 &
    python3 scripts/e2e-ui.py <url-youtube>
"""

import json
import os
import re
import subprocess
import sys
import time
import urllib.request

HOST = 'localhost'
PORT = int(os.environ.get("E2E_PORT", "9222"))


def _url(path):
    return f"http://{HOST}:{PORT}{path}"


def targets():
    with urllib.request.urlopen(_url("/json/list"), timeout=10) as r:
        return json.load(r)


def find_app_page():
    for t in targets():
        if t.get("type") == "page" and "index.html" in t.get("url", ""):
            return t
    raise SystemExit("Không tìm thấy cửa sổ app. App có chạy không?")


def ws_url(t):
    return t["webSocketDebuggerUrl"]


class CDP:
    """Client tối giản cho Chrome DevTools Protocol qua websocket."""

    def __init__(self, url):
        import json as _json
        # Dùng node vì python không cài sẵn websocket client
        self.proc = subprocess.Popen(
            [
                "node",
                "-e",
                f"""
const WebSocket = require('{require_websocket_path()}');
const ws = new WebSocket({json.dumps(url)});
let id = 0;
const pending = new Map();
ws.on('open', () => process.stdout.write('READY\\n'));
ws.on('message', (d) => {{
  const m = JSON.parse(d.toString());
  if (m.id && pending.has(m.id)) {{ pending.get(m.id)(m); pending.delete(m.id); }}
}});
ws.on('error', (e) => {{ process.stderr.write(String(e.message||e)+'\\n'); process.exit(1); }});
let buf = '';
process.stdin.on('data', (d) => {{
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {{
    const line = buf.slice(0, i); buf = buf.slice(i+1);
    if (!line.trim()) continue;
    try {{
      const cmd = JSON.parse(line);
      if (cmd.eval) {{
        const out = JSON.stringify({{id: ++id, result: null}});
        pending.set(id, (m) => process.stdout.write(JSON.stringify(m.result) + '\\n'));
        ws.send(JSON.stringify({{id, method:'Runtime.evaluate', params:{{
          expression: cmd.eval, awaitPromise: true, returnByValue: true
        }}}}));
      }}
    }} catch (e) {{ process.stdout.write(JSON.stringify({{error: String(e)}}) + '\\n'); }}
  }}
}});
""",
            ],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        )
        while True:
            line = self.proc.stdout.readline()
            if line.strip() == "READY":
                break
            if not line:
                raise SystemExit("CDP client không khởi động: " + self.proc.stderr.read())

    def eval(self, expr, timeout=30):
        """Chạy biểu thức trong renderer và trả về giá trị thô.

        Runtime.evaluate trả về {result:{result:{type,value}}, exceptionDetails}.
        Phải bóc 2 lớp, và phải kiểm tra exceptionDetails — nếu không, lỗi trong
        trang sẽ bị nuốt mất và test báo "sai" một cách rất khó hiểu.
        """
        self.proc.stdin.write(json.dumps({"eval": expr}) + "\n")
        self.proc.stdin.flush()
        start = time.time()
        while time.time() - start < timeout:
            line = self.proc.stdout.readline()
            if not line:
                raise SystemExit("CDP mất kết nối: " + self.proc.stderr.read())
            try:
                m = json.loads(line)
            except json.JSONDecodeError:
                continue
            if "error" in m:
                raise RuntimeError(m["error"])
            payload = m.get("result") or {}
            if "exceptionDetails" in payload:
                ex = payload["exceptionDetails"]
                desc = ex.get("exception", {}).get("description") or ex.get("text")
                raise RuntimeError(f"Lỗi JS trong renderer: {desc}")
            return payload.get("value")
        raise TimeoutError(f"CDP timeout sau {timeout}s: {expr[:80]}")

    def close(self):
        self.proc.kill()


def require_websocket_path():
    """Tìm thư viện websocket đã cài sẵn trong node_modules."""
    for p in (
        "ws",
        "electron/node_modules/ws",
    ):
        try:
            subprocess.run(
                ["node", "-e", f"require.resolve('{p}')"],
                check=True,
                capture_output=True,
            )
            return p
        except subprocess.CalledProcessError:
            continue
    raise SystemExit("Không tìm thấy thư viện websocket. Chạy: npm i -D ws")


def main():
    url = sys.argv[1] if len(sys.argv) > 1 else "https://www.youtube.com/watch?v=BaW_jenozKc"
    app = find_app_page()
    print(f"-> Đang điều khiển: {app['title']}  ({HOST}:{PORT})")

    cdp = CDP(ws_url(app))
    try:
        # 1. API preload phải tồn tại (nếu không, mọi nút sẽ chết âm thầm)
        has_api = cdp.eval("typeof window.api")
        if os.environ.get("E2E_DEBUG"):
            print(f"[debug] typeof window.api = {has_api!r}")
        if has_api != "object":
            raise SystemExit(
                f"window.api chưa sẵn sàng (nhận {has_api!r}) — preload lỗi?"
            )
        print("[ok] preload đã nối")

        # 2. Dán link và bấm nút, đúng như người dùng làm
        cdp.eval(
            "(() => {"
            f"  const t = document.querySelector('#urlInput');"
            f"  t.value = {json.dumps(url)};"
            "  document.querySelector('#btnStart').click();"
            "  return 'clicked';"
            "})()"
        )
        print(f"[..] đã bấm Bắt đầu với {url}")

        # 3. Theo dõi tới khi xong
        last = ""
        deadline = time.time() + 1800
        final = None
        while time.time() < deadline:
            state = cdp.eval(
                "(() => { const s=document.querySelector('.status');"
                " const e=document.querySelector('.job-error');"
                " const m=document.querySelector('.job-message');"
                " const p=document.querySelector('.job-meta');"
                " return JSON.stringify({state: s&&s.textContent.trim(),"
                " err: e&&e.textContent.trim().slice(0,300),"
                " msg: m&&m.textContent.trim().slice(0,120),"
                " meta: p&&p.textContent.trim().slice(0,120)}); })()"
            )
            info = json.loads(state) if state else {}
            line = f"     {info.get('state','?')} | {info.get('msg','')}"
            if line != last:
                print(line)
                last = line
            if info.get("err"):
                print(f"\n[LỖI] {info['err']}")
                final = info
                break
            if info.get("state") == "Xong":
                final = info
                break
            time.sleep(4)

        if not final:
            raise SystemExit("Hết thời gian chờ, app vẫn chưa xong")

        if final.get("state") != "Xong":
            print(f"\nKẾT QUẢ: thất bại -> {final.get('err')}")
            sys.exit(1)

        print(f"\n[ok] Hoàn tất. {final.get('meta')}")

        # 4. Mở transcript và đọc thử
        segs = cdp.eval(
            "(() => { const b=document.querySelector('[data-act=transcript]');"
            " if(b) b.click(); return 'clicked'; })()"
        )
        time.sleep(3)
        n = cdp.eval("document.querySelectorAll('.seg').length")
        print(f"[ok] Số đoạn hiển thị: {n}")
        if not n:
            raise SystemExit("Không có đoạn nào hiển thị trong UI")
        first = cdp.eval("document.querySelector('.seg-text').textContent")
        print(f"[ok] Đoạn đầu tiên: {first[:120]}")
    finally:
        cdp.close()


if __name__ == "__main__":
    main()
