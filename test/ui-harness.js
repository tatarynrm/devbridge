'use strict';
/**
 * Знімки екрана інтерфейсу для перевірки (не входить у збірку).
 * xvfb-run -s "-screen 0 1400x900x24" npx electron test/ui-harness.js --no-sandbox
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { spawn } = require('child_process');
const { app, BrowserWindow } = require('electron');

const OUT = process.env.SHOT_DIR || path.join(__dirname, '..', '..', 'shots');
const MODE = process.env.SHOT_MODE || 'full';
fs.mkdirSync(OUT, { recursive: true });
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'devbridge-ui-'));
app.setPath('userData', userData);
app.disableHardwareAcceleration();

const RELAY_PORT = 18555;
const TOKEN = 'demo-token-1234';
let upstreamPort;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function setup() {
  if (MODE === 'empty') return;
  const upstream = http.createServer((req, res) => {
    if (req.url.startsWith('/api/users')) {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ data: [{ id: 1, name: 'Олена', role: 'driver', active: true }, { id: 2, name: 'Taras', role: 'dispatcher', active: false }], total: 2, page: 1 }));
    }
    if (req.url.startsWith('/api/auth/login')) { res.writeHead(401, { 'content-type': 'application/json' }); return res.end('{"message":"Invalid credentials"}'); }
    if (req.url.startsWith('/api/orders') && req.method === 'POST') { res.writeHead(201, { 'content-type': 'application/json' }); return res.end('{"id":"ord_8812","status":"created"}'); }
    if (req.url.startsWith('/api/reports')) { res.writeHead(500, { 'content-type': 'application/json' }); return res.end('{"statusCode":500,"message":"Internal server error"}'); }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}');
  });
  await new Promise((r) => upstream.listen(3000, '127.0.0.1', r));
  upstreamPort = 3000;

  spawn(process.execPath, [path.join(__dirname, '..', 'server', 'relay-server.js')], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', BASE_DOMAIN: 't.example.com', TOKEN, PORT: String(RELAY_PORT), HOST: '127.0.0.1', DATA_DIR: path.join(userData, 'relay') },
    stdio: 'inherit',
  });
  await sleep(600);

  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({
    version: 1,
    settings: { relay: { url: `http://127.0.0.1:${RELAY_PORT}`, token: TOKEN } },
    tunnels: [
      { id: 'a', name: 'Logistics API', target: '3000', provider: 'relay', subdomain: 'myapi', autoStart: true, hostRewrite: false },
      { id: 'b', name: 'Expo Metro', target: '8081', provider: 'lan', lanPort: 8100, autoStart: true },
      { id: 'c', name: 'Next.js кабінет', target: 'localhost:3001', provider: 'cloudflare', autoStart: false },
    ],
  }));
}

function phone(method, p, body) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: RELAY_PORT, method, path: p, headers: { host: 'myapi.t.example.com', 'user-agent': 'okhttp/4.12.0', 'content-type': 'application/json', authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.demo' } }, (res) => { res.resume(); res.on('end', resolve); });
    req.on('error', resolve);
    req.end(body);
  });
}

async function shot(win, name) {
  await sleep(500);
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, `${name}.png`), img.toPNG());
  console.log('shot', name);
}

app.on('browser-window-created', (_e, win) => {
  let started = false;
  win.webContents.on('did-finish-load', async () => {
    if (started) return;
    started = true;
    try {
      win.setSize(1320, 840);
      await sleep(1500);
      if (MODE === 'empty') {
        await shot(win, 'empty');
        app.exit(0);
        return;
      }
      for (const [m, p, b] of [
        ['GET', '/api/users?page=1&limit=20'], ['POST', '/api/auth/login', '{"email":"test@example.com","password":"x"}'],
        ['POST', '/api/orders', '{"from":"Чернівці","to":"Київ","weight":1200}'], ['GET', '/api/reports/daily'],
        ['GET', '/api/users/1'], ['GET', '/api/users?page=2&limit=20'], ['GET', '/health'],
      ]) { await phone(m, p, b); await sleep(120); }
      await sleep(800);
      await shot(win, 'online');
      await win.webContents.executeJavaScript(`document.querySelectorAll('.req')[document.querySelectorAll('.req').length - 1].click()`);
      await sleep(600);
      await shot(win, 'detail');
      await win.webContents.executeJavaScript(`[...document.querySelectorAll('.tab')].find(t => t.textContent === 'Запит').click()`);
      await shot(win, 'detail-request');
      await win.webContents.executeJavaScript(`document.querySelectorAll('.tunnel-item')[1].click()`);
      await shot(win, 'lan');
      await win.webContents.executeJavaScript(`document.querySelectorAll('.tunnel-item')[2].click()`);
      await shot(win, 'stopped');
      await win.webContents.executeJavaScript(`document.getElementById('newTunnelBtn').click()`);
      await shot(win, 'dialog-new');
      await win.webContents.executeJavaScript(`document.getElementById('tunnelDialog').close(); document.getElementById('settingsBtn').click()`);
      await shot(win, 'settings-appearance');
      for (const pane of ['app', 'relay', 'cloudflare', 'inspector', 'about']) {
        await win.webContents.executeJavaScript(`document.querySelector('.nav-item[data-pane="${pane}"]').click()`);
        await shot(win, 'settings-' + pane);
      }
      // світла тема
      await win.webContents.executeJavaScript(`document.querySelector('.nav-item[data-pane="appearance"]').click(); document.querySelector('input[name="theme"][value="light"]').click()`);
      await shot(win, 'settings-light');
      await win.webContents.executeJavaScript(`document.getElementById('settingsClose').click(); document.querySelectorAll('.tunnel-item')[0].click()`);
      await sleep(300);
      await win.webContents.executeJavaScript(`document.querySelectorAll('.req')[document.querySelectorAll('.req').length - 1].click()`);
      await shot(win, 'light-detail');
      // фіалковий акцент + компактний журнал
      await win.webContents.executeJavaScript(`window.devbridge.settings.update({ appearance: { accent: 'violet', compact: true } })`);
      win.webContents.reload();
      await sleep(1800);
      await shot(win, 'light-violet-compact');
      await win.webContents.executeJavaScript(`window.devbridge.settings.update({ appearance: { theme: 'dark', accent: 'sky' } })`);
      win.webContents.reload();
      await sleep(1800);
      await shot(win, 'dark-sky-compact');
      app.exit(0);
    } catch (e) {
      console.error(e);
      app.exit(1);
    }
  });
});

setup().then(() => require('../src/main/main.js')).catch((e) => { console.error(e); app.exit(1); });
