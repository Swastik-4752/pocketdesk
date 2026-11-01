import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pocketdesk-test-'));
const home = path.join(tmp, 'home');
const projects = path.join(tmp, 'projects');
const outside = path.join(tmp, 'outside');
const dataDir = path.join(tmp, 'data');
for (const d of [home, projects, outside, path.join(projects, 'app', 'src'), path.join(home, '.claude'), path.join(home, '.claude-profiles', 'College')]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(projects, 'app', 'README.md'), '# hello\n');
fs.writeFileSync(path.join(projects, 'app', '.env'), 'SECRET=1\n');
fs.writeFileSync(path.join(projects, 'app', 'page.html'), '<script>alert(1)</script>');
fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside!');
// personal profile (main) and a college profile
const cred = (t) => JSON.stringify({ claudeAiOauth: { accessToken: t, expiresAt: Date.now() + 864e5 } });
fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), cred('tok-main'));
fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'me@personal.test' } }));
fs.writeFileSync(path.join(home, '.claude-profiles', 'College', '.credentials.json'), cred('tok-college'));
fs.writeFileSync(path.join(home, '.claude-profiles', 'College', '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'staff@college.test' } }));
let junctionMade = false;
try {
  fs.symlinkSync(outside, path.join(projects, 'app', 'escape'), 'junction');
  junctionMade = true;
} catch {
  /* no permission to make links here */
}

process.env.POCKETDESK_HOME = home;
const cfgFile = path.join(tmp, 'config.json');
fs.writeFileSync(cfgFile, JSON.stringify({ port: 0, roots: [{ name: 'Projects', path: projects }], dataDir, maxUploadBytes: 1024, idleSessionMinutes: 1 }));

const { loadConfig } = await import('../lib/config.js');
const { createApp } = await import('../server.js');
const cfg = loadConfig(cfgFile);

// ---------- fake Claude (Agent SDK stand-in) ----------
let fakeEmail = 'me@personal.test';
// Who each saved login token REALLY belongs to (what Anthropic's profile endpoint answers).
const tokenOwner = { 'tok-main': 'me@personal.test', 'tok-college': 'staff@college.test' };
let profileCalls = 0;
async function fakeFetch(url, opts) {
  profileCalls++;
  assert.equal(url, 'https://api.anthropic.com/api/oauth/profile');
  const token = String(opts.headers.Authorization).replace('Bearer ', '');
  const email = tokenOwner[token];
  if (!email) return { ok: false, status: 401, json: async () => ({}) };
  return { ok: true, status: 200, json: async () => ({ account: { email, display_name: email.split('@')[0] }, organization: { name: `${email}'s Organization` } }) };
}
const seenEnv = [];
const seenOpts = [];
function fakeQuery({ prompt, options }) {
  seenEnv.push(options.env);
  seenOpts.push(options);
  const it = prompt[Symbol.asyncIterator]();
  async function* gen() {
    let first = true;
    for (;;) {
      const next = await it.next();
      if (next.done) return;
      const text = next.value.message.content;
      if (first) {
        yield { type: 'system', subtype: 'init', session_id: 'sdk-1', model: 'fake', permissionMode: options.permissionMode, claude_code_version: 'x' };
        first = false;
      }
      if (text.includes('run ls')) {
        yield { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] } };
        const ctl = new AbortController();
        const r = await options.canUseTool('Bash', { command: 'ls' }, { signal: ctl.signal });
        yield { type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: r.behavior !== 'allow', content: r.behavior === 'allow' ? 'a.txt' : r.message }] } };
      }
      yield { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: `echo: ${text}` }] } };
      yield { type: 'rate_limit_event', rate_limit_info: { status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.25, resetsAt: 1900000000 }, seven_day: { utilization: 0.85, resetsAt: 1900000000 } } } };
      yield { type: 'result', subtype: 'success', is_error: false, duration_ms: 5, num_turns: 1, result: 'ok' };
    }
  }
  const g = gen();
  g.accountInfo = async () => ({ email: fakeEmail, subscriptionType: 'pro' });
  g.supportedModels = async () => [{ value: 'default', displayName: 'Default (recommended)', description: 'Opus', supportsEffort: true, supportedEffortLevels: ['low', 'high', 'max'] }, { value: 'haiku', displayName: 'Haiku', description: 'fast' }];
  g.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET = async () => ({ subscription_type: 'pro', rate_limits_available: true, rate_limits: { five_hour: { utilization: 12, resets_at: '2030-01-01T00:00:00Z' }, seven_day: { utilization: 49, resets_at: null }, model_scoped: [{ display_name: 'Fable', utilization: 3, resets_at: null }] } });
  g.interrupt = async () => {};
  g.setPermissionMode = async () => {};
  return g;
}

const pushed = [];
const fakePush = { publicKey: () => 'k', notify: async (n) => pushed.push(n), subscribe: async () => {}, removeDevice: async () => {} };
const app = createApp(cfg, { queryFn: fakeQuery, push: fakePush, fetchFn: fakeFetch, whoisFn: async () => null });
let server;
let base;

before(async () => {
  server = http.createServer((req, res) => app.handle(req, res));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await app.sessions.shutdown();
  await app.tasks.shutdown();
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Raw request so we control the Host header and proxy headers exactly. */
function req(method, url, { body, headers = {}, phone = false, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url, base);
    const h = { 'x-pocketdesk': '1', host: phone ? 'laptop.tail1234.ts.net' : u.host, ...headers };
    if (phone) h['x-forwarded-for'] = '100.64.0.2';
    if (cookie) h.cookie = cookie;
    let data;
    if (body !== undefined) {
      data = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
      if (!Buffer.isBuffer(body)) h['content-type'] = 'application/json';
      h['content-length'] = data.length;
    }
    const r = http.request({ method, hostname: u.hostname, port: u.port, path: u.pathname + u.search, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        let json = null;
        try { json = JSON.parse(text); } catch { /* not json */ }
        resolve({ status: res.statusCode, headers: res.headers, json, text });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

// ---------- files ----------
test('path safety: traversal, drive paths, denied names, junction escape', async () => {
  await assert.rejects(app.files.resolve(0, '../outside/secret.txt'), { status: 400 });
  await assert.rejects(app.files.resolve(0, 'app/..\\..\\outside'), { status: 400 });
  await assert.rejects(app.files.resolve(0, 'C:/Windows'), { status: 400 });
  await assert.rejects(app.files.resolve(0, 'app/README.md:stream'), { status: 400 });
  await assert.rejects(app.files.resolve(0, 'app/.env'), { status: 403 });
  await assert.rejects(app.files.resolve(0, 'app/.ENV'), { status: 403 });
  await assert.rejects(app.files.resolve(9, ''), { status: 404 });
  if (junctionMade) await assert.rejects(app.files.resolve(0, 'app/escape/secret.txt'), { status: 403 });
  const ok = await app.files.resolve(0, 'app/README.md');
  assert.equal(ok.rel, 'app/README.md');
});

test('listing hides denied files', async () => {
  const r = await app.files.list(0, 'app');
  const names = r.items.map((i) => i.name);
  assert.ok(names.includes('README.md'));
  assert.ok(!names.includes('.env'));
  assert.ok(r.hidden >= 1);
});

test('edit conflict, create, upload limits', async () => {
  const f = await app.files.readText(0, 'app/README.md');
  assert.equal(f.text, '# hello\n');
  const saved = await app.files.writeText(0, 'app/README.md', { text: '# changed\n', baseMtime: f.mtime });
  assert.equal(fs.readFileSync(path.join(projects, 'app', 'README.md'), 'utf8'), '# changed\n');
  await assert.rejects(app.files.writeText(0, 'app/README.md', { text: 'stale', baseMtime: f.mtime - 5000 }), { status: 409 });
  await app.files.writeText(0, 'app/README.md', { text: 'forced', baseMtime: saved.mtime });
  await app.files.writeText(0, 'app/new.txt', { text: 'n', create: true });
  await assert.rejects(app.files.writeText(0, 'app/new.txt', { text: 'n', create: true }), { status: 409 });
  await assert.rejects(app.files.writeText(0, 'app/missing.txt', { text: 'n' }), { status: 404 });

  const up = await req('POST', '/api/files/upload?root=0&path=app&name=photo.png', { body: Buffer.alloc(100, 1) });
  assert.equal(up.status, 200, up.text);
  assert.equal(fs.statSync(path.join(projects, 'app', 'photo.png')).size, 100);
  const dup = await req('POST', '/api/files/upload?root=0&path=app&name=photo.png', { body: Buffer.alloc(10) });
  assert.equal(dup.status, 409);
  const big = await req('POST', '/api/files/upload?root=0&path=app&name=big.bin', { body: Buffer.alloc(5000) });
  assert.equal(big.status, 413);
  assert.ok(!fs.existsSync(path.join(projects, 'app', 'big.bin')));
  assert.ok(!fs.readdirSync(path.join(projects, 'app')).some((n) => n.includes('.pocketdesk-')), 'no temp files left');
  const evil = await req('POST', '/api/files/upload?root=0&path=app&name=..%2F..%2Fx.txt', { body: Buffer.alloc(3) });
  assert.equal(evil.status, 200);
  assert.ok(fs.existsSync(path.join(projects, 'app', 'x.txt')), 'name is reduced to its basename');
  const denied = await req('POST', '/api/files/upload?root=0&path=app&name=.env', { body: Buffer.alloc(3) });
  assert.equal(denied.status, 403);
});

test('raw: html downloads as attachment inside a sandbox; images inline', async () => {
  const r = await req('GET', '/api/files/raw?root=0&path=app/page.html');
  assert.equal(r.status, 200);
  assert.match(r.headers['content-disposition'], /^attachment/);
  assert.equal(r.headers['content-type'], 'application/octet-stream');
  assert.match(r.headers['content-security-policy'], /sandbox/);
  const img = await req('GET', '/api/files/raw?root=0&path=app/photo.png');
  assert.match(img.headers['content-disposition'], /^inline/);
});

// ---------- auth ----------
test('laptop vs phone identity, CSRF header, pairing', async () => {
  const local = await req('GET', '/api/me');
  assert.equal(local.status, 200);
  assert.equal(local.json.kind, 'laptop');

  const fakeHost = await req('GET', '/api/me', { headers: { host: 'evil.example' } });
  assert.equal(fakeHost.status, 401, 'DNS-rebinding style Host is not trusted as the laptop');

  const phone = await req('GET', '/api/me', { phone: true });
  assert.equal(phone.status, 401);
  assert.equal((await req('GET', '/api/setup', { phone: true })).status, 403);

  const noHeader = await req('POST', '/api/setup/pairing', { headers: { 'x-pocketdesk': '' } });
  assert.equal(noHeader.status, 403);

  assert.equal((await req('POST', '/api/pair', { phone: true, body: { code: '123456' } })).status, 400, 'no code active yet');
  const made = await req('POST', '/api/setup/pairing');
  const code = made.json.code;
  assert.match(code, /^\d{6}$/);
  const wrong = code === '000000' ? '111111' : '000000';
  assert.equal((await req('POST', '/api/pair', { phone: true, body: { code: wrong } })).status, 401);
  const paired = await req('POST', '/api/pair', { phone: true, body: { code, name: 'Test phone' } });
  assert.equal(paired.status, 200, paired.text);
  const cookie = paired.headers['set-cookie'][0].split(';')[0];
  assert.match(paired.headers['set-cookie'][0], /HttpOnly/);
  assert.equal((await req('POST', '/api/pair', { phone: true, body: { code } })).status, 400, 'code works once');

  const me = await req('GET', '/api/me', { phone: true, cookie });
  assert.equal(me.status, 200);
  assert.equal(me.json.kind, 'device');
  assert.equal((await req('GET', '/api/files/list?root=0&path=app', { phone: true, cookie })).status, 200);
  assert.equal((await req('GET', '/api/setup', { phone: true, cookie })).status, 403, 'a paired phone still cannot open setup');
  assert.equal((await req('GET', '/api/me', { phone: true, cookie: 'pd_dev=forged' })).status, 401);

  const devices = app.auth.listDevices();
  assert.equal(devices.length, 1);
  assert.ok(!('hash' in devices[0]));
  await req('DELETE', `/api/devices/${devices[0].id}`);
  assert.equal((await req('GET', '/api/me', { phone: true, cookie })).status, 401, 'removed device loses access');
});

test('pairing code dies after too many wrong tries', async () => {
  const { code } = (await req('POST', '/api/setup/pairing')).json;
  const wrong = code === '000000' ? '111111' : '000000';
  for (let i = 0; i < 5; i++) await req('POST', '/api/pair', { phone: true, body: { code: wrong } });
  const r = await req('POST', '/api/pair', { phone: true, body: { code } });
  assert.equal(r.status, 429);
});

// ---------- account lock ----------
test('profiles: lists both, refuses unsigned, env pins the profile', async () => {
  const list = app.profiles.listForLaptop();
  assert.deepEqual(list.map((p) => p.email).sort(), ['me@personal.test', 'staff@college.test']);
  const college = await app.profiles.choose('profiles/College');
  const env = app.profiles.envFor(college);
  assert.equal(env.CLAUDE_CONFIG_DIR, path.join(home, '.claude-profiles', 'College'));
  const main = await app.profiles.choose('main');
  process.env.ANTHROPIC_API_KEY = 'sk-should-be-removed';
  const env2 = app.profiles.envFor(main);
  delete process.env.ANTHROPIC_API_KEY;
  assert.equal(env2.CLAUDE_CONFIG_DIR, undefined);
  assert.equal(env2.ANTHROPIC_API_KEY, undefined);
});

async function waitFor(fn, ms = 3000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

// ---------- Claude sessions ----------
test('session: runs, asks permission, follow-up, survives as resumable', async () => {
  await app.profiles.choose('main');
  fakeEmail = 'me@personal.test';
  const created = await req('POST', '/api/sessions', { body: { rootId: 0, rel: 'app', prompt: 'please run ls', permissionMode: 'default' } });
  assert.equal(created.status, 200, created.text);
  const id = created.json.id;
  const s = app.sessions.get(id);
  assert.equal(s.cwd, fs.realpathSync.native(path.join(projects, 'app')));

  const perm = await waitFor(() => s.events.find((e) => e.t === 'perm'));
  assert.equal(perm.tool, 'Bash');
  assert.equal(s.state, 'waiting');
  assert.ok(pushed.some((p) => p.tag === `perm-${perm.pid}`), 'phone notified about approval');

  const dec = await req('POST', `/api/sessions/${id}/decide`, { body: { pid: perm.pid, decision: 'allow' } });
  assert.equal(dec.status, 200, dec.text);
  await waitFor(() => s.state === 'idle');
  const r1 = s.events.find((e) => e.t === 'tool_result');
  assert.equal(r1.err, false);
  assert.ok(s.events.some((e) => e.t === 'text' && e.text === 'echo: please run ls'));
  assert.equal(s.sdkSessionId, 'sdk-1');
  assert.ok(s.account === 'me@personal.test');

  const again = await req('POST', `/api/sessions/${id}/decide`, { body: { pid: perm.pid, decision: 'allow' } });
  assert.equal(again.status, 409, 'cannot answer twice');

  await req('POST', `/api/sessions/${id}/send`, { body: { text: 'second' } });
  await waitFor(() => s.events.some((e) => e.t === 'text' && e.text === 'echo: second'));

  // events are on disk and replay from a cursor
  const after = s.events[2].seq;
  const ev = await req('GET', `/api/sessions/${id}?after=${after}`);
  assert.ok(ev.json.events.every((e) => e.seq > after));
  await waitFor(() => fs.readFileSync(path.join(dataDir, 'sessions', `${id}.jsonl`), 'utf8').trim().split('\n').length === s.events.length);
  assert.ok(s.events.length > 5);

  // close -> paused, then a new message resumes with the SDK session id
  await req('POST', `/api/sessions/${id}/close`);
  await waitFor(() => s.state === 'closed' && !s.q);
  const resumed = await req('POST', `/api/sessions/${id}/send`, { body: { text: 'third' } });
  assert.equal(resumed.status, 200, resumed.text);
  await waitFor(() => s.events.some((e) => e.t === 'text' && e.text === 'echo: third'));
  await req('POST', `/api/sessions/${id}/close`);
  await waitFor(() => !s.q);
});

test('session: deny goes back to Claude as a denial', async () => {
  const created = await req('POST', '/api/sessions', { body: { rootId: 0, rel: '', prompt: 'run ls now' } });
  const s = app.sessions.get(created.json.id);
  const perm = await waitFor(() => s.events.find((e) => e.t === 'perm'));
  await req('POST', `/api/sessions/${s.id}/decide`, { body: { pid: perm.pid, decision: 'deny', note: 'not now' } });
  const res = await waitFor(() => s.events.find((e) => e.t === 'tool_result'));
  assert.equal(res.err, true);
  assert.match(res.text, /denied.*not now/);
  await req('POST', `/api/sessions/${s.id}/close`);
  await waitFor(() => !s.q);
});

test('real login wins over the info file, and a session never runs on a swapped login', async () => {
  // The info file says personal, but the saved token belongs to someone else (what the desktop app caused).
  tokenOwner['tok-main'] = 'other@person.test';
  app.identity.cache.clear();
  const acc = await req('GET', '/api/accounts');
  const main = acc.json.accounts.find((a) => a.id === 'main');
  assert.equal(main.email, 'other@person.test', 'shows who the login really is');
  assert.equal(main.verified, true);
  const setup = await req('GET', '/api/setup');
  assert.equal(setup.json.profiles.find((p) => p.id === 'main').fileMismatch, 'me@personal.test');

  const created = await req('POST', '/api/sessions', { body: { rootId: 0, rel: '', prompt: 'hello', profileId: 'main' } });
  assert.equal(created.status, 200, created.text);
  const s = app.sessions.get(created.json.id);
  assert.equal(s.account, 'other@person.test');
  await waitFor(() => s.state === 'idle');
  await req('POST', `/api/sessions/${s.id}/close`);
  await waitFor(() => !s.q);

  // Someone signs "main" in as a different account: the old session must not continue on it.
  fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), cred('tok-main-2'));
  tokenOwner['tok-main-2'] = 'me@personal.test';
  const again = await req('POST', `/api/sessions/${s.id}/send`, { body: { text: 'continue' } });
  assert.equal(again.status, 409);
  assert.match(again.json.error, /belongs to other@person.test/);

  // An expired/unknown login is refused, never guessed.
  fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), cred('tok-dead'));
  const dead = await req('POST', '/api/sessions', { body: { rootId: 0, rel: '', prompt: 'x', profileId: 'main' } });
  assert.equal(dead.status, 409);
  fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), cred('tok-main'));
  tokenOwner['tok-main'] = 'me@personal.test';
  app.identity.cache.clear();
});

test('session: needs a picked account and a folder inside the roots', async () => {
  const bad = await req('POST', '/api/sessions', { body: { rootId: 0, rel: '../outside', prompt: 'x' } });
  assert.equal(bad.status, 400);
  const file = await req('POST', '/api/sessions', { body: { rootId: 0, rel: 'app/README.md', prompt: 'x' } });
  assert.equal(file.status, 400);
  const saved = app.profiles.state;
  app.profiles.state = { profileId: null };
  const none = await req('POST', '/api/sessions', { body: { rootId: 0, rel: '', prompt: 'x' } });
  assert.equal(none.status, 409);
  app.profiles.state = saved;
});

test('per-session account: college session runs on the college profile and is checked against it', async () => {
  seenEnv.length = 0;
  const created = await req('POST', '/api/sessions', { body: { rootId: 0, rel: '', prompt: 'hi', profileId: 'profiles/College', model: 'haiku', effort: 'high' } });
  assert.equal(created.status, 200, created.text);
  const s = app.sessions.get(created.json.id);
  await waitFor(() => s.state === 'idle');
  assert.equal(s.account, 'staff@college.test');
  assert.equal(seenEnv[0].CLAUDE_CONFIG_DIR, path.join(home, '.claude-profiles', 'College'));
  assert.equal(s.effort, 'high');
  await req('POST', `/api/sessions/${s.id}/close`);
  await waitFor(() => !s.q);
  assert.equal((await req('POST', '/api/sessions', { body: { rootId: 0, rel: '', prompt: 'x', effort: 'huge' } })).status, 400);
  assert.equal((await req('POST', '/api/sessions', { body: { rootId: 0, rel: '', prompt: 'x', profileId: 'nope' } })).status, 404);
});

test('accounts, models and usage come from Claude without a prompt', async () => {
  const acc = await req('GET', '/api/accounts');
  assert.equal(acc.status, 200);
  assert.ok(acc.json.accounts.every((a) => !('dir' in a)), 'no folder paths sent to the phone');
  fakeEmail = 'me@personal.test';
  const m = await req('GET', '/api/accounts/main/models');
  assert.equal(m.status, 200, m.text);
  assert.equal(m.json.models[0].displayName, 'Default (recommended)');
  assert.deepEqual(m.json.models[0].efforts, ['low', 'high', 'max']);
  const u = await req('GET', '/api/usage?fresh=1');
  assert.equal(u.status, 200, u.text);
  const main = u.json.accounts.find((a) => a.id === 'main');
  assert.equal(main.usage.windows[0].percent, 12);
  assert.ok(main.usage.windows.some((w) => w.label === 'Weekly · Fable'));
  // live numbers from real replies are kept per account
  assert.equal(main.live.windows.find((w) => w.label.startsWith('Weekly')).percent, 85);
  assert.equal(main.live.windows.find((w) => w.label.startsWith('Current')).percent, 25);
});

test('static app has a strict CSP', async () => {
  const r = await req('GET', '/');
  assert.equal(r.status, 200);
  assert.match(r.headers['content-security-policy'], /script-src 'self'/);
  const sw = await req('GET', '/sw.js');
  assert.equal(sw.status, 200);
  assert.equal((await req('GET', '/../config.json')).status, 404);
});

// ---------- helpers for the phone-side features ----------
async function pairPhone(name = 'Phone', headers = {}) {
  const { code } = (await req('POST', '/api/setup/pairing')).json;
  const r = await req('POST', '/api/pair', { phone: true, headers, body: { code, name } });
  assert.equal(r.status, 200, r.text);
  return r.headers['set-cookie'][0].split(';')[0];
}
const waitLong = (fn) => waitFor(fn, 20_000);

// ---------- commands ----------
test('commands: only package.json scripts / install / config quick commands run; output, port, failure push, stop', async () => {
  const web = path.join(projects, 'web');
  fs.mkdirSync(web, { recursive: true });
  fs.writeFileSync(path.join(web, 'package.json'), JSON.stringify({ name: 'web', scripts: {
    hello: "node -e \"console.log('ready on http://localhost:4567')\"",
    broken: 'node -e "process.exit(3)"',
    forever: 'node -e "setInterval(()=>{},1000) // pd-forever-marker"',
  } }));
  cfg.quickCommands = [{ name: 'Say hi', cmd: 'echo hi-from-quick' }];
  const opts = await req('GET', '/api/tasks/options?root=0&path=web');
  assert.equal(opts.status, 200, opts.text);
  assert.deepEqual(opts.json.scripts.map((s) => s.name), ['hello', 'broken', 'forever']);
  assert.equal(opts.json.quick[0].name, 'Say hi');

  assert.equal((await req('POST', '/api/tasks?root=0&path=web', { body: { kind: 'script', name: 'rm -rf' } })).status, 404, 'not a script name');
  assert.equal((await req('POST', '/api/tasks?root=0&path=web', { body: { kind: 'script', name: 'hello & calc' } })).status, 404);
  assert.equal((await req('POST', '/api/tasks?root=0&path=web', { body: { kind: 'shell', cmd: 'dir' } })).status, 400, 'no free commands');
  assert.equal((await req('POST', '/api/tasks?root=0&path=../outside', { body: { kind: 'install' } })).status, 400);

  const run = async (body) => {
    const r = await req('POST', '/api/tasks?root=0&path=web', { body });
    assert.equal(r.status, 200, r.text);
    return waitLong(async () => {
      const l = (await req('GET', `/api/tasks/${r.json.id}/log`)).json;
      return !l.task.running && l;
    });
  };
  const hello = await run({ kind: 'script', name: 'hello' });
  assert.equal(hello.task.state, 'done');
  assert.equal(hello.task.port, 4567, 'dev-server port is spotted in the output');
  assert.ok(hello.lines.some((l) => l.t.includes('ready on http://localhost:4567')));
  const quick = await run({ kind: 'quick', id: 0 });
  assert.ok(quick.lines.some((l) => l.t.includes('hi-from-quick')));

  pushed.length = 0;
  const broken = await run({ kind: 'script', name: 'broken' });
  assert.equal(broken.task.state, 'failed');
  assert.ok(pushed.some((n) => n.title.includes('broken') && n.url === `/#/t/${broken.task.id}`), 'a failed command buzzes the phone');

  const fr = await req('POST', '/api/tasks?root=0&path=web', { body: { kind: 'script', name: 'forever' } });
  assert.equal((await req('POST', '/api/tasks?root=0&path=web', { body: { kind: 'script', name: 'forever' } })).status, 409, 'same command twice is refused');
  await new Promise((r) => setTimeout(r, 300)); // stop while npm is still starting the inner node
  assert.equal((await req('POST', `/api/tasks/${fr.json.id}/stop`)).status, 200);
  const stopped = await waitLong(async () => {
    const l = (await req('GET', `/api/tasks/${fr.json.id}/log`)).json;
    return !l.task.running && l;
  });
  assert.equal(stopped.task.state, 'stopped');
  const { execFileSync: ex } = await import('node:child_process');
  const leftovers = () => ex('powershell.exe', ['-NoProfile', '-Command', "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*pd-forever-marker*' -and $_.Name -eq 'node.exe' } | Measure-Object | ForEach-Object Count"], { windowsHide: true }).toString().trim();
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(leftovers(), '0', 'Stop leaves no process of that command behind');
  assert.ok(app.activity.list().some((a) => a.action === 'Ran command' && a.detail.includes('run forever')));
  assert.equal((await req('DELETE', `/api/tasks/${fr.json.id}`)).status, 200);
});

test('share: dev server goes on its own tailnet port, never touches PocketDesk itself', async () => {
  const { Share } = await import('../lib/share.js');
  const calls = [];
  const runFn = async (args) => {
    calls.push(args);
    if (args[0] === 'status') return { stdout: JSON.stringify({ Self: { DNSName: 'laptop.tail1.ts.net.' } }) };
    if (args.join(' ') === 'serve status --json') return { stdout: JSON.stringify({ Web: { 'laptop.tail1.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:8765' } } }, 'laptop.tail1.ts.net:13000': { Handlers: { '/': { Proxy: 'http://127.0.0.1:3000' } } } } }) };
    return { stdout: '' };
  };
  const sh = new Share({ port: 8765 }, { runFn, probeFn: async (host) => host === '::1' });
  const r = await sh.share(3000);
  assert.deepEqual(calls[0], ['serve', '--bg', '--https=13000', 'http://[::1]:3000'], 'answers on ::1 only, so it is proxied there');
  assert.equal(r.url, 'https://laptop.tail1.ts.net:13000');
  assert.deepEqual(await sh.list(), [{ httpsPort: 13000, port: 3000, target: 'http://127.0.0.1:3000', url: 'https://laptop.tail1.ts.net:13000' }]);
  await sh.unshare(3000);
  assert.deepEqual(calls.at(-1), ['serve', '--https=13000', 'off']);
  await assert.rejects(sh.share(8765), { status: 400 });
  await assert.rejects(sh.share(80), { status: 400 });
  await assert.rejects(new Share({ port: 8765 }, { runFn, probeFn: async () => false }).share(5173), { status: 409 });
});

// ---------- git ----------
test('git: status, diff (incl. new files), stage, unstage, commit, log; push without remote refused', async () => {
  const { execFileSync } = await import('node:child_process');
  const repo = path.join(projects, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  const g = (...a) => execFileSync('git', a, { cwd: repo, windowsHide: true });
  g('init', '-q', '-b', 'main');
  g('config', 'user.name', 'Test');
  g('config', 'user.email', 'test@example.invalid');
  g('config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  g('add', '.');
  g('commit', '-q', '-m', 'first');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\n');
  fs.writeFileSync(path.join(repo, 'new file.txt'), 'hello\n');

  const stR = await req('GET', '/api/git/status?root=0&path=repo');
  assert.equal(stR.status, 200, stR.text);
  const st = stR.json;
  assert.equal(st.branch, 'main');
  assert.equal(st.upstream, null);
  assert.deepEqual(st.remotes, []);
  const byPath = Object.fromEntries(st.files.map((f) => [f.path, f]));
  assert.ok(byPath['a.txt'].unstaged && !byPath['a.txt'].staged);
  assert.ok(byPath['new file.txt'].untracked, 'paths with spaces come through unquoted');

  const d1 = (await req('GET', '/api/git/diff?root=0&path=repo&file=a.txt')).json;
  assert.match(d1.text, /^\+two$/m);
  const d2 = await req('GET', `/api/git/diff?root=0&path=repo&file=${encodeURIComponent('new file.txt')}`);
  assert.equal(d2.status, 200, d2.text);
  assert.match(d2.json.text, /^\+hello$/m);
  assert.equal((await req('GET', '/api/git/diff?root=0&path=repo&file=--output=x')).status, 400, 'no option injection');

  assert.equal((await req('POST', '/api/git/stage?root=0&path=repo', { body: { files: ['a.txt'] } })).status, 200);
  let st2 = (await req('GET', '/api/git/status?root=0&path=repo')).json;
  assert.ok(st2.files.find((f) => f.path === 'a.txt').staged);
  assert.match((await req('GET', '/api/git/diff?root=0&path=repo&file=a.txt&staged=1')).json.text, /^\+two$/m);
  assert.equal((await req('POST', '/api/git/unstage?root=0&path=repo', { body: { files: ['a.txt'] } })).status, 200);
  st2 = (await req('GET', '/api/git/status?root=0&path=repo')).json;
  assert.ok(!st2.files.find((f) => f.path === 'a.txt').staged);

  assert.equal((await req('POST', '/api/git/commit?root=0&path=repo', { body: { message: '' } })).status, 400);
  assert.equal((await req('POST', '/api/git/commit?root=0&path=repo', { body: { message: 'nothing staged' } })).status, 409);
  const c = await req('POST', '/api/git/commit?root=0&path=repo', { body: { message: 'second, from the phone', all: true } });
  assert.equal(c.status, 200, c.text);
  assert.equal((await req('GET', '/api/git/status?root=0&path=repo')).json.total, 0);
  const log = (await req('GET', '/api/git/log?root=0&path=repo')).json.commits;
  assert.deepEqual(log.map((x) => x.subject), ['second, from the phone', 'first']);
  const push = await req('POST', '/api/git/push?root=0&path=repo', { body: { setUpstream: true } });
  assert.equal(push.status, 409, 'no origin remote: refused, nothing sent');
  assert.ok(app.activity.list().some((a) => a.action === 'Git commit' && a.detail.startsWith('second, from the phone')));

  const parse = (await import('../lib/git.js')).parseBranch;
  assert.deepEqual(parse('main...origin/main [ahead 2, behind 1]'), { branch: 'main', upstream: 'origin/main', ahead: 2, behind: 1, detached: false });
  assert.equal(parse('No commits yet on dev').noCommits, true);
});

// ---------- PIN lock, tailscale login, activity ----------
test('PIN lock: idle phone must unlock, wrong PINs counted, laptop never locked', async () => {
  const cookie = await pairPhone('Locky');
  assert.equal((await req('GET', '/api/files/list?root=0&path=app', { phone: true, cookie })).status, 200, 'no PIN yet');
  assert.equal((await req('POST', '/api/security/pin', { body: { pin: '12', lockMinutes: 15 } })).status, 400, 'too short');
  assert.equal((await req('POST', '/api/security/pin', { body: { pin: '2468', lockMinutes: 15 } })).status, 200);
  assert.ok(!fs.readFileSync(path.join(dataDir, 'security.json'), 'utf8').includes('2468'), 'PIN is stored hashed');

  const locked = await req('GET', '/api/files/list?root=0&path=app', { phone: true, cookie });
  assert.equal(locked.status, 423);
  assert.equal(locked.json.locked, true);
  const me = (await req('GET', '/api/me', { phone: true, cookie })).json;
  assert.equal(me.locked, true);
  assert.equal(me.roots, undefined, 'a locked phone learns nothing');
  assert.equal((await req('GET', '/api/files/list?root=0&path=app')).status, 200, 'the laptop is never locked');

  assert.equal((await req('POST', '/api/lock/unlock', { phone: true, cookie, body: { pin: '0000' } })).status, 401);
  assert.equal((await req('POST', '/api/lock/unlock', { phone: true, cookie, body: { pin: '2468' } })).status, 200);
  assert.equal((await req('GET', '/api/files/list?root=0&path=app', { phone: true, cookie })).status, 200);
  assert.equal((await req('POST', '/api/security/pin', { phone: true, cookie, body: { pin: '1357', currentPin: '9999' } })).status, 401, 'changing needs the current PIN');

  assert.equal((await req('POST', '/api/lock/now', { phone: true, cookie })).status, 200);
  assert.equal((await req('GET', '/api/files/list?root=0&path=app', { phone: true, cookie })).status, 423);
  for (let i = 0; i < 5; i++) await req('POST', '/api/lock/unlock', { phone: true, cookie, body: { pin: '1111' } });
  const blocked = await req('POST', '/api/lock/unlock', { phone: true, cookie, body: { pin: '2468' } });
  assert.equal(blocked.status, 429, '5 wrong PINs block even the right one for a while');
  assert.ok(app.activity.list().some((a) => a.action === 'Wrong PIN' && a.by === 'Locky'));

  assert.equal((await req('POST', '/api/security/pin/clear', { body: {} })).status, 200, 'laptop can remove the PIN');
  assert.equal((await req('GET', '/api/files/list?root=0&path=app', { phone: true, cookie })).status, 200);
});

test('Tailscale login check: only my login gets in, also for pairing', async () => {
  const cookie = await pairPhone('Mine', { 'tailscale-user-login': 'me@ts.test' });
  await app.lock.setTailscaleUsers(['me@ts.test']);
  try {
    assert.equal((await req('GET', '/api/me', { phone: true, cookie, headers: { 'tailscale-user-login': 'me@ts.test' } })).status, 200);
    assert.equal((await req('GET', '/api/me', { phone: true, cookie, headers: { 'tailscale-user-login': 'friend@ts.test' } })).status, 401, 'a shared-in device with a stolen cookie is refused');
    assert.equal((await req('GET', '/api/me', { phone: true, cookie })).status, 401);
    const { code } = (await req('POST', '/api/setup/pairing')).json;
    assert.equal((await req('POST', '/api/pair', { phone: true, headers: { 'tailscale-user-login': 'friend@ts.test' }, body: { code } })).status, 403);
    assert.equal((await req('POST', '/api/security/tailscale', { phone: true, cookie, headers: { 'tailscale-user-login': 'me@ts.test' }, body: { only: false } })).status, 403, 'only the laptop changes this');
  } finally {
    await app.lock.setTailscaleUsers([]);
  }
});

test('activity log records phone actions and survives a restart', async () => {
  const cookie = await pairPhone('Logger');
  const f = await app.files.readText(0, 'app/new.txt');
  const put = await req('PUT', '/api/files/text?root=0&path=app/new.txt', { phone: true, cookie, body: { text: 'from phone', baseMtime: f.mtime } });
  assert.equal(put.status, 200, put.text);
  const items = (await req('GET', '/api/activity', { phone: true, cookie })).json.items;
  const hit = items.find((a) => a.action === 'Saved file');
  assert.ok(hit, JSON.stringify(items.slice(0, 3)));
  assert.equal(hit.by, 'Logger');
  assert.equal(hit.detail, 'Projects / app/new.txt');
  await app.activity.chain;
  const { Activity } = await import('../lib/activity.js');
  assert.ok(new Activity(cfg).list().some((a) => a.action === 'Saved file' && a.by === 'Logger'));
});

// ---------- alerts ----------
test('alerts: unplugged, low battery once, critical, hot, back online, woke up', async () => {
  const { Alerts } = await import('../lib/alerts.js');
  let now = 1_000_000;
  let battery = { percent: 50, pluggedIn: true };
  let temp = 40;
  let up = true;
  const sent = [];
  const al = new Alerts({ dataDir: fs.mkdtempSync(path.join(tmp, 'al-')) }, {
    status: { get: async () => ({ battery, temperatureC: temp }) },
    push: { notify: async (n) => sent.push(n.title) },
    fetchFn: async () => {
      if (!up) throw new Error('offline');
      return { ok: true };
    },
    now: () => now,
  });
  const tick = async (ms = 60_000) => {
    now += ms;
    await al.check();
  };
  await al.check();
  assert.deepEqual(sent, ['PocketDesk started']);
  battery = { percent: 48, pluggedIn: false };
  await tick();
  assert.ok(sent.includes('Charger unplugged'));
  battery = { percent: 19, pluggedIn: false };
  await tick();
  await tick();
  assert.equal(sent.filter((t) => t.startsWith('Battery low')).length, 1, 'only once');
  battery = { percent: 8, pluggedIn: false };
  await tick();
  assert.ok(sent.some((t) => t.startsWith('Battery critical')));
  temp = 93;
  await tick();
  assert.ok(sent.some((t) => t.startsWith('Laptop is hot')));
  up = false;
  await tick();
  await tick();
  await tick();
  up = true;
  await tick();
  assert.ok(sent.includes('Laptop is back online'));
  await tick(45 * 60_000);
  assert.ok(sent.includes('Laptop woke up'));
  await al.set({ batteryLow: 30, unplugged: false });
  assert.equal(al.get().batteryLow, 30);
  await assert.rejects(al.set({ batteryLow: 200 }), { status: 400 });
});

// ---------- photos & videos ----------
test('raw: Range requests let the phone seek in videos', async () => {
  const { parseRange } = await import('../server.js');
  assert.equal(parseRange(undefined, 100), null);
  assert.deepEqual(parseRange('bytes=0-9', 100), { start: 0, end: 9 });
  assert.deepEqual(parseRange('bytes=90-', 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange('bytes=-10', 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange('bytes=50-500', 100), { start: 50, end: 99 });
  assert.equal(parseRange('bytes=100-', 100), 'bad');
  assert.equal(parseRange('bytes=5-2', 100), 'bad');
  assert.equal(parseRange('items=0-1', 100), 'bad');

  fs.writeFileSync(path.join(projects, 'app', 'clip.mp4'), Buffer.from('0123456789abcdefghij'));
  const part = await req('GET', '/api/files/raw?root=0&path=app/clip.mp4', { headers: { range: 'bytes=10-14' } });
  assert.equal(part.status, 206);
  assert.equal(part.text, 'abcde');
  assert.equal(part.headers['content-range'], 'bytes 10-14/20');
  assert.equal(part.headers['content-type'], 'video/mp4');
  assert.equal(part.headers['accept-ranges'], 'bytes');
  const whole = await req('GET', '/api/files/raw?root=0&path=app/clip.mp4');
  assert.equal(whole.status, 200);
  assert.equal(whole.text.length, 20);
  assert.equal((await req('GET', '/api/files/raw?root=0&path=app/clip.mp4', { headers: { range: 'bytes=99-' } })).status, 416);
  assert.equal((await req('GET', '/api/files/raw?root=0&path=app/.env', { headers: { range: 'bytes=0-1' } })).status, 403, 'denied files stay denied');
});

test('thumbnails: made once, cached, shared between parallel asks, video falls back to the first frame', async () => {
  const { Thumbs } = await import('../lib/media.js');
  fs.writeFileSync(path.join(projects, 'app', 'pic.jpg'), 'not really a jpeg');
  fs.writeFileSync(path.join(projects, 'app', 'short.mp4'), 'tiny');
  const calls = [];
  const runFn = async (exe, args) => {
    calls.push(args);
    await new Promise((r) => setTimeout(r, 30));
    if (args.includes('-ss')) return; // pretend the clip is shorter than 1 s: no frame at 1 s
    fs.writeFileSync(args[args.length - 1], 'JPEG');
  };
  const th = new Thumbs({ dataDir: fs.mkdtempSync(path.join(tmp, 'th-')) }, { files: app.files, ffmpeg: 'ffmpeg.exe', runFn });
  const [a, b] = await Promise.all([th.get(0, 'app/pic.jpg', 320), th.get(0, 'app/pic.jpg', 320)]);
  assert.equal(a, b);
  assert.equal(calls.length, 1, 'two phones asking at once make one thumbnail');
  await th.get(0, 'app/pic.jpg', 320);
  assert.equal(calls.length, 1, 'second time comes from the cache');
  await th.get(0, 'app/pic.jpg', 999);
  assert.equal(calls.length, 1, 'odd widths snap to an allowed size (320)');
  await th.get(0, 'app/pic.jpg', 640);
  assert.equal(calls.length, 2);
  const v = await th.get(0, 'app/short.mp4', 320);
  assert.ok(fs.existsSync(v));
  assert.ok(calls.at(-2).includes('-ss') && !calls.at(-1).includes('-ss'), 'video retried without seeking');
  await assert.rejects(th.get(0, 'app/README.md', 320), { status: 400 });
  await assert.rejects(th.get(0, 'app/.env', 320), { status: 403 });
  await assert.rejects(new Thumbs({ dataDir: fs.mkdtempSync(path.join(tmp, 'th-')) }, { files: app.files, ffmpeg: null }).get(0, 'app/pic.jpg'), { status: 501 });
  const broken = new Thumbs({ dataDir: fs.mkdtempSync(path.join(tmp, 'th-')) }, { files: app.files, ffmpeg: 'x', runFn: async () => { throw new Error('Invalid data found'); } });
  await assert.rejects(broken.get(0, 'app/pic.jpg'), { status: 415 });
});

// ---------- typed commands ----------
test('typed commands: run in the folder, answer prompts, PowerShell, one line only, can be turned off', async () => {
  const run = async (body) => {
    const r = await req('POST', '/api/tasks?root=0&path=app', { body });
    assert.equal(r.status, 200, r.text);
    return r.json;
  };
  const done = (id) => waitLong(async () => {
    const l = (await req('GET', `/api/tasks/${id}/log`)).json;
    return !l.task.running && l;
  });
  const echo = await done((await run({ kind: 'custom', cmd: 'echo typed-%CD%' })).id);
  assert.equal(echo.task.state, 'done');
  assert.ok(echo.lines.some((l) => l.t === `typed-${path.join(projects, 'app')}`), JSON.stringify(echo.lines));

  const ps = await done((await run({ kind: 'custom', cmd: 'Write-Output ("ps-" + (2+3))', shell: 'powershell' })).id);
  assert.ok(ps.lines.some((l) => l.t === 'ps-5'), JSON.stringify(ps.lines));
  assert.ok(ps.lines[0].t.includes('ps> '), 'the log says which shell ran it');

  // a command that asks a question: the half line shows up before answering, and the answer reaches it
  const ask = await run({ kind: 'custom', cmd: 'node -e "process.stdout.write(\'Your name? \');process.stdin.once(\'data\',d=>{console.log(\'hello \'+String(d).trim());process.exit(0)})"' });
  await waitLong(async () => (await req('GET', `/api/tasks/${ask.id}/log`)).json.lines.some((l) => l.s === 'out' && l.t.includes('Your name?')));
  const inp = await req('POST', `/api/tasks/${ask.id}/input`, { body: { text: 'Yogesh' } });
  assert.equal(inp.status, 200, inp.text);
  const answered = await done(ask.id);
  assert.ok(answered.lines.some((l) => l.s === 'in' && l.t === '< Yogesh'));
  assert.ok(answered.lines.some((l) => l.t === 'hello Yogesh'), JSON.stringify(answered.lines));
  assert.equal((await req('POST', `/api/tasks/${ask.id}/input`, { body: { text: 'late' } })).status, 409, 'finished commands take no input');

  for (const cmd of ['', 'echo a\necho b', 'echo a\r\ndel x', 'x'.repeat(2001), 'echo \0']) {
    assert.equal((await req('POST', '/api/tasks?root=0&path=app', { body: { kind: 'custom', cmd } })).status, 400, JSON.stringify(cmd.slice(0, 20)));
  }
  assert.equal((await req('POST', '/api/tasks?root=0&path=../outside', { body: { kind: 'custom', cmd: 'dir' } })).status, 400, 'only inside shared folders');
  assert.ok(app.activity.list().some((a) => a.action === 'Ran command' && a.detail.includes('echo typed-%CD%')), 'the full typed line is in the activity log');

  cfg.allowCustomCommands = false;
  try {
    assert.equal((await req('POST', '/api/tasks?root=0&path=app', { body: { kind: 'custom', cmd: 'dir' } })).status, 403);
  } finally {
    delete cfg.allowCustomCommands;
  }
});

// ---------- chats from the laptop ----------
const chatId = '11111111-2222-4333-8444-555555555555';
const chatDir = path.join(home, '.claude', 'projects', 'C--fake-app');
function writeLaptopChat(id = chatId, extra = []) {
  fs.mkdirSync(chatDir, { recursive: true });
  const cwd = path.join(projects, 'app');
  const L = (o) => JSON.stringify({ sessionId: id, cwd, timestamp: '2026-11-09T10:00:00.000Z', ...o });
  const lines = [
    L({ type: 'user', entrypoint: 'cli', message: { role: 'user', content: 'fix the login bug' } }),
    L({ type: 'user', isMeta: true, message: { role: 'user', content: '<system-reminder>hidden</system-reminder>' } }),
    L({ type: 'assistant', requestedModel: 'opus', effort: 'high', message: { model: 'claude-x', content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'Looking at it now.' }, { type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: 'a.js' } }] } }),
    L({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'file text' }] } }),
    L({ type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'SUBAGENT CHATTER' }] } }),
    L({ type: 'user', message: { role: 'user', content: '<command-name>/clear</command-name>' } }),
    L({ type: 'assistant', message: { content: [{ type: 'text', text: 'Fixed: the token was not saved.' }] } }),
    L({ type: 'user', permissionMode: 'acceptEdits', message: { role: 'user', content: 'thanks, now add a test' } }),
    JSON.stringify({ type: 'custom-title', customTitle: 'Login bug', sessionId: id }),
    JSON.stringify({ type: 'last-prompt', lastPrompt: 'thanks, now add a test', sessionId: id }),
    ...extra,
  ];
  const file = path.join(chatDir, `${id}.jsonl`);
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  return file;
}

test('laptop chats: parser keeps the real conversation and drops noise', async () => {
  const { parseTranscript } = await import('../lib/laptop-sessions.js');
  const evs = parseTranscript(fs.readFileSync(writeLaptopChat(), 'utf8'));
  const text = JSON.stringify(evs);
  assert.ok(evs.some((e) => e.t === 'user' && e.text === 'fix the login bug'));
  assert.ok(evs.some((e) => e.t === 'text' && e.text === 'Looking at it now.'));
  assert.ok(evs.some((e) => e.t === 'tool' && e.name === 'Read'));
  assert.ok(evs.some((e) => e.t === 'tool_result' && e.tid === 'tu1'));
  assert.ok(!text.includes('SUBAGENT CHATTER'), 'subagent side chats are not shown as the main chat');
  assert.ok(!text.includes('hidden'), 'system reminders are hidden');
  assert.ok(!text.includes('"thinking"') && !text.includes('hmm'), 'thinking is not shown');
  assert.equal(evs.map((e) => e.seq).join(), evs.map((_, i) => i + 1).join());
});

test('laptop chats: list, read all of it, continue on the phone with resume, switch account', async () => {
  writeLaptopChat();
  app.laptopChats.listCache = null;
  const list = await req('GET', '/api/laptop-chats');
  assert.equal(list.status, 200, list.text);
  const row = list.json.sessions.find((s) => s.id === chatId);
  assert.ok(row, JSON.stringify(list.json));
  assert.equal(row.title, 'Login bug');
  assert.equal(row.where, 'Terminal');
  assert.equal(row.lastPrompt, 'thanks, now add a test');
  assert.equal(row.cwd, path.join(projects, 'app'));

  const cookie = await pairPhone('Chats');
  const t = await req('GET', `/api/laptop-chats/${chatId}`, { phone: true, cookie });
  assert.equal(t.status, 200, t.text);
  assert.ok(t.json.events.some((e) => e.text === 'Fixed: the token was not saved.'));
  assert.ok(t.json.info.suggestedAccount);
  assert.equal(t.json.info.model, 'opus');
  assert.equal(t.json.events.length, t.json.total, 'a short chat comes whole');
  assert.equal(t.json.events[0].text, 'fix the login bug');
  assert.equal((await req('GET', '/api/laptop-chats/not-an-id', { phone: true, cookie })).status, 400);
  assert.equal((await req('GET', '/api/laptop-chats/99999999-2222-4333-8444-555555555555', { phone: true, cookie })).status, 404);

  const c = await req('POST', `/api/laptop-chats/${chatId}/continue`, { phone: true, cookie, body: { accountId: 'profiles/College' } });
  assert.equal(c.status, 200, c.text);
  let sid = c.json.session.id;
  assert.equal(c.json.session.sdkSessionId, chatId);
  assert.equal(app.sessions.get(sid).cwd, path.join(projects, 'app'), 'runs in the exact folder the laptop chat used');
  assert.equal(c.json.session.rel, 'app');
  assert.equal(c.json.session.profileId, 'profiles/College');
  assert.equal(c.json.session.permissionMode, 'acceptEdits', 'keeps the mode the laptop chat had');
  const full = (await req('GET', `/api/sessions/${sid}`, { phone: true, cookie })).json;
  assert.ok(full.events.some((e) => e.t === 'user' && e.text === 'fix the login bug'), 'the whole chat is visible on the phone');
  // continuing again (paused) re-reads the laptop file into a fresh phone copy; never two copies of one chat
  const oldSid = sid;
  sid = (await req('POST', `/api/laptop-chats/${chatId}/continue`, { phone: true, cookie, body: { accountId: 'profiles/College' } })).json.session.id;
  assert.equal((await req('GET', `/api/sessions/${oldSid}`)).status, 404);
  assert.equal(app.sessions.list().filter((s) => s.sdkSessionId === chatId).length, 1);
  app.laptopChats.listCache = null;
  assert.equal((await req('GET', '/api/laptop-chats')).json.sessions.find((s) => s.id === chatId).phoneSession.id, sid);

  // pick the other account before the first message
  const sw = await req('POST', `/api/sessions/${sid}/account`, { phone: true, cookie, body: { profileId: 'main' } });
  assert.equal(sw.status, 200, sw.text);
  assert.equal(sw.json.profileId, 'main');

  seenOpts.length = 0;
  const send = await req('POST', `/api/sessions/${sid}/send`, { phone: true, cookie, body: { text: 'go on' } });
  assert.equal(send.status, 200, send.text);
  await waitLong(async () => (await req('GET', `/api/sessions/${sid}`)).json.events.some((e) => e.t === 'text' && e.text === 'echo: go on'));
  assert.equal(seenOpts[0].resume, chatId, 'Claude resumes the laptop conversation, not a new one');
  assert.equal(seenOpts[0].cwd, path.join(projects, 'app'));
  assert.equal((await req('POST', `/api/sessions/${sid}/account`, { phone: true, cookie, body: { profileId: 'profiles/College' } })).status, 409, 'no account swap while it runs');
  await req('POST', `/api/sessions/${sid}/close`);
  await waitLong(async () => !app.sessions.get(sid).q);
  assert.ok(app.activity.list().some((a) => a.action === 'Continued laptop chat on phone'));
  assert.equal((await req('DELETE', `/api/sessions/${sid}`)).status, 200);
});

test('"switch to phone": phrases, the hook script end to end, and refusals', async () => {
  const { wantsPhone } = await import('../hooks/switch-to-phone.mjs');
  for (const p of ['switch to phone', 'Switch to phone.', 'please switch to mobile', 'move this chat to my phone', 'continue on phone', 'ok send it to phone!', 'handoff to phone', 'go to mobile']) assert.ok(wantsPhone(p), p);
  for (const p of ['', 'fix the phone number validation', 'add a phone field to the switch statement', 'why does my phone not switch networks when I am at college today and the wifi drops', 'phone', 'switch the theme']) assert.ok(!wantsPhone(p), p);

  const id = '22222222-2222-4333-8444-555555555555';
  const file = writeLaptopChat(id);
  pushed.length = 0;
  const { spawn } = await import('node:child_process');
  const runHook = (input, env = {}) => new Promise((resolve) => {
    const child = spawn(process.execPath, [path.resolve('hooks', 'switch-to-phone.mjs')], { env: { ...process.env, POCKETDESK_PORT: String(server.address().port), ...env }, windowsHide: true });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.on('close', () => resolve(out));
    child.stdin.end(JSON.stringify(input));
  });
  assert.equal(await runHook({ session_id: id, transcript_path: file, cwd: path.join(projects, 'app'), prompt: 'what is 2+2' }), '', 'normal prompts pass through untouched');
  const out = JSON.parse(await runHook({ session_id: id, transcript_path: file, cwd: path.join(projects, 'app'), prompt: 'switch to phone' }, { CLAUDE_CONFIG_DIR: path.join(home, '.claude-profiles', 'College') }));
  assert.equal(out.decision, 'block', 'the phrase itself is not sent to Claude');
  assert.match(out.reason, /Moved to your phone/);
  assert.match(out.reason, /staff@college\.test/, 'continues on the account that chat ran on');
  assert.match(out.reason, new RegExp(`--resume ${id}`), 'says how to come back');
  await waitLong(async () => pushed.some((n) => n.title.includes('Moved to your phone')));
  const s = app.sessions.list().find((x) => x.sdkSessionId === id);
  assert.equal(s.origin, 'hook');
  assert.equal(s.profileId, 'profiles/College');

  // refused: not a Claude history file, a phone calling it, PocketDesk down
  assert.equal((await req('POST', '/api/handoff', { body: { session_id: id, transcript_path: path.join(outside, 'secret.txt') } })).status, 400);
  assert.equal((await req('POST', '/api/handoff', { body: { session_id: 'x', transcript_path: file } })).status, 400);
  const cookie = await pairPhone('Sneaky');
  assert.equal((await req('POST', '/api/handoff', { phone: true, cookie, body: { session_id: id, transcript_path: file } })).status, 403, 'only the laptop itself can hand a chat over');
  const down = JSON.parse(await runHook({ session_id: id, transcript_path: file, prompt: 'switch to phone' }, { POCKETDESK_PORT: '1' }));
  assert.equal(down.decision, 'block');
  assert.match(down.reason, /PocketDesk is not running|Could not move/);
  await req('DELETE', `/api/sessions/${s.id}`);
});

test('hook installer: adds next to existing hooks, backs up once, removes only its own', async () => {
  const { HookInstaller } = await import('../lib/hook-install.js');
  const mainSettings = path.join(home, '.claude', 'settings.json');
  const island = { type: 'command', command: 'node "C:/x/island-hook.js" prompt' };
  const before = { theme: 'dark', hooks: { UserPromptSubmit: [{ hooks: [island] }], Stop: [{ hooks: [{ type: 'command', command: 'node stop.js' }] }] } };
  fs.writeFileSync(mainSettings, JSON.stringify(before));
  const hi = new HookInstaller(app.profiles, { nodeExe: 'C:\\Program Files\\nodejs\\node.exe' });
  assert.match(hi.command, /^"C:\/Program Files\/nodejs\/node\.exe" ".*\/hooks\/switch-to-phone\.mjs"$/);
  assert.ok(hi.status().every((a) => !a.installed));
  const r = await hi.install();
  assert.ok(r.every((x) => x.ok), JSON.stringify(r));
  await hi.install(); // twice = still one copy
  const j = JSON.parse(fs.readFileSync(mainSettings, 'utf8'));
  assert.equal(j.theme, 'dark');
  assert.deepEqual(j.hooks.Stop, before.hooks.Stop);
  const ups = j.hooks.UserPromptSubmit.flatMap((g) => g.hooks);
  assert.ok(ups.some((x) => x.command === island.command), 'Dynamic Island hook kept');
  assert.equal(ups.filter((x) => x.command.includes('switch-to-phone.mjs')).length, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(`${mainSettings}.before-pocketdesk`, 'utf8')), before, 'backup is the untouched original');
  assert.ok(fs.existsSync(path.join(home, '.claude-profiles', 'College', 'settings.json')), 'profile without settings gets one');
  assert.ok(hi.status().every((a) => a.installed));
  await hi.remove();
  const after2 = JSON.parse(fs.readFileSync(mainSettings, 'utf8'));
  assert.deepEqual(after2.hooks, before.hooks, 'removing leaves everything else as it was');
  assert.ok(hi.status().every((a) => !a.installed));
  // laptop only
  const cookie = await pairPhone('NoHooks');
  assert.equal((await req('POST', '/api/setup/hooks', { phone: true, cookie, body: {} })).status, 403);
  fs.writeFileSync(mainSettings, '{ broken');
  assert.ok(hi.status().find((a) => a.id === 'main').error);
  assert.ok(!(await hi.install()).find((x) => x.id === 'main').ok, 'never overwrites a settings file it cannot read');
  assert.equal(fs.readFileSync(mainSettings, 'utf8'), '{ broken');
  fs.rmSync(mainSettings);
});
