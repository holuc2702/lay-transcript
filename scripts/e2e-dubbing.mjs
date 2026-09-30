#!/usr/bin/env node
/** Test lồng tiếng trực tiếp qua IPC: dịch + tạo voice + ghép, trên bất kỳ nền tảng nào. */
import fs from 'node:fs';
const PORT = process.env.E2E_PORT || '9222';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const die = (m) => { console.error('THAT BAI: ' + m); process.exit(1); };
class CDP {
  constructor(ws){this.ws=ws;this.id=0;this.pending=new Map();
    ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.id&&this.pending.has(m.id)){this.pending.get(m.id)(m);this.pending.delete(m.id);}});}
  static async connect(u){const ws=new WebSocket(u);await new Promise((r,j)=>{ws.addEventListener('open',r,{once:true});ws.addEventListener('error',j,{once:true});});return new CDP(ws);}
  call(method,params={},t=900000){const id=++this.id;
    const p=new Promise((res,rej)=>{this.pending.set(id,m=>(m.error?rej(new Error(m.error.message)):res(m.result)));
      setTimeout(()=>rej(new Error('timeout '+method)),t);});
    this.ws.send(JSON.stringify({id,method,params}));return p;}
  async eval(x,t=900000){const r=await this.call('Runtime.evaluate',{expression:x,awaitPromise:true,returnByValue:true},t);
    if(r.exceptionDetails) throw new Error('Loi JS: '+JSON.stringify(r.exceptionDetails).slice(0,300));
    return r.result?.value;}
}
const main = async () => {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find((t) => t.type === 'page' && (t.url || '').includes('index.html'));
  if (!page) die('khong thay app');
  const cdp = await CDP.connect(page.webSocketDebuggerUrl);
  console.log('-> ' + page.title);

  console.log('0) tab "Long tieng" co THAT su hien ra khong...');
  await cdp.eval(`document.querySelector('.tab[data-tab="dubbing"]').click()`);
  await sleep(700);
  const ui = JSON.parse(
    await cdp.eval(`(() => {
      const p = document.querySelector('.panel[data-panel="dubbing"]');
      const box = document.querySelector('#dubMac');
      const cards = p ? p.querySelectorAll('.card').length : 0;
      const h = p ? p.getBoundingClientRect().height : 0;
      return JSON.stringify({
        panelActive: !!(p && p.classList.contains('active')),
        boxHidden: !!(box && box.hidden),
        cards,
        height: Math.round(h),
        ttsLoginBtn: !!document.querySelector('#btnTtsLogin'),
      });
    })()`)
  );
  console.log('   ' + JSON.stringify(ui));
  if (!ui.panelActive) die('panel lồng tiếng không được bật');
  if (ui.boxHidden) die('#dubMac đang bị ẩn — tab Lồng tiếng trống trơn');
  if (ui.cards < 1) die('không có card nào hiện trong tab Lồng tiếng');
  if (ui.height < 100) die(`tab Lồng tiếng quá thấp (${ui.height}px) — co thể đang trống`);
  if (!ui.ttsLoginBtn) die('không thấy nút Đăng nhập 3A (Bước 1)');

  console.log('1) dang nhap 3A + dich Ollama...');
  console.log('   login:', await cdp.eval(`window.api.tts.login('3ATOOLOB@&#^21', false).then(r=>JSON.stringify(r)).catch(e=>'LOI '+e.message)`));
  console.log('   dich:', await cdp.eval(`window.api.providers.save({id:'ollama-cloud',keys:'eecdda1096f449e7877e1132b140f3fd.N2wndLBvGUHJtYG0cQa56cBr'}).then(()=>window.api.dubbing.translateAll([{text:'The library is closed today.'}],['ollama-cloud'])).then(r=>JSON.stringify(r).slice(0,160)).catch(e=>'LOI '+e.message)`));

  console.log('2) tao voice + ghep (2 cau)...');
  const r = await cdp.eval(`window.api.dubbing.run({
    segments:[{start:0,end:4,text:'Cau mot.'},{start:30,end:34,text:'Cau hai.'}],
    voice:'LÊ MINH', translate:false, outName:'WIN-DUB-TEST', voiceDirName:'Win test'
  }).then(r=>JSON.stringify({wav:r.wav,mp3:r.mp3,srt:r.srt,dir:r.dir,sum:r.summary})).catch(e=>'LOI '+e.message)`);
  console.log('   ' + r);
  if (String(r).startsWith('LOI')) die(r);

  console.log('3) kiem tra SRT co chu that...');
  const paths = JSON.parse(r);
  const srtTxt = fs.readFileSync(paths.srt, 'utf8');
  const bodies = srtTxt
    .split('\n\n')
    .map((b) => b.split('\n')[2] || '')
    .filter(Boolean);
  console.log('   srt: ' + JSON.stringify(bodies));
  if (bodies.length < 2) die('SRT khong co du so cau');
  if (bodies.some((b) => !b.trim())) die('SRT co cau rong chu');
  if (!/Cau/.test(bodies[0])) die('SRT sai chu: ' + bodies[0]);

  console.log('4) kiem tra merge khong canh chong...');
  const st = fs.statSync(paths.wav);
  console.log(`   wav: ${(st.size / 1024 / 1024).toFixed(2)} MB, mp3: ${fs.existsSync(paths.mp3)}`);
  if (st.size < 1024) die('file wav rong');

  console.log('\n[ok] LONG TIENG TREN WINDOWS THANH CONG');
  process.exit(0);
};
main().catch((e) => die(e.message));
