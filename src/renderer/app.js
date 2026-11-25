'use strict';
/* global window, document */
const api = window.devbridge;

/* ---------- утиліти DOM ---------- */
const $ = (sel, root = document) => root.querySelector(sel);

function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'text') el.textContent = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  append(el, children);
  return el;
}
function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
function icon(name) {
  const paths = {
    copy: '<rect x="5" y="5" width="9" height="9" rx="1.5"/><path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2h-6A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5"/>',
    open: '<path d="M9 2h5v5M14 2 7.5 8.5M12 9.5V13a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3.5"/>',
    play: '<path d="M5 3.2v9.6L13 8z"/>',
    stop: '<rect x="4" y="4" width="8" height="8" rx="1"/>',
    edit: '<path d="M10.5 2.5l3 3L6 13H3v-3z"/>',
    trash: '<path d="M2.5 4h11M6 4V2.5h4V4M4 4l.7 9.2a1 1 0 0 0 1 .8h4.6a1 1 0 0 0 1-.8L12 4"/>',
    close: '<path d="M4 4l8 8M12 4l-8 8"/>',
    replay: '<path d="M2.5 8a5.5 5.5 0 1 0 1.7-4M2.5 2.5v3h3"/>',
    log: '<path d="M3 4h10M3 8h10M3 12h6"/>',
  };
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 16 16');
  s.setAttribute('aria-hidden', 'true');
  s.innerHTML = paths[name] || '';
  return s;
}

const nf1 = new Intl.NumberFormat('uk-UA', { maximumFractionDigits: 1 });
const nf2 = new Intl.NumberFormat('uk-UA', { maximumFractionDigits: 2 });
const fmtTime = (t) => new Date(t).toLocaleTimeString('uk-UA', { hour12: false });
function fmtSize(n) {
  if (n == null) return '';
  if (n < 1024) return `${n} Б`;
  if (n < 1024 * 1024) return `${nf1.format(n / 1024)} КБ`;
  return `${nf1.format(n / 1048576)} МБ`;
}
function fmtDur(ms) {
  if (ms == null) return '…';
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} мс`;
  if (ms < 60000) return `${nf2.format(ms / 1000)} с`;
  return `${Math.floor(ms / 60000)} хв ${Math.round((ms % 60000) / 1000)} с`;
}
function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}
function statusClass(s) {
  if (s.error && !s.status) return 'e';
  if (s.pending && !s.status) return 'p';
  return s.status ? String(s.status)[0] : 'p';
}

const PROVIDER_LABEL = { cloudflare: 'Cloudflare', relay: 'Свій сервер', lan: 'Локальна мережа' };
const BUSY = new Set(['starting', 'connecting', 'installing', 'reconnecting']);

/* ---------- стан ---------- */
const state = {
  tunnels: [],
  selected: null,
  settings: { relay: { url: '', hasToken: false, tokenHint: '' } },
  cloudflared: null,
  requests: new Map(), // tunnelId → Map(id → summary)
  loaded: new Set(),
  logs: new Map(),
  selectedReq: null,
  detail: null,
  detailTab: 'res',
  filter: '',
  errorsOnly: false,
  showLog: false,
  qr: new Map(),
};
let view = null;

const byId = (id) => state.tunnels.find((t) => t.id === id) || null;
const current = () => byId(state.selected);
function reqMap(id) {
  let m = state.requests.get(id);
  if (!m) { m = new Map(); state.requests.set(id, m); }
  return m;
}

/* ---------- сповіщення ---------- */
function toast(text, kind = '') {
  const el = h('div', { class: `toast ${kind}`, role: kind === 'error' ? 'alert' : 'status' }, text);
  $('#toasts').append(el);
  setTimeout(() => el.remove(), kind === 'error' ? 5000 : 2200);
}
async function copy(text, what = 'Скопійовано') {
  try { await api.copy(text); toast(what); } catch (e) { toast(e.message, 'error'); }
}
async function run(fn) {
  try { return await fn(); } catch (e) { toast(e.message, 'error'); return undefined; }
}

/* ---------- бокова панель ---------- */
function renderSidebar() {
  const list = $('#tunnelList');
  list.replaceChildren(...state.tunnels.map((t) => h('button', {
    class: 'tunnel-item', type: 'button', 'aria-current': t.id === state.selected ? 'true' : 'false',
    onclick: () => select(t.id),
  },
  h('span', { class: 'dot', dataset: { s: t.status }, title: statusText(t) }),
  h('span', { class: 't-name' }, t.name),
  h('span', { class: 't-sub' }, t.targetLabel))));
}

function statusText(t) {
  switch (t.status) {
    case 'online': return 'Онлайн';
    case 'error': return 'Помилка';
    case 'stopped': return 'Зупинено';
    case 'reconnecting': return 'Перепідключення';
    default: return 'Запуск';
  }
}

function select(id) {
  if (state.selected !== id) {
    state.selected = id;
    state.selectedReq = null;
    state.detail = null;
    state.filter = '';
    state.showLog = false;
  }
  renderSidebar();
  renderMain();
  if (id && !state.loaded.has(id)) loadRequests(id);
}

async function loadRequests(id) {
  const list = await run(() => api.requests.list(id));
  if (!list) return;
  state.loaded.add(id);
  const m = reqMap(id);
  for (const s of list) m.set(s.id, s);
  if (view && view.id === id) renderRows();
}

/* ---------- головна область ---------- */
function renderMain() {
  const main = $('#main');
  main.replaceChildren();
  if (!state.tunnels.length) { view = null; main.append(emptyState()); return; }
  const t = current();
  if (!t) { select(state.tunnels[0].id); return; }

  view = { id: t.id, rowEls: new Map() };
  view.head = h('header', { class: 't-head' });
  view.pipe = h('section', { class: 'pipe-card', 'aria-label': 'Підключення' });
  view.traffic = h('section', { class: 'traffic', 'aria-label': 'Запити' });
  main.append(view.head, view.pipe, view.traffic);
  renderHead(t);
  renderPipe(t);
  renderTraffic();
}

function emptyState() {
  return h('div', { class: 'empty' },
    h('div', { class: 'empty-pipe', 'aria-hidden': 'true' }, h('span', { class: 'node' }), h('span', { class: 'e-wire' }), h('span', { class: 'node' })),
    h('h1', null, 'Відкрийте локальний сервер для телефона'),
    h('p', null, 'Вкажіть порт, на якому працює ваш API чи Metro, і DevBridge видасть адресу та QR-код. Усі запити з телефона видно тут же.'),
    h('button', { class: 'btn btn-primary', type: 'button', onclick: () => openTunnelDialog() }, 'Створити тунель'));
}

function renderHead(t) {
  const busy = t.active;
  view.head.replaceChildren(
    h('h1', { class: 't-title', title: t.name }, t.name),
    h('span', { class: 'chip' }, PROVIDER_LABEL[t.provider] || t.provider),
    h('span', { class: 'spacer' }),
    h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => openTunnelDialog(t) }, icon('edit'), 'Змінити'),
    h('button', { class: 'btn btn-ghost btn-sm icon-btn', type: 'button', title: 'Видалити тунель', 'aria-label': 'Видалити тунель', onclick: () => removeTunnel(t) }, icon('trash')),
    busy
      ? h('button', { class: 'btn', type: 'button', onclick: () => run(() => api.tunnels.stop(t.id)) }, icon('stop'), 'Зупинити')
      : h('button', { class: 'btn btn-primary', type: 'button', onclick: () => run(() => api.tunnels.start(t.id)) }, icon('play'), 'Запустити'),
  );
}

function stateLine(t) {
  const online = {
    cloudflare: 'Онлайн. Після перезапуску адреса буде нова.',
    relay: 'Онлайн. Адреса постійна.',
    lan: 'Онлайн. Телефон має бути в тій самій мережі.',
  };
  switch (t.status) {
    case 'online': return { text: online[t.provider] || 'Онлайн' };
    case 'error': return { text: t.error || 'Помилка', cls: 'error' };
    case 'reconnecting': return { text: t.error || 'Перепідключаюсь…', cls: 'warn' };
    case 'stopped': return { text: t.error ? t.error : 'Тунель зупинено', cls: t.error ? 'error' : '' };
    default: return { text: t.info || 'Підключаюсь…' };
  }
}

function renderPipe(t) {
  const online = t.status === 'online' || (t.status === 'reconnecting' && t.url);
  const wire = h('div', { class: 'wire', dataset: { live: t.status === 'online' ? 'true' : BUSY.has(t.status) ? 'pending' : 'false' }, 'aria-hidden': 'true' }, h('span', { class: 'cap' }));
  view.wire = wire;

  const localState = t.localUp == null ? null
    : h('div', { class: 'end-state' }, h('span', { class: 'dot', dataset: { s: t.localUp ? 'online' : 'error' } }), t.localUp ? 'Сервер відповідає' : 'Сервер не відповідає');

  const line = stateLine(t);
  const publicLabel = t.provider === 'lan' ? 'Адреса в мережі' : 'Публічна адреса';
  const value = t.url
    ? h('div', { class: 'end-value', title: t.url }, t.url)
    : h('div', { class: 'end-value placeholder' }, t.active ? 'Отримую адресу…' : 'Запустіть тунель, щоб отримати адресу');

  const actions = t.url ? h('div', { class: 'url-actions' },
    h('button', { class: 'btn btn-sm', type: 'button', onclick: () => copy(t.url, 'Адресу скопійовано') }, icon('copy'), 'Копіювати'),
    h('button', { class: 'btn btn-sm', type: 'button', onclick: () => run(() => api.open(t.url)) }, icon('open'), 'Відкрити в браузері'),
    h('button', { class: 'btn btn-sm btn-ghost', type: 'button', 'aria-pressed': String(state.showLog), onclick: toggleLog }, icon('log'), state.showLog ? 'Сховати журнал' : 'Журнал з\'єднання'),
  ) : (t.status === 'error' ? h('div', { class: 'url-actions' },
    h('button', { class: 'btn btn-sm', type: 'button', onclick: () => run(() => api.tunnels.start(t.id)) }, icon('replay'), 'Спробувати ще раз'),
    h('button', { class: 'btn btn-sm btn-ghost', type: 'button', 'aria-pressed': String(state.showLog), onclick: toggleLog }, icon('log'), state.showLog ? 'Сховати журнал' : 'Журнал з\'єднання'),
    t.provider === 'relay' ? h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: () => openSettings('relay') }, 'Налаштування сервера') : null,
  ) : null);

  const alt = t.urls && t.urls.length > 1 ? h('div', { class: 'alt-urls' },
    t.urls.slice(1).map((u) => h('div', null,
      h('button', { type: 'button', title: 'Скопіювати', onclick: () => copy(u.url, 'Адресу скопійовано') }, u.url),
      h('span', { class: 'iface' }, u.label)))) : null;

  const flow = h('div', { class: 'pipe-flow' },
    h('div', { class: 'end end-local' },
      h('div', { class: 'end-label' }, 'Локальний сервер'),
      h('div', { class: 'end-value', title: t.targetLabel }, t.targetLabel),
      localState),
    wire,
    h('div', { class: 'end end-public' },
      h('div', { class: 'end-label' }, publicLabel),
      value,
      h('div', { class: `state-line ${line.cls || ''}` }, line.text),
      actions,
      alt));

  let qrEl;
  if (t.url && online) {
    const img = h('img', { alt: `QR-код для ${t.url}` });
    qrEl = h('button', { class: 'qr', type: 'button', title: 'Збільшити QR-код', onclick: () => openQr(t.url) }, img);
    getQr(t.url).then((src) => { if (src) img.src = src; });
  } else {
    qrEl = h('div', { class: 'qr-off' }, 'QR-код з\'явиться після запуску');
  }

  const children = [flow, qrEl];
  if (t.url) {
    children.push(h('div', { class: 'snippets' },
      snippet('EXPO_PUBLIC_API_URL', t.url, 'Базова адреса API для Expo'),
      snippet('EXPO_PACKAGER_PROXY_URL', t.url, 'Якщо в тунелі Metro (порт 8081): npx expo start з цією змінною')));
  }
  if (state.showLog) {
    view.logEl = h('pre', { class: 'conn-log', 'aria-label': 'Журнал з\'єднання' });
    children.push(view.logEl);
    loadLogs(t.id);
  } else {
    view.logEl = null;
  }
  view.pipe.replaceChildren(...children);
}

function snippet(key, url, title) {
  const text = `${key}=${url}`;
  return h('button', { class: 'snippet', type: 'button', title, onclick: () => copy(text, `${key} скопійовано`) },
    h('code', null, h('span', { class: 'k' }, key), `=${url}`), icon('copy'));
}

function toggleLog() {
  state.showLog = !state.showLog;
  const t = current();
  if (t && view) renderPipe(t);
}

async function loadLogs(id) {
  const logs = await run(() => api.tunnels.logs(id));
  if (!logs) return;
  state.logs.set(id, logs);
  if (view && view.id === id && view.logEl) {
    view.logEl.textContent = logs.map((l) => `${fmtTime(l.time)}  ${l.line}`).join('\n') || 'Поки що порожньо';
    view.logEl.scrollTop = view.logEl.scrollHeight;
  }
}

async function getQr(url) {
  if (state.qr.has(url)) return state.qr.get(url);
  const src = await run(() => api.qr(url));
  if (src) state.qr.set(url, src);
  return src;
}
async function openQr(url) {
  const src = await getQr(url);
  $('#qrBig').src = src;
  $('#qrBigUrl').textContent = url;
  $('#qrDialog').showModal();
}

function pulse(direction, status) {
  if (!view || !view.wire || view.wire.dataset.live !== 'true') return;
  if (view.wire.querySelectorAll('.packet').length > 10) return;
  const p = h('span', { class: `packet ${direction === 'out' ? 'out' : ''}` });
  if (direction === 'out') {
    const c = status >= 500 ? 'var(--fail)' : status >= 400 ? 'var(--warn)' : 'var(--live)';
    p.style.background = c;
    p.style.boxShadow = `0 0 10px ${c}`;
  }
  p.addEventListener('animationend', () => p.remove());
  view.wire.append(p);
}

/* ---------- журнал запитів ---------- */
function matches(s) {
  if (state.errorsOnly && !(s.error || (s.status && s.status >= 400))) return false;
  if (!state.filter) return true;
  const q = state.filter.toLowerCase();
  return `${s.method} ${s.url} ${s.status || ''}`.toLowerCase().includes(q);
}

function renderTraffic() {
  const t = current();
  view.count = h('span', { class: 'count' });
  view.search = h('input', {
    class: 'search', type: 'search', placeholder: 'Фільтр: шлях, метод, статус', value: state.filter, 'aria-label': 'Фільтр запитів',
    oninput: (e) => { state.filter = e.target.value; renderRows(); },
  });
  const errToggle = h('label', { class: 'toggle' },
    h('input', { type: 'checkbox', checked: state.errorsOnly, onchange: (e) => { state.errorsOnly = e.target.checked; renderRows(); } }),
    'Лише помилки');
  const bar = h('div', { class: 'traffic-bar' },
    h('h2', null, 'Запити'), view.count, h('span', { class: 'spacer' }), errToggle, view.search,
    h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: () => clearRequests(t.id) }, 'Очистити'));
  view.rows = h('div', { class: 'rows', role: 'list' });
  view.detailEl = h('aside', { class: 'detail', 'aria-label': 'Деталі запиту', hidden: true });
  view.traffic.replaceChildren(h('div', { class: 'traffic-list' }, bar, view.rows), view.detailEl);
  renderRows();
  if (state.selectedReq) openDetail(state.selectedReq, false);
}

function rowHead() {
  return h('div', { class: 'row-head', 'aria-hidden': 'true' },
    h('span', null, 'Час'), h('span', null, 'Метод'), h('span', null, 'Шлях'), h('span', null, 'Статус'),
    h('span', { class: 'r' }, 'Тривалість'), h('span', { class: 'r c-size' }, 'Розмір'));
}

function rowEl(s, fresh = false) {
  const el = h('button', { class: `req${fresh ? ' fresh' : ''}`, type: 'button', role: 'listitem', onclick: () => openDetail(s.id) });
  fillRow(el, s);
  return el;
}

function fillRow(el, s) {
  const qi = s.url.indexOf('?');
  const path = qi >= 0 ? [s.url.slice(0, qi), h('span', { class: 'q' }, s.url.slice(qi))] : [s.url];
  const statusTxt = s.kind === 'ws' && s.status === 101 ? 'WS' : s.status ? String(s.status) : s.error ? 'ERR' : '…';
  el.setAttribute('aria-current', String(s.id === state.selectedReq));
  el.title = s.error ? `Помилка: ${s.error}` : '';
  el.replaceChildren(
    h('span', { class: 'time' }, fmtTime(s.time)),
    h('span', { class: 'method' }, s.method),
    h('span', { class: 'path' }, s.replayOf ? h('span', { class: 'replay-mark', title: `Повтор запиту #${s.replayOf}` }, '↻') : null, path),
    h('span', { class: 'status', dataset: { c: statusClass(s) } }, statusTxt),
    h('span', { class: 'dur' }, s.pending && s.kind === 'ws' && s.status === 101 ? 'відкрито' : fmtDur(s.duration)),
    h('span', { class: 'size' }, s.pending ? '' : fmtSize(s.resSize)));
}

function renderRows() {
  if (!view) return;
  const m = reqMap(view.id);
  const all = [...m.values()].sort((a, b) => b.id - a.id);
  const shown = all.filter(matches);
  view.rowEls = new Map();
  if (!all.length) {
    const t = current();
    view.rows.replaceChildren(h('div', { class: 'rows-empty' },
      h('strong', null, 'Запитів ще немає'),
      t && t.status === 'online'
        ? 'Відскануйте QR-код телефоном або вставте адресу в додаток. Кожен запит з\'явиться тут разом із заголовками й тілом.'
        : 'Запустіть тунель, і тут з\'являться всі запити, що проходять через нього.'));
  } else if (!shown.length) {
    view.rows.replaceChildren(rowHead(), h('div', { class: 'rows-empty' }, h('strong', null, 'Нічого не знайдено'), 'Змініть фільтр або вимкніть «Лише помилки».'));
  } else {
    const els = shown.map((s) => { const el = rowEl(s); view.rowEls.set(s.id, el); return el; });
    view.rows.replaceChildren(rowHead(), ...els);
  }
  updateCount();
}

function updateCount() {
  if (!view) return;
  const m = reqMap(view.id);
  const total = m.size;
  const visible = view.rowEls.size;
  view.count.textContent = (state.filter || state.errorsOnly) && total ? `${visible} з ${total}` : String(total);
}

function onBatch({ tunnelId, items }) {
  const m = reqMap(tunnelId);
  const isCurrent = view && view.id === tunnelId;
  let needFull = false;
  for (const s of items) {
    const prev = m.get(s.id);
    m.set(s.id, s);
    if (!isCurrent) continue;
    if (s.isNew && !prev) pulse('in');
    if (!s.pending && (!prev || prev.pending)) setTimeout(() => pulse('out', s.status), s.isNew ? 350 : 0);
    const el = view.rowEls.get(s.id);
    if (el) {
      if (matches(s)) fillRow(el, s); else { el.remove(); view.rowEls.delete(s.id); }
    } else if (matches(s)) {
      if (!view.rowEls.size) { needFull = true; continue; }
      const ne = rowEl(s, true);
      view.rowEls.set(s.id, ne);
      // нові id завжди більші — вставляємо одразу під шапкою
      const head = view.rows.querySelector('.row-head');
      if (head) head.after(ne); else view.rows.prepend(ne);
    }
    if (s.id === state.selectedReq && prev && prev.pending && !s.pending) openDetail(s.id, false);
  }
  // журнал обмежений так само, як в інспекторі (Налаштування → Інспектор)
  const limit = (state.settings.inspector && state.settings.inspector.maxEntries) || 1000;
  if (m.size > limit) {
    const ids = [...m.keys()].sort((a, b) => a - b).slice(0, m.size - limit);
    for (const id of ids) {
      m.delete(id);
      if (isCurrent) { const el = view.rowEls.get(id); if (el) { el.remove(); view.rowEls.delete(id); } }
    }
  }
  if (isCurrent) { if (needFull) renderRows(); else updateCount(); }
}

async function clearRequests(id) {
  await run(() => api.requests.clear(id));
  reqMap(id).clear();
  state.selectedReq = null;
  state.detail = null;
  if (view && view.id === id) { closeDetail(); renderRows(); }
}

/* ---------- деталі ---------- */
async function openDetail(reqId, resetTab = true) {
  if (!view) return;
  if (state.selectedReq !== reqId && resetTab) state.detailTab = 'res';
  state.selectedReq = reqId;
  for (const [id, el] of view.rowEls) el.setAttribute('aria-current', String(id === reqId));
  const d = await run(() => api.requests.get(view.id, reqId));
  if (!view || state.selectedReq !== reqId) return;
  if (!d) { toast('Запит уже видалено з журналу', 'error'); closeDetail(); return; }
  state.detail = d;
  view.traffic.classList.add('with-detail');
  view.detailEl.hidden = false;
  renderDetail(d);
}

function closeDetail() {
  state.selectedReq = null;
  state.detail = null;
  if (!view) return;
  view.traffic.classList.remove('with-detail');
  view.detailEl.hidden = true;
  view.detailEl.replaceChildren();
  for (const el of view.rowEls.values()) el.setAttribute('aria-current', 'false');
}

function renderDetail(d) {
  const t = current();
  const isWs = d.kind === 'ws';
  const meta = [
    `${fmtTime(d.time)}`,
    d.status ? `${d.status} ${d.statusMessage || ''}`.trim() : d.error ? `Помилка: ${d.error}` : 'Виконується…',
    d.duration != null ? fmtDur(d.duration) : null,
    isWs ? `↑ ${fmtSize(d.bytesIn)}  ↓ ${fmtSize(d.bytesOut)}` : `${fmtSize(d.resBody.size)}`,
    d.remote ? `з ${d.remote}` : null,
  ].filter(Boolean);

  const head = h('div', { class: 'detail-head' },
    h('div', { class: 'detail-title' },
      h('span', { class: 'method' }, isWs ? 'WS' : d.method),
      h('span', { class: 'path' }, d.url),
      h('button', { class: 'btn btn-ghost btn-sm icon-btn', type: 'button', title: 'Закрити (Esc)', 'aria-label': 'Закрити деталі', onclick: closeDetail }, icon('close'))),
    h('div', { class: 'detail-meta' }, meta.map((m) => h('span', null, m))),
    h('div', { class: 'detail-actions' },
      d.canReplay ? h('button', { class: 'btn btn-sm', type: 'button', onclick: () => replay(d.id) }, icon('replay'), 'Повторити') : null,
      !isWs ? h('button', { class: 'btn btn-sm', type: 'button', onclick: () => copy(toCurl(d, t && t.url), 'cURL скопійовано') }, icon('copy'), 'Копіювати як cURL') : null,
      d.resBody && d.resBody.text ? h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: () => copy(d.resBody.text, 'Тіло відповіді скопійовано') }, 'Копіювати відповідь') : null));

  const tabBtn = (key, label) => h('button', {
    class: 'tab', type: 'button', role: 'tab', 'aria-selected': String(state.detailTab === key),
    onclick: () => { state.detailTab = key; renderDetail(d); },
  }, label);
  const tabs = h('div', { class: 'tabs', role: 'tablist' }, tabBtn('res', 'Відповідь'), tabBtn('req', 'Запит'));

  const body = h('div', { class: 'detail-body', role: 'tabpanel' });
  if (state.detailTab === 'req') {
    body.append(h('h4', null, 'Заголовки'), headersList(d.reqHeaders), h('h4', null, 'Тіло'), bodyView(d.reqBody));
  } else {
    body.append(h('h4', null, 'Заголовки'), d.resHeaders.length ? headersList(d.resHeaders) : h('p', { class: 'muted' }, d.pending ? 'Очікую відповідь…' : 'Немає'));
    if (!isWs) body.append(h('h4', null, 'Тіло'), bodyView(d.resBody));
  }
  view.detailEl.replaceChildren(head, tabs, body);
}

function headersList(pairs) {
  return h('dl', { class: 'headers' }, pairs.map(([k, v]) => [h('dt', null, k), h('dd', null, v)]));
}

function bodyView(b) {
  if (!b || (b.kind === 'empty' && !b.truncated)) return h('p', { class: 'muted' }, 'Без тіла');
  const notes = [];
  if (b.truncated) {
    notes.push(h('p', { class: 'body-note' }, b.limit === 0
      ? `Збереження тіл вимкнено в налаштуваннях інспектора (${fmtSize(b.size)})`
      : `Показано перші ${fmtSize(b.limit)} із ${fmtSize(b.size)}`));
    if (b.limit === 0) return h('div', null, notes);
  }
  if (b.decodeError) notes.push(h('p', { class: 'body-note' }, `Не вдалося розпакувати (${b.encoding}): ${b.decodeError}`));
  if (b.kind === 'image') {
    return h('div', null, notes, b.dataUrl ? h('img', { class: 'img-preview', src: b.dataUrl, alt: 'Зображення з відповіді' }) : h('p', { class: 'muted' }, `Зображення ${b.contentType}, ${fmtSize(b.size)}`));
  }
  if (b.kind === 'json') {
    const pre = h('pre', { class: 'code' });
    if (b.text.length < 300_000) pre.append(highlightJson(b.text)); else pre.textContent = b.text;
    return h('div', null, notes, pre);
  }
  if (b.kind === 'text') return h('div', null, notes, h('pre', { class: 'code' }, b.text));
  return h('div', null, notes, h('p', { class: 'muted' }, `Бінарні дані ${b.contentType || ''}, ${fmtSize(b.size)}. Перші байти:`), h('pre', { class: 'code' }, b.hex || ''));
}

function highlightJson(text) {
  const frag = document.createDocumentFragment();
  const re = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) frag.append(text.slice(last, m.index));
    if (m[1]) { frag.append(h('span', { class: m[2] ? 'jk' : 'js' }, m[1])); if (m[2]) frag.append(m[2]); }
    else if (m[3]) frag.append(h('span', { class: 'jb' }, m[3]));
    else frag.append(h('span', { class: 'jn' }, m[4]));
    last = re.lastIndex;
  }
  frag.append(text.slice(last));
  return frag;
}

const CURL_SKIP = new Set(['host', 'content-length', 'connection', 'accept-encoding', 'cdn-loop', 'cf-ray', 'cf-visitor', 'cf-connecting-ip', 'cf-ipcountry', 'cf-warp-tag-id', 'x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host', 'x-real-ip', 'via']);
function shq(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }
function toCurl(d, baseUrl) {
  const t = current();
  const base = (baseUrl || (t ? `http://${t.targetLabel.replace(/^https?:\/\//, '')}` : '')).replace(/\/$/, '');
  const parts = [`curl -X ${d.method} ${shq(base + d.url)}`];
  for (const [k, v] of d.reqHeaders) {
    if (CURL_SKIP.has(k.toLowerCase())) continue;
    parts.push(`  -H ${shq(`${k}: ${v}`)}`);
  }
  const b = d.reqBody;
  if (b && (b.kind === 'json' || b.kind === 'text') && !b.truncated) parts.push(`  --data-raw ${shq(b.kind === 'json' ? JSON.stringify(JSON.parse(b.text)) : b.text)}`);
  return parts.join(' \\\n');
}

async function replay(reqId) {
  const code = await run(() => api.requests.replay(view.id, reqId));
  if (code !== undefined) toast(`Повторено: ${code}`);
}

/* ---------- діалог тунелю ---------- */
let editing = null;

function relayHost() {
  const url = state.settings.relay.url;
  if (!url) return null;
  try { return new URL(/^[a-z]+:\/\//i.test(url) ? url : `https://${url}`).host; } catch { return null; }
}

function updateProviderFields() {
  const form = $('#tunnelForm');
  const p = form.elements.provider.value;
  for (const el of form.querySelectorAll('[data-for]')) el.hidden = el.dataset.for !== p;
  const host = relayHost();
  $('#subdomainSuffix').textContent = host ? `.${host}` : '.ваш-домен';
  const hint = $('#relayHint');
  hint.replaceChildren();
  if (!host || !state.settings.relay.hasToken) {
    hint.append('Спершу вкажіть адресу й токен сервера в ', h('button', { type: 'button', class: 'btn-link', onclick: () => { $('#tunnelDialog').close(); openSettings('relay'); } }, 'налаштуваннях'), '.');
  } else {
    hint.append('Порожньо — випадковий субдомен.');
  }
}

function openTunnelDialog(t = null) {
  editing = t;
  const form = $('#tunnelForm');
  form.reset();
  $('#tunnelFormError').hidden = true;
  $('#tunnelDialogTitle').textContent = t ? 'Змінити тунель' : 'Новий тунель';
  $('#tunnelSubmit').textContent = t ? 'Зберегти' : 'Створити тунель';
  if (t) {
    form.elements.name.value = t.name;
    form.elements.target.value = t.target;
    form.elements.provider.value = t.provider;
    form.elements.subdomain.value = t.subdomain || '';
    form.elements.lanPort.value = t.lanPort || '';
    form.elements.hostRewrite.checked = !!t.hostRewrite;
    form.elements.autoStart.checked = !!t.autoStart;
  } else if (state.settings.relay.hasToken && state.settings.relay.url) {
    form.elements.provider.value = 'relay';
  }
  updateProviderFields();
  $('#tunnelDialog').showModal();
  form.elements[t ? 'name' : 'target'].focus();
}

async function submitTunnel(e) {
  e.preventDefault();
  const form = $('#tunnelForm');
  const f = form.elements;
  const data = {
    name: f.name.value, target: f.target.value, provider: f.provider.value,
    subdomain: f.subdomain.value, lanPort: f.lanPort.value ? Number(f.lanPort.value) : null,
    hostRewrite: f.hostRewrite.checked, autoStart: f.autoStart.checked,
  };
  const err = $('#tunnelFormError');
  err.hidden = true;
  if (!data.target.trim()) { err.textContent = 'Вкажіть порт локального сервера, наприклад 3000.'; err.hidden = false; f.target.focus(); return; }
  if (data.provider === 'relay' && (!relayHost() || !state.settings.relay.hasToken)) {
    err.textContent = 'Для власного сервера потрібні адреса й токен. Відкрийте налаштування або оберіть Cloudflare.'; err.hidden = false; return;
  }
  const btn = $('#tunnelSubmit');
  btn.disabled = true;
  try {
    if (editing) {
      const s = await api.tunnels.update(editing.id, data);
      upsert(s);
      toast('Збережено');
    } else {
      const s = await api.tunnels.create(data);
      upsert(s);
      select(s.id);
      api.tunnels.start(s.id).catch((x) => toast(x.message, 'error'));
    }
    $('#tunnelDialog').close();
  } catch (x) {
    err.textContent = x.message;
    err.hidden = false;
  } finally {
    btn.disabled = false;
  }
}

function confirmDialog(title, text, okLabel = 'Видалити') {
  const dlg = $('#confirmDialog');
  $('#confirmTitle').textContent = title;
  $('#confirmText').textContent = text;
  $('#confirmOk').textContent = okLabel;
  dlg.returnValue = '';
  dlg.showModal();
  return new Promise((resolve) => dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true }));
}

async function removeTunnel(t) {
  const ok = await confirmDialog(`Видалити «${t.name}»?`, 'Тунель зупиниться, журнал запитів буде очищено.');
  if (!ok) return;
  await run(() => api.tunnels.remove(t.id));
}

/* ---------- вигляд ---------- */
const darkMq = window.matchMedia('(prefers-color-scheme: dark)');

function applyAppearance() {
  const a = (state.settings && state.settings.appearance) || {};
  // main виставляє nativeTheme.themeSource, тож media query вже відображає вибір користувача
  document.documentElement.dataset.theme = darkMq.matches ? 'dark' : 'light';
  document.documentElement.dataset.accent = a.accent || 'amber';
  document.body.classList.toggle('compact', !!a.compact);
}
darkMq.addEventListener('change', applyAppearance);

/* ---------- налаштування ---------- */
let savedTimer = null;
function flashSaved(text = 'Збережено') {
  const el = $('#settingsSaved');
  el.textContent = text;
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => { el.textContent = ''; }, 1800);
}

async function updateSettings(patch) {
  const s = await run(() => api.settings.update(patch));
  if (!s) return;
  state.settings = s;
  applyAppearance();
  fillSettings();
  flashSaved();
}

function showPane(name) {
  for (const b of document.querySelectorAll('.settings-nav .nav-item')) b.setAttribute('aria-current', String(b.dataset.pane === name));
  for (const p of document.querySelectorAll('.settings-pane .pane')) p.hidden = p.dataset.pane !== name;
  $('.settings-pane').scrollTop = 0;
}

function setRadio(name, value) {
  for (const r of document.querySelectorAll(`#settingsDialog input[name="${name}"]`)) r.checked = r.value === value;
}
function setCheck(name, value, disabled = false) {
  const el = $(`#settingsDialog input[name="${name}"]`);
  el.checked = !!value;
  el.disabled = disabled;
  el.closest('.switch-row').classList.toggle('disabled', disabled);
}

function fillSettings() {
  const s = state.settings;
  const info = state.info || {};
  setRadio('theme', s.appearance.theme);
  setRadio('accent', s.appearance.accent);
  setCheck('compact', s.appearance.compact);

  setCheck('closeToTray', s.app.closeToTray, info.hasTray === false);
  const loginOk = info.loginItemsSupported && info.packaged;
  setCheck('openAtLogin', s.app.openAtLogin, !loginOk);
  setCheck('startHidden', s.app.startHidden, !loginOk || !s.app.openAtLogin);
  $('#loginHint').textContent = !info.loginItemsSupported
    ? 'На цій системі недоступно.'
    : !info.packaged
      ? 'Працює у встановленій версії (.exe), не в режимі npm start.'
      : 'Тунелі з позначкою «Запускати разом із DevBridge» піднімуться самі.';
  setCheck('notifications', s.app.notifications);
  setCheck('copyUrlOnStart', s.app.copyUrlOnStart);

  $('#settingsDialog select[name="cfProtocol"]').value = s.cloudflare.protocol;
  $('#settingsDialog input[name="maxEntries"]').value = s.inspector.maxEntries;
  $('#settingsDialog input[name="maxBodyMB"]').value = s.inspector.maxBodyMB;

  $('#aboutVersion').textContent = `Версія ${info.version || ''}. Electron ${info.electron || ''}, Node ${info.node || ''}.`;
}

function renderCloudflared() {
  const info = state.cloudflared;
  const st = $('#cfStatus');
  const btn = $('#cfInstall');
  if (info) {
    st.textContent = info.source === 'system'
      ? `Використовується системний cloudflared ${info.version || ''} (${info.path}).`
      : `cloudflared ${info.version || ''} встановлено в папку застосунку.`;
    btn.hidden = info.source === 'system';
    btn.textContent = 'Оновити cloudflared';
  } else {
    st.textContent = 'Ще не завантажено. Завантажиться сам при першому запуску Cloudflare-тунелю, або натисніть кнопку.';
    btn.hidden = false;
    btn.textContent = 'Завантажити cloudflared';
  }
}

function openSettings(pane = 'appearance') {
  const form = $('#relayForm');
  form.elements.relayUrl.value = state.settings.relay.url || '';
  form.elements.relayToken.value = '';
  form.elements.relayToken.placeholder = state.settings.relay.hasToken ? `збережено ${state.settings.relay.tokenHint}` : 'вставте токен';
  $('#relayTestResult').textContent = '';
  $('#relayTestResult').className = 'test-result';
  $('#settingsSaved').textContent = '';
  fillSettings();
  renderCloudflared();
  showPane(pane);
  const dlg = $('#settingsDialog');
  if (!dlg.open) dlg.showModal();
}

async function testRelayConn() {
  const form = $('#relayForm');
  const out = $('#relayTestResult');
  out.className = 'test-result';
  out.textContent = 'Перевіряю…';
  try {
    const r = await api.settings.testRelay({ url: form.elements.relayUrl.value, token: form.elements.relayToken.value });
    out.className = 'test-result ok';
    const n = r.tunnels.length;
    out.textContent = `З'єднано. Relay ${r.version}, домен ${r.baseDomain}, ${n} ${plural(n, 'активний тунель', 'активні тунелі', 'активних тунелів')}.`;
  } catch (e) {
    out.className = 'test-result bad';
    out.textContent = e.message;
  }
}

async function saveRelay(e) {
  e.preventDefault();
  const form = $('#relayForm');
  const s = await run(() => api.settings.saveRelay({ url: form.elements.relayUrl.value, token: form.elements.relayToken.value }));
  if (!s) return;
  state.settings = s;
  form.elements.relayToken.value = '';
  form.elements.relayToken.placeholder = s.relay.hasToken ? `збережено ${s.relay.tokenHint}` : 'вставте токен';
  flashSaved('Сервер збережено');
}

async function installCf() {
  const btn = $('#cfInstall');
  const bar = $('#cfProgress');
  btn.disabled = true;
  bar.hidden = false;
  try {
    state.cloudflared = await api.cloudflared.install();
    toast('cloudflared готовий');
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    btn.disabled = false;
    bar.hidden = true;
    renderCloudflared();
  }
}

function bindSettings() {
  const dlg = $('#settingsDialog');
  for (const b of dlg.querySelectorAll('.settings-nav .nav-item')) b.addEventListener('click', () => showPane(b.dataset.pane));
  $('#settingsClose').addEventListener('click', () => dlg.close());

  for (const r of dlg.querySelectorAll('input[name="theme"]')) r.addEventListener('change', () => updateSettings({ appearance: { theme: r.value } }));
  for (const r of dlg.querySelectorAll('input[name="accent"]')) r.addEventListener('change', () => updateSettings({ appearance: { accent: r.value } }));
  dlg.querySelector('input[name="compact"]').addEventListener('change', (e) => updateSettings({ appearance: { compact: e.target.checked } }));
  for (const key of ['closeToTray', 'openAtLogin', 'startHidden', 'notifications', 'copyUrlOnStart']) {
    dlg.querySelector(`input[name="${key}"]`).addEventListener('change', (e) => updateSettings({ app: { [key]: e.target.checked } }));
  }
  dlg.querySelector('select[name="cfProtocol"]').addEventListener('change', (e) => updateSettings({ cloudflare: { protocol: e.target.value } }));
  dlg.querySelector('input[name="maxEntries"]').addEventListener('change', (e) => updateSettings({ inspector: { maxEntries: Number(e.target.value) } }));
  dlg.querySelector('input[name="maxBodyMB"]').addEventListener('change', (e) => updateSettings({ inspector: { maxBodyMB: Number(e.target.value) } }));

  $('#relayForm').addEventListener('submit', saveRelay);
  $('#relayTest').addEventListener('click', testRelayConn);
  $('#cfInstall').addEventListener('click', installCf);
  $('#openDataFolder').addEventListener('click', () => run(() => api.settings.openDataFolder()));
}

/* ---------- події з main ---------- */
function upsert(s) {
  const i = state.tunnels.findIndex((t) => t.id === s.id);
  const prev = i >= 0 ? state.tunnels[i] : null;
  if (i >= 0) state.tunnels[i] = s; else state.tunnels.push(s);
  renderSidebar();
  if (!view && state.tunnels.length === 1 && !state.selected) { select(s.id); return; }
  if (view && view.id === s.id) {
    renderHead(s);
    const pipeChanged = !prev || ['status', 'url', 'error', 'info', 'localUp', 'targetLabel', 'provider', 'active'].some((k) => JSON.stringify(prev[k]) !== JSON.stringify(s[k])) || JSON.stringify(prev.urls) !== JSON.stringify(s.urls);
    if (pipeChanged) renderPipe(s);
    if (prev && prev.status !== s.status && !reqMap(s.id).size) renderRows();
  } else if (!view) {
    renderMain();
  }
}

function bindEvents() {
  api.on.state(upsert);
  api.on.removed((id) => {
    state.tunnels = state.tunnels.filter((t) => t.id !== id);
    state.requests.delete(id);
    state.loaded.delete(id);
    if (state.selected === id) { state.selected = state.tunnels[0] ? state.tunnels[0].id : null; state.selectedReq = null; }
    renderSidebar();
    renderMain();
  });
  api.on.requests(onBatch);
  api.on.log(({ tunnelId, entry }) => {
    if (view && view.id === tunnelId && view.logEl) {
      const atBottom = view.logEl.scrollTop + view.logEl.clientHeight >= view.logEl.scrollHeight - 4;
      view.logEl.append(`\n${fmtTime(entry.time)}  ${entry.line}`);
      if (atBottom) view.logEl.scrollTop = view.logEl.scrollHeight;
    }
  });
  api.on.cloudflaredProgress((p) => {
    const bar = $('#cfProgress');
    bar.hidden = false;
    bar.firstElementChild.style.width = p.total ? `${Math.round((p.received / p.total) * 100)}%` : '50%';
  });
  api.on.cloudflaredInfo((info) => { state.cloudflared = info; if ($('#settingsDialog').open) renderCloudflared(); });

  api.on.select((id) => { if (byId(id)) select(id); });

  $('#newTunnelBtn').addEventListener('click', () => openTunnelDialog());
  $('#settingsBtn').addEventListener('click', () => openSettings());
  $('#tunnelForm').addEventListener('submit', submitTunnel);
  $('#tunnelCancel').addEventListener('click', () => $('#tunnelDialog').close());
  for (const r of $('#tunnelForm').elements.provider) r.addEventListener('change', updateProviderFields);
  bindSettings();

  document.addEventListener('keydown', (e) => {
    const anyDialog = document.querySelector('dialog[open]');
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n' && !anyDialog) { e.preventDefault(); openTunnelDialog(); }
    if (e.key === 'Escape' && !anyDialog && state.selectedReq) closeDetail();
  });
}

/* ---------- старт ---------- */
(async function init() {
  bindEvents();
  const data = await run(() => api.init());
  if (!data) return;
  state.tunnels = data.tunnels;
  state.settings = data.settings;
  state.cloudflared = data.cloudflared;
  state.info = data.info;
  applyAppearance();
  $('#appVersion').textContent = `v${data.version}`;
  document.body.dataset.platform = data.platform;
  renderSidebar();
  if (state.tunnels.length) select(state.tunnels[0].id); else renderMain();
}());
