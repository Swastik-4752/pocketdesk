// Tests for the phone-remote features: notification buttons, done/stuck alerts, login alerts, panic button,
// saved prompts, photos for Claude, clipboard, send to laptop, find my laptop, restart/shutdown and screen peek.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pocketdesk-feat-'));
const home = path.join(tmp, 'home');
const projects = path.join(tmp, 'projects');
const dataDir = path.join(tmp, 'data');
for (const d of [home, projects, path.join(projects, 'app'), path.join(home, '.claude', 'projects', 'C--app'), path.join(home, 'Downloads')]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'tok-main', expiresAt: Date.now() + 864e5 } }));
fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'me@personal.test' } }));
process.env.POCKETDESK_HOME = home;
const cfgFile = path.join(tmp, 'config.json');
// home is a shared root too, so "Downloads/From phone" can be reached
fs.writeFileSync(cfgFile, JSON.stringify({ port: 0, roots: [{ name: 'Projects', path: projects }, { name: 'Home', path: home }], dataDir, idleSessionMinutes: 1 }));

const { loadConfig } = await import('../lib/config.js');
const { createApp } = await import('../server.js');
const { ChatWatch, lastTurn } = await import('../lib/chat-watch.js');
const { checkImages } = await import('../lib/claude.js');
const { parseWifi } = await import('../lib/desk.js');
const cfg = loadConfig(cfgFile);

async function fakeFetch(url, opts) {
  const token = String(opts.headers.Authorization).replace('Bearer ', '');
  if (token !== 'tok-main') return { ok: false, status: 401, json: async () => ({}) };
  return { ok: true, status: 200, json: async () => ({ account: { email: 'me@personal.test', display_name: 'me' }, organization: { name: 'x' } }) };
}

// Fake Claude: "run ls" asks for Bash permission; every user message is recorded as the SDK got it.
const seenMessages = [];
function fakeQuery({ prompt, options }) {
  const it = prompt[Symbol.asyncIterator]();
  async function* gen() {
    let first = true;
    for (;;) {
      const next = await it.next();
      if (next.done) return;
      seenMessages.push(next.value.message);
      const c = next.value.message.content;
      const text = typeof c === 'string' ? c : c.filter((b) => b.type === 'text').map((b) => b.text).join(' ');
      if (first) {
        yield { type: 'system', subtype: 'init', session_id: 'sdk-f', model: 'fake', permissionMode: options.permissionMode, claude_code_version: 'x' };
        first = false;
      }
      if (text.includes('run ls')) {
        const r = await options.canUseTool('Bash', { command: 'ls' }, { signal: new AbortController().signal });
        yield { type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: r.behavior !== 'allow', content: r.behavior === 'allow' ? 'ok' : r.message }] } };
      }
      yield { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: `echo: ${text}` }] } };
      yield { type: 'result', subtype: 'success', is_error: false, duration_ms: 5, num_turns: 1, result: 'ok' };
    }
  }
  const g = gen();
  g.interrupt = async () => {};
  g.setPermissionMode = async () => {};
  return g;
}

// Push stand-in that knows which device each subscription belongs to
const pushed = [];
const fakePush = {
  subs: [],
  publicKey: () => 'k',
  notify: async (n) => pushed.push(n),
  subscribe: async (deviceId) => fakePush.subs.push(deviceId),
  removeDevice: async (id) => { fakePush.subs = fakePush.subs.filter((x) => x !== id); },
  deviceIds: () => [...new Set(fakePush.subs)],
  removeAll: async () => { fakePush.subs = []; },
};

// Windows helper stand-in (screen, clipboard, sound)
const winCalls = [];
let clip = { text: 'laptop text', png: null };
let screenOn = true;
const fakeWin = {
  screenshot: async (w, q) => { winCalls.push(['screenshot', w, q]); if (!screenOn) throw new Error('Exception calling "Shot": Nothing to show: the laptop screen is off (lid closed, no monitor) or locked.'); return { jpeg: Buffer.from('JPEGDATA').toString('base64') }; },
  clipGet: async () => ({ ...clip }),
  clipSet: async (text) => { clip = { text, png: null }; return { ok: true }; },
  soundStart: async () => { winCalls.push(['soundStart']); return { playing: true, fullVolume: true }; },
  soundStop: async () => { winCalls.push(['soundStop']); return { stopped: true }; },
};
const deskRuns = [];
const deskRun = async (cmd, args) => {
  deskRuns.push([cmd, ...args]);
  if (cmd === 'netsh.exe') return { stdout: '    State                  : connected\n    SSID                   : CollegeWiFi\n    Signal                 : 81%\n' };
  return { stdout: '' };
};
const whois = async (ip) => ({ machine: ip === '100.64.0.9' ? 'strangers-pc' : 'redmi-9-power', os: 'android', login: 'me@ts.test' });
let screenLocked = 0;

const app = createApp(cfg, { queryFn: fakeQuery, push: fakePush, fetchFn: fakeFetch, win: fakeWin, deskRun, whoisFn: whois, lockScreenFn: async () => { screenLocked++; } });
let server;
let base;
before(async () => {
  server = http.createServer((req, res) => app.handle(req, res));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  await app.profiles.choose('main');
});
after(async () => {
  await app.sessions.shutdown();
  await app.tasks.shutdown();
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function req(method, url, { body, headers = {}, phone = false, ip = '100.64.0.2', cookie } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url, base);
    const h = { 'x-pocketdesk': '1', host: phone ? 'laptop.tail1234.ts.net' : u.host, ...headers };
    if (phone) h['x-forwarded-for'] = ip;
    if (cookie) h.cookie = cookie;
    let data;
    if (body !== undefined) {
      data = Buffer.from(JSON.stringify(body));
      h['content-type'] = 'application/json';
      h['content-length'] = data.length;
    }
    const r = http.request({ method, hostname: u.hostname, port: u.port, path: u.pathname + u.search, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let json = null;
        try { json = JSON.parse(buf.toString()); } catch { /* not json */ }
        resolve({ status: res.statusCode, headers: res.headers, json, text: buf.toString(), buf });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
async function waitFor(fn, ms = 3000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}
async function pairPhone(name, ip = '100.64.0.2') {
  const { code } = (await req('POST', '/api/setup/pairing')).json;
  const r = await req('POST', '/api/pair', { phone: true, ip, body: { code, name } });
  assert.equal(r.status, 200, r.text);
  const cookie = r.headers['set-cookie'][0].split(';')[0];
  await app.push.subscribe(r.json.device.id, {});
  return { cookie, id: r.json.device.id };
}
const settle = () => new Promise((r) => setTimeout(r, 30));

// ---------- 1. Allow / Deny on the notification ----------
test('notification buttons: one-time token answers only that prompt; locked phone needs the opt-in', async () => {
  const phone = await pairPhone('Notif phone');
  const created = await req('POST', '/api/sessions', { body: { rootId: 0, rel: 'app', prompt: 'please run ls' } });
  assert.equal(created.status, 200, created.text);
  const s = app.sessions.get(created.json.id);
  const perm = await waitFor(() => s.events.find((e) => e.t === 'perm'));
  const note = pushed.find((p) => p.tag === `perm-${perm.pid}`);
  assert.deepEqual(note.actions.map((a) => a.action), ['allow', 'deny']);
  assert.equal(note.decide.sid, s.id);
  assert.equal(note.decide.pid, perm.pid);
  assert.ok(note.decide.token.length >= 20);
  assert.ok(!JSON.stringify(s.events).includes(note.decide.token), 'the token never goes into the chat log');

  const wrong = await req('POST', '/api/push/decide', { phone: true, cookie: phone.cookie, body: { sid: s.id, pid: perm.pid, token: 'guess', decision: 'allow' } });
  assert.equal(wrong.status, 403);
  const noCookie = await req('POST', '/api/push/decide', { phone: true, body: { ...note.decide, decision: 'allow' } });
  assert.equal(noCookie.status, 401, 'still needs a paired device');

  // PIN set + phone locked: refused unless the user turned on "work while locked"
  await app.lock.setPin('2468', 15);
  const locked = await req('POST', '/api/push/decide', { phone: true, cookie: phone.cookie, body: { ...note.decide, decision: 'allow' } });
  assert.equal(locked.status, 423);
  assert.equal((await req('POST', '/api/security/notify-actions', { phone: true, cookie: phone.cookie, body: { on: true, currentPin: '0000' } })).status, 423, 'a locked phone cannot change it');
  assert.equal((await req('POST', '/api/security/notify-actions', { body: { on: true } })).status, 200);
  const ok = await req('POST', '/api/push/decide', { phone: true, cookie: phone.cookie, body: { ...note.decide, decision: 'allow' } });
  assert.equal(ok.status, 200, ok.text);
  await waitFor(() => s.events.some((e) => e.t === 'perm_done' && e.status === 'allowed'));
  const again = await req('POST', '/api/push/decide', { phone: true, cookie: phone.cookie, body: { ...note.decide, decision: 'deny' } });
  assert.equal(again.status, 409, 'a token works once');
  assert.ok(app.activity.list().some((a) => a.action === 'Claude prompt: allow (from notification)'));
  await app.lock.setActionsWhileLocked(false);
  await app.lock.clearPin();
  await req('POST', `/api/sessions/${s.id}/close`);
  await waitFor(() => !s.q);
});

// ---------- 4. done / stuck alerts ----------
function writeChat(file, lines) {
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}
const asst = (content, stop) => ({ type: 'assistant', isSidechain: false, message: { role: 'assistant', content, stop_reason: stop } });

test('lastTurn reads the end of a laptop chat file', async () => {
  const f = path.join(tmp, 'turn.jsonl');
  writeChat(f, [{ type: 'user', message: { content: 'hi' } }, asst([{ type: 'text', text: 'done' }], 'end_turn'), { type: 'system', subtype: 'stop_hook_summary' }, { type: 'last-prompt' }]);
  assert.deepEqual(await lastTurn(f), { done: true });
  writeChat(f, [asst([{ type: 'tool_use', id: 'tu1', name: 'Bash', input: {} }], 'tool_use'), { ...asst([{ type: 'text', text: 'sub' }], 'end_turn'), isSidechain: true }]);
  assert.deepEqual(await lastTurn(f), { tool: 'Bash', toolId: 'tu1' }, 'subagent lines are skipped');
  writeChat(f, [asst([{ type: 'tool_use', id: 'tu1', name: 'Bash', input: {} }], 'tool_use'), { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1' }] } }]);
  assert.deepEqual(await lastTurn(f), { thinking: true });
});

test('chat watch: laptop chat finished / waiting, phone session stuck, never on startup', async () => {
  let now = 1_000_000_000_000;
  const dir = path.join(tmp, 'watch');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'a.jsonl');
  const files = [{ id: 'chat-a', file, mtime: now - 5000 }];
  const sent = [];
  const phoneSessions = [{ id: 'p1', title: 'Phone job', state: 'working', updatedAt: now }];
  const settings = { laptopDone: true, laptopWaitMin: 5, stuckMin: 15 };
  const w = new ChatWatch({
    laptopChats: { allFiles: async () => files, meta: async () => ({ title: 'Fix the login page', entrypoint: 'claude-desktop' }) },
    sessions: { list: () => phoneSessions },
    push: { notify: async (n) => sent.push(n) },
    activity: { log: () => {} },
    settings: () => settings,
    now: () => now,
  });
  writeChat(file, [asst([{ type: 'text', text: 'ok' }], 'end_turn')]);
  await w.tick(); // first sight while still being written
  now += 60_000;
  await w.tick();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].title, 'Laptop Claude finished');
  assert.match(sent[0].body, /Fix the login page \(Desktop app\)/);
  assert.equal(sent[0].url, '/#/pc/chat-a');
  now += 60_000;
  await w.tick();
  assert.equal(sent.length, 1, 'once per finished turn');

  // new turn: Claude stops on a tool call and nothing moves for 5 minutes
  writeChat(file, [asst([{ type: 'tool_use', id: 'tu9', name: 'Edit', input: {} }], 'tool_use')]);
  files[0].mtime = now;
  await w.tick();
  now += 4 * 60_000;
  await w.tick();
  assert.equal(sent.length, 1, 'not yet: under 5 minutes');
  now += 2 * 60_000;
  await w.tick();
  assert.equal(sent.at(-1).title, 'Laptop Claude may need you');
  assert.match(sent.at(-1).body, /Edit/);
  await w.tick();
  assert.equal(sent.filter((x) => x.title.includes('may need')).length, 1, 'once per tool call');

  // phone session making no progress for 15 minutes (time had moved 8 minutes)
  now += 7 * 60_000;
  await w.tick();
  const stuck = sent.filter((x) => x.title === 'Claude has made no progress');
  assert.equal(stuck.length, 1);
  assert.equal(stuck[0].url, '/#/s/p1');
  await w.tick();
  assert.equal(sent.filter((x) => x.title === 'Claude has made no progress').length, 1);

  // a chat that had already finished before PocketDesk started never alerts
  const w2 = new ChatWatch({ laptopChats: { allFiles: async () => [{ id: 'old', file, mtime: now - 10 * 60_000 }], meta: async () => ({}) }, sessions: { list: () => [] }, push: { notify: async (n) => sent.push(n) }, activity: { log: () => {} }, settings: () => settings, now: () => now });
  const before = sent.length;
  writeChat(file, [asst([{ type: 'text', text: 'ok' }], 'end_turn')]);
  await w2.tick();
  now += 60_000;
  await w2.tick();
  assert.equal(sent.length, before);
});

test('alert settings accept the new Claude and security switches', async () => {
  const r = await req('PUT', '/api/alerts', { body: { laptopDone: false, laptopWaitMin: 10, stuckMin: 0, newDevice: true } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.laptopDone, false);
  assert.equal(r.json.laptopWaitMin, 10);
  assert.equal(r.json.stuckMin, 0);
  assert.equal((await req('PUT', '/api/alerts', { body: { stuckMin: 999 } })).status, 400);
  await req('PUT', '/api/alerts', { body: { laptopDone: true, laptopWaitMin: 5, stuckMin: 15 } });
});

// ---------- 11. login alerts ----------
test('login alerts: unpaired visitor (throttled), new device paired, cookie used from another device', async () => {
  pushed.length = 0;
  await req('GET', '/api/me', { phone: true, ip: '100.64.0.9' });
  await settle();
  const visit = pushed.filter((p) => p.tag === 'visitor');
  assert.equal(visit.length, 1);
  assert.match(visit[0].body, /strangers-pc \(android\)/);
  await req('GET', '/api/me', { phone: true, ip: '100.64.0.9' });
  await req('GET', '/api/files/list?root=0', { phone: true, ip: '100.64.0.9' });
  await settle();
  assert.equal(pushed.filter((p) => p.tag === 'visitor').length, 1, 'one alert per address per 6 hours');

  const a = await pairPhone('Phone A', '100.64.0.2');
  await settle();
  pushed.length = 0;
  const b = await pairPhone('Phone B', '100.64.0.3');
  await settle();
  const paired = pushed.find((p) => p.tag === 'paired');
  assert.ok(paired, 'other devices hear about a new pairing');
  assert.equal(paired.title, 'New device paired: Phone B');
  assert.ok(!paired.only.includes(b.id), 'not sent to the new device itself');
  assert.ok(paired.only.includes(a.id));

  pushed.length = 0;
  assert.equal((await req('GET', '/api/me', { phone: true, ip: '100.64.0.2', cookie: a.cookie })).status, 200);
  await settle();
  assert.equal(pushed.length, 0, 'same device, same address: quiet');
  assert.equal((await req('GET', '/api/me', { phone: true, ip: '100.64.0.9', cookie: a.cookie })).status, 200);
  await settle();
  const moved = pushed.find((p) => p.tag === `newip-${a.id}`);
  assert.ok(moved, "Phone A's login used from another Tailscale device");
  assert.match(moved.body, /strangers-pc/);
});

// ---------- 10. panic ----------
test('panic: notifies, stops Claude, unpairs every device, locks the laptop; works on a locked phone', async () => {
  const p = await pairPhone('Panic phone');
  const created = await req('POST', '/api/sessions', { body: { rootId: 0, rel: 'app', prompt: 'please run ls' } });
  const s = app.sessions.get(created.json.id);
  await waitFor(() => s.state === 'waiting');
  await app.lock.setPin('1357', 15); // the phone is now locked
  pushed.length = 0;
  const r = await req('POST', '/api/panic', { phone: true, cookie: p.cookie });
  assert.equal(r.status, 200, r.text);
  assert.ok(r.json.sessions >= 1);
  assert.ok(r.json.devices >= 1);
  assert.equal(r.json.locked, true);
  assert.equal(screenLocked, 1);
  assert.equal(pushed[0].tag, 'panic', 'the phones are told first');
  assert.equal(s.abort.signal.aborted, true, 'the Claude process was told to stop');
  assert.equal(app.auth.listDevices().length, 0);
  assert.equal(fakePush.deviceIds().length, 0);
  assert.equal((await req('GET', '/api/me', { phone: true, cookie: p.cookie })).status, 401, 'the cookie is dead');
  assert.ok(app.activity.list().some((a) => a.action === 'PANIC button'));
  await app.lock.clearPin();
});

// ---------- 2. saved prompts ----------
test('saved prompts: defaults, save with a folder, validation', async () => {
  const first = await req('GET', '/api/prompts');
  assert.ok(first.json.prompts.length >= 1, 'comes with a few to start');
  const save = await req('PUT', '/api/prompts', { body: { prompts: [{ name: 'Tests', text: 'run the tests', rootId: 0, rel: 'app' }, { name: 'Any', text: 'explain' }] } });
  assert.equal(save.status, 200, save.text);
  assert.equal(save.json.prompts[0].rootName, 'Projects');
  assert.equal(save.json.prompts[1].rootId, undefined);
  assert.equal((await req('PUT', '/api/prompts', { body: { prompts: [{ name: '', text: 'x' }] } })).status, 400);
  assert.equal((await req('PUT', '/api/prompts', { body: { prompts: [{ name: 'a', text: 'x', rootId: 9 }] } })).status, 400);
  assert.equal((await req('PUT', '/api/prompts', { body: { prompts: [{ name: 'a', text: 'x', rootId: 0, rel: '../..' }] } })).status, 400);
  assert.equal((await req('GET', '/api/prompts')).json.prompts.length, 2, 'kept on disk');
});

// ---------- 3. photos for Claude ----------
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
test('photos: sent to Claude as image blocks, shown in the chat, checked for type and size', async () => {
  assert.throws(() => checkImages([{ mediaType: 'image/bmp', data: 'AAAA' }]), { status: 400 });
  assert.throws(() => checkImages([{ mediaType: 'image/png', data: 'not base64!' }]), { status: 400 });
  assert.throws(() => checkImages(new Array(5).fill({ mediaType: 'image/png', data: 'AAAA' })), { status: 400 });
  assert.throws(() => checkImages([{ mediaType: 'image/jpeg', data: 'A'.repeat(7_200_000) }]), { status: 413 });

  seenMessages.length = 0;
  const img = { mediaType: 'image/png', data: PNG.toString('base64') };
  const created = await req('POST', '/api/sessions', { body: { rootId: 0, rel: 'app', prompt: '', images: [img] } });
  assert.equal(created.status, 200, created.text);
  const s = app.sessions.get(created.json.id);
  await waitFor(() => s.state === 'idle');
  const msg = seenMessages[0];
  assert.equal(msg.content[0].type, 'image');
  assert.equal(msg.content[0].source.media_type, 'image/png');
  assert.equal(msg.content[1].text, 'Look at the attached photo.', 'a photo alone gets a short prompt');

  const sent = await req('POST', `/api/sessions/${s.id}/send`, { body: { text: 'and this one?', images: [img, img] } });
  assert.equal(sent.status, 200, sent.text);
  await waitFor(() => seenMessages.length === 2);
  assert.equal(seenMessages[1].content.filter((b) => b.type === 'image').length, 2);
  const ev = s.events.filter((e) => e.t === 'user' && e.images);
  assert.equal(ev.length, 2);
  assert.ok(!JSON.stringify(s.events).includes(img.data), 'the chat log keeps file names, not the picture');
  const shown = await req('GET', `/api/sessions/${s.id}/image/${ev[1].images[0]}`);
  assert.equal(shown.status, 200);
  assert.equal(shown.headers['content-type'], 'image/png');
  assert.ok(shown.buf.equals(PNG));
  assert.equal((await req('GET', `/api/sessions/${s.id}/image/..%2F..%2Fsecurity.json`)).status, 404);
  await req('POST', `/api/sessions/${s.id}/close`);
  await waitFor(() => !s.q);
  await req('DELETE', `/api/sessions/${s.id}`);
  assert.ok(!fs.existsSync(path.join(dataDir, 'sessions', `${s.id}-files`)), 'deleting the session deletes its photos');
});

// ---------- 6. clipboard ----------
test('clipboard: read and write the laptop clipboard, logged without the text', async () => {
  const r = await req('GET', '/api/clipboard');
  assert.equal(r.json.text, 'laptop text');
  assert.equal((await req('PUT', '/api/clipboard', { body: { text: 'from phone ✓' } })).status, 200);
  assert.equal(clip.text, 'from phone ✓');
  clip = { text: null, png: PNG.toString('base64') };
  assert.match((await req('GET', '/api/clipboard')).json.image, /^data:image\/png;base64,/);
  assert.ok(!app.activity.list().some((a) => a.detail.includes('from phone')), 'the text itself is not logged');
  assert.equal((await req('PUT', '/api/clipboard', { body: { text: 'x'.repeat(1024 * 1024 + 1) } })).status, 413);
});

// ---------- 7. send to laptop ----------
test('send to laptop: inbox folder, open only web links, notes appended', async () => {
  const inbox = (await req('GET', '/api/inbox')).json;
  assert.equal(inbox.path, path.join(home, 'Downloads', 'From phone'));
  assert.ok(fs.statSync(inbox.path).isDirectory());
  assert.equal(inbox.rootId, 1);
  assert.equal(inbox.rel, 'Downloads/From phone');
  if (process.platform === 'win32') {
    const open = await req('POST', '/api/send/open', { body: { url: 'https://example.com/a?b=1' } });
    assert.equal(open.status, 200, open.text);
    assert.deepEqual(deskRuns.at(-1), ['rundll32.exe', 'url.dll,FileProtocolHandler', 'https://example.com/a?b=1']);
  }
  for (const bad of ['file:///C:/Windows/System32/calc.exe', 'javascript:alert(1)', 'calc.exe', 'ms-settings:']) {
    assert.equal((await req('POST', '/api/send/open', { body: { url: bad } })).status, 400, bad);
  }
  assert.equal((await req('POST', '/api/send/note', { body: { text: 'buy milk' } })).status, 200);
  assert.equal((await req('POST', '/api/send/note', { body: { title: 'Article', text: 'https://x.test' } })).status, 200);
  const notes = fs.readFileSync(path.join(inbox.path, 'Notes from phone.md'), 'utf8');
  assert.match(notes, /buy milk[\s\S]*Article\nhttps:\/\/x\.test/);
  assert.equal((await req('POST', '/api/send/note', { body: {} })).status, 400);
  // the Share menu's POST lands on the Send screen when the service worker was not running
  const share = await req('POST', '/share-target', {});
  assert.equal(share.status, 303);
  assert.equal(share.headers.location, '/#/send');
});

// ---------- 9. find my laptop ----------
test('find my laptop: alarm on/off, Wi-Fi and addresses', async () => {
  assert.equal((await req('POST', '/api/find/start')).json.playing, true);
  assert.equal((await req('POST', '/api/find/stop')).json.playing, false);
  assert.deepEqual(winCalls.filter((c) => c[0].startsWith('sound')).map((c) => c[0]), ['soundStart', 'soundStop']);
  const w = (await req('GET', '/api/find/where')).json;
  assert.deepEqual(w.wifi, { connected: true, ssid: 'CollegeWiFi', signal: '81%' });
  assert.ok(Array.isArray(w.addresses));
  assert.equal(parseWifi('There is no wireless interface on the system.'), null);
});

// ---------- 8. restart / shutdown ----------
test('restart / shutdown: PIN asked again on the phone, one minute to cancel, laptop needs no PIN', { skip: process.platform !== 'win32' }, async () => {
  const p = await pairPhone('Power phone');
  await app.lock.setPin('2468', 15);
  await req('POST', '/api/lock/unlock', { phone: true, cookie: p.cookie, body: { pin: '2468' } });
  const noPin = await req('POST', '/api/power', { phone: true, cookie: p.cookie, body: { action: 'restart' } });
  assert.equal(noPin.status, 401);
  assert.equal(noPin.json.needPin, true);
  assert.equal((await req('POST', '/api/power', { phone: true, cookie: p.cookie, body: { action: 'restart', pin: '1111' } })).status, 401);
  assert.ok(!deskRuns.some((r) => r[0] === 'shutdown.exe'), 'nothing ran yet');
  const ok = await req('POST', '/api/power', { phone: true, cookie: p.cookie, body: { action: 'restart', pin: '2468' } });
  assert.equal(ok.status, 200, ok.text);
  assert.deepEqual(deskRuns.at(-1).slice(0, 4), ['shutdown.exe', '/r', '/t', '60']);
  assert.equal((await req('GET', '/api/power')).json.pending.action, 'restart');
  assert.equal((await req('POST', '/api/power', { phone: true, cookie: p.cookie, body: { action: 'cancel' } })).status, 200, 'cancel needs no PIN');
  assert.deepEqual(deskRuns.at(-1), ['shutdown.exe', '/a']);
  assert.equal((await req('GET', '/api/power')).json.pending, null);
  assert.equal((await req('POST', '/api/power', { body: { action: 'shutdown' } })).status, 200, 'the laptop itself is not asked');
  assert.equal(deskRuns.at(-1)[1], '/s');
  await app.lock.clearPin();
});

// ---------- 5. screen peek ----------
test('screen peek: PIN once per 10 minutes on the phone, JPEG frames, clear message when the screen is off', async () => {
  const p = await pairPhone('Peek phone');
  const laptop = await req('GET', '/api/screen?w=800');
  assert.equal(laptop.status, 200, 'no PIN set: works');
  assert.equal(laptop.headers['content-type'], 'image/jpeg');
  assert.equal(laptop.buf.toString(), 'JPEGDATA');
  await app.lock.setPin('2468', 15);
  await req('POST', '/api/lock/unlock', { phone: true, cookie: p.cookie, body: { pin: '2468' } });
  const st = (await req('GET', '/api/screen/state', { phone: true, cookie: p.cookie })).json;
  assert.equal(st.pinNeeded, true);
  const refused = await req('GET', '/api/screen', { phone: true, cookie: p.cookie });
  assert.equal(refused.status, 401);
  assert.equal(refused.json.needPin, true);
  assert.equal((await req('POST', '/api/screen/start', { phone: true, cookie: p.cookie, body: { pin: '0000' } })).status, 401);
  assert.equal((await req('POST', '/api/screen/start', { phone: true, cookie: p.cookie, body: { pin: '2468' } })).status, 200);
  const frame = await req('GET', '/api/screen?w=99999', { phone: true, cookie: p.cookie });
  assert.equal(frame.status, 200);
  assert.equal(winCalls.filter((c) => c[0] === 'screenshot').at(-1)[1], 2560, 'width is capped');
  screenOn = false;
  const off = await req('GET', '/api/screen', { phone: true, cookie: p.cookie });
  assert.equal(off.status, 409);
  assert.match(off.json.error, /^Nothing to show/);
  screenOn = true;
  assert.ok(app.activity.list().some((a) => a.action === 'Screen peek started' && a.by === 'Peek phone'));
  await app.lock.clearPin();
});
