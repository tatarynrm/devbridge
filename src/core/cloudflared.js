'use strict';
/**
 * Cloudflare Quick Tunnel: `cloudflared tunnel --url http://127.0.0.1:<port>`.
 * Без акаунта й налаштувань, HTTPS-адреса *.trycloudflare.com (змінюється при кожному запуску).
 * Бінарник cloudflared завантажується автоматично з GitHub-релізів Cloudflare.
 */
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { EventEmitter } = require('events');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const BIN_NAME = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
const RELEASE_BASE = 'https://github.com/cloudflare/cloudflared/releases/latest/download/';

function assetName(platform = process.platform, arch = process.arch) {
  if (platform === 'win32') return arch === 'ia32' ? 'cloudflared-windows-386.exe' : 'cloudflared-windows-amd64.exe';
  if (platform === 'darwin') return arch === 'arm64' ? 'cloudflared-darwin-arm64.tgz' : 'cloudflared-darwin-amd64.tgz';
  if (platform === 'linux') {
    if (arch === 'arm64') return 'cloudflared-linux-arm64';
    if (arch === 'arm') return 'cloudflared-linux-arm';
    if (arch === 'ia32') return 'cloudflared-linux-386';
    return 'cloudflared-linux-amd64';
  }
  throw new Error(`Платформа ${platform}/${arch} не підтримується`);
}

function fileExists(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

function whichCloudflared() {
  return new Promise((resolve) => {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    execFile(cmd, ['cloudflared'], { timeout: 3000, windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null);
      const first = String(stdout).split(/\r?\n/).map((s) => s.trim()).find(Boolean);
      resolve(first && fileExists(first) ? first : null);
    });
  });
}

function versionOf(bin) {
  return new Promise((resolve) => {
    execFile(bin, ['--version'], { timeout: 5000, windowsHide: true }, (err, stdout, stderr) => {
      if (err) return resolve(null);
      const m = String(stdout || stderr).match(/version\s+([\w.\-]+)/i);
      resolve(m ? m[1] : String(stdout).trim().slice(0, 60));
    });
  });
}

/** Шукає cloudflared: спершу власна копія в binDir, потім системний у PATH. */
async function findCloudflared(binDir) {
  const own = path.join(binDir, BIN_NAME);
  if (fileExists(own)) return { path: own, source: 'bundled', version: await versionOf(own) };
  const sys = await whichCloudflared();
  if (sys) return { path: sys, source: 'system', version: await versionOf(sys) };
  return null;
}

/**
 * Завантажує cloudflared у binDir.
 * @param {string} binDir
 * @param {(p:{received:number,total:number})=>void} [onProgress]
 * @param {typeof fetch} [fetchImpl]  в Electron — net.fetch (поважає системний проксі)
 */
async function downloadCloudflared(binDir, onProgress, fetchImpl = globalThis.fetch) {
  const asset = assetName();
  fs.mkdirSync(binDir, { recursive: true });
  const tmp = path.join(binDir, asset + '.download');
  const res = await fetchImpl(RELEASE_BASE + asset, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`Не вдалося завантажити cloudflared: HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  let received = 0;
  let last = 0;
  const body = Readable.fromWeb(res.body);
  body.on('data', (c) => {
    received += c.length;
    const now = Date.now();
    if (onProgress && (now - last > 120 || received === total)) { last = now; onProgress({ received, total }); }
  });
  await pipeline(body, fs.createWriteStream(tmp));
  onProgress && onProgress({ received, total: total || received });

  const dest = path.join(binDir, BIN_NAME);
  if (asset.endsWith('.tgz')) {
    await new Promise((resolve, reject) => {
      execFile('tar', ['-xzf', tmp, '-C', binDir], (err) => (err ? reject(new Error('Не вдалося розпакувати cloudflared: ' + err.message)) : resolve()));
    });
    fs.rmSync(tmp, { force: true });
  } else {
    fs.rmSync(dest, { force: true });
    fs.renameSync(tmp, dest);
  }
  if (process.platform !== 'win32') fs.chmodSync(dest, 0o755);
  if (process.platform === 'darwin') {
    // знімаємо карантин, щоб Gatekeeper не блокував запуск
    await new Promise((r) => execFile('xattr', ['-d', 'com.apple.quarantine', dest], () => r()));
  }
  return { path: dest, source: 'bundled', version: await versionOf(dest) };
}

const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

class CloudflareTunnel extends EventEmitter {
  constructor({ bin, localPort, configPath, protocol = 'auto' }) {
    super();
    this.protocol = protocol;
    this.bin = bin;
    this.localPort = localPort;
    this.configPath = configPath; // порожній конфіг, щоб не підхопився ~/.cloudflared/config.yml
    this.child = null;
    this.url = null;
    this.status = 'idle';
    this.tail = [];
    this.stopping = false;
  }

  _set(status, extra = {}) {
    this.status = status;
    this.emit('status', { status, url: this.url, ...extra });
  }

  start() {
    this.stopping = false;
    const args = ['tunnel', '--no-autoupdate'];
    if (this.configPath) args.push('--config', this.configPath);
    if (this.protocol && this.protocol !== 'auto') args.push('--protocol', this.protocol);
    args.push('--url', `http://127.0.0.1:${this.localPort}`);
    this._set('connecting');
    this.emit('log', `$ cloudflared ${args.join(' ')}`);
    const child = spawn(this.bin, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child;

    let buf = '';
    const onData = (chunk) => {
      buf += chunk.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, '');
        buf = buf.slice(i + 1);
        this._onLine(line);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);

    child.on('error', (err) => {
      this._set('error', { error: `Не вдалося запустити cloudflared: ${err.message}` });
    });
    child.on('exit', (code, signal) => {
      this.child = null;
      if (this.stopping) { this._set('stopped'); return; }
      const hint = this.tail.slice(-4).join('\n');
      let msg = `cloudflared завершився (код ${code ?? signal})`;
      if (/429|Too Many Requests/i.test(hint)) msg = 'Cloudflare тимчасово обмежив створення quick-тунелів (429). Спробуйте за хвилину.';
      else if (/config/i.test(hint) && /quick/i.test(hint)) msg = 'cloudflared знайшов config.yml — quick-тунель з ним не працює.';
      this._set('error', { error: msg, details: hint });
    });
  }

  _onLine(raw) {
    const line = raw.replace(/^\S+\s+(INF|WRN|ERR|DBG)\s+/, '$1 ').trim();
    if (!line) return;
    this.tail.push(line);
    if (this.tail.length > 50) this.tail.shift();
    if (/^[|+\s-]+$/.test(line)) return; // рамки ASCII-банера
    this.emit('log', line);
    const m = line.match(URL_RE);
    if (m && !this.url) {
      this.url = m[0];
      this._set('starting', { info: 'Адресу отримано, чекаю реєстрації з\'єднання…' });
    }
    if (/Registered tunnel connection/i.test(line) && this.url && this.status !== 'online') {
      this._set('online');
    }
  }

  stop() {
    this.stopping = true;
    if (this.child) {
      const child = this.child;
      child.kill();
      setTimeout(() => { try { if (child.exitCode === null) child.kill('SIGKILL'); } catch { /* ignore */ } }, 3000).unref();
    } else {
      this._set('stopped');
    }
  }
}

module.exports = { CloudflareTunnel, findCloudflared, downloadCloudflared, assetName, BIN_NAME };
