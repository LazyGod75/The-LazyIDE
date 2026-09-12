// record-demo.mjs — record the README demo GIF by piloting the running app
// over CDP (127.0.0.1:9243), capturing PNG frames at each scripted beat, then
// encoding an animated GIF with gifenc (pure JS — no ffmpeg needed).
//
// Usage:
//   1. Build + launch the app with remote debugging:
//        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9243
//   2. npm run demo:record            # writes public/readme/demo.gif
//
// Requires: the dev build running (src-tauri/target/debug/lazy-ide.exe),
// gifenc + pngjs (devDependencies).

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { GIFEncoder, quantize, applyPalette } = require('gifenc');
const { PNG } = require('pngjs');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CDP_HOST = '127.0.0.1';
const CDP_PORT = 9243;
const FRAMES_DIR = path.join(__dirname, '_demo-frames');
const OUT = process.argv[2] || path.join(__dirname, 'public', 'readme', 'demo.gif');
const FRAME_DELAY_MS = 250;
const CAPTURE_SCALE = 0.55; // downscale via CDP clip.scale — keeps the GIF small

// --- Minimal CDP plumbing (same approach as _qa-manager.mjs) -----------------

function httpGetJson(p) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: CDP_HOST, port: CDP_PORT, path: p, headers: { Host: `${CDP_HOST}:${CDP_PORT}` } }, (res) => {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () => (res.statusCode === 200 ? resolve(JSON.parse(b)) : reject(new Error(`HTTP ${res.statusCode}`))));
      })
      .on('error', reject);
  });
}

class RawWebSocket {
  constructor(url) {
    this.url = url;
    this._onMessage = null;
    this._closed = false;
  }
  connect() {
    return new Promise((resolve, reject) => {
      const u = new URL(this.url);
      const key = crypto.randomBytes(16).toString('base64');
      const socket = net.connect(u.port || 80, u.hostname, () => {
        socket.write(
          `GET ${u.pathname} HTTP/1.1\r\nHost: ${u.hostname}:${u.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
        );
      });
      this._socket = socket;
      let buf = Buffer.alloc(0);
      let upgraded = false;
      socket.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        if (!upgraded) {
          const i = buf.indexOf('\r\n\r\n');
          if (i === -1) return;
          buf = buf.slice(i + 4);
          upgraded = true;
          resolve();
        }
        while (buf.length >= 2) {
          const f = this._frame(buf);
          if (!f) break;
          buf = buf.slice(f.consumed);
          if (f.msg !== null) this._onMessage?.(f.msg);
        }
      });
      socket.on('error', (e) => (!upgraded ? reject(e) : (this._closed = true)));
      socket.on('close', () => (this._closed = true));
    });
  }
  _frame(buf) {
    const b0 = buf[0];
    const b1 = buf[1];
    const op = b0 & 0x0f;
    const masked = (b1 & 0x80) === 0x80;
    let len = b1 & 0x7f;
    let off = 2;
    if (len === 126) {
      if (buf.length < 4) return null;
      len = buf.readUInt16BE(2);
      off = 4;
    } else if (len === 127) {
      if (buf.length < 10) return null;
      len = Number(buf.readBigUInt64BE(2));
      off = 10;
    }
    if (masked) {
      if (buf.length < off + 4) return null;
      var mask = buf.slice(off, off + 4);
      off += 4;
    }
    if (buf.length < off + len) return null;
    let payload = buf.slice(off, off + len);
    if (masked) payload = Buffer.from(payload.map((b, i) => b ^ mask[i % 4]));
    if (op === 0x8) return { consumed: off + len, msg: null };
    if (op === 0x9) {
      this._send(0xa, payload);
      return { consumed: off + len, msg: null };
    }
    if (op === 0xa) return { consumed: off + len, msg: null };
    return { consumed: off + len, msg: payload.toString('utf8') };
  }
  _send(op, payload) {
    const mask = crypto.randomBytes(4);
    const masked = Buffer.from(payload.map((b, i) => b ^ mask[i % 4]));
    const len = payload.length;
    let h;
    if (len < 126) {
      h = Buffer.alloc(6);
      h[1] = 0x80 | len;
      mask.copy(h, 2);
    } else if (len < 65536) {
      h = Buffer.alloc(8);
      h[1] = 0x80 | 126;
      h.writeUInt16BE(len, 2);
      mask.copy(h, 4);
    } else {
      h = Buffer.alloc(14);
      h[1] = 0x80 | 127;
      h.writeBigUInt64BE(BigInt(len), 6);
      mask.copy(h, 10);
    }
    h[0] = 0x80 | op;
    this._socket.write(Buffer.concat([h, masked]));
  }
  send(d) {
    this._send(0x1, Buffer.from(d, 'utf8'));
  }
  close() {
    try {
      this._send(0x8, Buffer.alloc(0));
    } catch {}
    try {
      this._socket.end();
    } catch {}
  }
}

class Cdp {
  constructor() {
    this._id = 0;
    this._pending = new Map();
  }
  async connect() {
    const targets = await httpGetJson('/json');
    const page = targets.find((t) => t.type === 'page') || targets[0];
    if (!page?.webSocketDebuggerUrl) throw new Error('no page target — is the app running with remote debugging?');
    this._ws = new RawWebSocket(page.webSocketDebuggerUrl);
    await this._ws.connect();
    this._ws._onMessage = (m) => {
      const msg = JSON.parse(m);
      if (msg.id && this._pending.has(msg.id)) {
        const { resolve, reject } = this._pending.get(msg.id);
        this._pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      }
    };
    await this.send('Page.enable');
    await this.send('Runtime.enable');
  }
  send(method, params = {}) {
    const id = ++this._id;
    this._ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this._pending.set(id, { resolve, reject }));
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval failed');
    return r.result?.value;
  }
  async shot(file) {
    const r = await this.send('Page.captureScreenshot', {
      format: 'png',
      clip: { x: 0, y: 0, width: 1568, height: 919, scale: CAPTURE_SCALE },
    });
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
  }
  close() {
    this._ws?.close();
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Scripted demo sequence ---------------------------------------------------

const cdp = new Cdp();
await cdp.connect();
fs.mkdirSync(FRAMES_DIR, { recursive: true });
for (const f of fs.readdirSync(FRAMES_DIR)) fs.unlinkSync(path.join(FRAMES_DIR, f));

let n = 0;
const frame = async (label) => {
  const f = path.join(FRAMES_DIR, `f${String(n++).padStart(3, '0')}.png`);
  await cdp.shot(f);
  console.log(`frame ${n}: ${label}`);
};

const clickByText = (text) =>
  cdp.eval(`(function(){const t=${JSON.stringify(text)};const w=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);while(w.nextNode()){const nd=w.currentNode;if(nd.nodeValue&&nd.nodeValue.includes(t)){let el=nd.parentElement;while(el&&el!==document.body){if(el.click){el.scrollIntoView({block:'center'});el.click();return true}el=el.parentElement}}}return false})()`);
const clickSel = (sel) =>
  cdp.eval(`(function(){const el=document.querySelector(${JSON.stringify(sel)});if(!el)return false;el.scrollIntoView({block:'center'});el.click();return true})()`);
const setInput = (text) =>
  cdp.eval(`(function(){const el=document.querySelector("[data-testid='manager-input']");if(!el)return false;el.focus();const s=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set;s.call(el,${JSON.stringify(text)});el.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);

try {
  // 1. Cockpit idle — let the fleet speak for itself
  await frame('cockpit idle');
  await sleep(300);
  await frame('cockpit idle 2');
  await sleep(300);

  // 2. Fresh conversation, then progressive typing into the manager input
  await clickByText('New');
  await sleep(400);
  const MSG = 'Create an agent that reviews my PRs every morning at 9am';
  for (let i = 0; i <= MSG.length; i += 6) {
    await setInput(MSG.slice(0, i));
    await frame(`typing ${i}`);
    await sleep(80);
  }
  await frame('message complete');
  await sleep(400);

  // 3. Send — watch the canvas react (mission node spawns)
  await cdp.eval(`(function(){const el=document.querySelector("[data-testid='manager-input']");el.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',bubbles:true}));return true})()`);
  for (let i = 0; i < 6; i++) {
    await sleep(500);
    await frame(`post-send ${i}`);
  }

  // 4. Brain tab — 3D graph reveal. 'This project' defaults to an empty
  // state; 'All brains' shows the real 3D constellation.
  await clickByText('Brain');
  await sleep(600);
  await clickByText('All brains');
  for (let i = 0; i < 6; i++) {
    await sleep(500);
    await frame(`brain ${i}`);
  }

  // 5. Code tab
  await clickByText('Code');
  for (let i = 0; i < 3; i++) {
    await sleep(400);
    await frame(`code ${i}`);
  }

  // 6. Back to Cockpit — closing beat
  await clickByText('Cockpit');
  for (let i = 0; i < 3; i++) {
    await sleep(400);
    await frame(`cockpit return ${i}`);
  }
} finally {
  cdp.close();
}

// --- Encode GIF ----------------------------------------------------------------

const files = fs.readdirSync(FRAMES_DIR).filter((f) => f.endsWith('.png')).sort();
if (files.length === 0) throw new Error('no frames captured');
console.log(`encoding ${files.length} frames -> ${OUT}`);

const gif = GIFEncoder();
let palette = null;
for (const f of files) {
  const png = PNG.sync.read(fs.readFileSync(path.join(FRAMES_DIR, f)));
  const { data, width, height } = png;
  if (!palette) palette = quantize(data, 128);
  const index = applyPalette(data, palette);
  gif.writeFrame(index, width, height, { palette, delay: FRAME_DELAY_MS });
}
gif.finish();
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, gif.bytes());
const kb = Math.round(fs.statSync(OUT).size / 1024);
console.log(`demo.gif written: ${kb} KB, ${files.length} frames @ ${FRAME_DELAY_MS}ms`);
