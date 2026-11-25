'use strict';
/**
 * Бінарний протокол між DevBridge (клієнт) і relay-сервером.
 * Один WebSocket на тунель, усередині — мультиплексовані потоки.
 *
 * Кадр: [1 байт тип][4 байти id потоку, BE][payload]
 * Для типів з метаданими payload — JSON (utf8), для *_DATA — сирі байти.
 */

const PROTOCOL_VERSION = 1;

const T = Object.freeze({
  CONTROL: 0,     // JSON: { type: 'ready' | 'error' | 'info', ... }
  REQ: 1,         // server → client: { method, url, headers: flat[] }
  REQ_DATA: 2,    // server → client: тіло запиту
  REQ_END: 3,     // server → client
  RES: 4,         // client → server: { status, statusMessage, headers: flat[] }
  RES_DATA: 5,    // client → server: тіло відповіді
  RES_END: 6,     // client → server
  UPGRADE: 7,     // server → client: { method, url, headers }
  UPGRADE_RES: 8, // client → server: { status, statusMessage, headers, body? (base64) }
  SOCK_DATA: 9,   // обидва напрямки: сирі байти після 101
  SOCK_END: 10,   // обидва напрямки
  ABORT: 11,      // обидва напрямки: { message? }
});

const EMPTY = Buffer.alloc(0);

function encode(type, id, payload) {
  let body;
  if (payload == null) body = EMPTY;
  else if (Buffer.isBuffer(payload)) body = payload;
  else if (payload instanceof Uint8Array) body = Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
  else if (typeof payload === 'string') body = Buffer.from(payload, 'utf8');
  else body = Buffer.from(JSON.stringify(payload), 'utf8');
  const head = Buffer.allocUnsafe(5);
  head.writeUInt8(type, 0);
  head.writeUInt32BE(id >>> 0, 1);
  return Buffer.concat([head, body], 5 + body.length);
}

function decode(data) {
  const buf = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
  if (buf.length < 5) return null;
  return { type: buf.readUInt8(0), id: buf.readUInt32BE(1), payload: buf.subarray(5) };
}

function parseJson(payload) {
  try { return JSON.parse(payload.toString('utf8')); } catch { return {}; }
}

/** Заголовки, які не можна пересилати між з'єднаннями (RFC 7230 §6.1). */
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-connection', 'proxy-authenticate',
  'proxy-authorization', 'te', 'trailer', 'trailers', 'upgrade', 'http2-settings',
]);

/** rawHeaders (flat) → flat без hop-by-hop. keepUpgrade — для WebSocket рукостискання. */
function stripHopByHop(flat, { keepUpgrade = false, drop = [] } = {}) {
  const extra = new Set(drop.map((h) => h.toLowerCase()));
  const out = [];
  for (let i = 0; i < flat.length; i += 2) {
    const k = String(flat[i]);
    const lk = k.toLowerCase();
    if (extra.has(lk)) continue;
    if (HOP_BY_HOP.has(lk) && !(keepUpgrade && (lk === 'connection' || lk === 'upgrade'))) continue;
    out.push(k, flat[i + 1]);
  }
  return out;
}

/** flat[] → об'єкт для http.request (дублікати об'єднуються). */
function flatToObject(flat) {
  const obj = {};
  for (let i = 0; i < flat.length; i += 2) {
    const k = String(flat[i]).toLowerCase();
    const v = flat[i + 1];
    if (k in obj) {
      if (k === 'cookie') obj[k] += '; ' + v;
      else if (k === 'set-cookie') obj[k] = [].concat(obj[k], v);
      else obj[k] += ', ' + v;
    } else {
      obj[k] = v;
    }
  }
  return obj;
}

function getHeader(flat, name) {
  const n = name.toLowerCase();
  for (let i = 0; i < flat.length; i += 2) if (String(flat[i]).toLowerCase() === n) return flat[i + 1];
  return undefined;
}

/** Сирий HTTP/1.1 заголовок відповіді для запису прямо в сокет. */
function rawResponseHead(status, statusMessage, flat) {
  let s = `HTTP/1.1 ${status} ${statusMessage || ''}\r\n`;
  for (let i = 0; i < flat.length; i += 2) s += `${flat[i]}: ${flat[i + 1]}\r\n`;
  return s + '\r\n';
}

/**
 * Обгортка над ws.send з простим backpressure: якщо буфер WebSocket
 * переповнений — ставимо джерело на паузу, поки не розвантажиться.
 */
function createSender(ws, { high = 8 * 1024 * 1024, low = 2 * 1024 * 1024 } = {}) {
  const paused = new Set();
  let timer = null;

  function check() {
    if (ws.readyState !== 1 /* OPEN */) { stopTimer(); paused.clear(); return; }
    if (ws.bufferedAmount <= low) {
      for (const s of paused) { try { s.resume(); } catch { /* ignore */ } }
      paused.clear();
      stopTimer();
    }
  }
  function stopTimer() { if (timer) { clearInterval(timer); timer = null; } }

  return {
    send(type, id, payload, source) {
      if (ws.readyState !== 1) return false;
      ws.send(encode(type, id, payload), { binary: true });
      if (source && ws.bufferedAmount > high && typeof source.pause === 'function') {
        source.pause();
        paused.add(source);
        if (!timer) timer = setInterval(check, 15);
      }
      return true;
    },
    dispose() { stopTimer(); paused.clear(); },
  };
}

const SUBDOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

module.exports = {
  PROTOCOL_VERSION, T, encode, decode, parseJson,
  HOP_BY_HOP, stripHopByHop, flatToObject, getHeader, rawResponseHead,
  createSender, SUBDOMAIN_RE,
};
