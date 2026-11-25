'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULTS = {
  version: 2,
  tunnels: [],
  settings: {
    relay: { url: '', token: '' },
    appearance: {
      theme: 'system',      // system | dark | light
      accent: 'amber',      // amber | violet | sky | coral | lime
      compact: false,       // щільніший журнал запитів
    },
    app: {
      closeToTray: true,    // закриття вікна ховає в трей, тунелі працюють далі
      openAtLogin: false,   // запуск разом з Windows/macOS
      startHidden: true,    // при автозапуску одразу в трей
      notifications: true,  // сповіщення: тунель онлайн / помилка
      copyUrlOnStart: false,// копіювати адресу в буфер, щойно тунель онлайн
    },
    inspector: {
      maxEntries: 1000,     // скільки запитів тримати в журналі на тунель
      maxBodyMB: 2,         // скільки тіла запиту/відповіді зберігати
    },
    cloudflare: {
      protocol: 'auto',     // auto | http2 | quic
    },
  },
};

const ALLOWED = {
  appearance: { theme: ['system', 'dark', 'light'], accent: ['amber', 'violet', 'sky', 'coral', 'lime'], compact: 'bool' },
  app: { closeToTray: 'bool', openAtLogin: 'bool', startHidden: 'bool', notifications: 'bool', copyUrlOnStart: 'bool' },
  inspector: { maxEntries: [100, 5000], maxBodyMB: [0, 20] },
  cloudflare: { protocol: ['auto', 'http2', 'quic'] },
};

function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }
function deepMerge(base, over) {
  const out = structuredClone(base);
  if (!isObj(over)) return out;
  for (const [k, v] of Object.entries(over)) {
    out[k] = isObj(v) && isObj(out[k]) ? deepMerge(out[k], v) : v;
  }
  return out;
}

/**
 * Конфіг у JSON (userData/config.json). Токен шифрується через safeStorage,
 * якщо ОС це підтримує (Windows DPAPI, macOS Keychain, libsecret на Linux).
 */
class Store {
  constructor(file, { encrypt, decrypt } = {}) {
    this.file = file;
    this.encrypt = encrypt;
    this.decrypt = decrypt;
    this.data = structuredClone(DEFAULTS);
    this.timer = null;
    this.load();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.data = deepMerge(DEFAULTS, raw);
      this.data.version = DEFAULTS.version;
      if (!Array.isArray(this.data.tunnels)) this.data.tunnels = [];
      const r = this.data.settings.relay;
      if (r.tokenEnc && this.decrypt) {
        try { r.token = this.decrypt(r.tokenEnc); } catch { r.token = ''; }
      }
      delete r.tokenEnc;
    } catch (e) {
      if (e.code !== 'ENOENT') {
        try { fs.copyFileSync(this.file, this.file + '.broken'); } catch { /* ignore */ }
      }
    }
  }

  _serialize() {
    const out = structuredClone(this.data);
    const r = out.settings.relay;
    if (r.token && this.encrypt) {
      try { r.tokenEnc = this.encrypt(r.token); delete r.token; } catch { /* залишаємо як є */ }
    }
    return JSON.stringify(out, null, 2);
  }

  save() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 150);
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, this._serialize());
      fs.renameSync(tmp, this.file);
    } catch (e) {
      console.error('Не вдалося зберегти конфіг:', e);
    }
  }

  get tunnels() { return this.data.tunnels; }
  getTunnel(id) { return this.data.tunnels.find((t) => t.id === id) || null; }

  addTunnel(t) {
    const tunnel = { id: crypto.randomUUID(), createdAt: Date.now(), ...t };
    this.data.tunnels.push(tunnel);
    this.save();
    return tunnel;
  }

  updateTunnel(id, patch) {
    const t = this.getTunnel(id);
    if (!t) return null;
    Object.assign(t, patch, { id });
    this.save();
    return t;
  }

  removeTunnel(id) {
    this.data.tunnels = this.data.tunnels.filter((t) => t.id !== id);
    this.save();
  }

  moveTunnel(id, toIndex) {
    const i = this.data.tunnels.findIndex((t) => t.id === id);
    if (i < 0) return;
    const [t] = this.data.tunnels.splice(i, 1);
    this.data.tunnels.splice(Math.max(0, Math.min(toIndex, this.data.tunnels.length)), 0, t);
    this.save();
  }

  get settings() { return this.data.settings; }

  setRelay({ url, token }) {
    const r = this.data.settings.relay;
    if (url !== undefined) r.url = String(url).trim();
    if (token !== undefined) r.token = String(token).trim();
    this.save();
    return r;
  }

  /** Оновлює appearance/app/inspector/cloudflare з перевіркою значень. Повертає змінені ключі. */
  patchSettings(patch) {
    const changed = [];
    for (const [section, rules] of Object.entries(ALLOWED)) {
      const p = patch && patch[section];
      if (!isObj(p)) continue;
      for (const [key, rule] of Object.entries(rules)) {
        if (!(key in p)) continue;
        let v = p[key];
        if (rule === 'bool') v = !!v;
        else if (Array.isArray(rule) && typeof rule[0] === 'number') {
          v = Number(v);
          if (!Number.isFinite(v)) continue;
          v = Math.min(rule[1], Math.max(rule[0], v));
        } else if (Array.isArray(rule) && !rule.includes(v)) continue;
        if (this.data.settings[section][key] !== v) {
          this.data.settings[section][key] = v;
          changed.push(`${section}.${key}`);
        }
      }
    }
    if (changed.length) this.save();
    return changed;
  }

  publicSettings() {
    const s = structuredClone(this.data.settings);
    const tok = s.relay.token;
    s.relay = { url: s.relay.url, hasToken: !!tok, tokenHint: tok ? `••••${tok.slice(-4)}` : '' };
    return s;
  }
}

module.exports = { Store, DEFAULTS };
