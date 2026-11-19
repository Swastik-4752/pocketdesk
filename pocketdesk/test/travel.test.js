import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Travel, travelValues, eCoreMask } from '../lib/travel.js';
import { TRAVEL_NOTE, travelNote } from '../hooks/switch-to-phone.mjs';

// ---------- a fake laptop ----------
const WIN = 'C:\\Windows';
const P = (pid, ppid, name, p, extra = {}) => ({ pid, ppid, name, path: p, own: true, session: 2, created: String(1000 + pid), memMb: 100, cpuSec: 10, window: false, desc: null, ...extra });
const ME = 50; // PocketDesk's own pid

function laptop() {
  return [
    P(1, 0, 'explorer', `${WIN}\\explorer.exe`, { window: true }),
    P(ME, 1, 'node', 'C:\\Program Files\\nodejs\\node.exe'),
    P(51, ME, 'claude', 'C:\\Users\\me\\.local\\bin\\claude.exe'), // a phone session
    P(52, 51, 'node', 'C:\\Program Files\\nodejs\\node.exe'), // something Claude started
    // Claude desktop app and its tools
    P(60, 1, 'claude', 'C:\\Program Files\\WindowsApps\\Claude_5\\app\\claude.exe', { window: true }),
    P(61, 60, 'claude', 'C:\\Program Files\\WindowsApps\\Claude_5\\app\\claude.exe'),
    P(62, 60, 'uv', 'C:\\Users\\me\\AppData\\Local\\Claude-Data\\uv.exe'),
    // terminal hosting a Claude CLI: the terminal must keep running
    P(70, 1, 'WindowsTerminal', 'C:\\Program Files\\WindowsApps\\Terminal\\WindowsTerminal.exe', { window: true }),
    P(71, 70, 'pwsh', 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'),
    P(72, 71, 'claude', 'C:\\Users\\me\\.local\\bin\\claude.exe'),
    // VS Code running Claude in its terminal: the whole app stays
    P(80, 1, 'Code', 'C:\\Users\\me\\AppData\\Local\\Programs\\VS Code\\Code.exe', { window: true }),
    P(81, 80, 'Code', 'C:\\Users\\me\\AppData\\Local\\Programs\\VS Code\\Code.exe'),
    P(82, 81, 'claude', 'C:\\Users\\me\\.local\\bin\\claude.exe'),
    P(83, 80, 'Code', 'C:\\Users\\me\\AppData\\Local\\Programs\\VS Code\\Code.exe'),
    // Chrome: pause
    P(90, 1, 'chrome', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', { window: true, desc: 'Google Chrome' }),
    P(91, 90, 'chrome', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'),
    // Dynamic Island (electron) with a python child: pause both
    P(100, 1, 'electron', 'C:\\Users\\me\\Projects\\dyanmic notch\\node_modules\\electron\\dist\\electron.exe', { window: true }),
    P(101, 100, 'python', 'C:\\Users\\me\\AppData\\Local\\Programs\\Python\\Python313\\python.exe'),
    // an audio app with a hidden window and almost no CPU: listed, not ticked
    P(105, 1, 'Nahimic3', 'C:\\Program Files\\WindowsApps\\Nahimic\\Nahimic3.exe', { window: true, cpuSec: 2 }),
    // background helper: listed, not ticked by default
    P(110, 1, 'PhoneExperienceHost', 'C:\\Program Files\\WindowsApps\\YourPhone\\PhoneExperienceHost.exe'),
    // Tailscale: never paused
    P(120, 1, 'tailscale-ipn', 'C:\\Program Files\\Tailscale\\tailscale-ipn.exe'),
    // Windows pieces: never listed
    P(130, 1, 'SearchHost', `${WIN}\\SystemApps\\SearchHost.exe`),
    { pid: 140, ppid: 0, name: 'svchost', path: null, own: false, session: 0, created: '1', memMb: 1, cpuSec: 1, window: false },
  ];
}

function fakeWin(procs = laptop()) {
  const calls = [];
  const w = {
    calls,
    procs: procs,
    power: { cpuMax: { ac: 100, dc: 100 }, cpuMax1: { ac: 100, dc: 100 }, freqMax: { ac: 0, dc: 0 }, freqMax1: { ac: 0, dc: 0 }, boost: { ac: 2, dc: 2 }, epp: { ac: 45, dc: 50 }, epp1: { ac: 45, dc: 50 }, lid: { ac: 0, dc: 1 }, saver: { ac: 0, dc: 30 } },
    bt: 'On',
    boot: 0,
    slept: [],
    async procs_() { return { session: 2, windir: WIN, procs: w.procs }; },
    async cores() { return { logical: 12, cores: [...[3, 12, 48, 192].map((m) => ({ eff: 1, mask: String(m) })), ...[256, 512, 1024, 2048].map((m) => ({ eff: 0, mask: String(m) }))] }; },
    async suspend(items) { calls.push(['suspend', items.map((i) => i.pid)]); return items.map((i) => ({ pid: i.pid, ok: true })); },
    async resume(items) { calls.push(['resume', items.map((i) => i.pid)]); return items.map((i) => ({ pid: i.pid, ok: true })); },
    async pin(items, mask, eco) { calls.push(['pin', items.map((i) => i.pid), String(mask), eco]); return items.map((i) => ({ pid: i.pid, ok: true, prev: '4095' })); },
    async unpin(items) { calls.push(['unpin', items.map((i) => [i.pid, i.mask])]); return items.map((i) => ({ pid: i.pid, ok: true })); },
    async powerGet() { return { scheme: 'scheme-1', values: structuredClone(w.power) }; },
    async powerSet(scheme, values) { calls.push(['powerSet', scheme, values]); },
    async bluetooth(state) {
      if (state) {
        calls.push(['bluetooth', state]);
        w.bt = state;
        return { present: true, before: w.bt, result: 'Allowed' };
      }
      return { present: true, state: w.bt };
    },
    async bootTime() { return w.boot; },
    sleep(hibernate) { w.slept.push(hibernate ? 'hibernate' : 'sleep'); },
  };
  w.procs = procs;
  // the real helper's method is called procs(); keep the list on a property for tests to change
  return new Proxy(w, { get: (t, k) => (k === 'procs' ? t.procs_ : t[k]), set: (t, k, v) => ((t[k === 'procs' ? 'procs' : k] = v), true) });
}

function setup({ battery = { percent: 80, pluggedIn: false }, sessions = [], tasksList = [], win } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-travel-'));
  let clock = Date.parse('2026-11-14T10:00:00Z');
  const pushes = [];
  const started = [];
  const status = { battery, get: async () => ({ battery: status.battery }) };
  const deps = {
    win: win || fakeWin(),
    status,
    push: { notify: async (n) => pushes.push(n) },
    activity: { log: () => {} },
    sessions: { list: () => sessions },
    tasks: { list: () => tasksList, start: async (...a) => started.push(a) },
    laptopChats: { projectsDirs: () => [] },
    now: () => clock,
    pid: ME,
  };
  const t = new Travel({ dataDir }, deps);
  return { t, deps, pushes, started, status, dataDir, advance: (ms) => (clock += ms), now: () => clock };
}

// ---------- tests ----------

test('travel: keeps Claude, its hosts, Tailscale and Windows; offers Chrome and Dynamic Island to pause', async () => {
  const { t } = setup();
  const p = await t.preview();
  const keys = p.apps.map((a) => a.exe.toLowerCase());
  assert.ok(keys.includes('chrome.exe'));
  assert.ok(keys.includes('electron.exe'));
  assert.ok(keys.includes('phoneexperiencehost.exe'));
  for (const kept of ['claude.exe', 'code.exe', 'windowsterminal.exe', 'tailscale-ipn.exe', 'node.exe', 'uv.exe', 'explorer.exe', 'searchhost.exe', 'pwsh.exe']) {
    assert.ok(!keys.includes(kept), `${kept} must not be pausable`);
  }
  const chrome = p.apps.find((a) => a.exe === 'chrome.exe');
  assert.equal(chrome.pause, true, 'Chrome is ticked by default');
  assert.equal(chrome.count, 2);
  assert.equal(p.apps.find((a) => a.exe === 'electron.exe').hint.includes('dyanmic notch'), true, 'generic runtimes show their folder');
  assert.equal(p.apps.find((a) => a.exe === 'PhoneExperienceHost.exe').pause, false, 'background helpers are not ticked by default');
  assert.equal(p.apps.find((a) => a.exe === 'Nahimic3.exe').pause, false, 'a quiet app with a hidden window is not ticked');
  const keptNames = p.kept.map((k) => k.name);
  assert.ok(keptNames.includes('Claude desktop app'));
  assert.ok(keptNames.includes('Tailscale'));
  assert.deepEqual(p.ecores, { count: 4, of: 12 });
});

test('travel: start saves power settings, cools the CPU, pins Claude to E-cores, turns Bluetooth off, pauses apps and their children', async () => {
  const { t, deps, pushes, dataDir } = setup();
  const w = deps.win;
  const chromeKey = 'c:\\program files\\google\\chrome\\application\\chrome.exe';
  const islandKey = 'c:\\users\\me\\projects\\dyanmic notch\\node_modules\\electron\\dist\\electron.exe';
  const st = await t.start({ minutes: 45, level: 'coolest', pause: [chromeKey, islandKey] });
  assert.equal(st.active, true);
  assert.equal(st.leftMs, 45 * 60_000);

  const set = w.calls.find((c) => c[0] === 'powerSet');
  assert.equal(set[1], 'scheme-1');
  assert.deepEqual(set[2].boost, { ac: 0, dc: 0 }, 'turbo off');
  assert.deepEqual(set[2].cpuMax, { ac: 60, dc: 60 });
  assert.deepEqual(set[2].epp, { ac: 100, dc: 100 }, 'full power-saving preference');
  assert.deepEqual(set[2].lid, { ac: 0, dc: 0 }, 'lid closed = keep running, only for the trip');
  assert.deepEqual(set[2].saver, { ac: 0, dc: 100 }, 'energy saver always on, on battery');

  assert.deepEqual(w.calls.find((c) => c[0] === 'bluetooth'), ['bluetooth', 'Off']);

  const pin = w.calls.find((c) => c[0] === 'pin');
  assert.equal(pin[2], String(0xF00), 'the 4 efficiency cores');
  assert.equal(pin[3], true, 'efficiency mode');
  assert.deepEqual(new Set(pin[1]), new Set([ME, 51, 52, 60, 61, 62, 72, 82]), 'Claude, PocketDesk and what they started');

  const sus = w.calls.find((c) => c[0] === 'suspend');
  assert.deepEqual(new Set(sus[1]), new Set([90, 91, 100, 101]), 'Chrome + Dynamic Island + its python child');

  const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'travel.json'), 'utf8'));
  assert.equal(saved.active, true);
  assert.equal(saved.power.saved.lid.dc, 1, 'old values kept for later');
  assert.ok(pushes.some((p) => p.title === 'Travel mode is on'));
  await assert.rejects(t.start({}), /already on/);

  // the choice is remembered: PhoneExperienceHost stays unticked, Chrome stays ticked
  const prefs = JSON.parse(fs.readFileSync(path.join(dataDir, 'travel-prefs.json'), 'utf8'));
  assert.equal(prefs.minutes, 45);
  assert.equal(prefs.level, 'coolest');
});

test('travel: end puts everything back and runs commands that waited', async () => {
  const { t, deps, started, pushes } = setup();
  const w = deps.win;
  await t.start({ minutes: 30 });
  const q = await t.queueTask('0', 'app', { kind: 'script', name: 'build' }, { kind: 'laptop' });
  assert.equal(q.queued, true);
  w.calls.length = 0;
  const st = await t.end('manual');
  assert.equal(st.active, false);
  assert.deepEqual(w.calls[0], ['powerSet', 'scheme-1', w.power], 'power restored first, to the saved values');
  assert.ok(w.calls.some((c) => c[0] === 'resume' && c[1].includes(90)));
  assert.ok(w.calls.some((c) => c[0] === 'unpin' && c[1].every(([, mask]) => mask === '4095')), 'old core masks back');
  assert.ok(w.calls.some((c) => c[0] === 'bluetooth' && c[1] === 'On'));
  assert.equal(started.length, 1);
  assert.equal(started[0][2].name, 'build');
  assert.equal(started[0][2].force, true);
  assert.ok(pushes.some((p) => p.title === 'Travel mode ended'));
  assert.equal(st.last.reason, 'manual');
});

test('travel: Bluetooth that was already off stays off afterwards', async () => {
  const w = fakeWin();
  w.bt = 'Off';
  const { t } = setup({ win: w });
  await t.start({});
  await t.end();
  assert.ok(!w.calls.some((c) => c[0] === 'bluetooth'));
});

test('travel: timer warns at 5 minutes, then sleeps when Claude is idle', async () => {
  const { t, deps, pushes, advance } = setup();
  await t.start({ minutes: 30, sleepWhenDone: false });
  advance(26 * 60_000);
  t.lastTick = t.now();
  await t.tick();
  assert.ok(pushes.some((p) => p.title === 'Travel mode: 5 minutes left'));
  for (let i = 0; i < 10; i++) {
    advance(30_000);
    await t.tick();
  }
  assert.deepEqual(deps.win.slept, ['sleep']);
  assert.ok(t.st.sleptAt);
});

test('travel: time up while Claude works gives a 10-minute grace, +15 min clears it', async () => {
  const sessions = [{ title: 'fix bug', state: 'working' }];
  const { t, deps, pushes, advance } = setup({ sessions });
  await t.start({ minutes: 15 });
  advance(15 * 60_000);
  t.lastTick = t.now();
  await t.tick();
  assert.ok(t.st.graceUntil);
  assert.ok(pushes.some((p) => p.title.startsWith('Travel time is up')));
  assert.equal(deps.win.slept.length, 0);
  await t.extend(15);
  assert.equal(t.st.graceUntil, null);
  advance(5 * 60_000);
  t.lastTick = t.now();
  await t.tick();
  assert.equal(deps.win.slept.length, 0);
  // grace runs out
  advance(10 * 60_000);
  t.lastTick = t.now();
  await t.tick();
  advance(11 * 60_000);
  t.lastTick = t.now();
  await t.tick();
  assert.deepEqual(deps.win.slept, ['sleep']);
});

test('travel: sleeps 1 minute after Claude finishes; Stay awake stops it', async () => {
  const sessions = [{ title: 'refactor', state: 'working' }];
  const { t, deps, pushes, advance } = setup({ sessions });
  await t.start({ minutes: 90, endAction: 'hibernate' });
  const step = async (n) => {
    for (let i = 0; i < n; i++) {
      advance(30_000);
      await t.tick();
    }
  };
  t.lastTick = t.now();
  await step(2);
  sessions[0].state = 'idle';
  await step(7); // 3.5 quiet minutes
  assert.ok(t.st.sleepAt, 'warned');
  assert.ok(pushes.some((p) => p.title.startsWith('Claude is done')));
  await t.stayAwake();
  await step(4);
  assert.equal(deps.win.slept.length, 0);

  // again, without pressing Stay awake
  const b = setup({ sessions: [{ title: 'x', state: 'working' }] });
  await b.t.start({ minutes: 90, endAction: 'hibernate' });
  b.t.lastTick = b.now();
  for (let i = 0; i < 2; i++) { b.advance(30_000); await b.t.tick(); }
  b.deps.sessions.list = () => [];
  for (let i = 0; i < 12; i++) { b.advance(30_000); await b.t.tick(); }
  assert.deepEqual(b.deps.win.slept, ['hibernate']);
});

test('travel: a waiting Claude (needs your answer) keeps the laptop awake', async () => {
  const { t, deps, advance } = setup({ sessions: [{ title: 'q', state: 'waiting' }] });
  await t.start({ minutes: 90 });
  t.lastTick = t.now();
  for (let i = 0; i < 40; i++) { advance(30_000); await t.tick(); }
  assert.equal(deps.win.slept.length, 0);
});

test('travel: plugging in the charger ends it; waking after sleep ends it', async () => {
  const a = setup({ sessions: [{ title: 'x', state: 'working' }] });
  await a.t.start({});
  a.t.lastTick = a.now();
  a.status.battery = { percent: 70, pluggedIn: true };
  a.advance(30_000);
  await a.t.tick();
  assert.equal(a.t.st.active, false);
  assert.equal(a.t.st.last.reason, 'charger');

  const b = setup({ sessions: [{ title: 'x', state: 'working' }] });
  await b.t.start({});
  b.t.lastTick = b.now();
  await b.t.sleepNow();
  b.advance(40 * 60_000); // asleep in the bag
  await b.t.tick();
  assert.equal(b.t.st.active, false);
  assert.equal(b.t.st.last.reason, 'woke');
  assert.ok(b.deps.win.calls.some((c) => c[0] === 'resume'));
});

test('travel: started on the charger, it does not end until unplugged and plugged back', async () => {
  const a = setup({ battery: { percent: 90, pluggedIn: true }, sessions: [{ title: 'x', state: 'working' }] });
  await a.t.start({});
  a.t.lastTick = a.now();
  a.advance(30_000);
  await a.t.tick();
  assert.equal(a.t.st.active, true);
});

test('travel: fast battery drain warns once and switches to Coolest', async () => {
  const { t, deps, pushes, status, advance } = setup({ sessions: [{ title: 'x', state: 'working' }] });
  await t.start({ level: 'cool', minutes: 90 });
  t.lastTick = t.now();
  let pct = 80;
  for (let i = 0; i < 10; i++) {
    status.battery = { percent: pct, pluggedIn: false };
    pct -= 1; // 2%/min at 30 s ticks
    advance(30_000);
    await t.tick();
  }
  assert.equal(pushes.filter((p) => p.title.startsWith('Battery dropping fast')).length, 1);
  assert.equal(t.st.level, 'coolest');
  const last = deps.win.calls.filter((c) => c[0] === 'powerSet').pop();
  assert.deepEqual(last[2].cpuMax, { ac: 60, dc: 60 });
});

test('travel: new Chrome processes get paused, new Claude processes get pinned', async () => {
  const { t, deps, advance } = setup({ sessions: [{ title: 'x', state: 'working' }] });
  await t.start({});
  deps.win.procs = [...laptop(), P(92, 90, 'chrome', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'), P(53, 51, 'npm', 'C:\\Program Files\\nodejs\\npm.exe')];
  deps.win.calls.length = 0;
  t.lastTick = t.now();
  advance(30_000);
  await t.tick();
  advance(30_000);
  await t.tick();
  assert.ok(deps.win.calls.some((c) => c[0] === 'suspend' && c[1].length === 1 && c[1][0] === 92));
  assert.ok(deps.win.calls.some((c) => c[0] === 'pin' && c[1].length === 1 && c[1][0] === 53));
});

test('travel: after a reboot it only restores the power plan', async () => {
  const { t, deps, dataDir } = setup();
  await t.start({});
  const w2 = fakeWin();
  w2.boot = t.st.startedAt + 1000;
  const t2 = new Travel({ dataDir }, { ...deps, win: w2 });
  assert.equal(t2.st.active, true, 'picked up from data/travel.json');
  await t2.resumeAfterRestart();
  assert.equal(t2.st.active, false);
  assert.equal(t2.st.last.reason, 'restart');
  assert.ok(w2.calls.some((c) => c[0] === 'powerSet'));
  assert.ok(!w2.calls.some((c) => c[0] === 'resume'));
});

test('travel: heavy commands are held, light ones are not', () => {
  for (const b of [{ kind: 'install' }, { kind: 'script', name: 'build' }, { kind: 'script', name: 'test:e2e' }, { kind: 'script', name: 'dev' },
    { kind: 'custom', cmd: 'npm run build' }, { kind: 'custom', cmd: 'npx tsc --noEmit' }, { kind: 'custom', cmd: 'docker compose up' }, { kind: 'custom', cmd: 'pnpm install' }]) {
    assert.equal(Travel.isHeavy(b), true, JSON.stringify(b));
  }
  for (const b of [{ kind: 'script', name: 'format' }, { kind: 'custom', cmd: 'git status' }, { kind: 'custom', cmd: 'dir' }, { kind: 'custom', cmd: 'node -v' }]) {
    assert.equal(Travel.isHeavy(b), false, JSON.stringify(b));
  }
  assert.equal(Travel.isHeavy({ kind: 'quick', id: 0 }, 'python -m pytest'), true);
});

test('travel: Claude gets the light-work note only while travelling; the hook reads the same file', async () => {
  const { t, dataDir } = setup();
  assert.equal(t.claudeNote(), null);
  assert.equal(travelNote(path.join(dataDir, 'travel.json')), null);
  await t.start({ lightWork: true });
  assert.equal(t.claudeNote(), TRAVEL_NOTE);
  assert.equal(travelNote(path.join(dataDir, 'travel.json')), TRAVEL_NOTE);
  assert.equal(t.holds({ kind: 'install' }), true);
  assert.equal(t.holds({ kind: 'install', force: true }), false);
  await t.end();
  assert.equal(travelNote(path.join(dataDir, 'travel.json')), null);
  assert.equal(t.holds({ kind: 'install' }), false);
});

test('travel: a Chrome that Claude started keeps running, but your own Chrome still pauses', async () => {
  const procs = [...laptop(), P(55, 52, 'chrome', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe')];
  const { t, deps } = setup({ win: fakeWin(procs) });
  const p = await t.preview();
  const chrome = p.apps.find((a) => a.exe === 'chrome.exe');
  assert.ok(chrome, 'Chrome is still offered');
  assert.equal(chrome.count, 2, 'only your two Chrome processes');
  assert.ok(p.kept.some((k) => k.name === 'Google Chrome (started by Claude)'));
  await t.start({});
  const sus = deps.win.calls.find((c) => c[0] === 'suspend');
  assert.ok(sus[1].includes(90) && !sus[1].includes(55));
  // and a group with nothing left to pause (uv only runs under Claude) is not offered at all
  assert.ok(!p.apps.some((a) => a.exe === 'uv.exe'));
});

test('travel: helpers', () => {
  assert.equal(eCoreMask({ cores: [{ eff: 0, mask: '1' }, { eff: 0, mask: '2' }] }), null, 'one kind of core: no pinning');
  const v = travelValues('cool', { boost: { ac: 2, dc: 2 }, saver: { ac: 5, dc: 30 } });
  assert.deepEqual(Object.keys(v).sort(), ['boost', 'saver'], 'only settings this laptop has');
  assert.deepEqual(v.saver, { ac: 5, dc: 100 });
});
