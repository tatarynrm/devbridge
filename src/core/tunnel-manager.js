'use strict';
/**
 * Життєвий цикл тунелів: інспектор + провайдер (cloudflare | relay | lan).
 * Не залежить від Electron — можна запускати й тестувати в чистому Node.
 */
const { EventEmitter } = require('events');
const { Inspector } = require('./inspector');
const { RelayClient } = require('./relay-client');
const { CloudflareTunnel, findCloudflared, downloadCloudflared } = require('./cloudflared');
const { parseTarget, probe, lanAddresses, findFreePort } = require('./util');
const { SUBDOMAIN_RE } = require('../../shared/protocol');

const PROVIDERS = ['cloudflare', 'relay', 'lan'];

class TunnelManager extends EventEmitter {
  constructor({ store, binDir, fetchImpl }) {
    super();
    this.store = store;
    this.binDir = binDir;
    this.fetchImpl = fetchImpl;
    this.rt = new Map();
    this.queue = new Map();
    this.flushTimer = null;
    this._installing = null;
    this.cloudflared = null;
  }

  /* ---------- конфіг ---------- */

  async validate(input, existingId = null) {
    const provider = PROVIDERS.includes(input.provider) ? input.provider : 'cloudflare';
    const target = parseTarget(input.target);
    const name = String(input.name || '').trim() || `localhost:${target.port}`;
    const subdomain = String(input.subdomain || '').trim().toLowerCase();
    if (provider === 'relay' && subdomain && !SUBDOMAIN_RE.test(subdomain)) {
      throw new Error('Субдомен: лише латиниця a-z, цифри та дефіс (не на початку чи в кінці)');
    }
    let lanPort = Number(input.lanPort) || null;
    if (provider === 'lan') {
      const taken = new Set(this.store.tunnels.filter((t) => t.id !== existingId && t.lanPort).map((t) => t.lanPort));
      if (!lanPort) lanPort = await findFreePort(8100, taken);
      if (lanPort < 1024 || lanPort > 65535) throw new Error('Порт для LAN: від 1024 до 65535');
      if (taken.has(lanPort)) throw new Error(`Порт ${lanPort} вже використовує інший тунель`);
      if (lanPort === target.port && /^(localhost|127\.0\.0\.1|::1|0\.0\.0\.0)$/.test(target.host)) {
        throw new Error('Порт для LAN має відрізнятися від порту локального сервера');
      }
    }
    return {
      name: name.slice(0, 60),
      target: String(input.target).trim(),
      provider,
      subdomain,
      lanPort,
      hostRewrite: !!input.hostRewrite,
      autoStart: !!input.autoStart,
    };
  }

  async create(input) {
    const data = await this.validate(input);
    const t = this.store.addTunnel(data);
    this._emitState(t.id);
    return this.state(t.id);
  }

  async update(id, input) {
    const prev = this.store.getTunnel(id);
    if (!prev) throw new Error('Тунель не знайдено');
    const data = await this.validate({ ...prev, ...input }, id);
    const wasActive = this._active(id);
    const changed = ['target', 'provider', 'subdomain', 'lanPort', 'hostRewrite'].some((k) => prev[k] !== data[k]);
    this.store.updateTunnel(id, data);
    if (wasActive && changed) { await this.stop(id); await this.start(id); }
    else this._emitState(id);
    return this.state(id);
  }

  async remove(id) {
    await this.stop(id);
    this.rt.delete(id);
    this.store.removeTunnel(id);
    this.emit('removed', id);
  }

  /* ---------- стан ---------- */

  _rt(id) {
    let r = this.rt.get(id);
    if (!r) {
      r = { status: 'stopped', url: null, urls: [], error: null, info: null, details: null, localUp: null, startedAt: null, logs: [], inspector: null, provider: null, health: null, active: false };
      this.rt.set(id, r);
    }
    return r;
  }

  _active(id) { const r = this.rt.get(id); return !!(r && r.active); }

  state(id) {
    const t = this.store.getTunnel(id);
    if (!t) return null;
    const r = this._rt(id);
    let targetLabel = t.target;
    try { targetLabel = parseTarget(t.target).label; } catch { /* ignore */ }
    return {
      ...t,
      targetLabel,
      status: r.status, url: r.url, urls: r.urls, error: r.error, info: r.info, details: r.details,
      localUp: r.localUp, startedAt: r.startedAt, active: r.active,
      requestCount: r.inspector ? r.inspector.entries.size : 0,
    };
  }

  states() { return this.store.tunnels.map((t) => this.state(t.id)); }

  _emitState(id) { const s = this.state(id); if (s) this.emit('state', s); }

  _set(id, status, extra = {}) {
    const r = this._rt(id);
    r.status = status;
    if ('url' in extra) r.url = extra.url;
    if ('urls' in extra) r.urls = extra.urls;
    r.error = extra.error || null;
    r.info = extra.info || null;
    r.details = extra.details || null;
    this._emitState(id);
  }

  _log(id, line) {
    const r = this._rt(id);
    const entry = { time: Date.now(), line: String(line) };
    r.logs.push(entry);
    if (r.logs.length > 300) r.logs.shift();
    this.emit('log', id, entry);
  }

  logs(id) { return this._rt(id).logs.slice(); }

  /* ---------- журнал запитів (батчинг для IPC) ---------- */

  _queueEntry(id, summary, isNew) {
    let q = this.queue.get(id);
    if (!q) { q = new Map(); this.queue.set(id, q); }
    const prev = q.get(summary.id);
    q.set(summary.id, { ...summary, isNew: isNew || (prev && prev.isNew) || false });
    if (!this.flushTimer) this.flushTimer = setTimeout(() => this._flush(), 60);
  }

  _flush() {
    this.flushTimer = null;
    for (const [id, q] of this.queue) {
      if (q.size) this.emit('requests', id, [...q.values()]);
    }
    this.queue.clear();
  }

  inspector(id) { return this._rt(id).inspector; }

  _limits() {
    const i = this.store.settings.inspector;
    return { maxEntries: i.maxEntries, maxBody: Math.round(i.maxBodyMB * 1024 * 1024) };
  }

  /** Застосувати нові ліміти журналу до вже створених інспекторів. */
  applyInspectorSettings() {
    const lim = this._limits();
    for (const r of this.rt.values()) if (r.inspector) r.inspector.setLimits(lim);
  }

  activeCount() {
    let n = 0;
    for (const r of this.rt.values()) if (r.active && r.status === 'online') n++;
    return n;
  }

  /* ---------- cloudflared ---------- */

  async cloudflaredInfo(refresh = false) {
    if (!this.cloudflared || refresh) this.cloudflared = await findCloudflared(this.binDir);
    return this.cloudflared;
  }

  installCloudflared(onProgress) {
    if (!this._installing) {
      this._installing = downloadCloudflared(this.binDir, (p) => {
        this.emit('cloudflared-progress', p);
        onProgress && onProgress(p);
      }, this.fetchImpl)
        .then((info) => { this.cloudflared = info; this.emit('cloudflared', info); return info; })
        .finally(() => { this._installing = null; });
    }
    return this._installing;
  }

  /* ---------- запуск / зупинка ---------- */

  async start(id) {
    const cfg = this.store.getTunnel(id);
    if (!cfg) throw new Error('Тунель не знайдено');
    const r = this._rt(id);
    if (r.active) return this.state(id);
    r.active = true;
    r.url = null;
    r.urls = [];
    r.startedAt = Date.now();
    this._set(id, 'starting', { info: 'Запускаю…' });

    try {
      const target = parseTarget(cfg.target);
      const isLan = cfg.provider === 'lan';
      const opts = { target, bindHost: isLan ? '0.0.0.0' : '127.0.0.1', port: isLan ? cfg.lanPort : 0, hostRewrite: !!cfg.hostRewrite, ...this._limits() };
      if (!r.inspector) {
        r.inspector = new Inspector(opts);
        r.inspector.on('entry', (summary, isNew) => this._queueEntry(id, summary, isNew));
      } else {
        r.inspector.configure(opts);
      }
      const port = await r.inspector.start();
      this._log(id, `інспектор слухає ${opts.bindHost}:${port} → ${target.label}`);
      this._startHealth(id, target);

      if (!r.active) return this.state(id); // зупинили, поки стартували

      if (cfg.provider === 'lan') {
        const ips = lanAddresses();
        if (!ips.length) throw new Error('Немає підключення до локальної мережі (Wi-Fi/Ethernet)');
        const urls = ips.map((ip) => ({ url: `http://${ip.address}:${port}`, label: ip.name, virtual: ip.virtual }));
        this._set(id, 'online', { url: urls[0].url, urls, info: 'Телефон має бути в тій самій мережі' });
        this._log(id, `доступно в мережі: ${urls.map((u) => u.url).join(', ')}`);
      } else if (cfg.provider === 'cloudflare') {
        let cf = await this.cloudflaredInfo(true);
        if (!cf) {
          this._set(id, 'installing', { info: 'Завантажую cloudflared (~40 МБ, один раз)…' });
          cf = await this.installCloudflared((p) => {
            if (!this._active(id)) return;
            const pct = p.total ? Math.round((p.received / p.total) * 100) : null;
            this._set(id, 'installing', { info: pct != null ? `Завантажую cloudflared… ${pct}%` : `Завантажую cloudflared… ${(p.received / 1048576).toFixed(1)} МБ` });
          });
          this._log(id, `cloudflared встановлено: ${cf.path} (${cf.version || '?'})`);
        }
        if (!r.active) return this.state(id);
        const t = new CloudflareTunnel({ bin: cf.path, localPort: port, protocol: this.store.settings.cloudflare.protocol });
        r.provider = t;
        t.on('log', (l) => this._log(id, l));
        t.on('status', (s) => this._onProviderStatus(id, s));
        t.start();
      } else if (cfg.provider === 'relay') {
        const relay = this.store.settings.relay;
        const c = new RelayClient({ serverUrl: relay.url, token: relay.token, subdomain: cfg.subdomain, localPort: port });
        r.provider = c;
        c.on('log', (l) => this._log(id, l));
        c.on('status', (s) => this._onProviderStatus(id, s));
        c.start();
      }
    } catch (e) {
      this._log(id, `✗ ${e.message}`);
      await this._teardown(id);
      this._set(id, 'error', { error: e.message });
    }
    return this.state(id);
  }

  _onProviderStatus(id, s) {
    const r = this._rt(id);
    if (!r.active) return;
    const map = { connecting: 'connecting', starting: 'connecting', reconnecting: 'reconnecting', online: 'online', error: 'error', stopped: 'stopped' };
    const status = map[s.status] || s.status;
    if (status === 'error') {
      this._teardown(id).then(() => this._set(id, 'error', { error: s.error, details: s.details }));
      return;
    }
    if (status === 'stopped') return;
    const info = s.info || (status === 'connecting' ? 'Підключаюсь…' : status === 'online' ? null : null);
    this._set(id, status, { url: s.url || r.url, error: status === 'reconnecting' ? s.error : null, info });
  }

  _startHealth(id, target) {
    const r = this._rt(id);
    clearInterval(r.health);
    const check = async () => {
      const up = await probe(target.host, target.port);
      if (r.localUp !== up) { r.localUp = up; this._emitState(id); }
    };
    check();
    r.health = setInterval(check, 2500);
  }

  async _teardown(id) {
    const r = this._rt(id);
    r.active = false;
    clearInterval(r.health);
    r.health = null;
    r.localUp = null;
    if (r.provider) { try { r.provider.stop(); } catch { /* ignore */ } r.provider = null; }
    if (r.inspector) { try { await r.inspector.stop(); } catch { /* ignore */ } }
  }

  async stop(id) {
    const r = this.rt.get(id);
    if (!r) return null;
    await this._teardown(id);
    r.url = null;
    r.urls = [];
    r.startedAt = null;
    this._set(id, 'stopped');
    return this.state(id);
  }

  async stopAll() {
    await Promise.all([...this.rt.keys()].map((id) => this._teardown(id)));
  }

  async startAuto() {
    for (const t of this.store.tunnels) if (t.autoStart) this.start(t.id);
  }
}

module.exports = { TunnelManager, PROVIDERS };
