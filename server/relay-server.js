#!/usr/bin/env node
'use strict';
/**
 * DevBridge relay — власний «ngrok» для вашого VPS.
 *
 *   <subdomain>.<BASE_DOMAIN>  → трафік йде в підключений клієнт DevBridge
 *   <BASE_DOMAIN>/_devbridge/connect  → WebSocket для клієнтів (Bearer TOKEN)
 *   /_devbridge/check?domain=…        → для Caddy on-demand TLS
 *   /_devbridge/status                → перевірка з додатка (Bearer TOKEN)
 *
 * Змінні середовища:
 *   BASE_DOMAIN  t.example.com              (обов'язково)
 *   TOKEN        секрет; кілька — через кому  (обов'язково)
 *   PORT         7000
 *   HOST         0.0.0.0
 *   PUBLIC_SCHEME https   (http, якщо без TLS)
 *   PUBLIC_PORT   ''      (додається до URL, якщо нестандартний)
 *   DATA_DIR      ./data  (список відомих субдоменів для TLS)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const P = require('../shared/protocol');

const { T } = P;
const VERSION = '1.0.0';

const cfg = {
  port: Number(process.env.PORT) || 7000,
  host: process.env.HOST || '0.0.0.0',
  baseDomain: String(process.env.BASE_DOMAIN || '').trim().toLowerCase().replace(/\.$/, ''),
  tokens: String(process.env.TOKEN || process.env.TOKENS || '').split(',').map((s) => s.trim()).filter(Boolean),
  scheme: process.env.PUBLIC_SCHEME || 'https',
  publicPort: String(process.env.PUBLIC_PORT || '').trim(),
  dataDir: process.env.DATA_DIR || path.join(__dirname, 'data'),
};

if (!cfg.baseDomain || !cfg.tokens.length) {
  console.error('Потрібні змінні BASE_DOMAIN і TOKEN. Приклад:\n  BASE_DOMAIN=t.example.com TOKEN=$(openssl rand -hex 24) node relay-server.js');
  process.exit(1);
}

const log = (...a) => console.log(new Date().toISOString(), ...a);

/* ---------- відомі субдомени (щоб Caddy видавав сертифікати лише для них) ---------- */
const knownFile = path.join(cfg.dataDir, 'subdomains.json');
let known = new Set();
try { known = new Set(JSON.parse(fs.readFileSync(knownFile, 'utf8'))); } catch { /* перший запуск */ }
function remember(sub) {
  if (known.has(sub)) return;
  known.add(sub);
  try {
    fs.mkdirSync(cfg.dataDir, { recursive: true });
    fs.writeFileSync(knownFile + '.tmp', JSON.stringify([...known]));
    fs.renameSync(knownFile + '.tmp', knownFile);
  } catch (e) { log('не вдалося зберегти subdomains.json:', e.message); }
}

/* ---------- утиліти ---------- */
function hostOf(req) {
  return String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
}
function subOf(host) {
  const suffix = '.' + cfg.baseDomain;
  if (!host.endsWith(suffix)) return null;
  const sub = host.slice(0, -suffix.length);
  return P.SUBDOMAIN_RE.test(sub) ? sub : null;
}
function publicUrl(sub) {
  const port = cfg.publicPort && !['80', '443'].includes(cfg.publicPort) ? ':' + cfg.publicPort : '';
  return `${cfg.scheme}://${sub}.${cfg.baseDomain}${port}`;
}
function tokenOk(req, url) {
  const h = String(req.headers.authorization || '');
  const tok = h.startsWith('Bearer ') ? h.slice(7).trim() : (url && url.searchParams.get('token')) || '';
  if (!tok) return false;
  const a = Buffer.from(tok);
  return cfg.tokens.some((t) => { const b = Buffer.from(t); return a.length === b.length && crypto.timingSafeEqual(a, b); });
}
function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim().replace(/^::ffff:/, '');
}
function randomSub() {
  const abc = 'abcdefghijklmnopqrstuvwxyz0123456789';
  for (;;) {
    const bytes = crypto.randomBytes(8);
    let s = '';
    for (const b of bytes) s += abc[b % abc.length];
    if (!tunnels.has(s) && /^[a-z]/.test(s)) return s;
  }
}
function forwardedHeaders(req) {
  const flat = P.stripHopByHop(req.rawHeaders, { drop: ['x-devbridge-replay'] });
  const has = (n) => P.getHeader(flat, n) !== undefined;
  const ip = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  if (!has('x-forwarded-for')) flat.push('X-Forwarded-For', ip);
  if (!has('x-forwarded-proto')) flat.push('X-Forwarded-Proto', cfg.scheme);
  if (!has('x-forwarded-host')) flat.push('X-Forwarded-Host', String(req.headers.host || ''));
  return flat;
}

function page(status, title, text) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  return `<!doctype html><html lang="uk"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${status} · DevBridge</title>
<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#10141f;color:#e4e8f2;font:16px/1.5 system-ui,sans-serif">
<main style="max-width:32rem;padding:2rem"><p style="color:#ff9f43;font-weight:600;margin:0 0 .5rem">${status} · DevBridge</p>
<h1 style="font-size:1.4rem;margin:0 0 1rem;font-weight:600">${esc(title)}</h1><p style="color:#8b93ab;margin:0">${esc(text)}</p></main></body></html>`;
}
function sendPage(req, res, status, title, text) {
  if (res.headersSent) { res.destroy(); return; }
  const json = String(req.headers.accept || '').includes('application/json');
  const body = json ? JSON.stringify({ error: 'devbridge', status, message: `${title}. ${text}` }) : page(status, title, text);
  res.writeHead(status, { 'content-type': json ? 'application/json; charset=utf-8' : 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}
function rejectSocket(socket, status, message) {
  const body = Buffer.from(message || '');
  try {
    socket.end(`HTTP/1.1 ${status} ${http.STATUS_CODES[status] || ''}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n` + body.toString());
  } catch { socket.destroy(); }
}

/* ---------- тунелі ---------- */
/** @type {Map<string, Tunnel>} */
const tunnels = new Map();

class Tunnel {
  constructor(ws, sub, ip) {
    this.ws = ws;
    this.sub = sub;
    this.ip = ip;
    this.connectedAt = Date.now();
    this.seq = 0;
    this.streams = new Map();
    this.sender = P.createSender(ws);
    this.requests = 0;
  }
  nextId() { this.seq = (this.seq + 1) >>> 0 || 1; return this.seq; }
  send(type, id, payload, source) { return this.sender.send(type, id, payload, source); }

  onFrame({ type, id, payload }) {
    const s = this.streams.get(id);
    switch (type) {
      case T.RES: {
        if (!s || s.kind !== 'http') return;
        const m = P.parseJson(payload);
        try {
          s.res.writeHead(m.status || 502, m.statusMessage || http.STATUS_CODES[m.status] || '', m.headers || []);
        } catch (e) {
          log(`[${this.sub}] некоректні заголовки відповіді: ${e.message}`);
          s.res.writeHead(m.status || 502);
        }
        return;
      }
      case T.RES_DATA: if (s && s.kind === 'http') s.res.write(payload); return;
      case T.RES_END: if (s && s.kind === 'http') { this.streams.delete(id); s.res.end(); } return;
      case T.UPGRADE_RES: {
        if (!s || s.kind !== 'sock') return;
        const m = P.parseJson(payload);
        s.socket.write(P.rawResponseHead(m.status, m.statusMessage || http.STATUS_CODES[m.status] || '', m.headers || []));
        if (m.status === 101) { s.open = true; return; }
        if (m.body) s.socket.write(Buffer.from(m.body, 'base64'));
        this.streams.delete(id);
        s.socket.end();
        return;
      }
      case T.SOCK_DATA: if (s && s.kind === 'sock') s.socket.write(payload); return;
      case T.SOCK_END: if (s && s.kind === 'sock') s.socket.end(); return;
      case T.ABORT: {
        if (!s) return;
        this.streams.delete(id);
        const m = P.parseJson(payload);
        if (s.kind === 'http') {
          if (!s.res.headersSent) sendPage(s.req, s.res, 502, 'Клієнт DevBridge не зміг виконати запит', m.message || 'Локальний сервер недоступний');
          else s.res.destroy();
        } else if (!s.open) {
          rejectSocket(s.socket, 502, m.message || 'upstream error');
        } else {
          s.socket.destroy();
        }
        return;
      }
      default:
    }
  }

  close() {
    this.sender.dispose();
    for (const s of this.streams.values()) {
      if (s.kind === 'http') sendPage(s.req, s.res, 502, `Тунель «${this.sub}» відключився`, 'Перезапустіть тунель у DevBridge.');
      else s.socket.destroy();
    }
    this.streams.clear();
  }

  forward(req, res) {
    const id = this.nextId();
    this.requests++;
    this.streams.set(id, { kind: 'http', req, res });
    this.send(T.REQ, id, { method: req.method, url: req.url, headers: forwardedHeaders(req) });
    req.on('data', (c) => this.send(T.REQ_DATA, id, c, req));
    req.on('end', () => this.send(T.REQ_END, id));
    res.on('close', () => {
      if (this.streams.has(id)) { this.streams.delete(id); this.send(T.ABORT, id); }
    });
  }

  forwardUpgrade(req, socket, head) {
    const id = this.nextId();
    this.requests++;
    const s = { kind: 'sock', socket, open: false };
    this.streams.set(id, s);
    const flat = forwardedHeaders(req);
    // повертаємо Connection/Upgrade, які зрізав stripHopByHop
    flat.push('Connection', 'Upgrade', 'Upgrade', String(req.headers.upgrade || 'websocket'));
    this.send(T.UPGRADE, id, { method: req.method, url: req.url, headers: flat });
    if (head && head.length) this.send(T.SOCK_DATA, id, head);
    socket.on('data', (d) => this.send(T.SOCK_DATA, id, d, socket));
    socket.on('end', () => this.send(T.SOCK_END, id));
    socket.on('error', () => {});
    socket.on('close', () => { if (this.streams.has(id)) { this.streams.delete(id); this.send(T.ABORT, id); } });
  }
}

/* ---------- HTTP ---------- */
const server = http.createServer((req, res) => {
  const host = hostOf(req);
  const sub = subOf(host);

  if (sub) {
    const t = tunnels.get(sub);
    if (!t) return sendPage(req, res, 404, `Тунель «${sub}» не підключено`, 'Запустіть його в DevBridge і оновіть сторінку.');
    return t.forward(req, res);
  }

  // службові маршрути — на базовому домені або localhost/IP
  let url;
  try { url = new URL(req.url, 'http://x'); } catch { res.writeHead(400); return res.end(); }

  if (url.pathname === '/_devbridge/check') {
    const d = String(url.searchParams.get('domain') || '').toLowerCase();
    const s = subOf(d);
    const ok = d === cfg.baseDomain || (s && (known.has(s) || tunnels.has(s)));
    res.writeHead(ok ? 200 : 403, { 'content-type': 'text/plain' });
    return res.end(ok ? 'ok' : 'unknown');
  }

  if (url.pathname === '/_devbridge/status') {
    if (!tokenOk(req, url)) { res.writeHead(401, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: false, message: 'Невірний токен' })); }
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    return res.end(JSON.stringify({
      ok: true, version: VERSION, protocol: P.PROTOCOL_VERSION, baseDomain: cfg.baseDomain,
      example: publicUrl('myapp'),
      tunnels: [...tunnels.values()].map((t) => ({ subdomain: t.sub, url: publicUrl(t.sub), connectedAt: t.connectedAt, requests: t.requests })),
    }));
  }

  if (url.pathname === '/' || url.pathname === '/_devbridge/health') {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end(`DevBridge relay ${VERSION} — тунелів: ${tunnels.size}\n`);
  }

  sendPage(req, res, 404, 'Не знайдено', `Відкривайте тунелі за адресою <субдомен>.${cfg.baseDomain}`);
});

server.requestTimeout = 0;
server.headersTimeout = 60_000;
server.keepAliveTimeout = 65_000;

/* ---------- WebSocket для клієнтів ---------- */
const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024, perMessageDeflate: false });

server.on('upgrade', (req, socket, head) => {
  socket.on('error', () => {});
  const host = hostOf(req);
  const sub = subOf(host);

  if (sub) {
    const t = tunnels.get(sub);
    if (!t) return rejectSocket(socket, 404, `Тунель «${sub}» не підключено`);
    return t.forwardUpgrade(req, socket, head);
  }

  let url;
  try { url = new URL(req.url, 'http://x'); } catch { return rejectSocket(socket, 400, 'bad url'); }
  if (url.pathname !== '/_devbridge/connect') return rejectSocket(socket, 404, 'not found');

  const json = (status, message) => {
    const body = JSON.stringify({ ok: false, message });
    socket.end(`HTTP/1.1 ${status} ${http.STATUS_CODES[status]}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
  };
  if (!tokenOk(req, url)) { log(`відхилено з'єднання без/з невірним токеном від ${clientIp(req)}`); return json(401, 'Невірний токен'); }

  let wanted = String(req.headers['x-devbridge-subdomain'] || url.searchParams.get('subdomain') || '').trim().toLowerCase();
  if (wanted && !P.SUBDOMAIN_RE.test(wanted)) return json(400, `Субдомен «${wanted}» некоректний: лише a-z, 0-9 і дефіс, до 63 символів`);

  wss.handleUpgrade(req, socket, head, (ws) => {
    const subdomain = wanted || randomSub();
    const prev = tunnels.get(subdomain);
    if (prev) {
      log(`[${subdomain}] новий клієнт перехоплює субдомен`);
      tunnels.delete(subdomain);
      prev.close();
      try { prev.ws.close(4000, 'replaced'); } catch { /* ignore */ }
    }
    const t = new Tunnel(ws, subdomain, clientIp(req));
    tunnels.set(subdomain, t);
    remember(subdomain);
    log(`[${subdomain}] підключено з ${t.ip} → ${publicUrl(subdomain)}`);
    t.send(T.CONTROL, 0, { type: 'ready', subdomain, url: publicUrl(subdomain), version: VERSION, protocol: P.PROTOCOL_VERSION });

    let alive = true;
    ws.on('pong', () => { alive = true; });
    const ping = setInterval(() => {
      if (!alive) { ws.terminate(); return; }
      alive = false;
      try { ws.ping(); } catch { /* ignore */ }
    }, 25_000);

    ws.on('message', (data) => { const f = P.decode(data); if (f) t.onFrame(f); });
    ws.on('error', () => {});
    ws.on('close', () => {
      clearInterval(ping);
      if (tunnels.get(subdomain) === t) tunnels.delete(subdomain);
      t.close();
      log(`[${subdomain}] відключено`);
    });
  });
});

server.listen(cfg.port, cfg.host, () => {
  log(`DevBridge relay ${VERSION} слухає ${cfg.host}:${cfg.port}; тунелі: ${publicUrl('<субдомен>')}`);
});

function shutdown() {
  log('зупинка…');
  for (const t of tunnels.values()) { try { t.ws.close(1001, 'server shutdown'); } catch { /* ignore */ } }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

module.exports = { server };
