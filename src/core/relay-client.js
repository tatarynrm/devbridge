'use strict';
/**
 * Клієнт власного relay-сервера (server/relay-server.js).
 * Тримає WebSocket до сервера, отримує HTTP/WS запити й відтворює їх
 * на локальному порту (інспекторі), відповіді стрімить назад.
 */
const http = require('http');
const { EventEmitter } = require('events');
const WebSocket = require('ws');
const P = require('../../shared/protocol');

const { T } = P;

function toWsUrl(serverUrl) {
  let u = String(serverUrl || '').trim().replace(/\/+$/, '');
  if (!u) throw new Error('Не вказано адресу власного сервера (Налаштування)');
  if (!/^[a-z]+:\/\//i.test(u)) u = 'https://' + u;
  const url = new URL(u);
  if (url.protocol === 'https:') url.protocol = 'wss:';
  else if (url.protocol === 'http:') url.protocol = 'ws:';
  url.pathname = url.pathname.replace(/\/+$/, '') + '/_devbridge/connect';
  return url.toString();
}

class RelayClient extends EventEmitter {
  constructor({ serverUrl, token, subdomain, localPort, localHost = '127.0.0.1' }) {
    super();
    this.serverUrl = serverUrl;
    this.token = token;
    this.subdomain = (subdomain || '').trim().toLowerCase();
    this.localPort = localPort;
    this.localHost = localHost;
    this.status = 'idle';
    this.url = null;
    this.ws = null;
    this.sender = null;
    this.streams = new Map();
    this.stopped = false;
    this.attempt = 0;
    this.reconnectTimer = null;
    this.pingTimer = null;
    this.agent = new http.Agent({ keepAlive: true, maxSockets: 128 });
  }

  _set(status, extra = {}) {
    this.status = status;
    this.emit('status', { status, url: this.url, ...extra });
  }

  _log(line) { this.emit('log', line); }

  start() {
    this.stopped = false;
    this._connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    clearInterval(this.pingTimer);
    this._cleanupStreams();
    if (this.ws) { try { this.ws.close(1000, 'stop'); } catch { /* ignore */ } setTimeout(() => this.ws && this.ws.terminate(), 1000).unref(); }
    this.agent.destroy();
    this._set('stopped');
  }

  _connect() {
    let wsUrl;
    try { wsUrl = toWsUrl(this.serverUrl); } catch (e) { this._set('error', { error: e.message }); return; }
    if (!this.token) { this._set('error', { error: 'Не вказано токен власного сервера (Налаштування)' }); return; }

    this._set(this.attempt ? 'reconnecting' : 'connecting');
    this._log(`→ ${wsUrl}`);
    const ws = new WebSocket(wsUrl, {
      headers: {
        authorization: `Bearer ${this.token}`,
        'x-devbridge-subdomain': this.subdomain,
        'x-devbridge-protocol': String(P.PROTOCOL_VERSION),
      },
      handshakeTimeout: 10_000,
      maxPayload: 64 * 1024 * 1024,
      perMessageDeflate: false,
    });
    this.ws = ws;
    this.sender = P.createSender(ws);

    ws.on('unexpected-response', (req, res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        let msg = `Сервер відповів ${res.statusCode}`;
        try { const j = JSON.parse(body); if (j.message) msg = j.message; } catch { if (body) msg += `: ${body.slice(0, 200)}`; }
        this._log(`✗ ${msg}`);
        if (this.ws === ws) this.ws = null;
        try { ws.terminate(); } catch { /* ignore */ }
        if (res.statusCode === 401 || res.statusCode === 403 || res.statusCode === 400) {
          this.stopped = true;
          this._set('error', { error: msg });
        } else {
          this._scheduleReconnect(msg);
        }
      });
    });

    ws.on('open', () => {
      this._log('✓ з\'єднано, чекаю підтвердження субдомену');
      clearInterval(this.pingTimer);
      let alive = true;
      ws.on('pong', () => { alive = true; });
      this.pingTimer = setInterval(() => {
        if (!alive) { this._log('✗ сервер не відповідає на ping'); ws.terminate(); return; }
        alive = false;
        try { ws.ping(); } catch { /* ignore */ }
      }, 20_000);
    });

    ws.on('message', (data) => {
      const f = P.decode(data);
      if (f) this._onFrame(f);
    });

    ws.on('error', (err) => { this._lastErr = err.code === 'ENOTFOUND' ? `домен не знайдено (${err.hostname || ''})` : err.message; this._log(`✗ ${err.message}`); });

    ws.on('close', (code, reasonBuf) => {
      clearInterval(this.pingTimer);
      this.sender && this.sender.dispose();
      this._cleanupStreams();
      if (this.ws !== ws) return;
      this.ws = null;
      const reason = reasonBuf ? reasonBuf.toString() : '';
      if (this.stopped) return;
      if (code === 4000) {
        this.stopped = true;
        this._set('error', { error: 'Цей субдомен перехопив інший клієнт DevBridge' });
        return;
      }
      if (code === 4001 || code === 4003) {
        this.stopped = true;
        this._set('error', { error: reason || 'Сервер відхилив тунель' });
        return;
      }
      const why = reason || this._lastErr || `з'єднання закрито (${code})`;
      this._lastErr = null;
      this._scheduleReconnect(why);
    });
  }

  _scheduleReconnect(why) {
    if (this.stopped) return;
    this.attempt++;
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.attempt - 1, 5));
    this.url = this.url || null;
    this._set('reconnecting', { error: `${why}. Повтор через ${Math.round(delay / 1000)} с` });
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this._connect(), delay);
  }

  _cleanupStreams() {
    for (const s of this.streams.values()) {
      try { if (s.preq) s.preq.destroy(); if (s.sock) s.sock.destroy(); } catch { /* ignore */ }
    }
    this.streams.clear();
  }

  _send(type, id, payload, source) {
    return this.sender ? this.sender.send(type, id, payload, source) : false;
  }

  _onFrame({ type, id, payload }) {
    switch (type) {
      case T.CONTROL: {
        const m = P.parseJson(payload);
        if (m.type === 'ready') {
          this.attempt = 0;
          this.url = m.url;
          this.subdomain = m.subdomain || this.subdomain;
          this._log(`✓ тунель активний: ${m.url}`);
          this._set('online');
        } else if (m.type === 'error') {
          this._log(`✗ ${m.message}`);
        } else if (m.type === 'info' && m.message) {
          this._log(`i ${m.message}`);
        }
        return;
      }
      case T.REQ: return this._onRequest(id, P.parseJson(payload));
      case T.REQ_DATA: { const s = this.streams.get(id); if (s && s.preq) s.preq.write(payload); return; }
      case T.REQ_END: { const s = this.streams.get(id); if (s && s.preq) s.preq.end(); return; }
      case T.UPGRADE: return this._onUpgrade(id, P.parseJson(payload));
      case T.SOCK_DATA: {
        const s = this.streams.get(id);
        if (!s) return;
        if (s.sock) s.sock.write(payload);
        else s.pending.push(Buffer.from(payload));
        return;
      }
      case T.SOCK_END: { const s = this.streams.get(id); if (s) { if (s.sock) s.sock.end(); else s.endPending = true; } return; }
      case T.ABORT: {
        const s = this.streams.get(id);
        if (s) { this.streams.delete(id); if (s.preq) s.preq.destroy(); if (s.sock) s.sock.destroy(); }
        return;
      }
      default:
    }
  }

  _onRequest(id, m) {
    const headers = P.flatToObject(P.stripHopByHop(m.headers || [], { drop: ['expect'] }));
    const preq = http.request({
      host: this.localHost, port: this.localPort, method: m.method, path: m.url, headers, agent: this.agent,
    });
    const stream = { preq };
    this.streams.set(id, stream);

    preq.on('response', (pres) => {
      if (!this.streams.has(id)) { pres.destroy(); return; }
      this._send(T.RES, id, {
        status: pres.statusCode,
        statusMessage: pres.statusMessage,
        headers: P.stripHopByHop(pres.rawHeaders),
      });
      pres.on('data', (c) => this._send(T.RES_DATA, id, c, pres));
      pres.on('end', () => { this._send(T.RES_END, id); this.streams.delete(id); });
      pres.on('error', (e) => { this._send(T.ABORT, id, { message: e.message }); this.streams.delete(id); });
    });
    preq.on('error', (e) => {
      if (!this.streams.has(id)) return;
      this.streams.delete(id);
      this._send(T.ABORT, id, { message: e.message, code: e.code });
    });
  }

  _onUpgrade(id, m) {
    const headers = P.flatToObject(P.stripHopByHop(m.headers || [], { keepUpgrade: true }));
    const preq = http.request({ host: this.localHost, port: this.localPort, method: m.method, path: m.url, headers });
    const stream = { preq, sock: null, pending: [], endPending: false };
    this.streams.set(id, stream);

    preq.on('upgrade', (pres, sock, head) => {
      if (!this.streams.has(id)) { sock.destroy(); return; }
      stream.sock = sock;
      stream.preq = null;
      this._send(T.UPGRADE_RES, id, { status: pres.statusCode, statusMessage: pres.statusMessage, headers: pres.rawHeaders });
      if (head && head.length) this._send(T.SOCK_DATA, id, head);
      for (const chunk of stream.pending) sock.write(chunk);
      stream.pending = [];
      if (stream.endPending) sock.end();
      sock.on('data', (d) => this._send(T.SOCK_DATA, id, d, sock));
      sock.on('end', () => this._send(T.SOCK_END, id));
      sock.on('error', () => {});
      sock.on('close', () => {
        if (this.streams.has(id)) { this.streams.delete(id); this._send(T.ABORT, id); }
      });
    });

    preq.on('response', (pres) => {
      const chunks = [];
      let size = 0;
      pres.on('data', (c) => { if (size < 1024 * 1024) { chunks.push(c); size += c.length; } });
      pres.on('end', () => {
        const body = Buffer.concat(chunks);
        const h = P.stripHopByHop(pres.rawHeaders, { drop: ['transfer-encoding', 'content-length'] });
        h.push('Content-Length', String(body.length), 'Connection', 'close');
        this._send(T.UPGRADE_RES, id, { status: pres.statusCode, statusMessage: pres.statusMessage, headers: h, body: body.toString('base64') });
        this.streams.delete(id);
      });
    });

    preq.on('error', (e) => {
      if (!this.streams.has(id)) return;
      this.streams.delete(id);
      this._send(T.ABORT, id, { message: e.message, code: e.code });
    });
    preq.end();
  }
}

/** Перевірка з'єднання з сервером (кнопка «Перевірити» в налаштуваннях). */
async function testRelay(serverUrl, token) {
  let base = String(serverUrl || '').trim().replace(/\/+$/, '');
  if (!base) throw new Error('Вкажіть адресу сервера');
  if (!/^[a-z]+:\/\//i.test(base)) base = 'https://' + base;
  const url = new URL(base);
  url.pathname = url.pathname.replace(/\/+$/, '') + '/_devbridge/status';
  const mod = url.protocol === 'https:' ? require('https') : http;
  return new Promise((resolve, reject) => {
    const req = mod.request(url, { method: 'GET', headers: { authorization: `Bearer ${token || ''}` }, timeout: 8000 }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        let j = null;
        try { j = JSON.parse(body); } catch { /* ignore */ }
        if (res.statusCode === 200 && j && j.ok) resolve(j);
        else if (res.statusCode === 401) reject(new Error('Сервер відхилив токен'));
        else reject(new Error((j && j.message) || `Сервер відповів ${res.statusCode}. Це точно DevBridge relay?`));
      });
    });
    req.on('timeout', () => req.destroy(new Error('Сервер не відповів за 8 секунд')));
    req.on('error', (e) => reject(new Error(e.code === 'ENOTFOUND' ? `Домен ${url.hostname} не знайдено` : e.message)));
    req.end();
  });
}

module.exports = { RelayClient, testRelay, toWsUrl };
