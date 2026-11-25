'use strict';
const path = require('path');
const {
  app, BrowserWindow, ipcMain, shell, clipboard, safeStorage, Menu, Tray, Notification, net, nativeTheme, nativeImage,
} = require('electron');
const QRCode = require('qrcode');
const { Store } = require('../core/store');
const { TunnelManager } = require('../core/tunnel-manager');
const { testRelay } = require('../core/relay-client');

const APP_ID = 'com.noris.devbridge';
const ASSETS = path.join(__dirname, '..', 'assets');
const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
const START_HIDDEN = process.argv.includes('--hidden');

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}
if (IS_WIN) app.setAppUserModelId(APP_ID);

let win = null;
let tray = null;
let manager = null;
let store = null;
let quitting = false;
let trayHintShown = false;
const lastStatus = new Map();

const BG = { dark: '#10141f', light: '#f3f5f9' };

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function appIcon() {
  return nativeImage.createFromPath(path.join(ASSETS, IS_WIN ? 'icon.ico' : 'icon.png'));
}

/* ---------- вікно ---------- */
function createWindow({ show = true } = {}) {
  win = new BrowserWindow({
    width: 1240,
    height: 800,
    minWidth: 920,
    minHeight: 600,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? BG.dark : BG.light,
    title: 'DevBridge',
    icon: appIcon(),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => { if (show) win.show(); });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());

  win.on('close', (e) => {
    if (quitting || !tray || !store.settings.app.closeToTray) return;
    e.preventDefault();
    win.hide();
    if (!trayHintShown) {
      trayHintShown = true;
      notify('DevBridge працює у треї', 'Тунелі не зупинено. Відкрити або вийти можна з іконки в треї.');
    }
  });
  win.on('closed', () => { win = null; });
}

function showWindow() {
  if (!win) createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/* ---------- тема ---------- */
function applyTheme() {
  nativeTheme.themeSource = store.settings.appearance.theme;
  if (win && !win.isDestroyed()) win.setBackgroundColor(nativeTheme.shouldUseDarkColors ? BG.dark : BG.light);
}

/* ---------- автозапуск ---------- */
function loginItemsSupported() { return IS_WIN || IS_MAC; }

function applyLoginItem() {
  if (!loginItemsSupported() || !app.isPackaged) return;
  const { openAtLogin, startHidden } = store.settings.app;
  const opts = { openAtLogin, args: startHidden ? ['--hidden'] : [] };
  // portable-версія розпаковується в temp — реєструємо саме .exe, який запускав користувач
  if (process.env.PORTABLE_EXECUTABLE_FILE) opts.path = process.env.PORTABLE_EXECUTABLE_FILE;
  app.setLoginItemSettings(opts);
}

/* ---------- сповіщення ---------- */
function notify(title, body, onClick) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, icon: appIcon(), silent: false });
  n.on('click', () => { showWindow(); if (onClick) onClick(); });
  n.show();
}

function onTunnelState(s) {
  const prev = lastStatus.get(s.id);
  lastStatus.set(s.id, s.status);
  const fresh = s.status === 'online' && prev !== 'online' && prev !== 'reconnecting' && s.url;
  if (fresh) {
    let copied = false;
    if (store.settings.app.copyUrlOnStart) { clipboard.writeText(s.url); copied = true; }
    const focused = win && win.isVisible() && win.isFocused();
    if (store.settings.app.notifications && !focused) {
      notify(`«${s.name}» онлайн`, copied ? `${s.url}\nАдресу скопійовано в буфер.` : s.url, () => send('app:select', s.id));
    }
  }
  if (s.status === 'error' && prev !== 'error' && store.settings.app.notifications) {
    const focused = win && win.isVisible() && win.isFocused();
    if (!focused) notify(`«${s.name}»: помилка`, s.error || 'Тунель зупинено', () => send('app:select', s.id));
  }
  scheduleTrayUpdate();
}

/* ---------- трей ---------- */
let trayTimer = null;
function scheduleTrayUpdate() {
  clearTimeout(trayTimer);
  trayTimer = setTimeout(updateTray, 120);
}

const SHORT = { online: 'онлайн', error: 'помилка', stopped: 'зупинено', reconnecting: 'перепідключення' };

function updateTray() {
  if (!tray || tray.isDestroyed()) return;
  const states = manager.states();
  const online = states.filter((t) => t.status === 'online');
  tray.setToolTip(online.length ? `DevBridge: онлайн ${online.length} з ${states.length}` : 'DevBridge');

  const tunnelItems = states.length
    ? states.map((t) => ({
      label: `${t.name} (${SHORT[t.status] || 'запуск…'})`,
      type: 'checkbox',
      checked: !!t.active,
      click: () => (t.active ? manager.stop(t.id) : manager.start(t.id)),
    }))
    : [{ label: 'Тунелів ще немає', enabled: false }];

  const copyItems = online.map((t) => ({ label: `${t.name}: ${t.url}`, click: () => clipboard.writeText(t.url) }));

  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Відкрити DevBridge', click: showWindow },
    { type: 'separator' },
    ...tunnelItems,
    ...(copyItems.length ? [{ type: 'separator' }, { label: 'Копіювати адресу', submenu: copyItems }] : []),
    { type: 'separator' },
    { label: 'Зупинити всі тунелі', enabled: states.some((t) => t.active), click: () => Promise.all(states.filter((t) => t.active).map((t) => manager.stop(t.id))) },
    { label: 'Вийти', click: () => app.quit() },
  ]));
}

function createTray() {
  let img;
  if (IS_WIN) img = nativeImage.createFromPath(path.join(ASSETS, 'tray.ico'));
  else {
    img = nativeImage.createFromPath(path.join(ASSETS, 'tray.png'));
    img.addRepresentation({ scaleFactor: 2, buffer: nativeImage.createFromPath(path.join(ASSETS, 'tray@2x.png')).toPNG() });
  }
  try {
    tray = new Tray(img);
  } catch {
    tray = null; // напр. Linux без системного трею
    return;
  }
  tray.on('click', showWindow);
  updateTray();
}

/* ---------- IPC ---------- */
function wireManager() {
  manager.on('state', (s) => { send('tunnel:state', s); onTunnelState(s); });
  manager.on('removed', (id) => { send('tunnel:removed', id); lastStatus.delete(id); scheduleTrayUpdate(); });
  manager.on('requests', (id, items) => send('requests:batch', { tunnelId: id, items }));
  manager.on('log', (id, entry) => send('tunnel:log', { tunnelId: id, entry }));
  manager.on('cloudflared-progress', (p) => send('cloudflared:progress', p));
  manager.on('cloudflared', (info) => send('cloudflared:info', info));
}

/** Помилки повертаються як { error } — у рендерері зрозумілий текст замість «Error invoking remote method». */
function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try { return { ok: true, data: await fn(...args) }; } catch (err) { return { ok: false, error: err && err.message ? err.message : String(err) }; }
  });
}

function appInfo() {
  return {
    platform: process.platform,
    version: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
    userData: app.getPath('userData'),
    loginItemsSupported: loginItemsSupported(),
    packaged: app.isPackaged,
    hasTray: !!tray,
  };
}

function registerIpc() {
  handle('app:init', async () => ({
    tunnels: manager.states(),
    settings: store.publicSettings(),
    cloudflared: await manager.cloudflaredInfo().catch(() => null),
    info: appInfo(),
    version: app.getVersion(),
    platform: process.platform,
  }));

  handle('tunnel:create', (data) => manager.create(data));
  handle('tunnel:update', (id, data) => manager.update(id, data));
  handle('tunnel:remove', (id) => manager.remove(id));
  handle('tunnel:start', (id) => manager.start(id));
  handle('tunnel:stop', (id) => manager.stop(id));
  handle('tunnel:logs', (id) => manager.logs(id));
  handle('tunnel:move', (id, index) => { store.moveTunnel(id, index); return manager.states(); });

  handle('requests:list', (id) => { const i = manager.inspector(id); return i ? i.list() : []; });
  handle('requests:get', (id, reqId) => { const i = manager.inspector(id); return i ? i.detail(reqId) : null; });
  handle('requests:replay', (id, reqId) => {
    const i = manager.inspector(id);
    if (!i) throw new Error('Тунель ще не запускався');
    return i.replay(reqId);
  });
  handle('requests:clear', (id) => { const i = manager.inspector(id); if (i) i.clear(); return true; });

  handle('settings:saveRelay', (data) => {
    const patch = { url: data.url };
    if (typeof data.token === 'string' && data.token.length) patch.token = data.token;
    if (data.clearToken) patch.token = '';
    store.setRelay(patch);
    store.flush();
    return store.publicSettings();
  });
  handle('settings:testRelay', (data) => testRelay(data.url, data.token || store.settings.relay.token));
  handle('settings:update', (patch) => {
    const changed = store.patchSettings(patch);
    if (changed.some((k) => k === 'appearance.theme')) applyTheme();
    if (changed.some((k) => k === 'app.openAtLogin' || k === 'app.startHidden')) applyLoginItem();
    if (changed.some((k) => k.startsWith('inspector.'))) manager.applyInspectorSettings();
    store.flush();
    return store.publicSettings();
  });

  handle('cloudflared:info', () => manager.cloudflaredInfo(true));
  handle('cloudflared:install', () => manager.installCloudflared());

  handle('qr', (text) => QRCode.toDataURL(String(text), { margin: 1, width: 360, errorCorrectionLevel: 'M', color: { dark: '#10141fff', light: '#ffffffff' } }));
  handle('clipboard:write', (text) => { clipboard.writeText(String(text)); return true; });
  handle('open:external', (url) => {
    if (!/^https?:\/\//i.test(url)) throw new Error('Можна відкривати лише http(s) адреси');
    return shell.openExternal(url);
  });
  handle('app:openDataFolder', () => shell.openPath(app.getPath('userData')));
}

/* ---------- запуск ---------- */
app.whenReady().then(async () => {
  Menu.setApplicationMenu(IS_MAC ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]) : null);

  const canEncrypt = safeStorage.isEncryptionAvailable();
  store = new Store(path.join(app.getPath('userData'), 'config.json'), canEncrypt ? {
    encrypt: (s) => safeStorage.encryptString(s).toString('base64'),
    decrypt: (b) => safeStorage.decryptString(Buffer.from(b, 'base64')),
  } : {});

  manager = new TunnelManager({
    store,
    binDir: path.join(app.getPath('userData'), 'bin'),
    fetchImpl: (url, opts) => net.fetch(url, opts),
  });

  applyTheme();
  nativeTheme.on('updated', () => {
    if (win && !win.isDestroyed()) win.setBackgroundColor(nativeTheme.shouldUseDarkColors ? BG.dark : BG.light);
  });

  wireManager();
  registerIpc();
  createTray();
  createWindow({ show: !(START_HIDDEN && tray) });
  applyLoginItem();
  manager.startAuto();

  app.on('activate', () => showWindow());
});

app.on('second-instance', () => showWindow());

// сюди потрапляємо, лише якщо «згортати в трей» вимкнено (інакше закриття вікна скасовується)
app.on('window-all-closed', () => {
  if (!IS_MAC) app.quit();
});

app.on('before-quit', (e) => {
  if (quitting || !manager) return;
  e.preventDefault();
  quitting = true;
  store && store.flush();
  Promise.race([manager.stopAll(), new Promise((r) => setTimeout(r, 2500))]).finally(() => {
    if (tray && !tray.isDestroyed()) tray.destroy();
    app.quit();
  });
});
