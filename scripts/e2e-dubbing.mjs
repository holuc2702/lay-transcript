#!/usr/bin/env node
/** Test lồng tiếng trực tiếp qua IPC: dịch + tạo voice + ghép, trên bất kỳ nền tảng nào. */
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

  console.log('1) dang nhap 3A + dich Ollama...');
  console.log('   login:', await cdp.eval(`window.api.tts.login('3ATOOLOB@&#^21', false).then(r=>JSON.stringify(r)).catch(e=>'LOI '+e.message)`));
  console.log('   dich:', await cdp.eval(`window.api.providers.save({id:'ollama-cloud',keys:'eecdda1096f449e7877e1132b140f3fd.N2wndLBvGUHJtYG0cQa56cBr'}).then(()=>window.api.dubbing.translateAll([{text:'The library is closed today.'}],['ollama-cloud'])).then(r=>JSON.stringify(r).slice(0,160)).catch(e=>'LOI '+e.message)`));

  console.log('2) tao voice + ghep (2 cau)...');
  const r = await cdp.eval(`window.api.dubbing.run({
    segments:[{start:0,end:4,text:'Cau mot.'},{start:30,end:34,text:'Cau hai.'}],
    voice:'LÊ MINH', translate:false, outName:'WIN-DUB-TEST', voiceDirName:'Win test'
  }).then(r=>JSON.stringify({wav:!!r.wav,mp3:!!r.mp3,srt:!!r.srt,dir:r.dir,sum:r.summary})).catch(e=>'LOI '+e.message)`);
  console.log('   ' + r);
  if (String(r).startsWith('LOI')) die(r);
  console.log('\n[ok] LONG TIENG TREN WINDOWS THANH CONG');
  process.exit(0);
};
main().catch((e) => die(e.message));
