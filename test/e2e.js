'use strict';
/**
 * Наскрізний тест ядра без Electron:
 *   upstream (HTTP+WS) ← інспектор ← relay-клієнт ⇄ relay-сервер ← «телефон»
 * Запуск: npm test
 */
const assert = require('assert');
const http = require('http');
const zlib = require('zlib');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const { Store } = require('../src/core/store');
const { TunnelManager } = require('../src/core/tunnel-manager');

const TOKEN = 'test-secret-token';
const BASE = 't.test';
let passed = 0;
const ok = (name) => { passed++; console.log(`  ✓ ${name}`); };

function listen(server) {
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
}

function request({ port, host, method = 'GET', path: p = '/', headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: { host, ...headers }, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, rawHeaders: res.rawHeaders, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

function waitFor(fn, timeout = 8000, label = 'condition') {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      let v;
      try { v = fn(); } catch { v = null; }
      if (v) return resolve(v);
      if (Date.now() - t0 > timeout) return reject(new Error('timeout: ' + label));
      setTimeout(tick, 50);
    };
    tick();
  });
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'devbridge-test-'));

  /* ---------- upstream: «ваш NestJS / Metro» ---------- */
  const big = Buffer.alloc(5 * 1024 * 1024, 7);
  const upstream = http.createServer((req, res) => {
    if (req.url === '/hello') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, host: req.headers.host, xfp: req.headers['x-forwarded-proto'] || null }));
    }
    if (req.url === '/echo' && req.method === 'POST') {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      return req.on('end', () => { res.writeHead(201, { 'content-type': req.headers['content-type'] || 'application/octet-stream' }); res.end(Buffer.concat(chunks)); });
    }
    if (req.url === '/gzip') {
      res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
      return res.end(zlib.gzipSync(JSON.stringify({ compressed: true, items: [1, 2, 3] })));
    }
    if (req.url === '/cookies') {
      res.setHeader('set-cookie', ['a=1; Path=/', 'b=2; Path=/']);
      return res.end('cookies');
    }
    if (req.url === '/sse') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      let n = 0;
      const t = setInterval(() => { res.write(`data: ${++n}\n\n`); if (n === 3) { clearInterval(t); res.end(); } }, 120);
      return;
    }
    if (req.url === '/big') { res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': big.length }); return res.end(big); }
    res.writeHead(404); res.end('nope');
  });
  const wss = new WebSocket.Server({ server: upstream, path: '/ws' });
  wss.on('connection', (ws) => { ws.send('hi'); ws.on('message', (m, isBin) => ws.send(isBin ? m : 'echo:' + m)); });
  const upPort = await listen(upstream);

  /* ---------- relay-сервер (окремий процес, як на VPS) ---------- */
  const relayPort = 17000 + Math.floor(Math.random() * 2000);
  const relay = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'relay-server.js')], {
    env: { ...process.env, BASE_DOMAIN: BASE, TOKEN, PORT: String(relayPort), HOST: '127.0.0.1', PUBLIC_SCHEME: 'https', DATA_DIR: path.join(tmp, 'relay-data') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let relayOut = '';
  relay.stdout.on('data', (d) => { relayOut += d; });
  relay.stderr.on('data', (d) => { relayOut += d; });
  await waitFor(() => relayOut.includes('слухає'), 5000, 'relay start');

  /* ---------- менеджер (як у застосунку) ---------- */
  const binDir = path.join(tmp, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const store = new Store(path.join(tmp, 'config.json'));
  store.setRelay({ url: `http://127.0.0.1:${relayPort}`, token: TOKEN });
  const mgr = new TunnelManager({ store, binDir });
  const seen = [];
  mgr.on('requests', (id, items) => seen.push(...items));

  console.log('Власний relay-сервер');
  const t = await mgr.create({ name: 'API', target: String(upPort), provider: 'relay', subdomain: 'myapp' });
  await mgr.start(t.id);
  const st = await waitFor(() => { const s = mgr.state(t.id); return s.status === 'online' && s; }, 8000, 'relay online');
  assert.strictEqual(st.url, 'https://myapp.t.test');
  ok('тунель онлайн, URL https://myapp.t.test');

  const host = 'myapp.t.test';
  let r = await request({ port: relayPort, host, path: '/hello' });
  assert.strictEqual(r.status, 200);
  const j = JSON.parse(r.body);
  assert.strictEqual(j.host, host);
  assert.strictEqual(j.xfp, 'https');
  ok('GET /hello — Host і X-Forwarded-Proto доходять до сервера');

  const payload = JSON.stringify({ hello: 'світ', n: 42 });
  r = await request({ port: relayPort, host, method: 'POST', path: '/echo', headers: { 'content-type': 'application/json' }, body: payload });
  assert.strictEqual(r.status, 201);
  assert.strictEqual(r.body.toString(), payload);
  ok('POST /echo — тіло запиту і статус 201');

  r = await request({ port: relayPort, host, path: '/gzip' });
  assert.strictEqual(r.headers['content-encoding'], 'gzip');
  assert.deepStrictEqual(JSON.parse(zlib.gunzipSync(r.body)), { compressed: true, items: [1, 2, 3] });
  ok('gzip-відповідь проходить без змін');

  r = await request({ port: relayPort, host, path: '/cookies' });
  const cookies = [];
  for (let i = 0; i < r.rawHeaders.length; i += 2) if (r.rawHeaders[i].toLowerCase() === 'set-cookie') cookies.push(r.rawHeaders[i + 1]);
  assert.deepStrictEqual(cookies, ['a=1; Path=/', 'b=2; Path=/']);
  ok('кілька Set-Cookie зберігаються');

  const t0 = Date.now();
  r = await request({ port: relayPort, host, path: '/sse' });
  assert.strictEqual(r.body.toString(), 'data: 1\n\ndata: 2\n\ndata: 3\n\n');
  assert(Date.now() - t0 >= 300);
  ok('SSE стрімиться');

  r = await request({ port: relayPort, host, path: '/big' });
  assert.strictEqual(r.body.length, big.length);
  assert(r.body.equals(big));
  ok('5 МБ відповідь без пошкоджень');

  await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${relayPort}/ws`, { headers: { host } });
    const got = [];
    ws.on('message', (m, isBin) => {
      got.push(isBin ? Buffer.from(m) : m.toString());
      if (got.length === 1) ws.send('ping');
      if (got.length === 2) ws.send(Buffer.from([1, 2, 3, 250]));
      if (got.length === 3) {
        try {
          assert.deepStrictEqual(got.slice(0, 2), ['hi', 'echo:ping']);
          assert.deepStrictEqual([...got[2]], [1, 2, 3, 250]);
          ws.close();
          resolve();
        } catch (e) { reject(e); }
      }
    });
    ws.on('error', reject);
  });
  ok('WebSocket (текст і бінарні кадри) через тунель — як HMR у Metro/Vite');

  r = await request({ port: relayPort, host: 'nobody.t.test', path: '/', headers: { accept: 'application/json' } });
  assert.strictEqual(r.status, 404);
  ok('невідомий субдомен → 404');

  /* ---------- інспектор ---------- */
  console.log('Інспектор');
  await waitFor(() => seen.some((s) => s.url === '/gzip' && !s.pending), 3000, 'entry gzip');
  const insp = mgr.inspector(t.id);
  const gz = insp.list().find((e) => e.url === '/gzip');
  const d = insp.detail(gz.id);
  assert.strictEqual(d.resBody.kind, 'json');
  assert(d.resBody.text.includes('"compressed": true'));
  ok('журнал розпаковує gzip і форматує JSON');

  const echo = insp.list().find((e) => e.url === '/echo');
  const ed = insp.detail(echo.id);
  assert.strictEqual(ed.reqBody.kind, 'json');
  assert(ed.reqBody.text.includes('світ'));
  assert(ed.canReplay);
  const before = insp.entries.size;
  const code = await insp.replay(echo.id);
  assert.strictEqual(code, 201);
  assert.strictEqual(insp.entries.size, before + 1);
  const replayed = insp.list().at(-1);
  assert.strictEqual(replayed.replayOf, echo.id);
  ok('повтор запиту (replay)');

  const wsEntry = insp.list().find((e) => e.kind === 'ws');
  assert.strictEqual(wsEntry.status, 101);
  ok('WebSocket-з\'єднання видно в журналі');

  /* ---------- локальний сервер упав ---------- */
  const t2 = await mgr.create({ name: 'Down', target: '1', provider: 'relay', subdomain: 'down' });
  await mgr.start(t2.id);
  await waitFor(() => mgr.state(t2.id).status === 'online', 8000, 'down online');
  r = await request({ port: relayPort, host: 'down.t.test', path: '/x', headers: { accept: 'application/json' } });
  assert.strictEqual(r.status, 502);
  assert.strictEqual(JSON.parse(r.body).error, 'devbridge_upstream_unavailable');
  ok('локальний сервер вимкнено → зрозумілий 502');
  await waitFor(() => mgr.state(t2.id).localUp === false, 4000, 'localUp false');
  ok('індикатор «локальний сервер не відповідає»');
  await mgr.remove(t2.id);

  /* ---------- невірний токен ---------- */
  store.setRelay({ token: 'wrong' });
  const t3 = await mgr.create({ name: 'Bad', target: String(upPort), provider: 'relay', subdomain: 'bad' });
  await mgr.start(t3.id);
  const bad = await waitFor(() => { const s = mgr.state(t3.id); return s.status === 'error' && s; }, 8000, 'bad token');
  assert(/токен/i.test(bad.error));
  ok('невірний токен → помилка без нескінченних повторів');
  await mgr.remove(t3.id);
  store.setRelay({ token: TOKEN });

  /* ---------- перезапуск relay: клієнт перепідключається ---------- */
  // (перевіряємо на тому ж процесі: розриваємо WebSocket з боку клієнта)
  const rtA = mgr.rt.get(t.id);
  rtA.provider.ws.terminate();
  await waitFor(() => mgr.state(t.id).status === 'reconnecting', 3000, 'reconnecting');
  await waitFor(() => mgr.state(t.id).status === 'online', 8000, 'online again');
  r = await request({ port: relayPort, host, path: '/hello' });
  assert.strictEqual(r.status, 200);
  ok('автоматичне перепідключення після обриву');

  await mgr.stop(t.id);
  await new Promise((res) => setTimeout(res, 150)); // сервер обробляє close-кадр асинхронно
  r = await request({ port: relayPort, host, path: '/hello', headers: { accept: 'application/json' } });
  assert.strictEqual(r.status, 404);
  ok('зупинка тунелю');

  /* ---------- LAN ---------- */
  console.log('Локальна мережа');
  const lan = await mgr.create({ name: 'LAN', target: String(upPort), provider: 'lan' });
  assert(lan.lanPort >= 8100);
  await mgr.start(lan.id);
  const ls = await waitFor(() => { const s = mgr.state(lan.id); return (s.status === 'online' || s.status === 'error') && s; }, 3000, 'lan');
  if (ls.status === 'online') {
    r = await request({ port: lan.lanPort, host: `x:${lan.lanPort}`, path: '/hello' });
    assert.strictEqual(r.status, 200);
    ok(`LAN: ${ls.url}`);
  } else {
    console.log(`  · LAN пропущено: ${ls.error}`);
  }
  await mgr.remove(lan.id);

  /* ---------- Host rewrite ---------- */
  const hr = await mgr.create({ name: 'Rewrite', target: `localhost:${upPort}`, provider: 'relay', subdomain: 'rw', hostRewrite: true });
  await mgr.start(hr.id);
  await waitFor(() => mgr.state(hr.id).status === 'online', 8000, 'rw online');
  r = await request({ port: relayPort, host: 'rw.t.test', path: '/hello' });
  assert.strictEqual(JSON.parse(r.body).host, `localhost:${upPort}`);
  ok('опція «підміняти Host» (для Vite allowedHosts)');
  await mgr.remove(hr.id);

  /* ---------- Cloudflare (фейковий cloudflared, без мережі) ---------- */
  console.log('Cloudflare (імітація cloudflared)');
  const fake = path.join(binDir, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
  fs.writeFileSync(fake, `#!${process.execPath}
if (process.argv.includes('--version')) { console.log('cloudflared version 2026.11.0 (built fake)'); process.exit(0); }
const log = (s) => process.stderr.write(new Date().toISOString() + ' ' + s + '\\n');
log('INF Requesting new quick Tunnel on trycloudflare.com...');
log('INF +--------------------------------------------------------------------------------------------+');
log('INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |');
log('INF |  https://brave-sample-words-test.trycloudflare.com                                        |');
log('INF +--------------------------------------------------------------------------------------------+');
setTimeout(() => log('INF Registered tunnel connection connIndex=0 connection=abc event=0 ip=198.41.200.13 location=waw01 protocol=quic'), 200);
setInterval(() => {}, 1000);
`);
  fs.chmodSync(fake, 0o755);
  if (process.platform !== 'win32') {
    const cf = await mgr.create({ name: 'CF', target: String(upPort), provider: 'cloudflare' });
    await mgr.start(cf.id);
    const cs = await waitFor(() => { const s = mgr.state(cf.id); return (s.status === 'online' || s.status === 'error') && s; }, 5000, 'cf online');
    assert.strictEqual(cs.status, 'online', cs.error);
    assert.strictEqual(cs.url, 'https://brave-sample-words-test.trycloudflare.com');
    ok('парсинг адреси й статусу cloudflared');
    await mgr.stop(cf.id);
    assert.strictEqual(mgr.state(cf.id).status, 'stopped');
    ok('процес cloudflared зупиняється');
  }

  await mgr.stopAll();
  store.flush();
  const saved = JSON.parse(fs.readFileSync(path.join(tmp, 'config.json'), 'utf8'));
  assert(saved.tunnels.some((x) => x.name === 'API'));
  ok('конфіг зберігається на диск');

  relay.kill();
  upstream.close();
  wss.close();
  console.log(`\nПройдено перевірок: ${passed}.`);
  process.exit(0);
}

main().catch((e) => { console.error('\n✗', e); process.exit(1); });
