import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const XTERM_JS_SHA256 = 'dcad74eddc249c9be1ff62ba66b58584418ce1a10727d1879461adc1311c9780';
const XTERM_CSS_SHA256 = 'a396d0aa1f91733337c046445e1a610e93a5ca6b2ce37353dca07bcf48091691';
const assetRoot = path.resolve(new URL('../../assets/observer', import.meta.url).pathname);
let cachedFrame = null;

function readPinnedAsset(name, expectedSha256) {
  const value = fs.readFileSync(path.join(assetRoot, name));
  const actual = crypto.createHash('sha256').update(value).digest('hex');
  if (actual !== expectedSha256) throw new Error(`Observer renderer asset digest mismatch: ${name}`);
  return value.toString('utf8');
}

export function observerFrameDocument() {
  if (cachedFrame) return cachedFrame;
  const xtermJs = readPinnedAsset('xterm.js', XTERM_JS_SHA256).replaceAll('</script', '<\\/script');
  const xtermCss = readPinnedAsset('xterm.css', XTERM_CSS_SHA256);
  cachedFrame = `<!doctype html>
<html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; connect-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'nonce-observer-frame'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'">
<style>html,body,#terminal{box-sizing:border-box;width:100%;height:100%;margin:0;background:#0a0f14;overflow:hidden}${xtermCss}</style>
</head><body><div id="terminal"></div>
<script nonce="observer-frame">${xtermJs}</script>
<script nonce="observer-frame">
const presets={standard:[80,21],wide:[110,30],large:[140,40]};
const terminal=new Terminal({cols:80,rows:21,disableStdin:true,cursorBlink:false,convertEol:false,theme:{background:'#0a0f14'}});
terminal.open(document.getElementById('terminal'));
let channel=null;
function initialize(event){
  if(event.source!==parent||event.data?.type!=='observer-init'||event.ports.length!==1||channel)return;
  channel=event.ports[0];
  removeEventListener('message',initialize);
  channel.onmessage=({data})=>{
    if(!data||typeof data!=='object')return;
    if(data.type==='render'&&data.bytes instanceof ArrayBuffer&&data.bytes.byteLength<=262144)terminal.write(new Uint8Array(data.bytes));
    else if(data.type==='preset'&&presets[data.preset])terminal.resize(...presets[data.preset]);
    else if(data.type==='shutdown'){terminal.dispose();channel.close();channel=null;}
  };
  channel.start();
  channel.postMessage({type:'ready'});
}
addEventListener('message',initialize);
</script></body></html>`;
  return cachedFrame;
}

export const OBSERVER_FRAME_ASSETS = Object.freeze({
  xtermJsSha256: XTERM_JS_SHA256,
  xtermCssSha256: XTERM_CSS_SHA256,
});
