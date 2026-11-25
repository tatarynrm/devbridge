'use strict';
const net = require('net');
const os = require('os');

/**
 * "3000" | "localhost:5173" | "http://192.168.1.5:8080" | "https://localhost:3000"
 * → { protocol, host, port, label }
 */
function parseTarget(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('Вкажіть порт або адресу локального сервера');
  let protocol = 'http:';
  let rest = raw;
  const m = raw.match(/^(https?):\/\//i);
  if (m) { protocol = m[1].toLowerCase() + ':'; rest = raw.slice(m[0].length); }
  rest = rest.replace(/\/.*$/, '');
  let host = 'localhost';
  let port;
  if (/^\d+$/.test(rest)) {
    port = Number(rest);
  } else {
    const ipv6 = rest.match(/^\[([^\]]+)\](?::(\d+))?$/);
    if (ipv6) { host = ipv6[1]; port = ipv6[2] ? Number(ipv6[2]) : undefined; }
    else {
      const idx = rest.lastIndexOf(':');
      if (idx > 0) { host = rest.slice(0, idx); port = Number(rest.slice(idx + 1)); }
      else { host = rest; }
    }
    if (port === undefined) port = protocol === 'https:' ? 443 : 80;
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Некоректний порт у «${raw}»`);
  if (!host) throw new Error(`Некоректна адреса «${raw}»`);
  const hostLabel = host.includes(':') ? `[${host}]` : host;
  const label = `${protocol === 'https:' ? 'https://' : ''}${hostLabel}:${port}`;
  return { protocol, host, port, label, hostHeader: `${hostLabel}:${port}` };
}

/** Перевіряє, чи слухає щось на host:port (для індикатора «локальний сервер»). */
function probe(host, port, timeout = 800) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let done = false;
    const finish = (ok) => { if (done) return; done = true; socket.destroy(); resolve(ok); };
    socket.setTimeout(timeout, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

/** Чи вільний порт на 0.0.0.0. */
function isPortFree(port, host = '0.0.0.0') {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', () => resolve(false));
    srv.listen({ port, host, exclusive: true }, () => srv.close(() => resolve(true)));
  });
}

async function findFreePort(start = 8100, taken = new Set()) {
  for (let p = start; p < start + 500; p++) {
    if (taken.has(p)) continue;
    if (await isPortFree(p)) return p;
  }
  throw new Error('Не вдалося знайти вільний порт');
}

const VIRTUAL_IFACE_RE = /(vethernet|virtualbox|vmware|vbox|docker|br-|veth|wsl|hyper-v|loopback|tailscale|zerotier|utun|awdl|llw|bridge|tap|tun)/i;

/** IPv4 адреси в локальній мережі, найімовірніші — першими. */
function lanAddresses() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const [name, list] of Object.entries(ifaces)) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' && a.family !== 4) continue;
      if (a.internal) continue;
      if (a.address.startsWith('169.254.')) continue;
      out.push({ name, address: a.address, virtual: VIRTUAL_IFACE_RE.test(name) });
    }
  }
  const score = (x) => {
    let s = 0;
    if (x.virtual) s += 100;
    if (x.address.startsWith('192.168.')) s += 0;
    else if (x.address.startsWith('10.')) s += 1;
    else if (/^172\.(1[6-9]|2\d|3[01])\./.test(x.address)) s += 2;
    else s += 5;
    return s;
  };
  return out.sort((a, b) => score(a) - score(b));
}

function randomId(len = 8) {
  const abc = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  const bytes = require('crypto').randomBytes(len);
  for (let i = 0; i < len; i++) s += abc[bytes[i] % abc.length];
  return s;
}

module.exports = { parseTarget, probe, isPortFree, findFreePort, lanAddresses, randomId };
