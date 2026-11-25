'use strict';
const { contextBridge, ipcRenderer } = require('electron');

async function call(channel, ...args) {
  const res = await ipcRenderer.invoke(channel, ...args);
  if (!res || !res.ok) throw new Error((res && res.error) || 'Невідома помилка');
  return res.data;
}

function on(channel, cb) {
  const listener = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('devbridge', {
  init: () => call('app:init'),
  tunnels: {
    create: (data) => call('tunnel:create', data),
    update: (id, data) => call('tunnel:update', id, data),
    remove: (id) => call('tunnel:remove', id),
    start: (id) => call('tunnel:start', id),
    stop: (id) => call('tunnel:stop', id),
    logs: (id) => call('tunnel:logs', id),
    move: (id, index) => call('tunnel:move', id, index),
  },
  requests: {
    list: (id) => call('requests:list', id),
    get: (id, reqId) => call('requests:get', id, reqId),
    replay: (id, reqId) => call('requests:replay', id, reqId),
    clear: (id) => call('requests:clear', id),
  },
  settings: {
    saveRelay: (data) => call('settings:saveRelay', data),
    testRelay: (data) => call('settings:testRelay', data),
    update: (patch) => call('settings:update', patch),
    openDataFolder: () => call('app:openDataFolder'),
  },
  cloudflared: {
    info: () => call('cloudflared:info'),
    install: () => call('cloudflared:install'),
  },
  qr: (text) => call('qr', text),
  copy: (text) => call('clipboard:write', text),
  open: (url) => call('open:external', url),
  on: {
    state: (cb) => on('tunnel:state', cb),
    removed: (cb) => on('tunnel:removed', cb),
    requests: (cb) => on('requests:batch', cb),
    log: (cb) => on('tunnel:log', cb),
    cloudflaredProgress: (cb) => on('cloudflared:progress', cb),
    cloudflaredInfo: (cb) => on('cloudflared:info', cb),
    select: (cb) => on('app:select', cb),
  },
});
