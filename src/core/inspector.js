'use strict';
/**
 * Локальний проксі-інспектор: стоїть між тунелем і вашим dev-сервером.
 * Пропускає HTTP і WebSocket без змін, паралельно записує запити/відповіді
 * (як веб-інспектор ngrok на :4040). Вміє повторювати запити.
 */
const http = require('http');
const https = require('https');
const zlib = require('zlib');
const { EventEmitter } = require('events');
const { stripHopByHop, flatToObject, getHeader, rawResponseHead } = require('../../shared/protocol');

const REPLAY_HEADER = 'x-devbridge-replay';

function makeCapture(limit) {
  return { chunks: [], size: 0, captured: 0, truncated: false, limit };
}
function capturePush(cap, chunk) {
  cap.size += chunk.length;
  if (cap.captured >= cap.limit) { if (chunk.length) cap.truncated = true; return; }
  const take = Math.min(chunk.length, cap.limit - cap.captured);
  cap.chunks.push(take === chunk.length ? Buffer.from(chunk) : Buffer.from(chunk.subarray(0, take)));
  cap.captured += take;
  if (take < chunk.length) cap.truncated = true;
}

function pairs(flat) {
  const out = [];
  for (let i = 0; i < flat.length; i += 2) out.push([flat[i], flat[i + 1]]);
  return out;
}

const TEXT_CT = /(json|text\/|xml|javascript|ecmascript|x-www-form-urlencoded|graphql|yaml|csv|html|svg)/i;

function looksLikeText(buf) {
  const n = Math.min(buf.length, 2048);
  for (let i = 0; i < n; i++) { const c = buf[i]; if (c === 0) return false; }
  try { new TextDecoder('utf-8', { fatal: true }).decode(buf.subarray(0, n)); return true; } catch { return n === 2048; }
}

function decodeBody(cap, flatHeaders) {
  const raw = Buffer.concat(cap.chunks);
  const encoding = String(getHeader(flatHeaders, 'content-encoding') || '').toLowerCase().trim();
  const contentType = String(getHeader(flatHeaders, 'content-type') || '');
  let data = raw;
  let decodeError = null;
  if (raw.length && encoding && encoding !== 'identity') {
    try {
      if (encoding === 'gzip' || encoding === 'x-gzip') data = zlib.gunzipSync(raw, { finishFlush: zlib.constants.Z_SYNC_FLUSH });
      else if (encoding === 'deflate') {
        try { data = zlib.inflateSync(raw, { finishFlush: zlib.constants.Z_SYNC_FLUSH }); } catch { data = zlib.inflateRawSync(raw, { finishFlush: zlib.constants.Z_SYNC_FLUSH }); }
      } else if (encoding === 'br') data = zlib.brotliDecompressSync(raw, { finishFlush: zlib.constants.BROTLI_OPERATION_FLUSH });
      else if (encoding === 'zstd' && typeof zlib.zstdDecompressSync === 'function') data = zlib.zstdDecompressSync(raw);
      else decodeError = `Кодування «${encoding}» не розпаковується`;
    } catch (e) { decodeError = e.message; data = raw; }
  }

  const out = { size: cap.size, truncated: cap.truncated, limit: cap.limit, encoding, contentType, decodeError, kind: 'empty' };
  if (!data.length) return out;

  const isImage = /^image\//i.test(contentType);
  if (isImage) {
    out.kind = 'image';
    if (!cap.truncated && data.length <= 3 * 1024 * 1024 && !/svg/i.test(contentType)) {
      out.dataUrl = `data:${contentType.split(';')[0]};base64,${data.toString('base64')}`;
    } else if (/svg/i.test(contentType)) {
      out.kind = 'text';
      out.text = data.toString('utf8');
    }
    return out;
  }

  if (TEXT_CT.test(contentType) || (!contentType && looksLikeText(data)) || (contentType && !/octet|protobuf|msgpack|font|video|audio|zip|pdf/i.test(contentType) && looksLikeText(data))) {
    const text = data.toString('utf8');
    if (/json|graphql/i.test(contentType) || /^\s*[{[]/.test(text)) {
      try { out.text = JSON.stringify(JSON.parse(text), null, 2); out.kind = 'json'; return out; } catch { /* не JSON */ }
    }
    out.kind = 'text';
    out.text = text;
    return out;
  }
  out.kind = 'binary';
  out.hex = data.subarray(0, 512).toString('hex').replace(/(.{32})/g, '$1\n').trim();
  return out;
}

function remoteOf(req) {
  const fwd = req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
}

function wantsJson(req) {
  const a = String(req.headers.accept || '');
  return a.includes('application/json') && !a.includes('text/html');
}

function errorText(err, target) {
  const code = err && err.code;
  if (code === 'ECONNREFUSED') return `Локальний сервер ${target.label} не відповідає. Запустіть його або перевірте порт у налаштуваннях тунелю.`;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return `Адресу ${target.host} не знайдено.`;
  if (code === 'ETIMEDOUT') return `Локальний сервер ${target.label} не відповів вчасно.`;
  if (code === 'ECONNRESET') return `Локальний сервер ${target.label} розірвав з'єднання.`;
  return `Помилка з'єднання з ${target.label}: ${(err && err.message) || code || 'невідома'}`;
}

function errorPage(message) {
  const esc = message.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  return `<!doctype html><html lang="uk"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>DevBridge · 502</title>
<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#10141f;color:#e4e8f2;font:16px/1.5 system-ui,sans-serif">
<main style="max-width:32rem;padding:2rem"><p style="color:#ff9f43;font-weight:600;margin:0 0 .5rem">502 · DevBridge</p>
<h1 style="font-size:1.4rem;margin:0 0 1rem;font-weight:600">Тунель працює, але локальний сервер недоступний</h1>
<p style="color:#8b93ab;margin:0">${esc}</p></main></body></html>`;
}

class Inspector extends EventEmitter {
  /**
   * @param {object} opts
   * @param {{protocol:string, host:string, port:number, label:string, hostHeader:string}} opts.target
   * @param {string} [opts.bindHost]  127.0.0.1 для тунелів, 0.0.0.0 для LAN
   * @param {number} [opts.port]      0 = випадковий
   * @param {boolean} [opts.hostRewrite] підміняти Host на адресу локального сервера
   */
  constructor(opts) {
    super();
    this.entries = new Map();
    this.seq = 0;
    this.port = null;
    this.server = null;
    this.sockets = new Set();
    this.agent = null;
    this.configure(opts);
  }

  /** Можна змінювати між stop() і start(): журнал запитів зберігається. */
  configure({ target, bindHost = '127.0.0.1', port = 0, hostRewrite = false, maxEntries = 1000, maxBody = 2 * 1024 * 1024 }) {
    this.target = target;
    this.bindHost = bindHost;
    this.wantPort = port;
    this.hostRewrite = hostRewrite;
    this.maxEntries = maxEntries;
    this.maxBody = maxBody;
    this.mod = target.protocol === 'https:' ? https : http;
  }

  /** Ліміти журналу можна міняти на льоту (з налаштувань). */
  setLimits({ maxEntries, maxBody }) {
    if (Number.isFinite(maxEntries)) this.maxEntries = maxEntries;
    if (Number.isFinite(maxBody)) this.maxBody = maxBody;
    while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value);
  }

  start() {
    if (this.server) return Promise.resolve(this.port);
    const Agent = this.target.protocol === 'https:' ? https.Agent : http.Agent;
    this.agent = new Agent({ keepAlive: true, maxSockets: 128, rejectUnauthorized: false });
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => this._onRequest(req, res));
      server.requestTimeout = 0;
      server.headersTimeout = 60_000;
      server.keepAliveTimeout = 65_000;
      server.on('upgrade', (req, socket, head) => this._onUpgrade(req, socket, head));
      server.on('connection', (s) => { this.sockets.add(s); s.on('close', () => this.sockets.delete(s)); });
      server.on('clientError', (err, socket) => { try { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); } catch { /* ignore */ } });
      server.once('error', (err) => {
        if (err.code === 'EADDRINUSE') reject(new Error(`Порт ${this.wantPort} вже зайнятий іншою програмою`));
        else if (err.code === 'EACCES') reject(new Error(`Немає дозволу слухати порт ${this.wantPort}`));
        else reject(err);
      });
      server.listen(this.wantPort, this.bindHost, () => {
        this.server = server;
        this.port = server.address().port;
        resolve(this.port);
      });
    });
  }

  async stop() {
    if (!this.server) return;
    const srv = this.server;
    this.server = null;
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
    if (this.agent) { this.agent.destroy(); this.agent = null; }
    this.port = null;
    await new Promise((r) => srv.close(() => r()));
  }

  _upstreamHeaders(req, { upgrade = false } = {}) {
    const flat = stripHopByHop(req.rawHeaders, { keepUpgrade: upgrade, drop: ['expect', REPLAY_HEADER] });
    const headers = flatToObject(flat);
    if (this.hostRewrite) {
      headers.host = this.target.hostHeader;
      if (headers.origin) headers.origin = `${this.target.protocol}//${this.target.hostHeader}`;
    }
    return headers;
  }

  _newEntry(req, kind) {
    const id = ++this.seq;
    const replayOf = req.headers[REPLAY_HEADER] ? Number(req.headers[REPLAY_HEADER]) || null : null;
    const entry = {
      id, kind, replayOf,
      time: Date.now(),
      t0: process.hrtime.bigint(),
      method: req.method,
      url: req.url,
      httpVersion: req.httpVersion,
      remote: remoteOf(req),
      reqHeaders: req.rawHeaders.slice(),
      reqBody: makeCapture(this.maxBody),
      status: null, statusMessage: '',
      resHeaders: [],
      resBody: makeCapture(this.maxBody),
      duration: null, error: null, pending: true,
      bytesIn: 0, bytesOut: 0,
    };
    this.entries.set(id, entry);
    if (this.entries.size > this.maxEntries) {
      const first = this.entries.keys().next().value;
      this.entries.delete(first);
    }
    this.emit('entry', this.summary(entry), true);
    return entry;
  }

  _finish(entry, error) {
    if (!entry.pending) return;
    entry.pending = false;
    if (error && !entry.error) entry.error = error;
    entry.duration = Number(process.hrtime.bigint() - entry.t0) / 1e6;
    this.emit('entry', this.summary(entry), false);
  }

  _onRequest(req, res) {
    const entry = this._newEntry(req, 'http');
    const target = this.target;
    let responded = false;

    const preq = this.mod.request({
      host: target.host,
      port: target.port,
      method: req.method,
      path: req.url,
      headers: this._upstreamHeaders(req),
      agent: this.agent,
      rejectUnauthorized: false,
    });

    req.on('data', (c) => capturePush(entry.reqBody, c));
    req.pipe(preq);

    preq.on('response', (pres) => {
      responded = true;
      entry.status = pres.statusCode;
      entry.statusMessage = pres.statusMessage || '';
      entry.resHeaders = pres.rawHeaders.slice();
      this.emit('entry', this.summary(entry), false);
      const headers = stripHopByHop(pres.rawHeaders);
      try {
        res.writeHead(pres.statusCode, pres.statusMessage || http.STATUS_CODES[pres.statusCode] || '', headers);
      } catch (e) {
        res.writeHead(pres.statusCode);
      }
      pres.on('data', (c) => capturePush(entry.resBody, c));
      pres.on('end', () => this._finish(entry));
      pres.on('error', (e) => { this._finish(entry, e.code || e.message); res.destroy(); });
      pres.pipe(res);
    });

    preq.on('error', (err) => {
      if (responded) { res.destroy(); this._finish(entry, err.code || err.message); return; }
      const message = errorText(err, target);
      entry.status = 502;
      entry.statusMessage = 'Bad Gateway';
      if (!res.headersSent) {
        const body = wantsJson(req)
          ? JSON.stringify({ error: 'devbridge_upstream_unavailable', code: err.code || null, message })
          : errorPage(message);
        const ct = wantsJson(req) ? 'application/json; charset=utf-8' : 'text/html; charset=utf-8';
        entry.resHeaders = ['Content-Type', ct, 'X-DevBridge-Error', err.code || 'error'];
        capturePush(entry.resBody, Buffer.from(body));
        res.writeHead(502, { 'content-type': ct, 'x-devbridge-error': err.code || 'error', 'cache-control': 'no-store' });
        res.end(body);
      } else {
        res.destroy();
      }
      this._finish(entry, err.code || 'upstream_error');
    });

    res.on('close', () => {
      if (entry.pending) {
        preq.destroy();
        this._finish(entry, res.writableFinished ? null : 'client_aborted');
      }
    });
  }

  _onUpgrade(req, socket, head) {
    const entry = this._newEntry(req, 'ws');
    const target = this.target;
    socket.on('error', () => {});

    const preq = this.mod.request({
      host: target.host,
      port: target.port,
      method: req.method,
      path: req.url,
      headers: this._upstreamHeaders(req, { upgrade: true }),
      rejectUnauthorized: false,
    });

    preq.on('upgrade', (pres, psock, phead) => {
      entry.status = pres.statusCode;
      entry.statusMessage = pres.statusMessage || 'Switching Protocols';
      entry.resHeaders = pres.rawHeaders.slice();
      this.emit('entry', this.summary(entry), false);
      socket.write(rawResponseHead(pres.statusCode, entry.statusMessage, pres.rawHeaders));
      if (phead && phead.length) { entry.bytesOut += phead.length; socket.write(phead); }
      if (head && head.length) { entry.bytesIn += head.length; psock.write(head); }
      psock.on('data', (d) => { entry.bytesOut += d.length; });
      socket.on('data', (d) => { entry.bytesIn += d.length; });
      psock.pipe(socket);
      socket.pipe(psock);
      psock.on('error', () => socket.destroy());
      const done = () => { psock.destroy(); socket.destroy(); this._finish(entry); };
      psock.on('close', done);
      socket.on('close', done);
    });

    preq.on('response', (pres) => {
      entry.status = pres.statusCode;
      entry.statusMessage = pres.statusMessage || '';
      entry.resHeaders = pres.rawHeaders.slice();
      const headers = stripHopByHop(pres.rawHeaders, { drop: ['transfer-encoding'] });
      headers.push('Connection', 'close');
      socket.write(rawResponseHead(pres.statusCode, entry.statusMessage, headers));
      pres.on('data', (c) => capturePush(entry.resBody, c));
      pres.pipe(socket);
      pres.on('end', () => this._finish(entry));
    });

    preq.on('error', (err) => {
      const message = errorText(err, target);
      entry.status = 502;
      const body = Buffer.from(message);
      socket.end(rawResponseHead(502, 'Bad Gateway', ['Content-Type', 'text/plain; charset=utf-8', 'Content-Length', String(body.length), 'Connection', 'close']) + body.toString());
      this._finish(entry, err.code || 'upstream_error');
    });

    socket.on('close', () => { if (entry.pending && entry.status !== 101) { preq.destroy(); this._finish(entry, 'client_aborted'); } });
    preq.end();
  }

  summary(e) {
    return {
      id: e.id, kind: e.kind, time: e.time, method: e.method, url: e.url,
      status: e.status, duration: e.duration, error: e.error, pending: e.pending,
      reqSize: e.reqBody.size, resSize: e.kind === 'ws' ? e.bytesIn + e.bytesOut : e.resBody.size,
      contentType: String(getHeader(e.resHeaders, 'content-type') || ''),
      remote: e.remote, replayOf: e.replayOf,
    };
  }

  list() {
    return Array.from(this.entries.values(), (e) => this.summary(e));
  }

  detail(id) {
    const e = this.entries.get(Number(id));
    if (!e) return null;
    return {
      ...this.summary(e),
      httpVersion: e.httpVersion,
      statusMessage: e.statusMessage,
      reqHeaders: pairs(e.reqHeaders),
      resHeaders: pairs(e.resHeaders),
      reqBody: decodeBody(e.reqBody, e.reqHeaders),
      resBody: e.kind === 'ws' ? { kind: 'empty', size: 0 } : decodeBody(e.resBody, e.resHeaders),
      bytesIn: e.bytesIn, bytesOut: e.bytesOut,
      canReplay: e.kind === 'http' && !e.reqBody.truncated,
    };
  }

  clear() {
    this.entries.clear();
  }

  /** Повторює запит через цей же інспектор (він з'явиться в журналі як новий). */
  replay(id) {
    const e = this.entries.get(Number(id));
    if (!e) return Promise.reject(new Error('Запит не знайдено (можливо, журнал очищено)'));
    if (e.kind !== 'http') return Promise.reject(new Error('WebSocket-з\'єднання не повторюються'));
    if (e.reqBody.truncated) return Promise.reject(new Error('Тіло запиту завелике для повтору'));
    if (!this.server) return Promise.reject(new Error('Тунель зупинено'));
    const body = Buffer.concat(e.reqBody.chunks);
    const headers = flatToObject(stripHopByHop(e.reqHeaders, { drop: ['content-length', 'transfer-encoding', 'expect'] }));
    if (body.length) headers['content-length'] = String(body.length);
    headers[REPLAY_HEADER] = String(e.id);
    return new Promise((resolve, reject) => {
      const r = http.request({ host: '127.0.0.1', port: this.port, method: e.method, path: e.url, headers, agent: false }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      });
      r.on('error', reject);
      r.end(body);
    });
  }
}

module.exports = { Inspector, decodeBody };
