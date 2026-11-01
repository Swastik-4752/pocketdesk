// PocketDesk phone app. Plain JS, no build step. All text goes in through textContent (never innerHTML).

// ---------- tiny helpers ----------
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked' || k === 'disabled' || k === 'selected') el[k] = !!v;
    else if (k === 'icon') continue;
    else el.setAttribute(k, v === true ? '' : v);
  }
  if (props?.icon) el.prepend(icon(props.icon));
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

/** Line icons (24×24, stroke = currentColor). Static path data only. */
const ICONS = {
  spark: 'M12 2.8v6.4M12 14.8v6.4M2.8 12h6.4M14.8 12h6.4M5.5 5.5l4.5 4.5M14 14l4.5 4.5M18.5 5.5L14 10M10 14l-4.5 4.5',
  swap: 'M7 4L4 7l3 3M4 7h13M17 14l3 3-3 3M20 17H7',
  folder: 'M3.5 7.5A2 2 0 0 1 5.5 5.5h3.6l2 2h7.4a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z',
  code: 'M8.5 8l-4 4 4 4M15.5 8l4 4-4 4M13.5 5.5l-3 13',
  chart: 'M5 19.5v-7M12 19.5v-14M19 19.5v-10',
  laptop: 'M5.5 6.5a1 1 0 0 1 1-1h11a1 1 0 0 1 1 1v8.5h-13zM3 18.5h18',
  sliders: 'M4 7h9M17 7h3M4 17h3M11 17h9M15 5v4M9 15v4',
  back: 'M15 5l-7 7 7 7',
  send: 'M12 19V5.5M6 11l6-6 6 6',
  plus: 'M12 5v14M5 12h14',
  refresh: 'M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4.5v4.5H15',
  chevron: 'M9.5 6l6 6-6 6',
  lock: 'M7 11V8a5 5 0 0 1 10 0v3M5.5 11h13v9h-13z',
  suitcase: 'M9 7V5.5a1.5 1.5 0 0 1 1.5-1.5h3A1.5 1.5 0 0 1 15 5.5V7M4.5 7h15v12h-15zM9 7v12M15 7v12',
};
function icon(name, cls = '') {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', `icon${cls ? ` ${cls}` : ''}`);
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(NS, 'path');
  p.setAttribute('d', ICONS[name] || '');
  svg.append(p);
  return svg;
}

/** replaceChildren that skips null/false (the DOM would print them as text). */
const fill = (el, ...kids) => el.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false));

class ApiError extends Error {
  constructor(status, data) {
    super(data?.error || `Request failed (${status})`);
    this.status = status;
    this.data = data;
  }
}

async function api(method, url, body, { raw, auto } = {}) {
  const opts = { method, headers: { 'x-pocketdesk': '1' }, credentials: 'same-origin' };
  if (auto) opts.headers['x-pd-auto'] = '1';
  if (raw) opts.body = raw;
  else if (body !== undefined) {
    opts.headers['content-type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* not json */
  }
  if (!res.ok) {
    if (res.status === 423 && data?.locked) showLock();
    throw new ApiError(res.status, data);
  }
  return data;
}

const qs = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v != null && v !== '')).toString();
const enc = (p) => p.split('/').map(encodeURIComponent).join('/');
const dec = (p) => p.split('/').map(decodeURIComponent).join('/');

function ago(ms) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(ms).toLocaleDateString();
}
function size(n) {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}
function duration(ms) {
  if (!ms && ms !== 0) return '';
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

let toastTimer;
function toast(msg, bad = false) {
  document.querySelector('.toast')?.remove();
  const t = h('div', { class: `toast${bad ? ' bad' : ''}`, role: 'status', text: msg });
  document.body.append(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), bad ? 6000 : 3000);
}
const fail = (e) => toast(e.message || String(e), true);

const STATE_LABEL = { starting: 'starting', working: 'working', waiting: 'needs you', idle: 'done', closed: 'paused', error: 'error' };
const chip = (state) => h('span', { class: `chip ${state}`, text: STATE_LABEL[state] || state });

/** Very small markdown: ``` fences, # headings, - lists, `code`, **bold**. Built with DOM nodes only. */
function md(text) {
  const box = h('div', { class: 'msg text' });
  const parts = String(text).split(/```/);
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      const nl = part.indexOf('\n');
      box.append(h('pre', {}, h('code', { text: nl >= 0 ? part.slice(nl + 1).replace(/\n$/, '') : part })));
      return;
    }
    let list = null;
    let para = [];
    const flush = () => {
      if (para.length) box.append(h('p', {}, inline(para.join('\n'))));
      para = [];
    };
    for (const line of part.split('\n')) {
      const hm = /^#{1,6}\s+(.*)$/.exec(line);
      const lm = /^\s*(?:[-*]|\d+\.)\s+(.*)$/.exec(line);
      if (hm) {
        flush();
        list = null;
        box.append(h('h4', {}, inline(hm[1])));
      } else if (lm) {
        flush();
        if (!list) {
          list = h('ul');
          box.append(list);
        }
        list.append(h('li', {}, inline(lm[1])));
      } else if (!line.trim()) {
        flush();
        list = null;
      } else {
        list = null;
        para.push(line);
      }
    }
    flush();
  });
  return box;
}
function inline(s) {
  const out = [];
  const re = /(`[^`]+`|\*\*[^*]+\*\*)/g;
  let last = 0;
  let m;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(s.slice(last, m.index));
    out.push(m[0][0] === '`' ? h('code', { text: m[0].slice(1, -1) }) : h('strong', { text: m[0].slice(2, -2) }));
    last = m.index + m[0].length;
  }
  out.push(s.slice(last));
  return out;
}

// ---------- app state ----------
const app = {
  me: null,
  sessions: [],
  hub: null,
  cleanup: [],
};

function onLeave(fn) {
  app.cleanup.push(fn);
}

async function boot() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data?.type === 'navigate') location.href = e.data.url;
    });
  }
  try {
    app.me = await api('GET', '/api/me');
  } catch (e) {
    if (e.status === 401) return renderPairing();
    document.getElementById('app').replaceChildren(h('div', { class: 'boot' }, `Cannot reach the laptop: ${e.message}`, h('br'), h('button', { class: 'btn', onclick: () => location.reload(), text: 'Try again' })));
    return;
  }
  window.addEventListener('hashchange', () => !app.locked && render());
  watchIdle();
  if (app.me.locked) return showLock();
  startApp();
}

function startApp() {
  app.locked = false;
  app.travel = app.me.travel || null;
  connectHub();
  render();
  // keep the Travel mode banner current (background call: does not count as activity for the PIN lock)
  setInterval(() => api('GET', '/api/travel', undefined, { auto: true }).then((t) => setTravel(t.active ? t : null)).catch(() => {}), 60_000);
}

function setTravel(t) {
  app.travel = t;
  const old = document.getElementById('travel-banner');
  const fresh = travelBanner();
  if (old && fresh) old.replaceWith(fresh);
  else if (old) old.remove();
  else if (fresh) document.querySelector('.shell main')?.prepend(fresh);
}

function travelBanner() {
  const t = app.travel;
  if (!t?.active || (location.hash || '').startsWith('#/travel')) return null;
  const now = Date.now();
  const text = t.sleepAt ? 'Travel mode · laptop sleeps in a minute' : t.graceUntil ? 'Travel mode · time is up, sleeping soon'
    : `Travel mode · ${Math.max(0, Math.ceil((t.endsAt - now) / 60000))} min left`;
  return h('a', { id: 'travel-banner', class: 'card row link-card travel-banner', href: '#/travel' }, h('span', { class: 'lead-ico' }, icon('suitcase')), h('span', { class: 'grow', text }), icon('chevron', 'chev'));
}

// ---------- PIN lock ----------
let lastActive = Date.now();
function watchIdle() {
  const mark = () => (lastActive = Date.now());
  for (const ev of ['pointerdown', 'keydown', 'touchstart']) window.addEventListener(ev, mark, { passive: true });
  const check = () => {
    const l = app.me?.lock;
    if (app.locked || app.me?.kind !== 'device' || !l?.pinSet) return;
    if (Date.now() - lastActive > l.lockMinutes * 60_000) {
      api('POST', '/api/lock/now').catch(() => {});
      showLock();
    }
  };
  setInterval(check, 15_000);
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && check());
}

function showLock() {
  if (app.locked) return;
  app.locked = true;
  for (const fn of app.cleanup.splice(0)) fn();
  app.hub?.close();
  app.hub = null;
  const pin = h('input', { type: 'password', inputmode: 'numeric', autocomplete: 'off', maxlength: 8, placeholder: 'PIN', class: 'pin-input' });
  const btn = h('button', { class: 'btn primary block', text: 'Unlock' });
  const go = async () => {
    btn.disabled = true;
    try {
      await api('POST', '/api/lock/unlock', { pin: pin.value });
      app.me = await api('GET', '/api/me');
      lastActive = Date.now();
      startApp();
    } catch (e) {
      fail(e);
      pin.value = '';
      btn.disabled = false;
      if (e.status === 401 && /unpaired/i.test(e.message)) setTimeout(() => location.reload(), 2500);
    }
  };
  btn.onclick = go;
  pin.addEventListener('keydown', (e) => e.key === 'Enter' && go());
  document.getElementById('app').replaceChildren(h('main', { class: 'lock-screen' },
    h('div', { class: 'card stack' },
      h('div', { class: 'lock-ico' }, icon('lock')),
      h('h2', { text: 'PocketDesk is locked' }),
      h('p', { class: 'small muted', text: 'Type your PIN. Claude and your commands keep running on the laptop while this is locked.' }),
      pin, btn,
      h('button', { class: 'btn small danger', style: 'margin-top:18px', text: '🚨 Panic (lost phone? lock everything out)', onclick: panic }))));
  setTimeout(() => pin.focus(), 50);
}

function connectHub() {
  refreshSessions();
  const es = new EventSource('/api/events');
  es.addEventListener('hub', (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'session') {
      const i = app.sessions.findIndex((s) => s.id === msg.session.id);
      if (i >= 0) app.sessions[i] = msg.session;
      else app.sessions.unshift(msg.session);
    } else if (msg.type === 'removed') {
      app.sessions = app.sessions.filter((s) => s.id !== msg.id);
    }
    updateBadge();
    if (location.hash === '' || location.hash === '#/' || location.hash === '#/claude') renderListOnly();
  });
  es.addEventListener('open', () => refreshSessions());
  app.hub = es;
}

async function refreshSessions() {
  try {
    const r = await api('GET', '/api/sessions', undefined, { auto: true });
    app.sessions = r.sessions;
    updateBadge();
    if (location.hash === '' || location.hash === '#/' || location.hash === '#/claude') renderListOnly();
  } catch {
    /* offline for a moment */
  }
}

function updateBadge() {
  const n = app.sessions.reduce((a, s) => a + (s.pendingCount || 0), 0);
  const b = document.getElementById('claude-badge');
  if (b) {
    b.textContent = n;
    b.style.display = n ? '' : 'none';
  }
  document.title = n ? `(${n}) PocketDesk` : 'PocketDesk';
}

// ---------- shell + router ----------
function shell({ title, back, actions, body, composer }) {
  const tab = (href, ico, label, on, extra) => h('a', { href, class: on ? 'on' : '', 'aria-current': on ? 'page' : null },
    h('span', { class: 'ico' }, icon(ico), extra), h('span', { class: 'lbl', text: label }));
  const r = location.hash || '#/claude';
  const tabs = h('nav', { class: 'tabs', 'aria-label': 'Sections' },
    tab('#/claude', 'spark', 'Claude', r.startsWith('#/claude') || r.startsWith('#/s/') || r.startsWith('#/new'), h('span', { class: 'badge', id: 'claude-badge', style: 'display:none' })),
    tab('#/pc', 'swap', 'From PC', r.startsWith('#/pc')),
    tab('#/files', 'folder', 'Files', r.startsWith('#/files') || r.startsWith('#/view') || r.startsWith('#/gallery')),
    tab('#/p', 'code', 'Project', r.startsWith('#/p') || r.startsWith('#/t/') || r.startsWith('#/git')),
    tab('#/usage', 'chart', 'Usage', r.startsWith('#/usage')),
    tab('#/laptop', 'laptop', 'Laptop', ['#/laptop', '#/travel', '#/screen', '#/clip', '#/send', '#/find', '#/activity'].some((p) => r.startsWith(p))),
    app.me.kind === 'laptop' ? tab('#/setup', 'sliders', 'Setup', r.startsWith('#/setup')) : null,
  );
  const top = h('header', { class: 'topbar' },
    back ? h('button', { class: 'back', 'aria-label': 'Back', onclick: () => (typeof back === 'string' ? (location.hash = back) : history.back()) }, icon('back')) : h('span', { class: 'brand' }, icon('spark')),
    h('h1', { text: title }),
    actions || null,
  );
  const root = h('div', { class: `shell${composer ? ' has-composer' : ''}` }, top, h('main', {}, travelBanner(), body), composer || null, tabs);
  document.getElementById('app').replaceChildren(root);
  updateBadge();
  return root;
}

function render() {
  for (const fn of app.cleanup.splice(0)) fn();
  const [pathPart, query = ''] = (location.hash.slice(1) || '/claude').split('?');
  const [, a, b, ...rest] = pathPart.split('/');
  try {
    if (a === 'claude' || a === '' || a == null) return viewClaude();
    if (a === 'new') return viewNew(new URLSearchParams(query));
    if (a === 's') return viewSession(b);
    if (a === 'files') return viewFiles(b, rest.join('/'));
    if (a === 'view') return viewFile(b, `${rest.join('/')}?${query}`);
    if (a === 'laptop') return viewLaptop();
    if (a === 'travel') return viewTravel();
    if (a === 'prompts') return viewPrompts();
    if (a === 'screen') return viewScreen();
    if (a === 'clip') return viewClip();
    if (a === 'send') return viewSend(new URLSearchParams(query));
    if (a === 'find') return viewFind();
    if (a === 'pc') return b ? viewPcChat(b) : viewPc();
    if (a === 'gallery') return viewGallery(b, rest.join('/'));
    if (a === 'p') return viewProject(b, rest.join('/'));
    if (a === 't') return viewTask(b);
    if (a === 'git') return viewGit(b, rest.join('/'));
    if (a === 'activity') return viewActivity();
    if (a === 'usage') return viewUsage();
    if (a === 'setup' && app.me.kind === 'laptop') return viewSetup();
    location.hash = '#/claude';
  } catch (e) {
    fail(e);
  }
}

// ---------- pairing (unpaired phone) ----------
function renderPairing() {
  const code = h('input', { type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 6, placeholder: '6-digit code' });
  const name = h('input', { type: 'text', value: guessDeviceName(), maxlength: 40 });
  const btn = h('button', { class: 'btn primary block', text: 'Pair this device' });
  btn.onclick = async () => {
    btn.disabled = true;
    try {
      await api('POST', '/api/pair', { code: code.value, name: name.value });
      location.reload();
    } catch (e) {
      fail(e);
      btn.disabled = false;
    }
  };
  document.getElementById('app').replaceChildren(h('main', {},
    h('div', { class: 'card stack' },
      h('h2', { text: 'Pair this device with your laptop' }),
      h('p', { class: 'muted small', text: 'On the laptop, open PocketDesk (http://127.0.0.1:8765), go to Setup and press "Make pairing code". Type that code here. You only do this once per device.' }),
      h('div', {}, h('label', { class: 'field', text: 'Pairing code' }), code),
      h('div', {}, h('label', { class: 'field', text: 'Name for this device' }), name),
      btn,
    )));
}
function guessDeviceName() {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android phone';
  return 'My device';
}

// ---------- Claude: list ----------
function viewClaude() {
  const acc = app.me.account;
  const body = h('div', { id: 'claude-list' });
  const chips = h('div');
  loadPrompts().then((list) => fill(chips, promptChips(list)));
  shell({
    title: 'Claude',
    actions: h('a', { class: 'btn primary small', href: '#/new', icon: 'plus', text: 'New' }),
    body: [
      h('div', { class: 'card row' },
        h('div', { class: 'grow' },
          h('div', { class: 'small muted', text: 'Running on account' }),
          h('div', { class: 'ellipsis', text: acc ? acc.email || acc.name : 'Not picked yet' })),
        acc ? null : h('span', { class: 'chip error', text: 'setup needed' })),
      chips,
      body,
    ],
  });
  renderListOnly();
  refreshSessions();
}

function renderListOnly() {
  const box = document.getElementById('claude-list');
  if (!box) return;
  if (!app.sessions.length) {
    box.replaceChildren(h('div', { class: 'empty' }, h('p', { text: 'No sessions yet.' }), h('a', { class: 'btn primary', href: '#/new', text: 'Start one' })));
    return;
  }
  box.replaceChildren(...app.sessions.map((s) => h('a', { class: 'card session-card', href: `#/s/${s.id}` },
    h('div', { class: 'row' },
      h('div', { class: 'title grow ellipsis', text: s.title }),
      s.pendingCount ? h('span', { class: 'badge', text: s.pendingCount }) : null,
      chip(s.state)),
    h('div', { class: 'small muted ellipsis', text: `${s.rootName}${s.rel ? ` / ${s.rel}` : ''} · ${ago(s.updatedAt)}` }),
    h('div', { class: 'small muted ellipsis', text: `${s.account || s.profileId || ''}${s.model && s.model !== 'default' ? ` · ${s.model}` : ''}` }),
    s.preview ? h('div', { class: 'preview', text: s.preview }) : null)));
}

// ---------- Claude: new session ----------
async function viewNew(params) {
  const roots = app.me.roots;
  const st = { root: Number(params.get('root') ?? 0), rel: params.get('path') || '' };
  const prompt = h('textarea', { rows: 5, placeholder: 'What should Claude do?' });
  prompt.value = params.get('prompt') || '';
  const photos = [];
  const pp = photoPicker(photos);
  const saved = h('div', { class: 'chips' });
  loadPrompts().then((list) => fill(saved, list.map((p) => h('button', { class: 'chip-link', type: 'button', text: p.name, onclick: () => {
    prompt.value = p.text;
    if (p.rootId != null && roots[p.rootId]) {
      st.root = p.rootId;
      st.rel = p.rel || '';
      loadPicker();
    }
  } }))));
  const saveAs = h('button', { class: 'btn small', type: 'button', text: '⚡ Save as a button', onclick: async () => {
    if (!prompt.value.trim()) return toast('Write the prompt first', true);
    const name = window.prompt('Name for this button', prompt.value.trim().slice(0, 30));
    if (!name) return;
    const fixFolder = confirm(`Always run it in this folder?\n\n${roots[st.root]?.name || '?'}${st.rel ? ` / ${st.rel}` : ''}\n\nOK = this folder, Cancel = pick the folder each time`);
    try {
      const list = await loadPrompts();
      list.push({ name, text: prompt.value.trim(), ...(fixFolder ? { rootId: st.root, rel: st.rel } : {}) });
      await api('PUT', '/api/prompts', { prompts: list });
      toast('Saved. It is on the Claude tab now.');
    } catch (e) { fail(e); }
  } });
  const account = h('select', {}, h('option', { text: 'Loading accounts…' }));
  const model = h('select', { disabled: true }, h('option', { text: 'Loading models…' }));
  const effort = h('select', { disabled: true }, h('option', { value: '', text: 'Default effort' }));
  const modelInfo = h('div', { class: 'small muted' });
  let models = [];
  const EFFORT_TEXT = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' };

  function fillEfforts() {
    const m = models.find((x) => x.value === model.value);
    const prev = effort.value;
    const levels = m?.efforts || [];
    fill(effort, h('option', { value: '', text: 'Default effort' }), levels.map((l) => h('option', { value: l, text: EFFORT_TEXT[l] || l, selected: l === prev })));
    effort.disabled = !levels.length;
    modelInfo.textContent = m?.description || '';
  }
  async function loadModels() {
    model.disabled = true;
    effort.disabled = true;
    fill(model, h('option', { text: 'Loading models…' }));
    modelInfo.textContent = 'Asking Claude for this account’s models…';
    try {
      const r = await api('GET', `/api/accounts/${encodeURIComponent(account.value)}/models`);
      models = r.models;
      if (!models.length) throw new Error(r.error || 'No models returned');
      fill(model, models.map((m) => h('option', { value: m.value, text: m.displayName })));
      model.disabled = false;
      fillEfforts();
    } catch (e) {
      models = [{ value: 'default', displayName: 'Default', description: '', efforts: [] }];
      fill(model, h('option', { value: 'default', text: 'Default' }));
      modelInfo.textContent = `Could not load models: ${e.message}`;
    }
  }
  model.onchange = fillEfforts;
  account.onchange = loadModels;
  (async () => {
    try {
      const r = await api('GET', '/api/accounts');
      const usable = r.accounts.filter((a) => a.signedIn);
      usable.sort((a, b) => (b.isDefault ? 1 : 0) - (a.isDefault ? 1 : 0));
      fill(account, usable.map((a) => h('option', { value: a.id, text: `${a.email || a.name}${a.isDefault ? ' (default)' : ''}${a.verified ? '' : ' (unchecked)'}` })));
      if (!usable.length) fill(account, h('option', { value: '', text: 'No signed-in accounts' }));
      else loadModels();
    } catch (e) { fail(e); }
  })();
  const MODE_TEXT = { default: 'Ask me before changes', acceptEdits: 'Auto-accept file edits', plan: 'Plan first, no changes', auto: 'Auto (classifier decides)', bypassPermissions: 'Never ask (dangerous)' };
  const mode = h('select', {}, app.me.options.modes.map((m) => h('option', { value: m, text: MODE_TEXT[m] || m })));
  const where = h('div');
  const picker = h('div', { class: 'list picker' });
  const start = h('button', { class: 'btn primary block', text: 'Start Claude' });

  async function loadPicker() {
    where.replaceChildren(h('div', { class: 'small muted', text: 'Folder' }), h('div', { class: 'ellipsis', text: `${roots[st.root]?.name || '?'}${st.rel ? ` / ${st.rel}` : ''}` }));
    picker.replaceChildren(h('div', { class: 'item muted', text: 'Loading…' }));
    try {
      const r = await api('GET', `/api/files/list?${qs({ root: st.root, path: st.rel })}`);
      const items = [];
      if (st.rel) items.push(h('button', { class: 'item', onclick: () => { st.rel = st.rel.split('/').slice(0, -1).join('/'); loadPicker(); } }, h('span', { class: 'ico', text: '⬆' }), 'Up one folder'));
      for (const it of r.items.filter((x) => x.dir)) {
        items.push(h('button', { class: 'item', onclick: () => { st.rel = [st.rel, it.name].filter(Boolean).join('/'); loadPicker(); } }, h('span', { class: 'ico', text: '📁' }), h('span', { class: 'grow ellipsis', text: it.name })));
      }
      if (!items.length) items.push(h('div', { class: 'item muted', text: 'No sub-folders' }));
      picker.replaceChildren(...items);
    } catch (e) {
      picker.replaceChildren(h('div', { class: 'item', text: e.message }));
    }
  }

  start.onclick = async () => {
    start.disabled = true;
    try {
      const s = await api('POST', '/api/sessions', { rootId: st.root, rel: st.rel, prompt: prompt.value, profileId: account.value, model: model.value || 'default', effort: effort.value || null, permissionMode: mode.value, images: photos.length ? photos.map(({ mediaType, data }) => ({ mediaType, data })) : undefined });
      location.hash = `#/s/${s.id}`;
    } catch (e) {
      fail(e);
      start.disabled = false;
    }
  };

  const rootSel = roots.length > 1 ? h('select', { onchange: (e) => { st.root = Number(e.target.value); st.rel = ''; loadPicker(); } }, roots.map((r) => h('option', { value: r.id, text: r.name, selected: r.id === st.root }))) : null;
  shell({
    title: 'New session',
    back: '#/claude',
    body: h('div', { class: 'stack' },
      h('div', { class: 'card stack' }, where, rootSel, picker),
      h('div', {}, h('label', { class: 'field', text: 'Task' }), saved, prompt),
      h('div', { class: 'row wrap' }, pp.button, pp.input, h('span', { class: 'small muted grow', text: 'Add photos (whiteboard, error on a screen…)' }), saveAs),
      pp.strip,
      h('div', {}, h('label', { class: 'field', text: 'Claude account' }), account),
      h('div', { class: 'row' }, h('div', { class: 'grow' }, h('label', { class: 'field', text: 'Model' }), model), h('div', { class: 'grow' }, h('label', { class: 'field', text: 'Effort' }), effort)),
      modelInfo,
      h('div', {}, h('label', { class: 'field', text: 'Permissions' }), mode),
      start),
  });
  loadPicker();
}

// ---------- Claude: one session ----------
async function viewSession(id) {
  const chat = h('div', { class: 'chat' });
  const head = h('div', { class: 'row wrap' });
  const input = h('textarea', { rows: 1, placeholder: 'Message Claude…' });
  const sendBtn = h('button', { class: 'btn primary send-btn', icon: 'send', 'aria-label': 'Send' });
  const photos = [];
  const pp = photoPicker(photos);
  const quick = h('button', { class: 'btn small photo-btn', type: 'button', 'aria-label': 'Saved prompts', title: 'Saved prompts', text: '⚡', onclick: async () => {
    const p = await pickSheet('Saved prompts', await loadPrompts(), (x) => [h('span', { class: 'grow' }, h('div', { text: x.name }), h('div', { class: 'small muted ellipsis', text: x.text }))]);
    if (!p) return;
    input.value = input.value.trim() ? `${input.value.trim()}\n${p.text}` : p.text;
    input.dispatchEvent(new Event('input'));
    input.focus();
  } });
  const composer = h('div', { class: 'composer' }, pp.strip, h('div', { class: 'inner' }, pp.button, quick, pp.input, input, sendBtn));
  const st = { session: app.sessions.find((s) => s.id === id) || null, last: 0, tools: new Map(), perms: new Map() };

  const modeSel = h('select', { class: 'small', style: 'width:auto;min-height:36px;padding:4px 30px 4px 10px;font-size:14px', onchange: async (e) => {
    try { await api('POST', `/api/sessions/${id}/mode`, { mode: e.target.value }); } catch (err) { fail(err); }
  } }, app.me.options.modes.map((m) => h('option', { value: m, text: m })));

  function renderHead() {
    const s = st.session;
    if (!s) return;
    modeSel.value = s.permissionMode;
    const live = ['starting', 'working', 'waiting', 'idle'].includes(s.state);
    const parts = [
      h('div', { class: 'small muted ellipsis', style: 'flex-basis:100%', text: `📁 ${s.rootName}${s.rel ? ` / ${s.rel}` : ''}` }),
      h('div', { class: 'small muted ellipsis', style: 'flex-basis:100%', text: `👤 ${s.account || s.profileId || '?'} · ${s.model || 'default'}${s.effort ? ` · ${s.effort} effort` : ''}` }),
      s.origin === 'phone' || s.origin === 'hook' ? h('div', { class: 'small muted', style: 'flex-basis:100%', text: `⇄ Moved here from the laptop${s.origin === 'hook' ? ' ("switch to phone")' : ''}. To go back, run /resume in Claude Code on the laptop.` }) : null,
      !live ? h('button', { class: 'btn small', text: '👤 Account', title: 'Continue this session on another Claude account', onclick: () => pickAccount(s) }) : null,
      chip(s.state),
      h('span', { class: 'grow' }),
      modeSel,
      ['working', 'waiting', 'starting'].includes(s.state) ? h('button', { class: 'btn small danger', text: 'Stop', onclick: () => api('POST', `/api/sessions/${id}/interrupt`).catch(fail) }) : null,
      live ? h('button', { class: 'btn small', text: 'Close', title: 'End the Claude process (you can continue later)', onclick: () => api('POST', `/api/sessions/${id}/close`).catch(fail) }) : null,
      !live ? h('button', { class: 'btn small danger', text: 'Delete', onclick: async () => {
        if (!confirm('Remove this session from PocketDesk? (Claude\'s own history file stays on the laptop.)')) return;
        try { await api('DELETE', `/api/sessions/${id}`); location.hash = '#/claude'; } catch (err) { fail(err); }
      } }) : null,
    ];
    head.replaceChildren(...parts.filter(Boolean));
    document.querySelector('.topbar h1').textContent = s.title;
  }

  async function pickAccount(s) {
    let accounts;
    try { accounts = (await api('GET', '/api/accounts')).accounts.filter((a) => a.signedIn); } catch (e) { return fail(e); }
    const sel = h('select', {}, accounts.map((a) => h('option', { value: a.id, text: a.email || a.name, selected: a.id === s.profileId })));
    const ok = h('button', { class: 'btn small primary', text: 'Use it', onclick: async () => {
      ok.disabled = true;
      try { st.session = await api('POST', `/api/sessions/${id}/account`, { profileId: sel.value }); toast('Account changed. Your next message uses it.'); renderHead(); } catch (e) { fail(e); ok.disabled = false; }
    } });
    head.append(h('div', { class: 'row', style: 'flex-basis:100%' }, sel, ok));
  }

  const nearBottom = () => window.innerHeight + window.scrollY >= document.body.scrollHeight - 160;
  function add(ev) {
    if (ev.seq <= st.last) return;
    st.last = ev.seq;
    const stick = nearBottom();
    const node = renderEvent(ev, st, id);
    if (node) chat.append(node);
    if (stick) requestAnimationFrame(() => window.scrollTo(0, document.body.scrollHeight));
  }

  async function send() {
    const text = input.value;
    if (!text.trim() && !photos.length) return;
    sendBtn.disabled = true;
    try {
      await api('POST', `/api/sessions/${id}/send`, { text, images: photos.length ? photos.map(({ mediaType, data }) => ({ mediaType, data })) : undefined });
      input.value = '';
      input.style.height = '';
      photos.length = 0;
      pp.redraw();
    } catch (e) {
      fail(e);
    } finally {
      sendBtn.disabled = false;
    }
  }
  sendBtn.onclick = send;
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
  });

  shell({ title: st.session?.title || 'Session', back: '#/claude', body: [h('div', { class: 'card' }, head), chat], composer });
  try {
    const r = await api('GET', `/api/sessions/${id}`);
    st.session = r.session;
    renderHead();
    r.events.forEach(add);
    window.scrollTo(0, document.body.scrollHeight);
  } catch (e) {
    fail(e);
    return;
  }
  const es = new EventSource(`/api/sessions/${id}/stream?after=${st.last}`);
  es.addEventListener('ev', (e) => {
    const ev = JSON.parse(e.data);
    add(ev);
    if (ev.t === 'state' && st.session) {
      st.session.state = ev.state;
      renderHead();
    }
  });
  es.addEventListener('summary', (e) => {
    st.session = JSON.parse(e.data);
    renderHead();
  });
  const onHub = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'session' && msg.session.id === id) {
      st.session = msg.session;
      renderHead();
    }
  };
  app.hub?.addEventListener('hub', onHub);
  onLeave(() => {
    es.close();
    app.hub?.removeEventListener('hub', onHub);
  });
}

function renderEvent(ev, st, id) {
  switch (ev.t) {
    case 'user':
      if (ev.images?.length) {
        return h('div', { class: 'msg user' },
          h('div', { class: 'msg-photos' }, ev.images.map((n) => h('img', { src: `/api/sessions/${id}/image/${encodeURIComponent(n)}`, alt: 'Photo sent to Claude', loading: 'lazy' }))),
          h('div', { text: ev.text }));
      }
      return h('div', { class: 'msg user', text: ev.text });
    case 'text':
      return md(ev.text);
    case 'tool': {
      const stEl = h('span', { class: 'st small muted', text: '…' });
      const body = h('div', { class: 'body' }, h('pre', { text: ev.detail || '' }));
      const node = h('details', { class: 'tool' }, h('summary', {}, h('span', { class: 'name', text: ev.name }), h('span', { class: 'sum', text: ev.summary || '' }), stEl), body);
      st.tools.set(ev.tid, { node, stEl, body });
      return node;
    }
    case 'tool_result': {
      const t = st.tools.get(ev.tid);
      if (!t) return null;
      t.stEl.textContent = ev.err ? 'failed' : '✓';
      if (ev.err) t.node.classList.add('err');
      if (ev.text) t.body.append(h('div', { class: 'small muted', text: 'Result' }), h('pre', { text: ev.text }));
      return null;
    }
    case 'perm':
      return renderPerm(ev, st, id);
    case 'perm_done': {
      const p = st.perms.get(ev.pid);
      if (p) p.finish(ev.status);
      return null;
    }
    case 'result':
      return ev.ok ? h('div', { class: 'msg done', text: `done${ev.ms ? ` in ${duration(ev.ms)}` : ''}` }) : h('div', { class: 'msg err', text: `Turn ended: ${ev.text || 'error'}` });
    case 'error':
      return h('div', { class: 'msg err', text: ev.text });
    case 'note':
      return h('div', { class: 'msg sys', text: ev.text });
    case 'init':
      return h('div', { class: 'msg sys', text: `Claude Code ${ev.version || ''} · ${ev.model || ''}` });
    default:
      return null;
  }
}

const DONE_TEXT = { allowed: 'Allowed', always: 'Allowed for this session', denied: 'Denied', answered: 'Answered', approved: 'Plan approved', cancelled: 'Cancelled' };

function renderPerm(ev, st, id) {
  const box = h('div', { class: 'perm' });
  const actions = h('div', { class: 'stack' });
  const note = h('input', { type: 'text', placeholder: 'Optional note for Claude' });
  const decide = async (payload, btns) => {
    btns.forEach((b) => (b.disabled = true));
    try {
      await api('POST', `/api/sessions/${id}/decide`, { pid: ev.pid, note: note.value || undefined, ...payload });
    } catch (e) {
      fail(e);
      btns.forEach((b) => (b.disabled = false));
    }
  };

  if (ev.kind === 'question') {
    box.append(h('h3', { text: 'Claude is asking' }));
    const pickers = (ev.questions || []).map((q) => {
      const name = `q-${ev.pid}-${Math.random().toString(36).slice(2)}`;
      const inputs = q.options.map((o) => {
        const inp = h('input', { type: q.multiSelect ? 'checkbox' : 'radio', name, value: o.label });
        return { inp, el: h('label', { class: 'opt' }, inp, h('div', {}, h('div', { text: o.label }), o.description ? h('div', { class: 'small muted', text: o.description }) : null)) };
      });
      const other = h('input', { type: 'text', placeholder: 'Or type your own answer' });
      box.append(h('div', { class: 'small muted', text: q.header }), h('div', { text: q.question }), h('div', { class: 'opts' }, inputs.map((i) => i.el)), other);
      return { q, inputs, other };
    });
    const send = h('button', { class: 'btn primary', text: 'Send answers' });
    const skip = h('button', { class: 'btn', text: 'Skip' });
    send.onclick = () => {
      const answers = {};
      for (const p of pickers) {
        const picked = p.inputs.filter((i) => i.inp.checked).map((i) => i.inp.value);
        const val = p.other.value.trim() || picked.join(', ');
        if (!val) return toast('Answer every question (or press Skip)', true);
        answers[p.q.question] = val;
      }
      decide({ decision: 'answer', answers }, [send, skip]);
    };
    skip.onclick = () => decide({ decision: 'deny' }, [send, skip]);
    actions.append(h('div', { class: 'row wrap' }, send, skip));
  } else if (ev.kind === 'plan') {
    box.append(h('h3', { text: 'Claude has a plan for you to approve' }), (() => { const p = md(ev.plan || ''); p.classList.add('plan'); return p; })());
    const a1 = h('button', { class: 'btn primary', text: 'Approve' });
    const a2 = h('button', { class: 'btn ok', text: 'Approve + auto-accept edits' });
    const no = h('button', { class: 'btn', text: 'Keep planning' });
    a1.onclick = () => decide({ decision: 'approve', mode: 'default' }, [a1, a2, no]);
    a2.onclick = () => decide({ decision: 'approve', mode: 'acceptEdits' }, [a1, a2, no]);
    no.onclick = () => decide({ decision: 'deny' }, [a1, a2, no]);
    actions.append(note, h('div', { class: 'row wrap' }, a1, a2, no));
  } else {
    box.append(h('h3', { text: `Allow ${ev.tool}?` }), h('div', { class: 'small', text: ev.summary || '' }));
    if (ev.reason) box.append(h('div', { class: 'small muted', text: ev.reason }));
    if (ev.blockedPath) box.append(h('div', { class: 'small muted', text: `Path: ${ev.blockedPath}` }));
    if (ev.detail) box.append(h('details', {}, h('summary', { class: 'small muted', text: 'Details' }), h('pre', { text: ev.detail })));
    const yes = h('button', { class: 'btn primary', text: 'Allow' });
    const all = h('button', { class: 'btn ok', text: `Allow all ${ev.tool}` });
    const no = h('button', { class: 'btn danger', text: 'Deny' });
    yes.onclick = () => decide({ decision: 'allow' }, [yes, all, no]);
    all.onclick = () => decide({ decision: 'always' }, [yes, all, no]);
    no.onclick = () => decide({ decision: 'deny' }, [yes, all, no]);
    actions.append(note, h('div', { class: 'row wrap' }, yes, all, no));
  }
  box.append(actions);
  st.perms.set(ev.pid, {
    finish(status) {
      box.classList.add('done');
      actions.replaceChildren(h('div', { class: 'small muted', text: DONE_TEXT[status] || status }));
    },
  });
  return box;
}

// ---------- Files ----------
async function viewFiles(rootStr, relEnc) {
  const roots = app.me.roots;
  if (!roots.length) {
    shell({ title: 'Files', body: h('div', { class: 'empty', text: 'No folders are shared. Add one to config.json on the laptop.' }) });
    return;
  }
  const root = rootStr == null || rootStr === '' ? 0 : Number(rootStr);
  const rel = relEnc ? dec(relEnc) : '';
  const listBox = h('div', { class: 'list' }, h('div', { class: 'item muted', text: 'Loading…' }));
  const upload = h('input', { type: 'file', multiple: true, style: 'display:none' });
  const toFolder = (p) => `#/files/${root}/${enc(p)}`;

  const crumbs = h('div', { class: 'crumbs' }, h('a', { href: `#/files/${root}/`, text: roots[root]?.name || '?' }));
  rel.split('/').filter(Boolean).reduce((acc, part) => {
    const p = [acc, part].filter(Boolean).join('/');
    crumbs.append(h('span', { text: '/' }), h('a', { href: toFolder(p), text: part }));
    return p;
  }, '');

  async function load() {
    try {
      const r = await api('GET', `/api/files/list?${qs({ root, path: rel })}`);
      const rows = r.items.map((it) => h('a', { class: 'item', href: it.dir ? toFolder([rel, it.name].filter(Boolean).join('/')) : `#/view/${root}/${enc([rel, it.name].filter(Boolean).join('/'))}` },
        h('span', { class: 'ico', text: it.dir ? '📁' : fileIcon(it.name) }),
        h('span', { class: 'grow ellipsis', text: it.name }),
        h('span', { class: 'small muted', text: it.dir ? '' : size(it.size) })));
      if (!rows.length) rows.push(h('div', { class: 'item muted', text: 'Empty folder' }));
      if (r.hidden) rows.push(h('div', { class: 'item small muted', text: `${r.hidden} hidden (blocked or build folders)` }));
      listBox.replaceChildren(...rows);
    } catch (e) {
      listBox.replaceChildren(h('div', { class: 'item', text: e.message }));
    }
  }

  upload.onchange = async () => {
    for (const f of upload.files) {
      try {
        toast(`Uploading ${f.name}…`);
        await api('POST', `/api/files/upload?${qs({ root, path: rel, name: f.name })}`, undefined, { raw: f });
        toast(`Uploaded ${f.name}`);
      } catch (e) {
        if (e.status === 409 && confirm(`${f.name} already exists. Replace it?`)) {
          try {
            await api('POST', `/api/files/upload?${qs({ root, path: rel, name: f.name, overwrite: 1 })}`, undefined, { raw: f });
            toast(`Replaced ${f.name}`);
          } catch (e2) { fail(e2); }
        } else if (e.status !== 409) fail(e);
      }
    }
    upload.value = '';
    load();
  };

  const newFile = async () => {
    const name = prompt('New file name');
    if (!name) return;
    const p = [rel, name].filter(Boolean).join('/');
    try {
      await api('POST', `/api/files/new?${qs({ root, path: p })}`, { text: '' });
      location.hash = `#/view/${root}/${enc(p)}?edit=1`;
    } catch (e) { fail(e); }
  };
  const newFolder = async () => {
    const name = prompt('New folder name');
    if (!name) return;
    try {
      await api('POST', `/api/files/mkdir?${qs({ root, path: [rel, name].filter(Boolean).join('/') })}`);
      load();
    } catch (e) { fail(e); }
  };

  const rootSel = roots.length > 1 ? h('select', { onchange: (e) => (location.hash = `#/files/${e.target.value}/`) }, roots.map((r) => h('option', { value: r.id, text: r.name, selected: r.id === root }))) : null;
  shell({
    title: 'Files',
    back: rel ? toFolder(rel.split('/').slice(0, -1).join('/')) : null,
    body: [
      rootSel ? h('div', { style: 'margin-bottom:10px' }, rootSel) : null,
      crumbs,
      h('div', { class: 'row wrap', style: 'margin-bottom:10px' },
        h('button', { class: 'btn small', text: '⬆ Upload', onclick: () => upload.click() }),
        h('button', { class: 'btn small', text: '+ File', onclick: newFile }),
        h('button', { class: 'btn small', text: '+ Folder', onclick: newFolder }),
        h('a', { class: 'btn small', href: `#/new?${qs({ root, path: rel })}`, text: '✳ Claude here' }),
        h('a', { class: 'btn small', href: `#/p/${root}/${enc(rel)}`, text: '🛠 Run / Git' }),
        h('a', { class: 'btn small', href: `#/gallery/${root}/${enc(rel)}`, text: '🖼 Gallery' })),
      !rel ? h('a', { class: 'card row link-card', href: '#/gallery' }, h('span', { class: 'grow', text: '🖼 Photos & videos on the laptop' }), h('span', { text: '›' })) : null,
      upload,
      listBox,
    ],
  });
  load();
}

function fileIcon(name) {
  const ext = name.split('.').pop().toLowerCase();
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif', 'heic', 'heif'].includes(ext)) return '🖼';
  if (VID_EXT.includes(ext)) return '🎬';
  if (['mp3', 'm4a', 'wav', 'ogg', 'flac', 'aac'].includes(ext)) return '🎵';
  if (['pdf'].includes(ext)) return '📕';
  if (['md', 'txt'].includes(ext)) return '📝';
  if (['zip', '7z', 'rar'].includes(ext)) return '🗜';
  return '📄';
}

async function viewFile(rootStr, relEncAndQuery) {
  const [relEnc, query] = relEncAndQuery.split('?');
  const root = Number(rootStr);
  const rel = dec(relEnc);
  const name = rel.split('/').pop();
  const parent = rel.split('/').slice(0, -1).join('/');
  const startEdit = new URLSearchParams(query || '').get('edit') === '1';
  const box = h('div', {}, h('div', { class: 'muted', text: 'Loading…' }));
  const rawUrl = `/api/files/raw?${qs({ root, path: rel })}`;
  const dlUrl = `/api/files/raw?${qs({ root, path: rel, dl: 1 })}`;
  const actions = h('div', { class: 'row wrap', style: 'margin-bottom:10px' });
  shell({ title: name, back: `#/files/${root}/${enc(parent)}`, body: [h('div', { class: 'small muted ellipsis', style: 'margin-bottom:8px', text: rel }), actions, box] });

  let file;
  try {
    file = await api('GET', `/api/files/text?${qs({ root, path: rel })}`);
  } catch (e) {
    box.replaceChildren(h('div', { class: 'card', text: e.message }));
    return;
  }
  const ask = h('a', { class: 'btn small', href: `#/new?${qs({ root, path: parent, prompt: `Look at ${name}: ` })}`, text: '✳ Ask Claude' });
  const inGallery = h('a', { class: 'btn small', href: `#/gallery/${root}/${enc(parent)}`, text: '🖼 Gallery' });
  const download = h('a', { class: 'btn small', href: dlUrl, text: '⬇ Download' });
  const ext = name.split('.').pop().toLowerCase();

  if (file.text == null) {
    actions.replaceChildren(download, ask);
    if (mediaOf(name)) actions.append(inGallery);
    if (PLAYABLE_IMG.includes(ext)) box.replaceChildren(h('img', { class: 'preview-img', src: rawUrl, alt: name }));
    else if (PLAYABLE_VID.includes(ext)) box.replaceChildren(h('video', { class: 'preview-img', src: rawUrl, controls: true, playsinline: true, preload: 'metadata' }), h('div', { class: 'small muted', style: 'margin-top:6px', text: `${size(file.size)} · if it does not play, download it` }));
    else if (mediaOf(name)) box.replaceChildren(h('img', { class: 'preview-img', src: `/api/files/thumb?${qs({ root, path: rel, w: 1280 })}`, alt: name }), h('div', { class: 'small muted', style: 'margin-top:6px', text: 'Preview only. Download for the original.' }));
    else if (['mp3', 'm4a', 'wav', 'ogg', 'aac'].includes(ext)) box.replaceChildren(h('audio', { src: rawUrl, controls: true, preload: 'metadata', style: 'width:100%' }));
    else if (ext === 'pdf') box.replaceChildren(h('a', { class: 'btn', href: rawUrl, target: '_blank', rel: 'noopener', text: 'Open PDF' }));
    else box.replaceChildren(h('div', { class: 'card muted', text: file.tooBig ? `Too big to show here (${size(file.size)}). Download it instead.` : `Binary file (${size(file.size)}).` }));
    return;
  }

  let wrap = false;
  const showView = () => {
    const pre = h('pre', { class: `viewer${wrap ? ' wrap' : ''}` }, h('code', { text: file.text }));
    box.replaceChildren(h('div', { class: 'small muted', style: 'margin-bottom:6px', text: `${size(file.size)} · changed ${ago(file.mtime)}` }), pre);
    actions.replaceChildren(
      h('button', { class: 'btn small primary', text: '✎ Edit', onclick: showEdit }),
      h('button', { class: 'btn small', text: wrap ? 'No wrap' : 'Wrap', onclick: () => { wrap = !wrap; showView(); } }),
      download, ask);
  };
  const showEdit = () => {
    const ta = h('textarea', { class: 'editor', spellcheck: 'false', autocapitalize: 'off', autocomplete: 'off' });
    ta.value = file.text;
    const save = h('button', { class: 'btn small primary', text: 'Save' });
    const cancel = h('button', { class: 'btn small', text: 'Cancel', onclick: () => (ta.value === file.text || confirm('Discard your changes?')) && showView() });
    save.onclick = async (_e, force = false) => {
      save.disabled = true;
      try {
        const r = await api('PUT', `/api/files/text?${qs({ root, path: rel })}`, { text: ta.value, baseMtime: force ? undefined : file.mtime });
        file = { ...file, text: ta.value, mtime: r.mtime, size: r.size };
        toast('Saved');
        showView();
      } catch (e) {
        save.disabled = false;
        if (e.status === 409 && e.data?.mtime) {
          if (confirm('This file was changed on the laptop (maybe by Claude) after you opened it.\n\nOK = overwrite with your version\nCancel = keep editing (copy your text first, then reload)')) save.onclick(null, true);
        } else fail(e);
      }
    };
    actions.replaceChildren(save, cancel);
    box.replaceChildren(ta);
    ta.focus();
  };
  if (startEdit) showEdit();
  else showView();
}

// ---------- Laptop ----------
async function viewLaptop() {
  const box = h('div', {}, h('div', { class: 'muted', text: 'Loading…' }));
  const pushCard = h('div', { class: 'card stack' });
  const alertsCard = h('div', { class: 'card stack' }, h('div', { class: 'small muted', text: 'Loading…' }));
  const securityCard = h('div', { class: 'card stack' }, h('div', { class: 'small muted', text: 'Loading…' }));
  shell({ title: 'Laptop', actions: h('button', { class: 'btn small', icon: 'refresh', 'aria-label': 'Refresh', onclick: () => load() }), body: [
    h('a', { class: 'card row link-card', href: '#/travel' }, h('span', { class: 'grow' }, h('strong', { text: '🧳 Travel mode' }),
      h('div', { class: 'small muted', text: app.travel?.active ? 'On now. Tap to see it, add time or end it.' : 'Lid closed in a bag: Claude keeps working, everything else pauses, the CPU runs cool.' })), h('span', { text: '›' })),
    box,
    h('div', { class: 'section-title', text: 'Control the laptop' }),
    h('div', { class: 'list' },
      h('a', { class: 'item', href: '#/screen' }, h('span', { class: 'ico', text: '🖥' }), h('span', { class: 'grow' }, h('div', { text: 'See the screen' }), h('div', { class: 'small muted', text: 'Live view only, asks for the PIN' })), icon('chevron', 'chev')),
      h('a', { class: 'item', href: '#/clip' }, h('span', { class: 'ico', text: '📋' }), h('span', { class: 'grow' }, h('div', { text: 'Clipboard' }), h('div', { class: 'small muted', text: 'Copy on one, paste on the other' })), icon('chevron', 'chev')),
      h('a', { class: 'item', href: '#/send' }, h('span', { class: 'ico', text: '📤' }), h('span', { class: 'grow' }, h('div', { text: 'Send to laptop' }), h('div', { class: 'small muted', text: 'Files, photos, links, notes (also from the Share menu)' })), icon('chevron', 'chev')),
      h('a', { class: 'item', href: '#/find' }, h('span', { class: 'ico', text: '📍' }), h('span', { class: 'grow' }, h('div', { text: 'Find my laptop' }), h('div', { class: 'small muted', text: 'Make it ring, see its Wi-Fi' })), icon('chevron', 'chev'))),
    h('div', { class: 'section-title', text: 'Alerts on the phone' }), alertsCard,
    h('div', { class: 'section-title', text: 'Security' }), securityCard,
    h('a', { class: 'card row link-card', href: '#/activity' }, h('span', { class: 'grow', text: '📜 Activity log: everything done through PocketDesk' }), h('span', { text: '›' })),
    h('div', { class: 'section-title', text: 'This device' }), pushCard] });
  renderAlertsCard(alertsCard);
  renderSecurityCard(securityCard);

  async function load() {
    try {
      const [s, pw] = await Promise.all([api('GET', '/api/status', undefined, { auto: true }), api('GET', '/api/power', undefined, { auto: true }).catch(() => ({}))]);
      const b = s.battery;
      const up = s.uptimeSec;
      const stat = (v, l) => h('div', { class: 'stat' }, h('div', { class: 'v', text: v }), h('div', { class: 'l', text: l }));
      fill(box, 
        h('div', { class: 'stat-grid' },
          stat(b ? `${b.percent}%` : '—', b ? (b.pluggedIn ? 'battery · plugged in' : 'battery · ON BATTERY') : 'battery'),
          stat(`${Math.floor(up / 3600)}h ${Math.floor((up % 3600) / 60)}m`, 'awake for'),
          s.temperatureC != null ? stat(`${Math.round(s.temperatureC)}°C`, 'temperature sensor') : null,
          stat(String(s.claudeProcesses ?? '—'), 'Claude processes'),
          stat(`${Math.round((s.memory.totalMb - s.memory.freeMb) / 1024 * 10) / 10} / ${Math.round(s.memory.totalMb / 1024)} GB`, 'memory used'),
          ...s.disks.map((d) => stat(`${d.freeGb} GB`, `free on ${d.drive}`))),
        b && !b.pluggedIn ? h('div', { class: 'card', style: 'margin-top:10px;color:var(--warn)', text: 'The laptop is on battery. If the lid is closed it may sleep, and everything stops.' }) : null,
        h('div', { class: 'section-title', text: 'Power' }),
        pw.pending ? h('div', { class: 'card warn-card row' }, h('span', { class: 'grow', text: `${pw.pending.action === 'restart' ? 'Restart' : 'Shutdown'} in ${Math.max(0, Math.round((pw.pending.at - Date.now()) / 1000))} s` }),
          h('button', { class: 'btn small primary', text: 'Cancel it', onclick: () => power('cancel') })) : null,
        h('div', { class: 'row wrap' },
          h('button', { class: 'btn', text: '🔒 Lock screen', onclick: () => power('lock') }),
          h('button', { class: 'btn danger', text: '☾ Sleep laptop', onclick: () => confirm('Put the laptop to sleep? You cannot wake it from the phone. Claude stops until the lid is opened.') && power('sleep') }),
          h('button', { class: 'btn danger', text: '↻ Restart', onclick: () => confirm('Restart the laptop in 1 minute?\n\nClaude sessions and commands stop, unsaved work in other apps can be lost, and PocketDesk only comes back after someone signs in to Windows on the laptop. You can cancel during that minute.') && power('restart') }),
          h('button', { class: 'btn danger', text: '⏻ Shut down', onclick: () => confirm('Shut the laptop down in 1 minute?\n\nEverything stops and the phone cannot turn it back on. You can cancel during that minute.') && power('shutdown') })),
        h('div', { class: 'small muted', style: 'margin-top:8px', text: `${s.host} · updated ${new Date(s.at).toLocaleTimeString()}` }),
      );
    } catch (e) {
      box.replaceChildren(h('div', { class: 'card', text: e.message }));
    }
  }
  async function power(action) {
    try {
      const r = await withPin(`Type your PIN to ${action === 'shutdown' ? 'shut down' : action}`, null, (pin) => api('POST', '/api/power', { action, pin }));
      if (!r) return;
      toast(r.message);
      if (['restart', 'shutdown', 'cancel'].includes(action)) load();
    } catch (e) { fail(e); }
  }

  const pushSupported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const renderPush = () => {
    fill(pushCard, 
      h('h3', { text: 'Notifications' }),
      h('div', { class: 'small muted', text: pushSupported ? `Status: ${Notification.permission}. Get a buzz when Claude finishes or needs approval.` : 'This browser cannot get notifications here. On iPhone, add PocketDesk to the Home Screen first and open it from there.' }),
      pushSupported ? h('div', { class: 'row wrap' },
        h('button', { class: 'btn primary small', text: 'Turn on notifications', onclick: enablePush }),
        h('button', { class: 'btn small', text: 'Send test', onclick: () => api('POST', '/api/push/test').then(() => toast('Sent')).catch(fail) })) : null,
      app.me.kind === 'device' ? h('button', { class: 'btn small danger', text: 'Unpair this device', onclick: async () => {
        if (!confirm('Unpair this device? You will need a new pairing code to come back.')) return;
        await api('POST', '/api/logout').catch(() => {});
        location.reload();
      } }) : h('div', { class: 'small muted', text: 'You are on the laptop itself.' }),
    );
  };
  async function enablePush() {
    try {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') return toast('Notifications were not allowed', true);
      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(app.me.pushKey) });
      await api('POST', '/api/push/subscribe', { subscription: sub.toJSON() });
      toast('Notifications on');
      renderPush();
    } catch (e) { fail(e); }
  }
  renderPush();
  load();
  const t = setInterval(load, 30_000);
  onLeave(() => clearInterval(t));
}

function b64ToBytes(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const s = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

// ---------- Travel mode ----------
async function viewTravel() {
  const box = h('div', {}, h('div', { class: 'muted', text: 'Loading…' }));
  shell({ title: 'Travel mode', back: '#/laptop', body: box });
  let timer = null;
  onLeave(() => clearInterval(timer));

  const fmtLeft = (ms) => {
    const m = Math.max(0, Math.ceil(ms / 60000));
    return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m} min`;
  };
  const act = async (url, body, okMsg) => {
    try {
      const t = await api('POST', url, body);
      setTravel(t.active ? t : null);
      if (okMsg) toast(okMsg);
      load();
    } catch (e) { fail(e); }
  };

  async function load() {
    let t;
    try {
      t = await api('GET', '/api/travel', undefined, { auto: true });
    } catch (e) {
      return fill(box, h('div', { class: 'card', text: e.message }));
    }
    setTravel(t.active ? t : null);
    clearInterval(timer);
    if (t.active) {
      renderOn(t);
      timer = setInterval(load, 20_000);
    } else await renderOff(t);
  }

  function renderOn(t) {
    const stat = (v, l) => h('div', { class: 'stat' }, h('div', { class: 'v', text: v }), h('div', { class: 'l', text: l }));
    const levelBtn = (id, label) => h('button', { class: `btn small${t.level === id ? ' primary' : ''}`, text: label, onclick: () => t.level !== id && act('/api/travel/level', { level: id }, `CPU: ${label}`) });
    fill(box,
      t.sleepAt ? h('div', { class: 'card stack warn-card' },
        h('strong', { text: 'The laptop goes to sleep in about a minute' }),
        h('div', { class: 'small', text: 'Claude looks done. Press Stay awake if you still need it.' }),
        h('button', { class: 'btn primary block', text: 'Stay awake', onclick: () => act('/api/travel/stay-awake', {}, 'Staying awake (sleep-when-done is off for this trip)') })) : null,
      t.graceUntil && !t.sleepAt ? h('div', { class: 'card stack warn-card' },
        h('strong', { text: 'Travel time is up, Claude is still working' }),
        h('div', { class: 'small', text: `The laptop sleeps in ${fmtLeft(t.graceUntil - Date.now())} unless you add time.` }),
        h('button', { class: 'btn primary block', text: '+15 min', onclick: () => act('/api/travel/extend', { minutes: 15 }, 'Added 15 minutes') })) : null,
      h('div', { class: 'stat-grid' },
        stat(t.graceUntil ? 'Time up' : fmtLeft(t.leftMs), `left (of ${t.minutes} min)`),
        stat(t.levelLabel || t.level, 'CPU · turbo off'),
        stat(String(t.apps.length), `apps paused (${t.pausedCount} processes)`),
        stat(t.ecores ? 'E-cores' : 'All cores', t.ecores ? `Claude on efficiency cores (${t.pinnedCount})` : 'Claude cores'),
      ),
      t.busy ? h('div', { class: 'card small' }, t.busy.busy
        ? [h('strong', { text: 'Working: ' }), t.busy.reasons.slice(0, 4).join(' · ')]
        : h('span', { class: 'muted', text: 'Nothing is running right now.' })) : null,
      h('div', { class: 'section-title', text: 'While travelling' }),
      h('div', { class: 'row wrap' },
        h('button', { class: 'btn', text: '+15 min', onclick: () => act('/api/travel/extend', { minutes: 15 }, 'Added 15 minutes') }),
        h('button', { class: 'btn', text: '+30 min', onclick: () => act('/api/travel/extend', { minutes: 30 }, 'Added 30 minutes') }),
        h('button', { class: 'btn', text: '☾ Sleep now', onclick: () => confirm('Put the laptop to sleep now? Claude stops until you open the lid. Travel mode ends when it wakes.') && act('/api/travel/sleep', {}, 'Going to sleep') })),
      h('div', { class: 'row wrap', style: 'margin-top:8px' }, h('span', { class: 'small muted', text: 'CPU:' }), levelBtn('coolest', 'Coolest'), levelBtn('cool', 'Cool')),
      h('div', { class: 'small muted', style: 'margin-top:6px', text: [
        t.sleepWhenDone ? 'Sleeps when Claude is done.' : 'Stays awake until the timer.',
        t.endOnCharger ? 'Ends when the charger is plugged in.' : '',
        t.bluetoothOff ? 'Bluetooth is off (comes back after).' : '',
        t.lightWork ? 'Claude is told to keep work light.' : '',
      ].filter(Boolean).join(' ') }),
      t.queue.length ? [h('div', { class: 'section-title', text: 'Commands waiting for the trip to end' }),
        h('div', { class: 'list' }, t.queue.map((q) => h('div', { class: 'item' }, h('span', { class: 'grow mono small', text: q.label }),
          h('button', { class: 'btn small', text: 'Remove', onclick: async () => {
            try { await api('DELETE', `/api/travel/queue/${q.i}`); load(); } catch (e) { fail(e); }
          } }))))] : null,
      t.apps.length ? [h('div', { class: 'section-title', text: 'Paused (they come back exactly as they were)' }), h('div', { class: 'small muted', text: t.apps.join(' · ') })] : null,
      t.problems.length ? [h('div', { class: 'section-title', text: 'Problems' }), h('div', { class: 'card small warn-text', text: t.problems.join('\n'), style: 'white-space:pre-wrap' })] : null,
      h('div', { class: 'section-title', text: 'Back home or at college' }),
      h('button', { class: 'btn ok block', text: '✓ End Travel mode: bring everything back', onclick: () => act('/api/travel/end', {}, 'Travel mode ended. Apps are back.') }),
      h('div', { class: 'small muted', style: 'margin-top:6px', text: 'It also ends by itself when you open the lid after it slept, or plug in the charger. If you used Fn+Q for Quiet mode, press Fn+Q again for normal speed.' }),
    );
  }

  async function renderOff(t) {
    fill(box, h('div', { class: 'muted', text: 'Looking at what is running on the laptop…' }));
    let p;
    try {
      p = await api('GET', '/api/travel/preview');
    } catch (e) {
      return fill(box, h('div', { class: 'card', text: e.message }));
    }
    const pr = p.prefs;
    const sel = (opts, value) => h('select', { class: 'inline-select' }, opts.map(([v, txt]) => h('option', { value: v, text: txt, selected: String(v) === String(value) })));
    const minutes = sel(p.durations.map((m) => [m, m >= 60 ? `${m / 60 === Math.floor(m / 60) ? m / 60 : (m / 60).toFixed(1)} h` : `${m} min`]), pr.minutes);
    const level = sel(p.levels.map((l) => [l.id, l.id === 'coolest' ? 'Coolest (slowest)' : 'Cool (a bit faster)']), pr.level);
    const endAction = sel([['sleep', 'Sleep'], ['hibernate', 'Hibernate (zero power)']], pr.endAction);
    const toggles = {};
    const tick = (key, text, sub, disabled) => {
      const inp = h('input', { type: 'checkbox', checked: !disabled && pr[key], disabled });
      toggles[key] = inp;
      return h('label', { class: 'check' }, inp, h('span', {}, text, sub ? h('div', { class: 'small muted', text: sub }) : null));
    };
    const appBoxes = new Map();
    const appRow = (a) => {
      const inp = h('input', { type: 'checkbox', checked: a.pause });
      appBoxes.set(a.key, inp);
      const meta = [a.hint, `${a.count} process${a.count > 1 ? 'es' : ''}`, `${a.memMb} MB`, a.window ? 'open window' : 'background'].filter(Boolean).join(' · ');
      return h('label', { class: 'check item' }, inp, h('span', { class: 'grow' }, a.name, h('div', { class: 'small muted', text: meta })));
    };
    const shown = p.apps.filter((a) => a.pause || a.window);
    const others = p.apps.filter((a) => !(a.pause || a.window));
    const othersBox = h('div', { class: 'list', style: 'display:none' }, others.map(appRow));
    const startBtn = h('button', { class: 'btn primary block', text: '🧳 Start Travel mode' });
    startBtn.onclick = async () => {
      startBtn.disabled = true;
      startBtn.textContent = 'Starting…';
      const body = {
        minutes: Number(minutes.value), level: level.value, endAction: endAction.value,
        pause: [...appBoxes].filter(([, i]) => i.checked).map(([k]) => k),
      };
      for (const [k, inp] of Object.entries(toggles)) body[k] = inp.checked;
      try {
        const r = await api('POST', '/api/travel/start', body);
        setTravel(r);
        toast(app.me.kind === 'laptop' ? 'Travel mode is on. Close the lid and go.' : 'Travel mode is on.');
        load();
      } catch (e) {
        fail(e);
        startBtn.disabled = false;
        startBtn.textContent = '🧳 Start Travel mode';
      }
    };
    fill(box,
      t.last ? h('div', { class: 'card small muted', text: `Last trip: ${new Date(t.last.startedAt).toLocaleString()} · ${t.last.minutes} min · ended: ${t.last.reason}${t.last.problems?.length ? ` · ${t.last.problems.length} problem(s): ${t.last.problems.join('; ')}` : ''}` }) : null,
      h('p', { class: 'small muted', text: 'For a 30–90 minute trip with the lid closed in your bag. Claude keeps working; the apps you tick below pause (they stay open and come back exactly as they were); the CPU runs slow and cool. Everything goes back to normal at the end.' }),
      h('div', { class: 'section-title', text: 'Before you go (do these by hand)' }),
      h('div', { class: 'card stack small' },
        h('div', {}, h('strong', { text: 'Fn + Q' }), ' until the power-button light is ', h('strong', { text: 'blue' }), ' (Quiet mode). This makes the laptop itself limit CPU and GPU power. Biggest help.'),
        h('div', {}, h('strong', { text: 'Charger out.' }), ' Charging in a bag makes a lot of heat.'),
        h('div', {}, h('strong', { text: 'Fn + Space' }), ' until the keyboard light is off.'),
        h('div', {}, h('strong', { text: 'Upright' }), ' in the laptop sleeve, not flat under books, not in the pocket against your back. Leave the zip open a little near the laptop\'s back edge (where the vents are).'),
        h('div', { class: 'muted', text: 'Once only: Lenovo Vantage → GPU Working Mode → Hybrid-Auto, so the NVIDIA GPU turns fully off on battery.' })),
      h('div', { class: 'section-title', text: 'Trip' }),
      h('div', { class: 'card stack' },
        h('div', { class: 'row' }, h('span', { class: 'grow', text: 'How long' }), minutes),
        h('div', { class: 'row' }, h('span', { class: 'grow', text: 'CPU' }), level),
        h('div', { class: 'row' }, h('span', { class: 'grow', text: 'When it ends' }), endAction),
        tick('sleepWhenDone', 'Sleep as soon as Claude is done', 'After 3 quiet minutes (you get a 1-minute warning).'),
        tick('ecores', 'Run Claude on the efficiency cores', p.ecores ? `${p.ecores.count} low-power cores, Windows efficiency mode. Slower builds, much less heat.` : 'This CPU has only one kind of core.', !p.ecores),
        tick('lightWork', 'Tell Claude to keep work light', 'No builds, installs, full test runs or Docker. Heavy Project-tab commands wait until the trip ends.'),
        tick('bluetoothOff', 'Bluetooth off during the trip', 'Comes back on afterwards. Wi-Fi stays on (needed for your phone).'),
        tick('endOnCharger', 'End when the charger is plugged in')),
      h('div', { class: 'section-title', text: 'Pause these apps' }),
      shown.length ? h('div', { class: 'list' }, shown.map(appRow)) : h('div', { class: 'small muted', text: 'No open apps to pause.' }),
      others.length ? h('button', { class: 'btn small', style: 'margin-top:8px', text: `Background programs (${others.length})`, onclick: (e) => { othersBox.style.display = ''; e.target.remove(); } }) : null,
      othersBox,
      h('div', { class: 'section-title', text: 'Keeps running' }),
      h('div', { class: 'small muted', text: `${p.kept.map((k) => k.name).join(' · ')} · Windows itself` }),
      h('div', { style: 'margin-top:16px' }, startBtn),
      h('div', { class: 'small muted', style: 'margin-top:6px', text: app.me.kind === 'laptop' ? 'Then close the lid and put the laptop in your bag.' : 'Then close the laptop lid.' }),
    );
  }

  load();
}

// ---------- Usage (per account) ----------
async function viewUsage() {
  const box = h('div', {}, h('div', { class: 'muted', text: 'Asking each account for its usage…' }));
  const refresh = h('button', { class: 'btn small', icon: 'refresh', 'aria-label': 'Refresh' });
  shell({ title: 'Usage', actions: refresh, body: box });
  const resetText = (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    const mins = Math.round((d - Date.now()) / 60000);
    if (mins <= 0) return 'resets now';
    if (mins < 60) return `resets in ${mins} min`;
    if (mins < 24 * 60) return `resets in ${Math.floor(mins / 60)} h ${mins % 60} min`;
    return `resets ${d.toLocaleDateString(undefined, { weekday: 'short' })} ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  };
  const bar = (pct) => {
    const p = Math.max(0, Math.min(100, Number(pct) || 0));
    const color = p >= 90 ? 'var(--bad)' : p >= 70 ? 'var(--warn)' : 'var(--accent)';
    return h('div', { class: 'meter' }, h('div', { class: 'fill', style: `width:${p}%;background:${color}` }));
  };
  async function load(fresh) {
    refresh.disabled = true;
    try {
      const r = await api('GET', `/api/usage${fresh ? '?fresh=1' : ''}`);
      const cards = r.accounts.map((a) => {
        const u = a.usage;
        const card = h('div', { class: 'card stack' },
          h('div', { class: 'row' },
            h('div', { class: 'grow' }, h('div', { class: 'ellipsis', style: 'font-weight:600', text: a.email || a.name }), h('div', { class: 'small muted', text: `${a.plan || ''}${a.isDefault ? ' · default' : ''}` })),
            a.at ? h('span', { class: 'small muted', text: ago(a.at) }) : null));
        if (a.error && !u?.windows?.length) card.append(h('div', { class: 'small', style: 'color:var(--bad)', text: a.error }));
        if (u?.error) card.append(h('div', { class: 'small muted', text: `Usage not available: ${u.error}` }));
        else if (u && !u.available) card.append(h('div', { class: 'small muted', text: 'This account has no plan limits to show.' }));
        const liveNewer = a.live && (!u?.dataAt || a.live.at > u.dataAt);
        const windows = liveNewer ? a.live.windows : u?.windows || [];
        const when = liveNewer ? a.live.at : u?.dataAt;
        if (when) card.append(h('div', { class: 'small muted', text: liveNewer ? `Live, from your last Claude reply at ${new Date(when).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : `Anthropic usage data from ${new Date(when).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} (${ago(when)})` }));
        for (const w of windows) {
          card.append(h('div', {},
            h('div', { class: 'row small' }, h('span', { class: 'grow', text: w.label }), h('strong', { text: w.percent == null ? '—' : `${Math.round(w.percent)}% used` })),
            bar(w.percent),
            h('div', { class: 'small muted', text: resetText(w.resetsAt) })));
        }
        if (u?.extra) {
          card.append(h('div', {},
            h('div', { class: 'row small' }, h('span', { class: 'grow', text: 'Extra usage this month' }), h('strong', { text: u.extra.used != null && u.extra.limit != null ? `${u.extra.used} / ${u.extra.limit} ${u.extra.currency || ''}` : `${Math.round(u.extra.percent || 0)}%` })),
            bar(u.extra.percent)));
        }
        return card;
      });
      fill(box,
        cards.length ? cards : h('div', { class: 'empty', text: 'No signed-in accounts on the laptop.' }),
        r.notSignedIn?.length ? h('div', { class: 'small muted', text: `Not signed in (skipped): ${r.notSignedIn.join(', ')}` }) : null,
        h('div', { class: 'small muted', style: 'margin-top:8px', text: 'Checking usage starts Claude briefly on each account but sends no message, so it uses none of your limit.' }));
    } catch (e) {
      fill(box, h('div', { class: 'card', text: e.message }));
    } finally {
      refresh.disabled = false;
    }
  }
  refresh.onclick = () => load(true);
  load(false);
}

// ---------- Setup (laptop only) ----------
async function viewSetup() {
  const box = h('div', {}, h('div', { class: 'muted', text: 'Loading…' }));
  shell({ title: 'Setup (laptop only)', body: box });
  let timer;
  onLeave(() => clearInterval(timer));

  async function load() {
    let s;
    try {
      s = await api('GET', '/api/setup');
    } catch (e) {
      box.replaceChildren(h('div', { class: 'card', text: e.message }));
      return;
    }
    const ts = s.tailscale;
    const accountCard = h('div', { class: 'card stack' },
      h('h3', { text: '1. Default Claude account' }),
      h('div', { class: 'small muted', text: 'New sessions start on this account unless you pick another one. Every session checks that Claude really is signed in as the account it was started for, and stops if not.' }),
      h('div', { class: 'list' }, s.profiles.map((p) => h('label', { class: 'item' },
        h('input', { type: 'radio', name: 'acct', value: p.id, checked: p.chosen, disabled: !p.signedIn }),
        h('div', { class: 'grow' }, h('div', { class: 'ellipsis', text: p.email || '(no email found)' }), h('div', { class: 'small muted', text: `${p.name}${p.signedIn ? (p.verified ? ' · ✓ checked with Anthropic' : ' · not checked yet') : ' · not signed in'}` }),
          p.fileMismatch ? h('div', { class: 'small', style: 'color:var(--warn)', text: `Its info file says ${p.fileMismatch}, but the saved login really is ${p.email}. PocketDesk uses the real one.` }) : null)))),
      h('button', { class: 'btn primary', text: 'Use this account', onclick: async () => {
        const v = box.querySelector('input[name=acct]:checked')?.value;
        if (!v) return toast('Pick one', true);
        try {
          await api('POST', '/api/setup/account', { id: v });
          app.me = await api('GET', '/api/me');
          toast('Account saved');
          load();
        } catch (e) { fail(e); }
      } }));

    const tsCard = h('div', { class: 'card stack' },
      h('h3', { text: '2. Private network (Tailscale)' }),
      !ts.installed ? h('div', { class: 'small', text: 'Tailscale is not installed. Run scripts\\3-tailscale.ps1 (see the guide).' })
        : !ts.running ? h('div', { class: 'small', text: 'Tailscale is installed but not signed in / not running. Open Tailscale from the Start menu and sign in with YOUR personal account.' })
          : h('div', { class: 'stack small' },
            h('div', {}, 'Signed in as ', h('strong', { text: ts.loginName || '?' })),
            ts.serving ? h('div', {}, 'Phone address: ', h('strong', { text: ts.url })) : h('div', { text: 'Not shared yet. Run: tailscale serve --bg 8765' })));
    let sec = null;
    try { sec = await api('GET', '/api/security'); } catch { /* ignore */ }
    if (sec && ts.running) {
      const only = sec.tailscaleUsers.length > 0;
      tsCard.append(h('label', { class: 'check' },
        h('input', { type: 'checkbox', checked: only, onchange: async (e) => {
          try {
            await api('POST', '/api/security/tailscale', { only: e.target.checked });
            toast(e.target.checked ? `Only ${ts.loginName} can connect now` : 'Any device in your tailnet can connect');
            load();
          } catch (err) { fail(err); e.target.checked = !e.target.checked; }
        } }),
        h('span', { text: `Only allow my own Tailscale login (${only ? sec.tailscaleUsers.join(', ') : ts.loginName || '?'}). Devices shared into your tailnet by other people are refused, even with a pairing code.` })));
    }

    const pairCard = h('div', { class: 'card stack' },
      h('h3', { text: '3. Pair your phone' }),
      h('div', { class: 'small muted', text: 'On the phone: install Tailscale, sign in with the same account, open the phone address above, then type this code. Codes last 5 minutes and work once.' }));
    if (s.pairing) {
      const left = h('div', { class: 'small muted', style: 'text-align:center' });
      const tick = () => {
        const sec = Math.max(0, Math.round((s.pairing.expires - Date.now()) / 1000));
        left.textContent = sec ? `expires in ${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}` : 'expired';
      };
      tick();
      clearInterval(timer);
      timer = setInterval(() => { tick(); }, 1000);
      pairCard.append(h('div', { class: 'code-big', text: s.pairing.code }), left);
    }
    pairCard.append(h('button', { class: 'btn primary', text: s.pairing ? 'Make a new code' : 'Make pairing code', onclick: async () => {
      try { await api('POST', '/api/setup/pairing'); load(); } catch (e) { fail(e); }
    } }));

    const devCard = h('div', { class: 'card stack' },
      h('h3', { text: 'Paired devices' }),
      s.devices.length ? h('div', { class: 'list' }, s.devices.map((d) => h('div', { class: 'item' },
        h('div', { class: 'grow' }, h('div', { text: d.name }), h('div', { class: 'small muted ellipsis', text: `paired ${ago(d.created)} · last seen ${ago(d.lastSeen)}${d.tailscaleLogin ? ` · ${d.tailscaleLogin}` : ''}` })),
        h('button', { class: 'btn small danger', text: 'Remove', onclick: async () => {
          if (!confirm(`Remove ${d.name}? It loses access immediately.`)) return;
          try { await api('DELETE', `/api/devices/${d.id}`); load(); } catch (e) { fail(e); }
        } })))) : h('div', { class: 'small muted', text: 'No devices yet.' }),
      s.devices.length ? h('button', { class: 'btn small', text: '🔒 Lock all phones now (they need the PIN again)', onclick: () => api('POST', '/api/security/lock-all').then(() => toast('All phones locked')).catch(fail) }) : null);

    const hookCard = h('div', { class: 'card stack' }, h('div', { class: 'small muted', text: 'Checking "switch to phone"…' }));
    renderHookCard(hookCard);
    box.replaceChildren(accountCard, tsCard, pairCard, hookCard, devCard);
  }
  load();
}

// ---------- Project: run commands, dev servers, git summary ----------
const TASK_LABEL = { running: 'running', done: 'done', failed: 'failed', stopped: 'stopped' };
const taskChip = (state) => h('span', { class: `chip ${state === 'running' ? 'working' : state === 'done' ? 'idle' : state === 'failed' ? 'error' : 'closed'}`, text: TASK_LABEL[state] || state });

function rememberProject(root, rel) {
  try { localStorage.setItem('pd-project', JSON.stringify({ root, rel })); } catch { /* private mode */ }
}
function lastProject() {
  try { return JSON.parse(localStorage.getItem('pd-project') || 'null'); } catch { return null; }
}

/** A folder browser that calls onPick(root, rel) when "Use this folder" is pressed. */
function folderPicker(start, onPick) {
  const roots = app.me.roots;
  const st = { root: start?.root ?? 0, rel: start?.rel || '' };
  const where = h('div', { class: 'ellipsis', style: 'font-weight:600' });
  const list = h('div', { class: 'list picker' });
  const rootSel = roots.length > 1 ? h('select', { onchange: (e) => { st.root = Number(e.target.value); st.rel = ''; load(); } }, roots.map((r) => h('option', { value: r.id, text: r.name, selected: r.id === st.root }))) : null;
  async function load() {
    where.textContent = `${roots[st.root]?.name || '?'}${st.rel ? ` / ${st.rel}` : ''}`;
    fill(list, h('div', { class: 'item muted', text: 'Loading…' }));
    try {
      const r = await api('GET', `/api/files/list?${qs({ root: st.root, path: st.rel })}`);
      const items = [];
      if (st.rel) items.push(h('button', { class: 'item', onclick: () => { st.rel = st.rel.split('/').slice(0, -1).join('/'); load(); } }, h('span', { class: 'ico', text: '⬆' }), 'Up one folder'));
      for (const it of r.items.filter((x) => x.dir)) items.push(h('button', { class: 'item', onclick: () => { st.rel = [st.rel, it.name].filter(Boolean).join('/'); load(); } }, h('span', { class: 'ico', text: '📁' }), h('span', { class: 'grow ellipsis', text: it.name })));
      if (!items.length) items.push(h('div', { class: 'item muted', text: 'No sub-folders' }));
      fill(list, items);
    } catch (e) {
      fill(list, h('div', { class: 'item', text: e.message }));
    }
  }
  load();
  return h('div', { class: 'card stack' }, h('div', { class: 'small muted', text: 'Project folder' }), where, rootSel, list,
    h('button', { class: 'btn primary', text: 'Use this folder', onclick: () => onPick(st.root, st.rel) }));
}

async function viewProject(rootStr, relEnc) {
  if (rootStr == null || rootStr === '') {
    const last = lastProject();
    if (last && app.me.roots[last.root]) return void (location.hash = `#/p/${last.root}/${enc(last.rel)}`);
    shell({ title: 'Project', body: [h('p', { class: 'small muted', text: 'Pick the project folder you want to run commands or use git in.' }), folderPicker(null, (r, p) => (location.hash = `#/p/${r}/${enc(p)}`))] });
    return;
  }
  const root = Number(rootStr);
  const rel = relEnc ? dec(relEnc) : '';
  rememberProject(root, rel);
  const name = rel ? rel.split('/').pop() : app.me.roots[root]?.name || '?';
  const loc = qs({ root, path: rel });
  const pickerBox = h('div');
  const runCard = h('div', { class: 'card stack' }, h('div', { class: 'small muted', text: 'Loading commands…' }));
  const typeCard = commandBox((cmd, sh, btn) => run({ kind: 'custom', cmd, shell: sh }, btn));
  const recentBox = h('div', { class: 'list' });
  const shareCard = h('div', { class: 'card stack' });
  const gitCard = h('a', { class: 'card stack link-card', href: `#/git/${root}/${enc(rel)}` }, h('div', { class: 'small muted', text: 'Checking git…' }));

  shell({
    title: name,
    actions: h('button', { class: 'btn small', text: 'Change', onclick: () => fill(pickerBox, pickerBox.firstChild ? null : folderPicker({ root, rel }, (r, p) => (location.hash = `#/p/${r}/${enc(p)}`))) }),
    body: [
      h('div', { class: 'small muted ellipsis', style: 'margin-bottom:8px', text: `${app.me.roots[root]?.name || '?'}${rel ? ` / ${rel}` : ''}` }),
      pickerBox,
      h('div', { class: 'row wrap', style: 'margin-bottom:10px' },
        h('a', { class: 'btn small', href: `#/new?${loc}`, text: '✳ Claude here' }),
        h('a', { class: 'btn small', href: `#/files/${root}/${enc(rel)}`, text: '📁 Files' })),
      h('div', { class: 'section-title', text: 'Type a command' }), typeCard,
      h('div', { class: 'section-title', text: 'Run' }), runCard,
      h('div', { class: 'section-title', text: 'Running and recent here' }), recentBox,
      h('div', { class: 'section-title', text: 'Open a dev server on the phone' }), shareCard,
      h('div', { class: 'section-title', text: 'Git' }), gitCard,
    ],
  });

  async function run(payload, btn) {
    btn.disabled = true;
    try {
      const t = await api('POST', `/api/tasks?${loc}`, payload);
      location.hash = `#/t/${t.id}`;
    } catch (e) {
      if (e.status === 409 && e.data?.id) {
        toast('Already running. Opening it.');
        location.hash = `#/t/${e.data.id}`;
      } else if (e.status === 409 && e.data?.travelHeld) {
        btn.disabled = false;
        if (confirm('Travel mode is on, and this command would heat the laptop in your bag.\n\nOK = run it automatically when Travel mode ends\nCancel = more choices')) {
          try {
            const q = await api('POST', `/api/tasks?${loc}`, { ...payload, later: true });
            toast(`Waiting: ${q.label} runs when Travel mode ends`);
          } catch (e2) { fail(e2); }
        } else if (confirm('Run it now anyway? The laptop will get warmer.')) {
          run({ ...payload, force: true }, btn);
        }
        return;
      } else fail(e);
      btn.disabled = false;
    }
  }

  async function loadRun() {
    try {
      const o = await api('GET', `/api/tasks/options?${loc}`);
      const rows = [];
      for (const sc of o.scripts) {
        const b = h('button', { class: 'item' }, h('span', { class: 'ico', text: /dev|start|serve|watch/.test(sc.name) ? '🌐' : /test|lint|check/.test(sc.name) ? '🧪' : /build/.test(sc.name) ? '📦' : '▶' }),
          h('div', { class: 'grow', style: 'min-width:0' }, h('div', { class: 'ellipsis', text: `${o.manager} run ${sc.name}` }), h('div', { class: 'small muted ellipsis mono', text: sc.cmd })));
        b.onclick = () => run({ kind: 'script', name: sc.name }, b);
        rows.push(b);
      }
      if (o.hasPackage) {
        const b = h('button', { class: 'item' }, h('span', { class: 'ico', text: '⬇' }), h('div', { class: 'grow', text: `${o.manager} install` }));
        b.onclick = () => run({ kind: 'install' }, b);
        rows.push(b);
      }
      for (const q of o.quick) {
        const b = h('button', { class: 'item' }, h('span', { class: 'ico', text: '⚡' }), h('div', { class: 'grow', style: 'min-width:0' }, h('div', { class: 'ellipsis', text: q.name }), h('div', { class: 'small muted ellipsis mono', text: q.cmd })));
        b.onclick = () => run({ kind: 'quick', id: q.id }, b);
        rows.push(b);
      }
      fill(runCard,
        rows.length ? h('div', { class: 'list' }, rows) : h('div', { class: 'small muted', text: 'This folder has no package.json scripts. (You can add fixed commands as "quickCommands" in config.json on the laptop.)' }));
    } catch (e) {
      fill(runCard, h('div', { class: 'small', text: e.message }));
    }
  }

  async function loadRecent() {
    try {
      const { tasks } = await api('GET', '/api/tasks', undefined, { auto: true });
      const here = tasks.filter((t) => t.rootId === root && t.rel === rel);
      fill(recentBox, here.length ? here.map(taskRow) : h('div', { class: 'item muted', text: 'Nothing run here yet.' }));
    } catch { /* offline */ }
  }

  async function loadShares() {
    const port = h('input', { type: 'number', inputmode: 'numeric', placeholder: 'Port, e.g. 3000', min: 1024, max: 65535 });
    try {
      const { shares } = await api('GET', '/api/share');
      fill(shareCard,
        h('div', { class: 'small muted', text: 'Start a dev server above, then share its port. It opens at your laptop’s private Tailscale address (only your own devices can reach it).' }),
        shares.length ? h('div', { class: 'list' }, shares.map((sh) => h('div', { class: 'item' },
          h('div', { class: 'grow', style: 'min-width:0' }, h('div', { text: `Port ${sh.port ?? '?'}` }), h('div', { class: 'small muted ellipsis', text: sh.url })),
          h('a', { class: 'btn small primary', href: sh.url, target: '_blank', rel: 'noopener', text: 'Open' }),
          h('button', { class: 'btn small', text: 'Stop', onclick: () => api('POST', '/api/share/off', { port: sh.port }).then(loadShares).catch(fail) })))) : null,
        h('div', { class: 'row' }, port, h('button', { class: 'btn', text: 'Share', onclick: (e) => sharePort(Number(port.value), e.target).then(loadShares) })));
    } catch (e) {
      fill(shareCard, h('div', { class: 'small', text: e.message }));
    }
  }

  async function loadGit() {
    try {
      const g = await api('GET', `/api/git/status?${loc}`);
      const changed = g.total;
      fill(gitCard,
        h('div', { class: 'row' }, h('span', { class: 'grow', style: 'font-weight:600', text: `⎇ ${g.branch || '?'}` }), h('span', { text: '›' })),
        h('div', { class: 'small muted', text: [
          changed ? `${changed} changed file${changed === 1 ? '' : 's'}` : 'No changes',
          g.upstream ? `${g.ahead} to push · ${g.behind} to pull (${g.upstream})` : 'no upstream branch',
        ].join(' · ') }));
    } catch (e) {
      fill(gitCard, h('div', { class: 'small muted', text: e.message }));
    }
  }

  loadRun();
  loadRecent();
  loadShares();
  loadGit();
  const t = setInterval(loadRecent, 5000);
  onLeave(() => clearInterval(t));
}

const CMD_KEY = 'pd-cmds';
const recentCmds = () => { try { return JSON.parse(localStorage.getItem(CMD_KEY) || '[]'); } catch { return []; } };
function saveCmd(cmd, sh) {
  const list = [{ cmd, sh }, ...recentCmds().filter((c) => !(c.cmd === cmd && c.sh === sh))].slice(0, 12);
  try { localStorage.setItem(CMD_KEY, JSON.stringify(list)); } catch { /* private mode */ }
}

/** Free-typed command line for the Project page: runs in this folder like a terminal, one line at a time. */
function commandBox(onRun) {
  const input = h('input', { type: 'text', class: 'mono', placeholder: 'e.g. git log --oneline -5', autocapitalize: 'off', autocomplete: 'off', spellcheck: 'false', enterkeyhint: 'go' });
  let sh = (() => { try { return localStorage.getItem('pd-shell') || 'cmd'; } catch { return 'cmd'; } })();
  const shSel = h('select', { class: 'inline-select', 'aria-label': 'Shell', onchange: (e) => { sh = e.target.value; try { localStorage.setItem('pd-shell', sh); } catch { /* */ } } },
    h('option', { value: 'cmd', text: 'cmd', selected: sh === 'cmd' }), h('option', { value: 'powershell', text: 'PowerShell', selected: sh === 'powershell' }));
  const go = h('button', { class: 'btn primary', text: '▶ Run' });
  const recent = h('div', { class: 'chips' });
  const drawRecent = () => fill(recent, recentCmds().map((c) => h('button', { class: 'chip-link mono', title: c.sh, text: c.cmd, onclick: () => { input.value = c.cmd; sh = c.sh; shSel.value = c.sh; input.focus(); } })));
  const submit = () => {
    const cmd = input.value.trim();
    if (!cmd) return input.focus();
    saveCmd(cmd, sh);
    onRun(cmd, sh, go);
  };
  go.onclick = submit;
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
  drawRecent();
  return h('div', { class: 'card stack' },
    h('div', { class: 'row' }, input, shSel),
    go, recent,
    h('div', { class: 'small muted', text: 'Runs in this folder on the laptop, like a terminal. Commands that ask a question can be answered from the next screen. Long-running ones (dev servers) keep going until you press Stop.' }));
}

function taskRow(t) {
  return h('a', { class: 'item', href: `#/t/${t.id}` },
    h('div', { class: 'grow', style: 'min-width:0' },
      h('div', { class: 'row' }, h('span', { class: 'grow ellipsis', text: t.label }), taskChip(t.state)),
      h('div', { class: 'small muted ellipsis mono', text: t.last || '' }),
      h('div', { class: 'small muted', text: `${ago(t.startedAt)} · by ${t.by}${t.port ? ` · port ${t.port}` : ''}` })));
}

async function sharePort(port, btn) {
  if (!port) return toast('Type a port', true);
  if (btn) btn.disabled = true;
  try {
    const r = await api('POST', '/api/share', { port });
    toast(`Shared at ${r.url}`);
    if (r.url) window.open(r.url, '_blank', 'noopener');
    return r;
  } catch (e) {
    fail(e);
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function viewTask(id) {
  const head = h('div', { class: 'card stack' }, h('div', { class: 'small muted', text: 'Loading…' }));
  const log = h('pre', { class: 'log' });
  const answer = h('input', { type: 'text', class: 'mono', placeholder: 'Type an answer / input and press Send', autocapitalize: 'off', autocomplete: 'off', spellcheck: 'false', enterkeyhint: 'send' });
  const sendIn = h('button', { class: 'btn primary send-btn', icon: 'send', 'aria-label': 'Send' });
  const inputBar = h('div', { class: 'composer', style: 'display:none' }, h('div', { class: 'inner' }, answer, sendIn));
  const sendAnswer = async () => {
    sendIn.disabled = true;
    try {
      await api('POST', `/api/tasks/${id}/input`, { text: answer.value });
      answer.value = '';
    } catch (e) { fail(e); } finally { sendIn.disabled = false; }
  };
  sendIn.onclick = sendAnswer;
  answer.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); sendAnswer(); } });
  shell({ title: 'Command', back: true, body: [head, log], composer: inputBar });
  let after = 0;
  let task = null;
  let timer = null;
  const nearBottom = () => window.innerHeight + window.scrollY >= document.body.scrollHeight - 120;

  function renderHead() {
    const t = task;
    document.querySelector('.topbar h1').textContent = t.label;
    inputBar.style.display = t.running ? '' : 'none';
    fill(head,
      h('div', { class: 'row' }, h('span', { class: 'grow ellipsis small muted', text: t.dir }), taskChip(t.state)),
      h('div', { class: 'small muted', text: `started ${ago(t.startedAt)} by ${t.by}${t.endedAt ? ` · ran ${duration(t.endedAt - t.startedAt)} · exit ${t.code}` : ''}` }),
      h('div', { class: 'row wrap' },
        t.running ? h('button', { class: 'btn small danger', text: '■ Stop', onclick: (e) => { e.target.disabled = true; api('POST', `/api/tasks/${id}/stop`).catch(fail); } }) : null,
        t.port ? h('button', { class: 'btn small primary', text: `📱 Open port ${t.port} on phone`, onclick: (e) => sharePort(t.port, e.target) }) : null,
        h('a', { class: 'btn small', href: `#/p/${t.rootId}/${enc(t.rel)}`, text: 'Project' }),
        !t.running ? h('button', { class: 'btn small', text: 'Remove', onclick: async () => {
          try { await api('DELETE', `/api/tasks/${id}`); history.back(); } catch (e) { fail(e); }
        } }) : null));
  }

  async function poll() {
    try {
      const r = await api('GET', `/api/tasks/${id}/log?after=${after}`, undefined, { auto: true });
      const stick = nearBottom();
      const changed = !task || task.state !== r.task.state || task.port !== r.task.port;
      task = r.task;
      if (changed) renderHead();
      if (r.dropped && after) log.append(h('span', { class: 'sys', text: '… (older lines dropped) …\n' }));
      for (const l of r.lines) log.append(h('span', { class: l.s, text: `${l.t}\n` }));
      while (log.childNodes.length > 3000) log.firstChild.remove();
      after = r.next;
      if (stick && r.lines.length) window.scrollTo(0, document.body.scrollHeight);
      if (!task.running && !r.lines.length) return; // finished: stop polling
    } catch (e) {
      if (e.status === 404) return fill(head, h('div', { text: 'This run is gone (PocketDesk was restarted or it was removed).' }));
    }
    timer = setTimeout(poll, task?.running ? 1500 : 4000);
  }
  onLeave(() => clearTimeout(timer));
  poll();
}

// ---------- Git ----------
async function viewGit(rootStr, relEnc) {
  const root = Number(rootStr);
  const rel = relEnc ? dec(relEnc) : '';
  const loc = qs({ root, path: rel });
  const head = h('div', { class: 'card stack' }, h('div', { class: 'small muted', text: 'Loading…' }));
  const filesBox = h('div');
  const commitBox = h('div', { class: 'card stack' });
  const logBox = h('div', { class: 'list' });
  const out = h('pre', { class: 'log', style: 'display:none' });
  shell({ title: 'Git', back: `#/p/${root}/${enc(rel)}`, actions: h('button', { class: 'btn small', icon: 'refresh', 'aria-label': 'Refresh', onclick: () => load() }), body: [head, out, filesBox, commitBox, h('div', { class: 'section-title', text: 'Recent commits' }), logBox] });
  let g = null;

  const showOut = (text, bad) => {
    out.style.display = text ? '' : 'none';
    out.className = `log${bad ? ' bad' : ''}`;
    out.textContent = text || '';
  };

  async function act(path, body, btn, okMsg) {
    if (btn) btn.disabled = true;
    try {
      const r = await api('POST', `/api/git/${path}?${loc}`, body);
      if (r.output) showOut(r.output);
      if (okMsg) toast(okMsg);
      await load();
      return r;
    } catch (e) {
      showOut(e.message, true);
      if (btn) btn.disabled = false;
      throw e;
    }
  }

  function fileRow(f, stagedList) {
    const box = h('div', { class: 'gitfile' });
    const cb = h('input', { type: 'checkbox', checked: stagedList, 'aria-label': stagedList ? 'Unstage' : 'Stage' });
    cb.onchange = () => act(stagedList ? 'unstage' : 'stage', { files: [f.path] }).catch(() => {});
    const diff = h('div');
    const label = f.untracked ? 'new' : f.conflict ? 'conflict' : f.code.trim();
    const name = h('button', { class: 'gitname' }, h('span', { class: `gcode g-${label[0]}`, text: label }), h('span', { class: 'grow ellipsis', text: f.from ? `${f.from} → ${f.path}` : f.path }));
    name.onclick = async () => {
      if (diff.firstChild) return fill(diff);
      fill(diff, h('div', { class: 'small muted', text: 'Loading diff…' }));
      try {
        const d = await api('GET', `/api/git/diff?${qs({ root, path: rel, file: f.path, staged: stagedList ? 1 : null })}`);
        fill(diff, renderDiff(d.text), d.cut ? h('div', { class: 'small muted', text: 'Diff cut short (too big). Open the file in Files to see all of it.' }) : null);
      } catch (e) {
        fill(diff, h('div', { class: 'small', text: e.message }));
      }
    };
    box.append(h('div', { class: 'row' }, cb, name), diff);
    return box;
  }

  async function load() {
    try {
      g = await api('GET', `/api/git/status?${loc}`);
    } catch (e) {
      fill(head, h('div', { text: e.message }));
      fill(filesBox);
      fill(commitBox);
      return;
    }
    const staged = g.files.filter((f) => f.staged);
    const unstaged = g.files.filter((f) => f.unstaged || f.untracked);
    const pull = h('button', { class: 'btn small', text: `⬇ Pull${g.behind ? ` (${g.behind})` : ''}` });
    const push = h('button', { class: 'btn small primary', text: `⬆ Push${g.ahead ? ` (${g.ahead})` : ''}` });
    pull.onclick = () => act('pull', {}, pull, 'Pulled').catch(() => {});
    push.onclick = async () => {
      const target = g.upstream || `origin/${g.branch} (new branch on the remote)`;
      if (!confirm(`Push ${g.ahead || 'your'} commit(s) on ${g.branch} to ${target}?\n\nThis sends your code to the remote repository.`)) return;
      try {
        await act('push', { setUpstream: !g.upstream }, push, 'Pushed');
      } catch { /* shown */ }
    };
    fill(head,
      h('div', { class: 'row' }, h('span', { class: 'grow ellipsis', style: 'font-weight:600', text: `⎇ ${g.branch || '?'}` }), g.detached ? h('span', { class: 'chip error', text: 'detached' }) : null),
      h('div', { class: 'small muted ellipsis', text: g.top }),
      h('div', { class: 'small muted', text: g.upstream ? `${g.ahead} ahead, ${g.behind} behind ${g.upstream}${g.upstreamGone ? ' (gone on remote)' : ''}` : g.remotes.length ? 'This branch is not on the remote yet. Push will create it.' : 'No remote. Commits stay on the laptop.' }),
      h('div', { class: 'row wrap' }, g.upstream ? pull : null, g.remotes.length ? push : null));

    const section = (title, list, isStaged) => list.length ? h('div', {},
      h('div', { class: 'row section-title' }, h('span', { class: 'grow', text: `${title} (${list.length})` }),
        h('button', { class: 'btn small', text: isStaged ? 'Unstage all' : 'Stage all', onclick: (e) => act(isStaged ? 'unstage' : 'stage', { files: list.map((f) => f.path) }, e.target).catch(() => {}) })),
      h('div', { class: 'card gitlist' }, list.map((f) => fileRow(f, isStaged)))) : null;
    fill(filesBox,
      g.files.length ? null : h('div', { class: 'empty', text: 'No changes. Everything is committed.' }),
      section('Staged, will be committed', staged, true),
      section('Changes', unstaged, false),
      g.total > g.files.length ? h('div', { class: 'small muted', text: `Showing ${g.files.length} of ${g.total} files.` }) : null,
      g.files.length && h('div', { class: 'small muted', style: 'margin-top:6px', text: 'Tap a file to see its diff. Tick it to stage it. (Discarding changes is not possible from the phone, on purpose.)' }));

    if (g.files.length) {
      const msg = h('textarea', { rows: 3, placeholder: 'Commit message' });
      const c1 = h('button', { class: 'btn primary', text: `Commit staged (${staged.length})`, disabled: !staged.length });
      const c2 = h('button', { class: 'btn', text: 'Stage everything + commit' });
      c1.onclick = () => act('commit', { message: msg.value }, c1, 'Committed').catch(() => {});
      c2.onclick = () => confirm(`Commit ALL ${g.total} changed files, including new ones?`) && act('commit', { message: msg.value, all: true }, c2, 'Committed').catch(() => {});
      fill(commitBox, h('h3', { text: 'Commit' }), msg, h('div', { class: 'row wrap' }, c1, c2));
      commitBox.style.display = '';
    } else {
      fill(commitBox);
      commitBox.style.display = 'none';
    }
    try {
      const { commits } = await api('GET', `/api/git/log?${loc}`);
      fill(logBox, commits.length ? commits.map((c) => h('div', { class: 'item' }, h('div', { class: 'grow', style: 'min-width:0' }, h('div', { class: 'ellipsis', text: c.subject }), h('div', { class: 'small muted', text: `${c.hash} · ${c.author} · ${ago(c.at)}` })))) : h('div', { class: 'item muted', text: 'No commits yet.' }));
    } catch { /* ignore */ }
  }
  load();
}

function renderDiff(text) {
  const pre = h('pre', { class: 'diff' });
  if (!text.trim()) {
    pre.textContent = '(no text changes, e.g. only file mode or a binary file)';
    return pre;
  }
  for (const line of text.split('\n')) {
    let cls = '';
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('new file') || line.startsWith('deleted file')) cls = 'd-meta';
    else if (line.startsWith('+')) cls = 'd-add';
    else if (line.startsWith('-')) cls = 'd-del';
    else if (line.startsWith('@@')) cls = 'd-hunk';
    pre.append(h('span', { class: cls, text: line || ' ' })); // spans are blocks, so no newline needed
  }
  return pre;
}

// ---------- Activity ----------
async function viewActivity() {
  const box = h('div', { class: 'list' }, h('div', { class: 'item muted', text: 'Loading…' }));
  shell({ title: 'Activity', back: '#/laptop', body: [h('p', { class: 'small muted', text: 'Everything done through PocketDesk, newest first. Stored only on the laptop (data\\activity.jsonl).' }), box] });
  try {
    const { items } = await api('GET', '/api/activity?limit=300');
    fill(box, items.length ? items.map((it) => h('div', { class: 'item' },
      h('div', { class: 'grow', style: 'min-width:0' },
        h('div', { class: 'row' }, h('span', { class: 'grow ellipsis', style: 'font-weight:600', text: it.action }), h('span', { class: 'small muted', text: new Date(it.at).toLocaleString([], { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) })),
        it.detail ? h('div', { class: 'small muted ellipsis', text: it.detail }) : null,
        h('div', { class: 'small muted', text: `by ${it.by}` })))) : h('div', { class: 'item muted', text: 'Nothing yet.' }));
  } catch (e) {
    fill(box, h('div', { class: 'item', text: e.message }));
  }
}

// ---------- Laptop tab: alerts + security cards ----------
async function renderAlertsCard(card) {
  let a;
  try {
    a = await api('GET', '/api/alerts');
  } catch (e) {
    return fill(card, h('div', { class: 'small', text: e.message }));
  }
  const save = async (patch) => {
    try {
      a = await api('PUT', '/api/alerts', patch);
      toast('Saved');
    } catch (e) { fail(e); }
  };
  const sel = (key, opts) => h('select', { class: 'inline-select', onchange: (e) => save({ [key]: Number(e.target.value) }) },
    opts.map(([v, t]) => h('option', { value: v, text: t, selected: a[key] === v })));
  const tick = (key, text) => h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: a[key], onchange: (e) => save({ [key]: e.target.checked }) }), h('span', { text }));
  fill(card,
    h('div', { class: 'small muted', text: 'Sent as phone notifications (turn them on below under "This device"). Checked every minute.' }),
    h('div', { class: 'row' }, h('span', { class: 'grow', text: 'Battery low' }), sel('batteryLow', [[0, 'Off'], [10, 'at 10%'], [15, 'at 15%'], [20, 'at 20%'], [30, 'at 30%'], [40, 'at 40%']])),
    tick('unplugged', 'Charger pulled out'),
    h('div', { class: 'row' }, h('span', { class: 'grow', text: 'Laptop too hot' }), sel('hotC', [[0, 'Off'], [75, 'at 75°C'], [80, 'at 80°C'], [85, 'at 85°C'], [90, 'at 90°C'], [95, 'at 95°C']])),
    tick('backOnline', 'Internet came back after an outage'),
    tick('wake', 'Laptop woke up / PocketDesk restarted'),
    h('div', { class: 'small muted', style: 'margin-top:6px', text: 'Claude' }),
    tick('laptopDone', 'A laptop chat (desktop app / terminal) finished'),
    h('div', { class: 'row' }, h('span', { class: 'grow', text: 'Laptop chat waiting on a step' }), sel('laptopWaitMin', [[0, 'Off'], [3, 'after 3 min'], [5, 'after 5 min'], [10, 'after 10 min'], [20, 'after 20 min']])),
    h('div', { class: 'row' }, h('span', { class: 'grow', text: 'Phone session making no progress' }), sel('stuckMin', [[0, 'Off'], [10, 'after 10 min'], [15, 'after 15 min'], [30, 'after 30 min'], [60, 'after 1 h']])),
    h('div', { class: 'small muted', style: 'margin-top:6px', text: 'Security' }),
    tick('newDevice', 'A new device paired, an unpaired device opened PocketDesk, or a phone login was used from another device'),
    h('div', { class: 'small muted', text: 'Note: some laptops only expose a slow board sensor, so the temperature can read lower than the CPU really is.' }));
}

async function renderSecurityCard(card) {
  let s;
  try {
    s = await api('GET', '/api/security');
  } catch (e) {
    return fill(card, h('div', { class: 'small', text: e.message }));
  }
  const onDevice = app.me.kind === 'device';
  const cur = h('input', { type: 'password', inputmode: 'numeric', maxlength: 8, placeholder: 'Current PIN', autocomplete: 'off' });
  const pin = h('input', { type: 'password', inputmode: 'numeric', maxlength: 8, placeholder: s.pinSet ? 'New PIN (4-8 digits)' : 'PIN (4-8 digits)', autocomplete: 'off' });
  const pin2 = h('input', { type: 'password', inputmode: 'numeric', maxlength: 8, placeholder: 'Type it again', autocomplete: 'off' });
  const mins = h('select', { class: 'inline-select' }, [5, 10, 15, 30, 60, 240, 1440].map((m) => h('option', { value: m, text: m < 60 ? `${m} min` : m === 1440 ? '1 day' : `${m / 60} h`, selected: s.lockMinutes === m })));
  const refresh = async () => {
    app.me = await api('GET', '/api/me');
    renderSecurityCard(card);
  };
  mins.onchange = async () => {
    try {
      await api('POST', '/api/security/pin', { lockMinutes: Number(mins.value) });
      toast('Saved');
      refresh();
    } catch (e) { fail(e); }
  };
  const setBtn = h('button', { class: 'btn primary small', text: s.pinSet ? 'Change PIN' : 'Turn on PIN lock' });
  setBtn.onclick = async () => {
    if (pin.value !== pin2.value) return toast('The two PINs are different', true);
    try {
      await api('POST', '/api/security/pin', { pin: pin.value, currentPin: cur.value || undefined, lockMinutes: Number(mins.value) });
      toast(s.pinSet ? 'PIN changed' : 'PIN lock on');
      refresh();
    } catch (e) { fail(e); }
  };
  const offBtn = h('button', { class: 'btn small danger', text: 'Turn off PIN' });
  offBtn.onclick = async () => {
    if (!confirm('Turn off the PIN lock? Anyone holding an unlocked paired phone could then use PocketDesk.')) return;
    try {
      await api('POST', '/api/security/pin/clear', { currentPin: cur.value });
      toast('PIN lock off');
      refresh();
    } catch (e) { fail(e); }
  };
  fill(card,
    h('div', { class: 'row' }, h('strong', { class: 'grow', text: s.pinSet ? '🔒 PIN lock is ON' : '🔓 PIN lock is off' }),
      s.pinSet && onDevice ? h('button', { class: 'btn small', text: 'Lock now', onclick: () => api('POST', '/api/lock/now').then(showLock).catch(fail) }) : null),
    h('div', { class: 'small muted', text: 'With a PIN, a paired phone asks for it after being idle. 5 wrong tries block it for 15 minutes; 10 unpair it. The laptop itself never asks.' }),
    h('div', { class: 'row' }, h('span', { class: 'grow', text: 'Lock after idle' }), mins),
    s.pinSet && onDevice ? cur : null,
    pin, pin2,
    h('div', { class: 'row wrap' }, setBtn, s.pinSet ? offBtn : null),
    h('div', { class: 'small muted', text: s.tailscaleUsers.length || s.configUsers.length
      ? `Only these Tailscale logins can connect: ${[...s.configUsers, ...s.tailscaleUsers].join(', ')}`
      : 'Any device in your Tailscale network can open the pairing page. You can limit it to your own login in Setup on the laptop.' }),
    s.myLogin ? h('div', { class: 'small muted', text: `This device is connected as ${s.myLogin}.` }) : null,
    s.pinSet ? h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: s.actionsWhileLocked, onchange: async (e) => {
      const on = e.target.checked;
      try {
        let currentPin;
        if (on && onDevice) {
          currentPin = await pinDialog('Type your PIN', 'Allow / Deny on notifications will then work without unlocking PocketDesk.');
          if (currentPin == null) return void (e.target.checked = false);
        }
        await api('POST', '/api/security/notify-actions', { on, currentPin });
        toast('Saved');
      } catch (err) {
        e.target.checked = !on;
        fail(err);
      }
    } }), h('span', {}, h('span', { text: 'Allow / Deny on notifications work while PocketDesk is locked' }),
      h('div', { class: 'small muted', text: 'Off: tapping Allow on a locked phone opens PocketDesk for the PIN first. On: your phone\'s own screen lock is the only guard.' }))) : null,
    h('div', { class: 'section-title', text: 'Panic button' }),
    h('div', { class: 'small muted', text: 'If a phone is lost or you think someone else got in: stops every Claude session and command, stops dev-server sharing, unpairs EVERY device (this one too) and locks the laptop screen. Pair again with a new code afterwards.' }),
    h('button', { class: 'btn danger block', text: '🚨 Panic: lock everything out', onclick: panic }));
}

async function panic() {
  if (!confirm('PANIC: stop all Claude work, unpair every device (including this one) and lock the laptop?\n\nChats in the desktop app keep running; only PocketDesk ones stop.')) return;
  try {
    const r = await api('POST', '/api/panic');
    alert(`Done. Stopped ${r.sessions} Claude session(s) and ${r.commands} command(s), unpaired ${r.devices} device(s)${r.locked ? ', laptop screen locked' : ''}.`);
  } catch (e) {
    fail(e);
  }
  location.reload();
}

// ---------- Photos & videos ----------
const IMG_EXT = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'avif', 'heic', 'heif'];
const VID_EXT = ['mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi', '3gp', 'wmv'];
const PLAYABLE_IMG = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'avif'];
const PLAYABLE_VID = ['mp4', 'm4v', 'mov', 'webm', 'mkv', '3gp'];
const extOf = (n) => n.split('.').pop().toLowerCase();
const mediaOf = (n) => (IMG_EXT.includes(extOf(n)) ? 'image' : VID_EXT.includes(extOf(n)) ? 'video' : null);

async function viewGallery(rootStr, relEnc) {
  if (rootStr == null || rootStr === '') return viewGalleryHome();
  const root = Number(rootStr);
  const rel = relEnc ? dec(relEnc) : '';
  const name = rel ? rel.split('/').pop() : app.me.roots[root]?.name || '?';
  const grid = h('div', { class: 'gallery' });
  const folders = h('div', { class: 'chips' });
  const info = h('div', { class: 'small muted', text: 'Loading…' });
  let sort = (() => { try { return localStorage.getItem('pd-gsort') || 'new'; } catch { return 'new'; } })();
  const sortSel = h('select', { class: 'inline-select', onchange: (e) => { sort = e.target.value; try { localStorage.setItem('pd-gsort', sort); } catch { /* */ } draw(); } },
    h('option', { value: 'new', text: 'Newest first', selected: sort === 'new' }), h('option', { value: 'old', text: 'Oldest first', selected: sort === 'old' }), h('option', { value: 'name', text: 'By name', selected: sort === 'name' }));
  shell({
    title: name,
    back: rel ? `#/gallery/${root}/${enc(rel.split('/').slice(0, -1).join('/'))}` : '#/gallery',
    actions: h('a', { class: 'btn small', href: `#/files/${root}/${enc(rel)}`, text: '📁' }),
    body: [h('div', { class: 'small muted ellipsis', style: 'margin-bottom:6px', text: `${app.me.roots[root]?.name || '?'}${rel ? ` / ${rel}` : ''}` }), folders, h('div', { class: 'row', style: 'margin:8px 0' }, h('span', { class: 'grow' }, info), sortSel), grid],
  });
  let items = [];
  const PAGE = 180;
  let shown = PAGE;
  const more = h('button', { class: 'btn block', style: 'margin-top:10px;display:none', onclick: () => { shown += PAGE; draw(); } });
  function draw() {
    const list = [...items].sort((a, b) => (sort === 'name' ? a.name.localeCompare(b.name, undefined, { numeric: true }) : sort === 'old' ? a.mtime - b.mtime : b.mtime - a.mtime));
    more.style.display = list.length > shown ? '' : 'none';
    more.textContent = `Show more (${list.length - shown} left)`;
    if (!more.isConnected) grid.after(more);
    fill(grid, list.slice(0, shown).map((it, i) => {
      const p = [rel, it.name].filter(Boolean).join('/');
      const tile = h('button', { class: `tile ${it.kind}`, 'aria-label': it.name, onclick: () => openViewer(root, rel, list, i) },
        h('img', { loading: 'lazy', decoding: 'async', alt: '', src: `/api/files/thumb?${qs({ root, path: p, w: 320 })}`, onerror: (e) => { e.target.replaceWith(h('span', { class: 'tile-name', text: it.name })); } }),
        it.kind === 'video' ? h('span', { class: 'play', text: '▶' }) : null);
      return tile;
    }));
  }
  try {
    const r = await api('GET', `/api/files/list?${qs({ root, path: rel })}`);
    items = r.items.filter((x) => !x.dir && mediaOf(x.name)).map((x) => ({ ...x, kind: mediaOf(x.name) }));
    const subs = r.items.filter((x) => x.dir);
    fill(folders, subs.slice(0, 60).map((d) => h('a', { class: 'chip-link', href: `#/gallery/${root}/${enc([rel, d.name].filter(Boolean).join('/'))}`, text: `📁 ${d.name}` })));
    const nImg = items.filter((x) => x.kind === 'image').length;
    info.textContent = items.length ? `${nImg} photo${nImg === 1 ? '' : 's'}, ${items.length - nImg} video${items.length - nImg === 1 ? '' : 's'}` : 'No photos or videos in this folder.';
    draw();
  } catch (e) {
    info.textContent = e.message;
  }
}

async function viewGalleryHome() {
  const box = h('div', { class: 'list' }, h('div', { class: 'item muted', text: 'Loading…' }));
  shell({ title: 'Photos & videos', back: '#/files', body: [h('p', { class: 'small muted', text: 'Folders on the laptop where photos and videos usually are. Any folder works: in Files, open it and press 🖼 Gallery.' }), box] });
  try {
    const r = await api('GET', '/api/media/places');
    fill(box, r.places.length ? r.places.map((p) => h('a', { class: 'item', href: `#/gallery/${p.rootId}/${enc(p.rel)}` }, h('span', { class: 'ico', text: '🖼' }), h('span', { class: 'grow', text: p.name }), h('span', { class: 'small muted ellipsis', text: p.rel }))) : h('div', { class: 'item muted', text: 'None found.' }),
      r.thumbs ? null : h('div', { class: 'item small muted', text: 'ffmpeg was not found, so there are no thumbnails (photos still open).' }));
  } catch (e) {
    fill(box, h('div', { class: 'item', text: e.message }));
  }
}

/** Full-screen photo/video viewer with swipe, arrows and download. */
function openViewer(root, rel, list, start) {
  let i = start;
  const stage = h('div', { class: 'mv-stage' });
  const cap = h('div', { class: 'mv-cap' });
  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  };
  const go = (d) => {
    const n = i + d;
    if (n < 0 || n >= list.length) return;
    i = n;
    show();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowLeft') go(-1);
    else if (e.key === 'ArrowRight') go(1);
  };
  function show() {
    const it = list[i];
    const p = [rel, it.name].filter(Boolean).join('/');
    const raw = `/api/files/raw?${qs({ root, path: p })}`;
    const dl = `/api/files/raw?${qs({ root, path: p, dl: 1 })}`;
    const ext = extOf(it.name);
    let media;
    if (it.kind === 'video' && PLAYABLE_VID.includes(ext)) {
      media = h('video', { src: raw, controls: true, playsinline: true, preload: 'metadata', poster: `/api/files/thumb?${qs({ root, path: p, w: 1280 })}` });
      media.addEventListener('error', () => fill(stage, h('div', { class: 'mv-msg' }, h('p', { text: 'The phone cannot play this video format here.' }), h('a', { class: 'btn primary', href: dl, text: '⬇ Download it' }))));
    } else if (it.kind === 'image' && PLAYABLE_IMG.includes(ext)) {
      media = h('img', { src: raw, alt: it.name });
    } else {
      media = h('div', { class: 'mv-msg' }, h('img', { src: `/api/files/thumb?${qs({ root, path: p, w: 1280 })}`, alt: it.name }), h('a', { class: 'btn primary', href: dl, text: '⬇ Download original' }));
    }
    fill(stage, media);
    fill(cap, h('div', { class: 'grow', style: 'min-width:0' }, h('div', { class: 'ellipsis', text: it.name }), h('div', { class: 'small', text: `${i + 1} / ${list.length} · ${size(it.size)} · ${new Date(it.mtime).toLocaleString([], { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' })}` })),
      h('a', { class: 'btn small', href: dl, text: '⬇' }));
  }
  let x0 = null;
  stage.addEventListener('touchstart', (e) => { x0 = e.touches[0].clientX; }, { passive: true });
  stage.addEventListener('touchend', (e) => {
    if (x0 == null) return;
    const dx = e.changedTouches[0].clientX - x0;
    x0 = null;
    if (Math.abs(dx) > 60 && !(stage.querySelector('video') && e.target.tagName === 'VIDEO' && Math.abs(dx) < 120)) go(dx < 0 ? 1 : -1);
  });
  const overlay = h('div', { class: 'mv', role: 'dialog' },
    h('div', { class: 'mv-top' }, h('button', { class: 'btn small', text: '✕ Close', onclick: close }), h('span', { class: 'grow' }),
      h('button', { class: 'btn small', text: '‹', 'aria-label': 'Previous', onclick: () => go(-1) }), h('button', { class: 'btn small', text: '›', 'aria-label': 'Next', onclick: () => go(1) })),
    stage, cap);
  document.body.append(overlay);
  document.addEventListener('keydown', onKey);
  onLeave(close);
  show();
}

// ---------- From PC: laptop chats, any account ----------
const WHERE_ICON = { 'Desktop app': '🖥', Terminal: '⌨', 'PocketDesk / SDK': '📱', 'VS Code': '🧩' };

async function viewPc() {
  const box = h('div', {}, h('div', { class: 'muted', text: 'Reading chats on the laptop…' }));
  let limit = 40;
  shell({
    title: 'From PC',
    actions: h('button', { class: 'btn small', icon: 'refresh', 'aria-label': 'Refresh', onclick: () => load() }),
    body: [
      h('div', { class: 'card small' },
        h('strong', { text: 'Continue a laptop chat here. ' }),
        'Pick any Claude chat from the laptop (desktop app or terminal, any account) to read all of it and continue on the phone. Or, in that chat on the laptop, just type ',
        h('code', { text: 'switch to phone' }), ' and it moves here by itself.'),
      box],
  });
  async function load() {
    try {
      const r = await api('GET', `/api/laptop-chats?limit=${limit}`);
      fill(box,
        h('div', { class: 'list' }, r.sessions.map((c) => h('a', { class: 'item pc-item', href: c.phoneSession ? `#/s/${c.phoneSession.id}` : `#/pc/${c.id}` },
          h('span', { class: 'ico', text: WHERE_ICON[c.where] || '💬' }),
          h('div', { class: 'grow', style: 'min-width:0' },
            h('div', { class: 'row' }, h('span', { class: 'grow ellipsis', style: 'font-weight:600', text: c.title }),
              c.phoneSession ? h('span', { class: 'chip idle', text: 'on phone' }) : c.activeNow ? h('span', { class: 'chip working', text: 'active now' }) : null),
            h('div', { class: 'small muted ellipsis', text: `${c.where || ''}${c.account ? ` · ${c.account}` : ''} · ${ago(c.updatedAt)}` }),
            h('div', { class: 'small muted ellipsis', text: `📁 ${c.cwd || '?'}` }),
            c.lastPrompt ? h('div', { class: 'small ellipsis', text: `You: ${c.lastPrompt}` }) : null)))),
        r.sessions.length >= limit ? h('button', { class: 'btn block', style: 'margin-top:10px', text: 'Show more', onclick: () => { limit += 40; load(); } }) : null);
    } catch (e) {
      fill(box, h('div', { class: 'card', text: e.message }));
    }
  }
  load();
}

async function viewPcChat(id) {
  const head = h('div', { class: 'card stack' }, h('div', { class: 'small muted', text: 'Loading…' }));
  const chat = h('div', { class: 'chat' });
  const panel = h('div', { class: 'card stack continue-panel' });
  shell({ title: 'Laptop chat', back: '#/pc', body: [head, panel, chat] });
  let limit = 300;
  let accounts = [];
  try {
    accounts = (await api('GET', '/api/accounts')).accounts.filter((a) => a.signedIn);
  } catch { /* shown below */ }
  async function load() {
    let r;
    try {
      r = await api('GET', `/api/laptop-chats/${id}?limit=${limit}`);
    } catch (e) {
      return fill(head, h('div', { text: e.message }));
    }
    const c = r.info;
    document.querySelector('.topbar h1').textContent = c.title || 'Laptop chat';
    fill(head,
      h('div', { class: 'small muted ellipsis', text: `📁 ${c.cwd || '?'}` }),
      h('div', { class: 'small muted', text: `${c.where || ''} · ${c.model || ''}${c.effort ? ` · ${c.effort}` : ''} · last activity ${ago(c.updatedAt)} · ${r.total} messages` }),
      c.activeNow ? h('div', { class: 'small warn-text', text: 'This chat changed in the last 2 minutes, so it may still be open on the laptop. Continuing here is fine, but don\'t type in both places.' }) : null,
      c.phoneSession ? h('a', { class: 'btn primary', href: `#/s/${c.phoneSession.id}`, text: 'Already on the phone: open it' }) : null);

    const acct = h('select', {}, accounts.map((a) => h('option', { value: a.id, text: `${a.email || a.name}${a.isDefault ? ' (default)' : ''}`, selected: a.id === c.suggestedAccount })));
    const go = h('button', { class: 'btn primary block', text: c.phoneSession ? 'Refresh the phone copy and open it' : '📱 Continue this chat on the phone' });
    go.onclick = async () => {
      go.disabled = true;
      try {
        const out = await api('POST', `/api/laptop-chats/${id}/continue`, { accountId: acct.value });
        location.hash = `#/s/${out.session.id}`;
      } catch (e) {
        fail(e);
        go.disabled = false;
      }
    };
    fill(panel,
      h('div', {}, h('label', { class: 'field', text: 'Continue on account' }), acct),
      h('div', { class: 'small muted', text: c.accountSure ? 'This is the account it ran on.' : `Suggested (${c.accountWhy}). Your accounts share one chat history, so pick the one you want this chat to use from now on.` }),
      c.desktopNote ? h('div', { class: 'small warn-text', text: c.desktopNote }) : null,
      go);

    const st = { tools: new Map(), perms: new Map() };
    fill(chat,
      r.total > r.events.length ? h('button', { class: 'btn small', text: `Show earlier messages (${r.total - r.events.length} more)`, onclick: () => { limit = Math.min(1500, limit + 400); load(); } }) : null,
      r.events.map((ev) => renderEvent(ev, st, null)).filter(Boolean));
  }
  await load();
  window.scrollTo(0, document.body.scrollHeight);
}

// ---------- Setup: "switch to phone" hook ----------
async function renderHookCard(card) {
  let r;
  try {
    r = await api('GET', '/api/setup/hooks');
  } catch (e) {
    return fill(card, h('div', { class: 'small', text: e.message }));
  }
  const all = r.accounts.every((a) => a.installed);
  const some = r.accounts.some((a) => a.installed);
  const act = async (remove, btn) => {
    btn.disabled = true;
    try {
      const out = await api('POST', '/api/setup/hooks', { remove });
      const bad = out.results.filter((x) => !x.ok);
      toast(bad.length ? `Done, but failed for: ${bad.map((b) => `${b.id} (${b.error})`).join(', ')}` : remove ? 'Removed' : 'Installed in every account', !!bad.length);
      renderHookCard(card);
    } catch (e) { fail(e); btn.disabled = false; }
  };
  fill(card,
    h('h3', { text: '4. "switch to phone" in any laptop chat' }),
    h('div', { class: 'small muted', text: 'Adds a small hook to each Claude account on this laptop. Then typing "switch to phone" (or "move to mobile", "continue on phone") in any Claude Code chat, in the desktop app or a terminal, moves that chat to PocketDesk and your phone gets a notification. Other messages are not affected. It works in chats started after installing.' }),
    h('div', { class: 'list' }, r.accounts.map((a) => h('div', { class: 'item' }, h('span', { class: 'grow ellipsis', text: `${a.email || a.name}` }),
      h('span', { class: `chip ${a.error ? 'error' : a.installed ? 'idle' : ''}`, text: a.error ? 'error' : a.installed ? 'on' : 'off' })))),
    h('div', { class: 'row wrap' },
      !all ? h('button', { class: 'btn primary', text: 'Turn on for all accounts', onclick: (e) => act(false, e.target) }) : null,
      some ? h('button', { class: 'btn', text: 'Turn off', onclick: (e) => act(true, e.target) }) : null));
}

// ---------- small dialogs ----------
/** A PIN box over the page. Resolves with the typed PIN, or null when cancelled. */
function pinDialog(title, text) {
  return new Promise((resolve) => {
    const pin = h('input', { type: 'password', inputmode: 'numeric', autocomplete: 'off', maxlength: 8, placeholder: 'PIN', class: 'pin-input' });
    let ov;
    const done = (v) => {
      ov.remove();
      resolve(v);
    };
    pin.addEventListener('keydown', (e) => e.key === 'Enter' && done(pin.value));
    ov = h('div', { class: 'overlay', onclick: (e) => e.target === ov && done(null) },
      h('div', { class: 'card stack dialog', role: 'dialog', 'aria-label': title },
        h('h3', { text: title }),
        text ? h('div', { class: 'small muted', text }) : null,
        pin,
        h('div', { class: 'row' }, h('span', { class: 'grow' }),
          h('button', { class: 'btn', text: 'Cancel', onclick: () => done(null) }),
          h('button', { class: 'btn primary', text: 'OK', onclick: () => done(pin.value) }))));
    document.body.append(ov);
    setTimeout(() => pin.focus(), 30);
  });
}

/** Calls fn(pin). Asks for the PIN only when the laptop says this action needs it (and again after a wrong one). */
async function withPin(title, text, fn) {
  try {
    return await fn(undefined);
  } catch (e) {
    if (!e.data?.needPin) throw e;
  }
  for (;;) {
    const pin = await pinDialog(title, text);
    if (pin == null) return null;
    try {
      return await fn(pin);
    } catch (e) {
      if (!e.data?.needPin) throw e;
      toast(e.message, true);
    }
  }
}

/** A bottom sheet with a list of choices. Resolves with the picked item, or null. */
function pickSheet(title, items, label) {
  return new Promise((resolve) => {
    let ov;
    const done = (v) => {
      ov.remove();
      resolve(v);
    };
    ov = h('div', { class: 'overlay sheet', onclick: (e) => e.target === ov && done(null) },
      h('div', { class: 'card stack dialog' },
        h('div', { class: 'row' }, h('h3', { class: 'grow', text: title }), h('button', { class: 'btn small', text: 'Close', onclick: () => done(null) })),
        items.length ? h('div', { class: 'list' }, items.map((it) => h('button', { class: 'item', onclick: () => done(it) }, label(it))))
          : h('div', { class: 'small muted', text: 'Nothing here yet.' }),
        h('a', { class: 'btn small', href: '#/prompts', text: '✎ Edit saved prompts', onclick: () => done(null) })));
    document.body.append(ov);
  });
}

// ---------- photos for Claude ----------
const MAX_PHOTOS = 4;
/** Shrinks a photo on the phone (longest side 1568 px, what Claude reads best) and returns { mediaType, data, url }. */
async function photoForClaude(file, max = 1568) {
  let src;
  let w;
  let hgt;
  try {
    src = await createImageBitmap(file, { imageOrientation: 'from-image' });
    w = src.width;
    hgt = src.height;
  } catch {
    src = await new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error(`${file.name || 'This photo'} cannot be read on this phone (HEIC? Send it as JPEG).`));
      im.src = URL.createObjectURL(file);
    });
    w = src.naturalWidth;
    hgt = src.naturalHeight;
  }
  const scale = Math.min(1, max / Math.max(w, hgt));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(hgt * scale);
  canvas.getContext('2d').drawImage(src, 0, 0, canvas.width, canvas.height);
  const url = canvas.toDataURL('image/jpeg', 0.85);
  return { mediaType: 'image/jpeg', data: url.slice(url.indexOf(',') + 1), url };
}

/** The 📷 button + thumbnails strip. photos: array kept by the caller. */
function photoPicker(photos, onChange) {
  const input = h('input', { type: 'file', accept: 'image/*', multiple: true, style: 'display:none' });
  const strip = h('div', { class: 'photo-strip' });
  const redraw = () => {
    fill(strip, photos.map((p, i) => h('div', { class: 'photo-thumb' }, h('img', { src: p.url, alt: `Photo ${i + 1}` }),
      h('button', { class: 'x', 'aria-label': 'Remove photo', text: '×', onclick: () => { photos.splice(i, 1); redraw(); } }))));
    strip.style.display = photos.length ? '' : 'none';
    onChange?.();
  };
  input.onchange = async () => {
    for (const f of input.files) {
      if (photos.length >= MAX_PHOTOS) {
        toast(`At most ${MAX_PHOTOS} photos per message`, true);
        break;
      }
      try {
        photos.push(await photoForClaude(f));
      } catch (e) { fail(e); }
    }
    input.value = '';
    redraw();
  };
  const button = h('button', { class: 'btn small photo-btn', type: 'button', 'aria-label': 'Add a photo', title: 'Add a photo (camera or gallery)', text: '📷', onclick: () => input.click() });
  redraw();
  return { button, strip, input, redraw };
}

async function loadPrompts() {
  try {
    return (await api('GET', '/api/prompts')).prompts;
  } catch {
    return [];
  }
}

// ---------- saved prompt buttons ----------
async function viewPrompts() {
  const box = h('div', { class: 'stack' }, h('div', { class: 'muted', text: 'Loading…' }));
  shell({ title: 'Saved prompts', back: '#/claude', body: box });
  let list = (await loadPrompts()).map((p) => ({ ...p }));
  const roots = app.me.roots;
  const save = async (btn) => {
    btn.disabled = true;
    try {
      list = (await api('PUT', '/api/prompts', { prompts: list })).prompts;
      toast('Saved');
      draw();
    } catch (e) {
      fail(e);
      btn.disabled = false;
    }
  };
  function draw() {
    const cards = list.map((p, i) => {
      const name = h('input', { type: 'text', value: p.name, maxlength: 40, placeholder: 'Button name', oninput: (e) => (p.name = e.target.value) });
      const text = h('textarea', { rows: 4, placeholder: 'What Claude should do', oninput: (e) => (p.text = e.target.value) });
      text.value = p.text;
      const folderLine = h('div', { class: 'row wrap' },
        h('span', { class: 'small muted grow', text: p.rootId != null ? `📁 ${roots[p.rootId]?.name || '?'}${p.rel ? ` / ${p.rel}` : ''}` : '📁 Folder: pick when starting' }),
        h('button', { class: 'btn small', text: p.rootId != null ? 'Change' : 'Fix a folder', onclick: () => {
          folderLine.replaceWith(folderPicker({ root: p.rootId ?? 0, rel: p.rel || '' }, (root, rel) => { p.rootId = root; p.rel = rel; draw(); }));
        } }),
        p.rootId != null ? h('button', { class: 'btn small', text: 'Any folder', onclick: () => { delete p.rootId; delete p.rel; draw(); } }) : null);
      return h('div', { class: 'card stack' }, name, text, folderLine,
        h('div', { class: 'row wrap' },
          i > 0 ? h('button', { class: 'btn small', text: '↑', 'aria-label': 'Move up', onclick: () => { [list[i - 1], list[i]] = [list[i], list[i - 1]]; draw(); } }) : null,
          h('span', { class: 'grow' }),
          h('button', { class: 'btn small danger', text: 'Delete', onclick: () => { list.splice(i, 1); draw(); } })));
    });
    const saveBtn = h('button', { class: 'btn primary block', text: 'Save' });
    saveBtn.onclick = () => save(saveBtn);
    fill(box,
      h('div', { class: 'small muted', text: 'Buttons for prompts you use often. On the Claude tab, tap one to start a session with it. In an open chat, the ⚡ button puts it in the message box. Remember to press Save.' }),
      cards,
      h('button', { class: 'btn block', icon: 'plus', text: 'Add a prompt', onclick: () => { list.push({ name: '', text: '' }); draw(); } }),
      saveBtn);
  }
  draw();
}

/** Chips on the Claude tab: tap = new session with that prompt (and its folder). */
function promptChips(list) {
  if (!list.length) return null;
  return h('div', { class: 'card stack' },
    h('div', { class: 'row' }, h('strong', { class: 'grow', text: '⚡ Saved prompts' }), h('a', { class: 'small', href: '#/prompts', text: 'Edit' })),
    h('div', { class: 'chips' }, list.map((p) => {
      const last = lastProject();
      const where = p.rootId != null ? { root: p.rootId, path: p.rel || '' } : last && app.me.roots[last.root] ? { root: last.root, path: last.rel } : {};
      return h('a', { class: 'chip-link', href: `#/new?${qs({ ...where, prompt: p.text })}`, text: p.name });
    })));
}

// ---------- screen peek ----------
async function viewScreen() {
  const img = h('img', { class: 'screen-img', alt: 'The laptop screen' });
  const stage = h('div', { class: 'screen-stage' }, img);
  const msg = h('div', { class: 'small muted', text: 'Connecting…' });
  const SIZES = { fast: [800, 3000], normal: [1280, 2000], sharp: [1920, 2500] };
  let size = 'normal';
  try { size = localStorage.getItem('pd-peek') || 'normal'; } catch { /* private mode */ }
  if (!SIZES[size]) size = 'normal';
  let running = false;
  let timer = null;
  let lastUrl = null;
  let alive = true;
  const pauseBtn = h('button', { class: 'btn small', text: 'Pause' });
  const sizeSel = h('select', { class: 'inline-select', onchange: (e) => { size = e.target.value; try { localStorage.setItem('pd-peek', size); } catch { /* ignore */ } } },
    [['fast', 'Fast'], ['normal', 'Normal'], ['sharp', 'Sharp']].map(([v, t]) => h('option', { value: v, text: t, selected: v === size })));
  shell({ title: 'Laptop screen', back: '#/laptop', body: [
    h('div', { class: 'row wrap', style: 'margin-bottom:8px' }, pauseBtn, sizeSel, h('span', { class: 'grow' }), msg),
    stage,
    h('div', { class: 'small muted', style: 'margin-top:8px', text: 'View only: nothing you do here touches the laptop. Tap the picture to zoom in or out. With the lid closed and no monitor, or when Windows is locked, there is nothing to show.' })] });

  async function frame() {
    if (!running || !alive) return;
    const [w, every] = SIZES[size];
    try {
      const r = await fetch(`/api/screen?w=${w}`, { credentials: 'same-origin', headers: { 'x-pd-auto': '1' } });
      if (!r.ok) {
        let data = null;
        try { data = await r.json(); } catch { /* not json */ }
        if (r.status === 423 && data?.locked) return showLock();
        if (data?.needPin) {
          running = false;
          return unlockAndStart();
        }
        throw new Error(data?.error || `The laptop said ${r.status}`);
      }
      const url = URL.createObjectURL(await r.blob());
      img.src = url;
      if (lastUrl) URL.revokeObjectURL(lastUrl);
      lastUrl = url;
      msg.textContent = `live · ${new Date().toLocaleTimeString()}`;
    } catch (e) {
      msg.textContent = e.message;
    }
    if (running && alive) timer = setTimeout(frame, document.visibilityState === 'visible' ? every : 10_000);
  }
  async function unlockAndStart() {
    try {
      const st = await withPin('Type your PIN to see the screen', 'Screen peek asks for the PIN every time (it then works for 10 minutes).', (pin) => api('POST', '/api/screen/start', { pin }));
      if (!st) return void (msg.textContent = 'Not started.');
      running = true;
      pauseBtn.textContent = 'Pause';
      frame();
    } catch (e) { fail(e); }
  }
  pauseBtn.onclick = () => {
    running = !running;
    pauseBtn.textContent = running ? 'Pause' : 'Resume';
    clearTimeout(timer);
    if (running) frame();
    else msg.textContent = 'paused';
  };
  img.onclick = () => stage.classList.toggle('zoomed');
  onLeave(() => {
    alive = false;
    clearTimeout(timer);
    if (lastUrl) URL.revokeObjectURL(lastUrl);
  });
  unlockAndStart();
}

// ---------- clipboard ----------
async function viewClip() {
  const fromBox = h('div', { class: 'stack' });
  const toText = h('textarea', { rows: 5, placeholder: 'Type or paste text for the laptop' });
  const getBtn = h('button', { class: 'btn primary', text: '⬇ Get laptop clipboard' });
  getBtn.onclick = async () => {
    getBtn.disabled = true;
    try {
      const r = await api('GET', '/api/clipboard');
      if (r.image) {
        fill(fromBox, h('img', { class: 'preview-img', src: r.image, alt: 'Picture on the laptop clipboard' }),
          h('a', { class: 'btn small', href: r.image, download: 'laptop-clipboard.png', text: '⬇ Save picture' }));
      } else if (r.text) {
        const copy = h('button', { class: 'btn small primary', text: 'Copy on this phone' });
        copy.onclick = () => navigator.clipboard.writeText(r.text).then(() => toast('Copied'), () => toast('This browser would not allow copying. Select the text and copy it.', true));
        fill(fromBox, h('pre', { class: 'viewer wrap clip-text', text: r.text }), h('div', { class: 'row wrap' }, copy,
          /^https?:\/\/\S+$/.test(r.text.trim()) ? h('a', { class: 'btn small', href: r.text.trim(), target: '_blank', rel: 'noopener noreferrer', text: 'Open link' }) : null));
      } else fill(fromBox, h('div', { class: 'small muted', text: 'The laptop clipboard is empty (or holds something that is not text or a picture, like files).' }));
    } catch (e) { fail(e); }
    getBtn.disabled = false;
  };
  const pasteBtn = h('button', { class: 'btn small', text: 'Paste from this phone' });
  pasteBtn.onclick = async () => {
    try {
      toText.value = await navigator.clipboard.readText();
    } catch {
      toast('This browser would not allow reading the clipboard. Long-press the box and paste instead.', true);
    }
  };
  const sendBtn = h('button', { class: 'btn primary', text: '⬆ Put on laptop clipboard' });
  sendBtn.onclick = async () => {
    sendBtn.disabled = true;
    try {
      await api('PUT', '/api/clipboard', { text: toText.value });
      toast('On the laptop clipboard. Press Ctrl+V there.');
    } catch (e) { fail(e); }
    sendBtn.disabled = false;
  };
  shell({ title: 'Clipboard', back: '#/laptop', body: h('div', { class: 'stack' },
    h('div', { class: 'card stack' }, h('h3', { text: 'Laptop → phone' }), h('div', { class: 'small muted', text: 'Shows what is copied on the laptop right now (text or a picture).' }), getBtn, fromBox),
    h('div', { class: 'card stack' }, h('h3', { text: 'Phone → laptop' }), toText, h('div', { class: 'row wrap' }, pasteBtn, h('span', { class: 'grow' }), sendBtn)),
    h('div', { class: 'small muted', text: 'Every clipboard read and write is in the activity log (without the text itself).' })) });
}

// ---------- send to laptop (also what the phone's Share menu opens) ----------
async function readShared() {
  if (!('caches' in window)) return null;
  try {
    const cache = await caches.open('pd-share');
    const metaRes = await cache.match('/shared/meta');
    if (!metaRes) return null;
    const meta = await metaRes.json();
    meta.blobs = [];
    for (const f of meta.files) {
      const r = await cache.match(`/shared/file/${f.i}`);
      if (r) meta.blobs.push(new File([await r.blob()], f.name, { type: f.type }));
    }
    return meta;
  } catch {
    return null;
  }
}
async function clearShared() {
  try { await caches.delete('pd-share'); } catch { /* ignore */ }
}

/** Uploads files to the laptop's "Downloads/From phone" folder; never overwrites (adds " (2)" etc). */
async function uploadToInbox(files, inbox, onProgress) {
  const done = [];
  for (const f of files) {
    const dot = f.name.lastIndexOf('.');
    const base = dot > 0 ? f.name.slice(0, dot) : f.name;
    const ext = dot > 0 ? f.name.slice(dot) : '';
    for (let n = 1; n <= 20; n++) {
      const name = n === 1 ? f.name : `${base} (${n})${ext}`;
      try {
        onProgress?.(`Sending ${name}…`);
        await api('POST', `/api/files/upload?${qs({ root: inbox.rootId, path: inbox.rel, name })}`, undefined, { raw: f });
        done.push(name);
        break;
      } catch (e) {
        if (e.status !== 409) throw e;
      }
    }
  }
  return done;
}

async function viewSend(params) {
  const box = h('div', { class: 'stack' }, h('div', { class: 'muted', text: 'Loading…' }));
  shell({ title: 'Send to laptop', back: '#/laptop', body: box });
  let inbox = null;
  try {
    inbox = await api('GET', '/api/inbox');
  } catch (e) {
    fill(box, h('div', { class: 'card', text: `No place for files on the laptop: ${e.message}` }));
  }
  const shared = params.get('shared') ? await readShared() : null;
  const status = h('div', { class: 'small muted' });
  const isUrl = (s) => /^https?:\/\/\S+$/i.test(String(s || '').trim());

  const textBox = h('textarea', { rows: 4, placeholder: 'A link or some text' });
  if (shared) textBox.value = [shared.url, shared.text].filter(Boolean).join('\n').trim() || shared.title;
  const pick = h('input', { type: 'file', multiple: true, style: 'display:none' });
  const fileList = h('div', { class: 'small' });
  let files = shared?.blobs || [];
  const drawFiles = () => fill(fileList, files.length ? files.map((f) => h('div', { class: 'ellipsis', text: `📄 ${f.name} · ${size(f.size)}` })) : null);
  pick.onchange = () => { files = [...pick.files]; drawFiles(); };
  drawFiles();

  const busy = async (btn, fn) => {
    btn.disabled = true;
    try { await fn(); } catch (e) { fail(e); }
    btn.disabled = false;
  };
  const firstUrl = () => (textBox.value.match(/https?:\/\/\S+/i) || [])[0];
  const sendFiles = h('button', { class: 'btn primary', text: '⬆ Save files on the laptop' });
  sendFiles.onclick = () => busy(sendFiles, async () => {
    if (!files.length) return toast('Pick files first', true);
    const names = await uploadToInbox(files, inbox, (t) => (status.textContent = t));
    status.textContent = `Saved ${names.length} file(s) in ${inbox.path}`;
    toast('Saved on the laptop');
    files = [];
    drawFiles();
    clearShared();
  });
  const openBtn = h('button', { class: 'btn', text: '🌐 Open link on laptop' });
  openBtn.onclick = () => busy(openBtn, async () => {
    const u = firstUrl();
    if (!u) return toast('There is no web link in the box', true);
    await api('POST', '/api/send/open', { url: u });
    toast('Opened in the laptop browser');
  });
  const clipBtn = h('button', { class: 'btn', text: '📋 Laptop clipboard' });
  clipBtn.onclick = () => busy(clipBtn, async () => {
    await api('PUT', '/api/clipboard', { text: textBox.value });
    toast('On the laptop clipboard');
  });
  const noteBtn = h('button', { class: 'btn', text: '📝 Save as note' });
  noteBtn.onclick = () => busy(noteBtn, async () => {
    const r = await api('POST', '/api/send/note', { title: shared?.title && !textBox.value.includes(shared.title) ? shared.title : '', text: textBox.value });
    toast('Added to "Notes from phone.md"');
    status.textContent = r.file;
  });
  const claudeBtn = h('a', { class: 'btn', text: '✳ Ask Claude', onclick: (e) => { e.preventDefault(); const last = lastProject(); location.hash = `#/new?${qs({ ...(last ? { root: last.root, path: last.rel } : {}), prompt: textBox.value })}`; } });

  if (!inbox) return;
  fill(box,
    shared ? h('div', { class: 'card warn-card small', text: shared.files.length || shared.text || shared.url ? '📥 Shared from your phone. Pick what to do with it below.' : 'Nothing arrived from the share. Try sharing again.' }) : null,
    h('div', { class: 'card stack' }, h('h3', { text: 'Files and photos' }),
      h('button', { class: 'btn small', text: 'Pick files…', onclick: () => pick.click() }), pick, fileList, sendFiles,
      h('div', { class: 'small' }, h('a', { href: `#/files/${inbox.rootId}/${enc(inbox.rel)}`, text: `They go to ${inbox.path}` }))),
    h('div', { class: 'card stack' }, h('h3', { text: 'Link or text' }), textBox,
      h('div', { class: 'row wrap' }, isUrl(textBox.value) || !shared ? openBtn : null, clipBtn, noteBtn, claudeBtn)),
    status,
    h('div', { class: 'small muted', text: 'Tip: in any app, press Share and pick PocketDesk to land here. That shows up once PocketDesk is added to the home screen (Chrome may take a day to pick up the new Share option, or remove and re-add it).' }));
}

// ---------- find my laptop ----------
async function viewFind() {
  const info = h('div', { class: 'stack' }, h('div', { class: 'muted', text: 'Asking the laptop…' }));
  const ring = h('button', { class: 'btn primary block big-btn', text: '🔊 Ring the laptop' });
  let playing = false;
  const draw = () => {
    ring.textContent = playing ? '⏹ Stop the sound' : '🔊 Ring the laptop';
    ring.className = `btn block big-btn ${playing ? 'danger' : 'primary'}`;
  };
  ring.onclick = async () => {
    ring.disabled = true;
    try {
      const r = await api('POST', playing ? '/api/find/stop' : '/api/find/start');
      playing = r.playing;
      if (playing) toast(r.fullVolume ? `Ringing at full volume for ${r.stopsInSec} s` : 'Ringing (could not change the volume)');
    } catch (e) { fail(e); }
    ring.disabled = false;
    draw();
  };
  async function load() {
    try {
      const w = await api('GET', '/api/find/where', undefined, { auto: true });
      const line = (k, v) => (v ? h('div', { class: 'row' }, h('span', { class: 'muted grow', text: k }), h('strong', { class: 'ellipsis', text: v })) : null);
      fill(info,
        line('Wi-Fi', w.wifi ? (w.wifi.connected ? `${w.wifi.ssid || '?'} (${w.wifi.signal || '?'})` : 'not connected') : 'no Wi-Fi'),
        ...w.addresses.map((a) => line(a.name, a.address)),
        line('Tailscale', w.tailscale),
        line('Battery', w.battery ? `${w.battery.percent}%${w.battery.pluggedIn ? ', plugged in' : ''}` : null),
        line('Awake for', `${Math.floor(w.uptimeSec / 3600)} h ${Math.floor((w.uptimeSec % 3600) / 60)} min`),
        line('Answered', new Date(w.at).toLocaleTimeString()));
    } catch (e) {
      fill(info, h('div', { class: 'warn-text', text: `The laptop is not answering (${e.message}). If it is asleep, off, or has no internet, it cannot ring.` }));
    }
  }
  shell({ title: 'Find my laptop', back: '#/laptop', body: h('div', { class: 'stack' },
    ring,
    h('div', { class: 'small muted', text: 'Plays an alarm at full volume for a minute, then puts your volume back. It only works while the laptop is awake and online.' }),
    h('div', { class: 'section-title', text: 'Where it is' }),
    h('div', { class: 'card stack' }, info)) });
  draw();
  load();
  const t = setInterval(load, 20_000);
  onLeave(() => clearInterval(t));
}

boot();
