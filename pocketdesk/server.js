import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { loadConfig, APP_DIR } from './lib/config.js';
import { Auth } from './lib/auth.js';
import { Files } from './lib/files.js';
import { Profiles } from './lib/profiles.js';
import { Status } from './lib/status.js';
import { Push } from './lib/push.js';
import { ClaudeSessions } from './lib/claude.js';
import { Probe } from './lib/probe.js';
import { Identity } from './lib/identity.js';
import { Activity } from './lib/activity.js';
import { Lock } from './lib/lock.js';
import { Tasks } from './lib/tasks.js';
import { Share, tailscaleInfo } from './lib/share.js';
import { Git } from './lib/git.js';
import { Alerts } from './lib/alerts.js';
import { Thumbs } from './lib/media.js';
import { LaptopSessions } from './lib/laptop-sessions.js';
import { HookInstaller } from './lib/hook-install.js';
import { Travel } from './lib/travel.js';
import { WinHelper } from './lib/winhelper.js';
import { ChatWatch } from './lib/chat-watch.js';
import { Guard } from './lib/guard.js';
import { Prompts } from './lib/prompts.js';
import { Desk } from './lib/desk.js';
import { HttpError, httpErr } from './lib/util.js';
const PUBLIC = path.join(APP_DIR, 'public');
const MAX_JSON = 8 * 1024 * 1024; // photos for Claude come in as base64 JSON

const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};
// Project files that may be shown inline; everything else downloads. Never inline html/svg (same-origin script).
const INLINE_TYPES = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.avif': 'image/avif',
  '.pdf': 'application/pdf',
  // phones play H.264 .mov/.m4v as mp4; .mkv often plays as webm. If not, the viewer offers a download.
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/mp4', '.webm': 'video/webm', '.mkv': 'video/webm', '.3gp': 'video/3gpp',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
};

const APP_CSP = "default-src 'self'; img-src 'self' data: blob:; media-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; script-src 'self'; connect-src 'self'; worker-src 'self'; manifest-src 'self'; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

export function createApp(cfg, deps = {}) {
  const auth = deps.auth || new Auth(cfg);
  const files = deps.files || new Files(cfg);
  const profiles = deps.profiles || new Profiles(cfg);
  const status = deps.status || new Status(cfg);
  const push = deps.push || new Push(cfg);
  const probe = deps.probe || new Probe(profiles, { queryFn: deps.queryFn });
  const identity = deps.identity || new Identity({ fetchFn: deps.fetchFn, refreshFn: (p) => probe.run(p.id) });
  profiles.identity = identity;
  const sessions = deps.sessions || new ClaudeSessions(cfg, { files, profiles, push, identity, queryFn: deps.queryFn, onRateLimit: (id, info) => probe.recordLive(id, info) });

  const activity = deps.activity || new Activity(cfg);
  const lock = deps.lock || new Lock(cfg);
  auth.extraAllowed = () => lock.state.tailscaleUsers;
  const tasks = deps.tasks || new Tasks(cfg, { files, push, activity, spawnFn: deps.spawnFn, killFn: deps.killFn });
  const share = deps.share || new Share(cfg, { runFn: deps.tailscaleRun });
  const git = deps.git || new Git(cfg, { files, activity, runFn: deps.gitRun });
  const alerts = deps.alerts || new Alerts(cfg, { status, push, activity, fetchFn: deps.fetchFn });
  const thumbs = deps.thumbs || new Thumbs(cfg, { files, ffmpeg: deps.ffmpeg });
  const laptopChats = deps.laptopChats || new LaptopSessions(cfg, { profiles, sessions, files, push, activity });
  const hooks = deps.hooks || new HookInstaller(profiles);
  const win = deps.win || new WinHelper();
  const travel = deps.travel || new Travel(cfg, { win, status, push, activity, sessions, tasks, laptopChats });
  const watch = deps.watch || new ChatWatch({ laptopChats, sessions, push, activity, settings: () => alerts.get() });
  const guard = deps.guard || new Guard({ auth, push, activity, sessions, tasks, share, lock, settings: () => alerts.get(), whoisFn: deps.whoisFn, lockScreenFn: deps.lockScreenFn });
  const prompts = deps.prompts || new Prompts(cfg);
  const desk = deps.desk || new Desk(cfg, { win, lock, files, status, activity, runFn: deps.deskRun });
  sessions.noteFor = () => travel.claudeNote();
  tasks.onExit = (t) => {
    if (!t.port) return;
    share.list().then((l) => l.some((x) => x.port === t.port) && share.unshare(t.port)).catch(() => {});
  };

  const routes = [];
  /**
   * access: 'user' (laptop or paired device), 'laptop' (only the laptop itself), 'public'.
   * lockFree: still works while the phone's PIN lock is on. auto: background call, does not count as activity.
   * act: (ctx, result) => [action, detail] written to the activity log after success.
   */
  const route = (method, pattern, handler, { access = 'user', raw = false, lockFree = false, auto = false, act = null } = {}) => {
    const keys = [];
    const re = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)'))}$`);
    routes.push({ method, re, keys, handler, access, raw, lockFree, auto, act });
  };
  const where = (url) => {
    const r = cfg.roots[Number(url.searchParams.get('root'))];
    return `${r ? r.name : '?'}${url.searchParams.get('path') ? ` / ${url.searchParams.get('path')}` : ''}`;
  };
  const titleOf = (id) => {
    try {
      return sessions.get(id).title;
    } catch {
      return id;
    }
  };
  const locked = (who) => who?.kind === 'device' && lock.isLocked(who.device.id);

  // ---------- identity / pairing ----------
  route('GET', '/api/me', async ({ who }) => {
    const device = who.device ? { id: who.device.id, name: who.device.name } : null;
    if (locked(who)) return { kind: who.kind, device, locked: true, lock: { lockMinutes: lock.state.lockMinutes } };
    await profiles.refreshIdentities().catch(() => {});
    const acc = profiles.chosen();
    return {
      kind: who.kind,
      device,
      locked: false,
      lock: lock.settings(),
      account: acc ? { name: acc.name, email: acc.email, signedIn: acc.signedIn } : null,
      roots: files.roots(),
      options: sessions.options(),
      pushKey: push.publicKey(),
      travel: travel.summary(),
    };
  }, { lockFree: true });

  route('POST', '/api/pair', async ({ req, res, body }) => {
    const { device, token } = await auth.pair(body.code, body.name, req.headers['user-agent'], req.headers['tailscale-user-login']);
    res.setHeader('Set-Cookie', auth.cookieFor(token, req));
    activity.log(device.name, 'Paired device', req.headers['tailscale-user-login'] || '');
    guard.paired(device, req).catch(() => {});
    return { ok: true, device };
  }, { access: 'public' });

  route('POST', '/api/logout', async ({ who, res }) => {
    if (who.kind === 'device') {
      await auth.removeDevice(who.device.id);
      await push.removeDevice(who.device.id);
      activity.log(who, 'Unpaired itself');
    }
    res.setHeader('Set-Cookie', auth.clearCookie());
    return { ok: true };
  }, { lockFree: true });

  // ---------- laptop-only setup ----------
  route('GET', '/api/setup', async () => (await profiles.refreshIdentities(), {
    profiles: profiles.listForLaptop(),
    chosen: profiles.chosen() && { id: profiles.chosen().id, email: profiles.chosen().email },
    pairing: auth.pairingStatus(),
    devices: auth.listDevices(),
    tailscale: await tailscaleInfo(cfg.port),
  }), { access: 'laptop' });

  route('POST', '/api/setup/account', async ({ body }) => {
    if (sessions.liveCount() > 0) throw httpErr(409, 'Stop running sessions before switching account');
    const p = await profiles.choose(body.id);
    return { ok: true, chosen: { id: p.id, email: p.email } };
  }, { access: 'laptop', act: (_c, out) => ['Default account changed', out.chosen.email] });

  route('POST', '/api/setup/pairing', () => auth.newPairingCode(), { access: 'laptop' });

  route('DELETE', '/api/devices/:id', async ({ params }) => {
    const d = auth.listDevices().find((x) => x.id === params.id);
    await auth.removeDevice(params.id);
    await push.removeDevice(params.id);
    return { ok: true, name: d?.name };
  }, { access: 'laptop', act: (_c, out) => ['Removed device', out.name || ''] });

  // ---------- files ----------
  route('GET', '/api/files/list', ({ url }) => files.list(url.searchParams.get('root'), url.searchParams.get('path')));
  route('GET', '/api/files/text', ({ url }) => files.readText(url.searchParams.get('root'), url.searchParams.get('path')));
  route('PUT', '/api/files/text', ({ url, body }) => files.writeText(url.searchParams.get('root'), url.searchParams.get('path'), { text: body.text, baseMtime: body.baseMtime }),
    { act: ({ url }) => ['Saved file', where(url)] });
  route('POST', '/api/files/new', ({ url, body }) => files.writeText(url.searchParams.get('root'), url.searchParams.get('path'), { text: body.text || '', create: true }),
    { act: ({ url }) => ['Created file', where(url)] });
  route('POST', '/api/files/mkdir', ({ url }) => files.mkdir(url.searchParams.get('root'), url.searchParams.get('path')),
    { act: ({ url }) => ['Created folder', where(url)] });
  route('POST', '/api/files/upload', ({ url, req }) =>
    files.upload(url.searchParams.get('root'), url.searchParams.get('path'), url.searchParams.get('name'), req, { overwrite: url.searchParams.get('overwrite') === '1' }),
  { raw: true, act: ({ url }) => ['Uploaded file', `${where(url)} / ${url.searchParams.get('name')}`] });
  route('GET', '/api/files/raw', async ({ url, req, res, who }) => {
    const root = url.searchParams.get('root');
    const rel = url.searchParams.get('path');
    const info = await files.statFile(root, rel);
    const ext = path.extname(info.name).toLowerCase();
    const inline = url.searchParams.get('dl') !== '1' && INLINE_TYPES[ext];
    const headers = {
      'Content-Type': inline || 'application/octet-stream',
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(info.name)}`,
      'Content-Security-Policy': "sandbox; default-src 'none'; img-src 'self'; media-src 'self'",
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, max-age=300',
    };
    // Byte ranges let the phone's video player seek without downloading the whole file.
    const range = parseRange(req.headers.range, info.size);
    if (range === 'bad') {
      res.writeHead(416, { 'Content-Range': `bytes */${info.size}` });
      res.end();
      return STREAMED;
    }
    const f = await files.openRead(root, rel, range);
    if (range) {
      res.writeHead(206, { ...headers, 'Content-Length': range.end - range.start + 1, 'Content-Range': `bytes ${range.start}-${range.end}/${info.size}` });
    } else {
      res.writeHead(200, { ...headers, 'Content-Length': info.size });
    }
    f.stream.pipe(res);
    res.on('close', () => f.stream.destroy());
    if (!inline) activity.log(who, 'Downloaded file', where(url));
    return STREAMED;
  });
  route('GET', '/api/files/thumb', async ({ url, res }) => {
    const file = await thumbs.get(url.searchParams.get('root'), url.searchParams.get('path'), url.searchParams.get('w'));
    const data = await fsp.readFile(file);
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': data.length, 'Cache-Control': 'private, max-age=86400' });
    res.end(data);
    return STREAMED;
  }, { auto: true });
  route('GET', '/api/media/places', () => ({ places: mediaPlaces(files), thumbs: thumbs.available() }));

  // ---------- Claude accounts, models, usage ----------
  route('GET', '/api/accounts', async () => {
    await profiles.refreshIdentities();
    return { accounts: profiles.listPublic() };
  });
  route('GET', '/api/accounts/:id/models', async ({ params }) => {
    const r = await probe.models(params.id);
    return { models: r.models || [], account: r.account, error: r.error };
  });
  route('GET', '/api/usage', async ({ url }) => {
    const fresh = url.searchParams.get('fresh') === '1';
    await profiles.refreshIdentities();
    const list = profiles.listPublic().filter((p) => p.signedIn);
    const results = await Promise.allSettled(list.map((p) => probe.usage(p.id, { fresh })));
    return {
      accounts: list.map((p, i) => {
        const r = results[i];
        if (r.status === 'rejected') return { ...p, error: r.reason?.message || 'failed' };
        return { ...p, plan: r.value.account?.plan || r.value.usage?.plan || null, usage: r.value.usage, live: probe.liveFor(p.id), error: r.value.error, at: r.value.usageAt };
      }),
      notSignedIn: profiles.listPublic().filter((p) => !p.signedIn).map((p) => p.name),
    };
  });

  // ---------- laptop status / power ----------
  route('GET', '/api/status', () => status.get());
  route('GET', '/api/power', () => desk.powerState());
  route('POST', '/api/power', ({ body, who }) => (['restart', 'shutdown', 'cancel'].includes(body.action) ? desk.power(who, body.action, body.pin) : status.power(body.action)),
    { act: ({ body }) => (['lock', 'sleep'].includes(body.action) ? ['Power', body.action] : null) });

  // ---------- laptop control: screen peek, clipboard, send to laptop, find my laptop ----------
  route('GET', '/api/screen/state', ({ who }) => desk.peekState(who));
  route('POST', '/api/screen/start', ({ who, body }) => desk.startPeek(who, body.pin));
  route('GET', '/api/screen', async ({ who, url, res }) => {
    const jpg = await desk.screenshot(who, url.searchParams.get('w'));
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': jpg.length, 'Cache-Control': 'no-store' });
    res.end(jpg);
    return STREAMED;
  }, { auto: true });
  route('GET', '/api/clipboard', ({ who }) => desk.clipboard(who));
  route('PUT', '/api/clipboard', ({ who, body }) => desk.setClipboard(who, body.text));
  route('GET', '/api/inbox', () => desk.inbox());
  route('POST', '/api/send/open', ({ who, body }) => desk.openUrl(who, body.url));
  route('POST', '/api/send/note', ({ who, body }) => desk.saveNote(who, body));
  route('GET', '/api/find/where', () => desk.where());
  route('POST', '/api/find/start', ({ who }) => desk.findStart(who));
  route('POST', '/api/find/stop', ({ who }) => desk.findStop(who));

  // ---------- saved prompt buttons ----------
  route('GET', '/api/prompts', () => ({ prompts: prompts.list() }));
  route('PUT', '/api/prompts', ({ body }) => prompts.save(body.prompts), { act: ({ body }) => ['Saved prompt buttons', `${(body.prompts || []).length}`] });

  // ---------- Claude sessions ----------
  route('GET', '/api/sessions', () => ({ sessions: sessions.list(), live: sessions.liveCount(), max: cfg.maxLiveSessions }));
  route('POST', '/api/sessions', ({ body }) => sessions.create(body), { act: (_c, s) => ['Started Claude', `${s.title} (${s.account || s.profileId})`] });
  route('GET', '/api/sessions/:id', async ({ params, url }) => ({
    session: sessions.summary(sessions.get(params.id)),
    events: await sessions.events(params.id, Number(url.searchParams.get('after') || 0)),
  }));
  route('GET', '/api/sessions/:id/stream', async ({ params, url, req, res, who }) => {
    const s = sessions.get(params.id);
    const after = Number(url.searchParams.get('after') || req.headers['last-event-id'] || 0);
    const backlog = await sessions.events(params.id, after);
    openSse(res);
    let last = after;
    const send = (ev) => {
      if (locked(who)) return res.end();
      if (ev.seq <= last) return;
      last = ev.seq;
      res.write(`id: ${ev.seq}\nevent: ev\ndata: ${JSON.stringify(ev)}\n\n`);
    };
    const off = sessions.subscribe(params.id, send);
    backlog.forEach(send);
    res.write(`event: summary\ndata: ${JSON.stringify(sessions.summary(s))}\n\n`);
    keepAlive(req, res, off);
    return STREAMED;
  }, { auto: true });
  route('POST', '/api/sessions/:id/send', ({ params, body }) => sessions.send(params.id, body.text, body.images), { act: ({ params, body }) => [body.images?.length ? `Message + ${body.images.length} photo(s) to Claude` : 'Message to Claude', titleOf(params.id)] });
  route('GET', '/api/sessions/:id/image/:name', async ({ params, res }) => {
    const file = sessions.imagePath(params.id, params.name);
    let data;
    try {
      data = await fsp.readFile(file);
    } catch {
      throw httpErr(404, 'No such photo');
    }
    const ext = path.extname(file).slice(1);
    res.writeHead(200, { 'Content-Type': `image/${ext === 'jpg' ? 'jpeg' : ext}`, 'Content-Length': data.length, 'Cache-Control': 'private, max-age=86400', 'Content-Security-Policy': "sandbox; default-src 'none'" });
    res.end(data);
    return STREAMED;
  }, { auto: true });
  route('POST', '/api/sessions/:id/decide', ({ params, body }) => sessions.decide(params.id, body.pid, body), { act: ({ params, body }) => [`Claude prompt: ${body.decision}`, titleOf(params.id)] });
  route('POST', '/api/sessions/:id/interrupt', ({ params }) => sessions.interrupt(params.id), { act: ({ params }) => ['Stopped Claude', titleOf(params.id)] });
  route('POST', '/api/sessions/:id/close', ({ params }) => sessions.close(params.id), { act: ({ params }) => ['Closed Claude session', titleOf(params.id)] });
  route('POST', '/api/sessions/:id/mode', ({ params, body }) => sessions.setMode(params.id, body.mode), { act: ({ params, body }) => [`Permission mode: ${body.mode}`, titleOf(params.id)] });
  route('DELETE', '/api/sessions/:id', async ({ params }) => {
    const title = titleOf(params.id);
    await sessions.remove(params.id);
    return { ok: true, title };
  }, { act: (_c, out) => ['Deleted session', out.title] });

  route('GET', '/api/events', ({ req, res, who }) => {
    openSse(res);
    const off = sessions.onHub((msg) => (locked(who) ? res.end() : res.write(`event: hub\ndata: ${JSON.stringify(msg)}\n\n`)));
    keepAlive(req, res, off);
    return STREAMED;
  }, { auto: true });

  // ---------- commands (npm scripts, quick commands, dev servers) ----------
  const rootPath = (url) => [url.searchParams.get('root'), url.searchParams.get('path') || ''];
  route('GET', '/api/tasks/options', ({ url }) => tasks.options(...rootPath(url)));
  route('GET', '/api/tasks', () => ({ tasks: tasks.list() }), { auto: true });
  route('POST', '/api/tasks', ({ url, body, who }) => {
    // Travel mode: heavy commands (build, test, install, dev server…) wait until the trip ends, unless forced
    const quick = body.kind === 'quick' ? tasks.quickList()[Number(body.id)]?.cmd : null;
    if (travel.holds(body, quick)) {
      if (body.later) return travel.queueTask(...rootPath(url), body, who);
      throw httpErr(409, 'Travel mode is on: this command would heat the laptop.', { travelHeld: true });
    }
    return tasks.start(...rootPath(url), body, who);
  });
  route('GET', '/api/tasks/:id/log', ({ params, url }) => tasks.log(params.id, Number(url.searchParams.get('after') || 0)), { auto: true });
  route('POST', '/api/tasks/:id/stop', ({ params, who }) => tasks.stop(params.id, who));
  route('POST', '/api/tasks/:id/input', ({ params, body }) => tasks.input(params.id, body.text), { act: ({ params }) => ['Typed into command', tasks.get(params.id).label] });
  route('DELETE', '/api/tasks/:id', ({ params }) => (tasks.remove(params.id), { ok: true }));

  // ---------- open a dev server on the phone (tailscale serve, tailnet only) ----------
  route('GET', '/api/share', async () => ({ shares: await share.list() }));
  route('POST', '/api/share', ({ body }) => share.share(body.port), { act: (_c, out) => ['Shared dev server', `port ${out.port} -> ${out.url}`] });
  route('POST', '/api/share/off', ({ body }) => share.unshare(body.port), { act: ({ body }) => ['Stopped sharing', `port ${body.port}`] });

  // ---------- git ----------
  route('GET', '/api/git/status', ({ url }) => git.status(...rootPath(url)));
  route('GET', '/api/git/diff', ({ url }) => git.diff(...rootPath(url), url.searchParams.get('file'), { staged: url.searchParams.get('staged') === '1' }));
  route('GET', '/api/git/log', ({ url }) => git.log(...rootPath(url)));
  route('POST', '/api/git/stage', ({ url, body, who }) => git.stage(...rootPath(url), body.files, who));
  route('POST', '/api/git/unstage', ({ url, body, who }) => git.unstage(...rootPath(url), body.files, who));
  route('POST', '/api/git/commit', ({ url, body, who }) => git.commit(...rootPath(url), body, who));
  route('POST', '/api/git/pull', ({ url, who }) => git.pull(...rootPath(url), who));
  route('POST', '/api/git/push', ({ url, body, who }) => git.push(...rootPath(url), body, who));

  // ---------- chats from the laptop (desktop app / terminal, any account) ----------
  route('GET', '/api/laptop-chats', ({ url }) => laptopChats.list({ limit: Math.min(200, Number(url.searchParams.get('limit') || 40)) }));
  route('GET', '/api/laptop-chats/:id', ({ params, url }) => laptopChats.transcript(params.id, { limit: url.searchParams.get('limit') }));
  route('POST', '/api/laptop-chats/:id/continue', ({ params, body, who }) => laptopChats.continueOnPhone({ id: params.id, accountId: body.accountId, model: body.model, effort: body.effort, permissionMode: body.permissionMode }, who));
  route('POST', '/api/sessions/:id/account', ({ params, body, who }) => laptopChats.switchAccount(params.id, body.profileId, who));
  // the "switch to phone" hook calls this from inside a Claude Code session on the laptop
  route('POST', '/api/handoff', ({ body }) => laptopChats.handoff(body), { access: 'laptop' });
  route('GET', '/api/setup/hooks', () => ({ accounts: hooks.status(), command: hooks.command }), { access: 'laptop' });
  route('POST', '/api/setup/hooks', async ({ body }) => ({ results: body.remove ? await hooks.remove() : await hooks.install(), accounts: hooks.status() }),
    { access: 'laptop', act: ({ body }) => [body.remove ? 'Removed "switch to phone" hook' : 'Installed "switch to phone" hook', 'all Claude accounts'] });

  // ---------- travel mode ----------
  route('GET', '/api/travel', () => travel.state(), { auto: true });
  route('GET', '/api/travel/preview', () => travel.preview());
  route('POST', '/api/travel/start', ({ body, who }) => travel.start(body, who));
  route('POST', '/api/travel/end', ({ who }) => travel.end('manual', who));
  route('POST', '/api/travel/extend', ({ body }) => travel.extend(body.minutes ?? 15), { act: ({ body }) => ['Travel mode: more time', `+${body.minutes ?? 15} min`] });
  route('POST', '/api/travel/level', ({ body }) => travel.setLevel(body.level), { act: ({ body }) => ['Travel mode: CPU level', body.level] });
  route('POST', '/api/travel/stay-awake', () => travel.stayAwake(), { act: () => ['Travel mode: stay awake'] });
  route('POST', '/api/travel/sleep', () => travel.sleepNow());
  route('DELETE', '/api/travel/queue/:i', ({ params }) => travel.dropQueued(params.i));

  // ---------- alerts, activity ----------
  route('GET', '/api/alerts', () => alerts.get());
  route('PUT', '/api/alerts', ({ body }) => alerts.set(body), { act: () => ['Changed alert settings'] });
  route('GET', '/api/activity', ({ url }) => ({ items: activity.list(Math.min(500, Number(url.searchParams.get('limit') || 200))) }));

  // ---------- PIN lock + Tailscale login check ----------
  route('POST', '/api/lock/unlock', async ({ who, body }) => {
    if (who.kind !== 'device') return { ok: true };
    try {
      await lock.unlock(who.device.id, body.pin, async () => {
        await auth.removeDevice(who.device.id).catch(() => {});
        await push.removeDevice(who.device.id).catch(() => {});
        activity.log(who, 'Unpaired after 10 wrong PINs');
        push.notify({ title: 'PocketDesk: device unpaired', body: `${who.device.name} typed a wrong PIN 10 times and was removed.`, url: '/', tag: 'pin' }).catch(() => {});
      });
    } catch (e) {
      if (e.status === 401) activity.log(who, 'Wrong PIN');
      throw e;
    }
    activity.log(who, 'Unlocked');
    return { ok: true };
  }, { lockFree: true });
  route('POST', '/api/lock/now', ({ who }) => {
    if (who.kind === 'device') lock.lockNow(who.device.id);
    return { ok: true };
  }, { lockFree: true });
  route('GET', '/api/security', ({ req }) => ({ ...lock.settings(), myLogin: req.headers['tailscale-user-login'] || null, configUsers: cfg.allowedTailscaleUsers || [] }));
  route('POST', '/api/security/pin', async ({ who, body }) => {
    if (who.kind === 'device' && lock.enabled() && body.pin != null && !lock.checkPin(body.currentPin)) throw httpErr(401, 'Current PIN is wrong');
    const out = await lock.setPin(body.pin ?? null, body.lockMinutes ?? null);
    if (who.kind === 'device' && body.pin != null) await lock.unlock(who.device.id, body.pin);
    return out;
  }, { act: ({ body }) => [body.pin != null ? 'PIN set' : 'Lock time changed', body.lockMinutes ? `${body.lockMinutes} min` : ''] });
  route('POST', '/api/security/pin/clear', async ({ who, body }) => {
    if (who.kind === 'device' && !lock.checkPin(body.currentPin)) throw httpErr(401, 'Current PIN is wrong');
    return lock.clearPin();
  }, { act: () => ['PIN removed'] });
  route('POST', '/api/security/tailscale', async ({ body }) => {
    if (!body.only) return lock.setTailscaleUsers([]);
    const ts = await tailscaleInfo(cfg.port);
    if (!ts.loginName) throw httpErr(409, 'Tailscale is not signed in on the laptop');
    return lock.setTailscaleUsers([ts.loginName]);
  }, { access: 'laptop', act: ({ body }) => [body.only ? 'Only my Tailscale login allowed' : 'Any tailnet device allowed'] });
  route('POST', '/api/security/lock-all', () => (lock.lockAll(), { ok: true }), { access: 'laptop', act: () => ['Locked all devices'] });
  route('POST', '/api/security/notify-actions', async ({ who, body }) => {
    if (body.on && who.kind === 'device' && lock.enabled() && !lock.checkPin(body.currentPin)) throw httpErr(401, 'Current PIN is wrong');
    return lock.setActionsWhileLocked(body.on);
  }, { act: ({ body }) => [body.on ? 'Notification buttons work while locked' : 'Notification buttons need unlock'] });
  // the panic button works even while this phone is PIN-locked: it only ever takes access away
  route('POST', '/api/panic', ({ who }) => guard.panic(who), { lockFree: true });

  // ---------- push ----------
  route('POST', '/api/push/subscribe', async ({ who, body }) => {
    await push.subscribe(who.kind === 'device' ? who.device.id : 'laptop', body.subscription);
    return { ok: true };
  });
  // Allow / Deny pressed on a notification (sent by the service worker, with that prompt's one-time token)
  route('POST', '/api/push/decide', ({ who, body }) => {
    if (locked(who) && !lock.state.actionsWhileLocked) throw httpErr(423, 'Locked. Type your PIN.', { locked: true });
    return sessions.decideByToken(body.sid, body.pid, body.token, body.decision);
  }, { lockFree: true, auto: true, act: ({ body }) => [`Claude prompt: ${body.decision} (from notification)`, titleOf(body.sid)] });
  route('POST', '/api/push/test', async () => {
    await push.notify({ title: 'PocketDesk', body: 'Notifications work.', url: '/', tag: 'test' });
    return { ok: true };
  });

  // ---------- request handling ----------
  async function handle(req, res) {
    setCommonHeaders(res);
    const url = new URL(req.url, 'http://local');
    try {
      if (req.method === 'POST' && url.pathname === '/share-target') {
        // the service worker normally answers this; if it was not running yet, just open the Send screen
        res.writeHead(303, { Location: '/#/send' });
        res.end();
        return;
      }
      if (!url.pathname.startsWith('/api/')) return await serveStatic(url.pathname, res);
      const match = findRoute(req.method, url.pathname);
      if (!match) throw httpErr(404, 'Unknown API');
      const { r, params } = match;
      if (!auth.isLocal(req)) guard.observe(req, auth.identify(req), url.pathname).catch(() => {});
      auth.checkCsrf(req);
      let who = null;
      if (r.access === 'laptop') who = auth.requireLaptop(req);
      else if (r.access === 'user') who = auth.require(req);
      if (who?.kind === 'device') {
        if (!r.lockFree && lock.isLocked(who.device.id)) throw httpErr(423, 'Locked. Type your PIN.', { locked: true });
        if (!r.auto && req.headers['x-pd-auto'] !== '1') lock.touch(who.device.id);
      }
      res.setHeader('Cache-Control', 'no-store');
      const body = !r.raw && req.method !== 'GET' ? await readJsonBody(req) : {};
      const ctx = { req, res, url, params, body, who };
      const out = await r.handler(ctx);
      if (r.act) {
        try {
          const entry = r.act(ctx, out);
          if (entry) activity.log(who || 'Unknown', entry[0], entry[1]);
        } catch {
          /* never fail a request over the log */
        }
      }
      if (out === STREAMED) return;
      sendJson(res, 200, out ?? { ok: true });
    } catch (e) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (e instanceof HttpError) sendJson(res, e.status, { error: e.message, ...(e.extra || {}) });
      else if (e.code === 'EEXIST') sendJson(res, 409, { error: 'Already exists' });
      else if (e.code === 'EPERM' || e.code === 'EACCES' || e.code === 'EBUSY') sendJson(res, 423, { error: 'Windows would not allow that (file in use or no permission)' });
      else {
        console.error('[server]', req.method, url.pathname, e);
        sendJson(res, 500, { error: 'Something went wrong on the laptop' });
      }
    }
  }

  function findRoute(method, pathname) {
    for (const r of routes) {
      if (r.method !== method) continue;
      const m = r.re.exec(pathname);
      if (m) return { r, params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) };
    }
    return null;
  }

  return { handle, auth, files, profiles, status, push, sessions, probe, identity, activity, lock, tasks, share, git, alerts, thumbs, laptopChats, hooks, travel, watch, guard, prompts, desk };
}

const STREAMED = Symbol('streamed');

/** "bytes=start-end" -> { start, end }; null = whole file; 'bad' = cannot satisfy. */
export function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!m || (m[1] === '' && m[2] === '')) return 'bad';
  let start;
  let end;
  if (m[1] === '') {
    start = Math.max(0, size - Number(m[2]));
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start > end || start >= size) return 'bad';
  return { start, end };
}

/** Usual photo/video folders on this laptop that exist, as shortcuts. */
function mediaPlaces(files) {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  const cands = [
    ['Pictures', 'Pictures'], ['Screenshots', 'Pictures/Screenshots'], ['Camera Roll', 'Pictures/Camera Roll'], ['Videos', 'Videos'],
    ['Captures', 'Videos/Captures'], ['Downloads', 'Downloads'], ['Desktop', 'Desktop'],
    ['OneDrive Pictures', 'OneDrive/Pictures'], ['OneDrive Desktop', 'OneDrive/Desktop'],
  ];
  const out = [];
  for (const [name, sub] of cands) {
    const abs = path.join(home, ...sub.split('/'));
    try {
      if (!fs.statSync(abs).isDirectory()) continue;
      out.push({ name, ...files.locate(abs) });
    } catch {
      /* missing or not shared */
    }
  }
  return out;
}

function setCommonHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
}

function sendJson(res, status, obj) {
  const text = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_JSON) throw httpErr(413, 'Request too large');
    chunks.push(c);
  }
  if (!size) return {};
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return v && typeof v === 'object' ? v : {};
  } catch {
    throw httpErr(400, 'Bad JSON');
  }
}

function openSse(res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('retry: 3000\n\n');
}

function keepAlive(req, res, off) {
  const t = setInterval(() => res.write(': ping\n\n'), 20_000);
  req.on('close', () => {
    clearInterval(t);
    off();
  });
}

async function serveStatic(pathname, res) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep)) throw httpErr(404, 'Not found');
  let data;
  try {
    data = await fsp.readFile(file);
  } catch {
    throw httpErr(404, 'Not found');
  }
  const ext = path.extname(file).toLowerCase();
  const headers = { 'Content-Type': STATIC_TYPES[ext] || 'application/octet-stream', 'Content-Length': data.length, 'Content-Security-Policy': APP_CSP };
  headers['Cache-Control'] = ext === '.png' ? 'max-age=86400' : 'no-cache';
  if (rel === '/sw.js') headers['Service-Worker-Allowed'] = '/';
  res.writeHead(200, headers);
  res.end(data);
}

// ---------- main ----------
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.join(APP_DIR, 'server.js');
if (isMain) {
  const cfg = loadConfig();
  const app = createApp(cfg);
  const server = http.createServer((req, res) => app.handle(req, res));
  server.requestTimeout = 0; // uploads and event streams can be long
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') console.error(`Port ${cfg.port} is busy. Is PocketDesk already running?`);
    else console.error(e);
    process.exit(1);
  });
  server.listen(cfg.port, cfg.host, () => {
    console.log(`PocketDesk on http://${cfg.host}:${cfg.port}  (roots: ${cfg.roots.map((r) => r.name).join(', ') || 'none'})`);
    app.profiles.refreshIdentities().catch(() => {}).finally(() => {
      const acc = app.profiles.chosen();
      console.log(acc ? `Claude account: ${acc.email}${acc.verified ? ' (checked with Anthropic)' : ' (not checked yet)'}` : 'Claude account: NOT PICKED YET - open the page on the laptop and go to Setup.');
    });
    app.alerts.start();
    app.watch.start();
    app.travel.resumeAfterRestart().catch((e) => console.error('[travel] resume', e.message));
  });
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await app.sessions.shutdown().catch(() => {});
    await app.tasks.shutdown().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
