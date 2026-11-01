import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { httpErr, randomToken, readJson, safeEqual, truncate, uuid, writeJsonAtomic } from './util.js';

const MODES = ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const MODEL_RE = /^[\w.\-[\]]{1,80}$/;
const MAX_EVENTS_IN_MEMORY = 4000;
const LIVE = new Set(['starting', 'working', 'waiting', 'idle']);
const IMAGE_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // the Claude API limit per image
const IMAGE_NAME_RE = /^\d+-\d\.(jpg|png|webp|gif)$/;

/** Async iterable that we push user messages into; Claude reads from it for the whole session. */
class InputQueue {
  constructor() {
    this.items = [];
    this.waiters = [];
    this.closed = false;
  }
  push(v) {
    if (this.closed) throw new Error('input closed');
    const w = this.waiters.shift();
    if (w) w({ value: v, done: false });
    else this.items.push(v);
  }
  end() {
    this.closed = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined, done: true });
  }
  [Symbol.asyncIterator]() {
    return {
      next: () => {
        if (this.items.length) return Promise.resolve({ value: this.items.shift(), done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((r) => this.waiters.push(r));
      },
      return: () => {
        this.end();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}

/**
 * Runs Claude Code sessions through the Agent SDK on the chosen account, keeps a replayable event log
 * per session, and routes permission prompts / questions / plans to the phone.
 */
export class ClaudeSessions {
  constructor(cfg, { files, profiles, push, identity = null, queryFn = sdkQuery, onRateLimit = null }) {
    this.identity = identity;
    this.onRateLimit = onRateLimit;
    this.cfg = cfg;
    this.files = files;
    this.profiles = profiles;
    this.push = push;
    this.queryFn = queryFn;
    this.dir = path.join(cfg.dataDir, 'sessions');
    fs.mkdirSync(this.dir, { recursive: true });
    this.sessions = new Map();
    this.hubListeners = new Set();
    this.loadAll();
  }

  // ---------- persistence ----------

  loadAll() {
    for (const f of fs.readdirSync(this.dir)) {
      if (!f.endsWith('.json')) continue;
      const meta = readJson(path.join(this.dir, f), null);
      if (!meta?.id) continue;
      if (LIVE.has(meta.state)) meta.state = 'closed'; // the server restarted; the process is gone
      this.sessions.set(meta.id, this.hydrate(meta));
    }
  }

  hydrate(meta) {
    return Object.assign(meta, {
      events: null, // loaded on first open
      seq: meta.seq || 0,
      listeners: new Set(),
      pending: new Map(),
      allowAlways: new Set(),
      q: null,
      input: null,
      abort: null,
      idleTimer: null,
      writeChain: Promise.resolve(),
      saveTimer: null,
    });
  }

  metaOf(s) {
    const { id, title, rootId, rel, cwd, model, effort, profileId, permissionMode, sdkSessionId, createdAt, updatedAt, state, account, expectedEmail, preview, seq, lastError, turns, origin } = s;
    return { id, title, rootId, rel, cwd, model, effort, profileId, permissionMode, sdkSessionId, createdAt, updatedAt, state, account, expectedEmail, preview, seq, lastError, turns, origin };
  }

  summary(s) {
    const m = this.metaOf(s);
    delete m.cwd;
    return { ...m, pendingCount: s.pending.size, resumable: !!s.sdkSessionId, rootName: this.cfg.roots[s.rootId]?.name || '?' };
  }

  scheduleSave(s) {
    clearTimeout(s.saveTimer);
    s.saveTimer = setTimeout(() => {
      writeJsonAtomic(path.join(this.dir, `${s.id}.json`), this.metaOf(s)).catch((e) => console.error('[claude] save meta', e));
    }, 300);
  }

  async ensureEvents(s) {
    if (s.events) return s.events;
    const file = path.join(this.dir, `${s.id}.jsonl`);
    let lines = [];
    try {
      lines = (await fsp.readFile(file, 'utf8')).split('\n').filter(Boolean);
    } catch {
      /* new or missing */
    }
    const events = [];
    for (const l of lines.slice(-MAX_EVENTS_IN_MEMORY)) {
      try {
        events.push(JSON.parse(l));
      } catch {
        /* skip a torn last line */
      }
    }
    if (!s.events) s.events = events;
    if (events.length) s.seq = Math.max(s.seq, events[events.length - 1].seq);
    return s.events;
  }

  emit(s, ev) {
    s.seq += 1;
    const full = { seq: s.seq, at: Date.now(), ...ev };
    if (!s.events) s.events = [];
    s.events.push(full);
    if (s.events.length > MAX_EVENTS_IN_MEMORY) s.events.splice(0, s.events.length - MAX_EVENTS_IN_MEMORY);
    const line = `${JSON.stringify(full)}\n`;
    s.writeChain = s.writeChain.then(() => fsp.appendFile(path.join(this.dir, `${s.id}.jsonl`), line)).catch((e) => console.error('[claude] append', e));
    s.updatedAt = full.at;
    if (ev.t === 'text') s.preview = truncate(ev.text.replace(/\s+/g, ' '), 140);
    for (const fn of s.listeners) fn(full);
    this.scheduleSave(s);
    this.broadcast(s);
    return full;
  }

  setState(s, state, extra = {}) {
    s.state = state;
    Object.assign(s, extra);
    s.updatedAt = Date.now();
    this.emit(s, { t: 'state', state });
  }

  broadcast(s) {
    const msg = { type: 'session', session: this.summary(s) };
    for (const fn of this.hubListeners) fn(msg);
  }

  onHub(fn) {
    this.hubListeners.add(fn);
    return () => this.hubListeners.delete(fn);
  }

  // ---------- public API ----------

  options() {
    return { modes: MODES, efforts: EFFORTS };
  }

  list() {
    return [...this.sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt).map((s) => this.summary(s));
  }

  get(id) {
    const s = this.sessions.get(id);
    if (!s) throw httpErr(404, 'No such session');
    return s;
  }

  async events(id, after = 0) {
    const s = this.get(id);
    const evs = await this.ensureEvents(s);
    return evs.filter((e) => e.seq > after);
  }

  subscribe(id, fn) {
    const s = this.get(id);
    s.listeners.add(fn);
    return () => s.listeners.delete(fn);
  }

  liveCount() {
    return [...this.sessions.values()].filter((s) => s.q).length;
  }

  async create({ rootId, rel = '', prompt, model = 'default', effort = null, profileId = null, permissionMode = 'default', title, images = null }) {
    const imgs = checkImages(images);
    if (!String(prompt || '').trim() && !imgs.length) throw httpErr(400, 'Write what Claude should do');
    if (!String(prompt || '').trim()) prompt = PHOTO_PROMPT;
    if (!MODES.includes(permissionMode)) throw httpErr(400, 'Unknown permission mode');
    if (!MODEL_RE.test(String(model))) throw httpErr(400, 'Unknown model');
    if (effort && !EFFORTS.includes(effort)) throw httpErr(400, 'Unknown effort level');
    const profile = profileId ? this.profiles.get(profileId) : this.profiles.chosen();
    if (!profile) throw httpErr(409, 'No Claude account picked. Choose one when starting the session.');
    if (!profile.signedIn) throw httpErr(409, `${profile.email || profile.name} is not signed in on the laptop`);
    const real = await this.whoIs(profile);
    const where = await this.files.resolve(rootId, rel);
    const st = await fsp.stat(where.abs);
    if (!st.isDirectory()) throw httpErr(400, 'Pick a folder, not a file');
    const now = Date.now();
    const s = this.hydrate({
      id: uuid(),
      title: String(title || prompt).replace(/\s+/g, ' ').trim().slice(0, 70),
      rootId: where.rootId,
      rel: where.rel,
      cwd: where.abs,
      model,
      effort: effort || null,
      profileId: profile.id,
      permissionMode,
      sdkSessionId: null,
      createdAt: now,
      updatedAt: now,
      state: 'starting',
      account: real.email,
      expectedEmail: real.email,
      preview: '',
      turns: 0,
    });
    s.events = [];
    this.sessions.set(s.id, s);
    await this.start(s, String(prompt), imgs);
    return this.summary(s);
  }

  /**
   * Takes over a conversation that started elsewhere on the laptop (desktop app, terminal): stores its
   * history as this session's events and waits, paused, until the next message resumes it.
   */
  async adopt({ rootId, rel, cwd, title, profileId, sdkSessionId, model = 'default', effort = null, permissionMode = 'default', events = [], notes = [], origin = 'laptop' }) {
    if (!MODEL_RE.test(String(model))) model = 'default';
    if (effort && !EFFORTS.includes(effort)) effort = null;
    if (!MODES.includes(permissionMode)) permissionMode = 'default';
    const profile = this.profiles.get(profileId);
    const real = await this.whoIs(profile);
    const now = Date.now();
    const s = this.hydrate({
      id: uuid(),
      title: String(title || 'Laptop chat').replace(/\s+/g, ' ').trim().slice(0, 70),
      rootId, rel, cwd, model, effort, profileId: profile.id, permissionMode, sdkSessionId,
      createdAt: now, updatedAt: now, state: 'closed', account: real.email, expectedEmail: real.email,
      preview: '', turns: 0, origin,
    });
    const all = [...events, ...notes.map((text) => ({ t: 'note', text }))];
    s.events = all.map((ev, i) => ({ ...ev, seq: i + 1, at: ev.at || now }));
    s.seq = s.events.length;
    const lastText = [...events].reverse().find((e) => e.t === 'text');
    if (lastText) s.preview = truncate(lastText.text.replace(/\s+/g, ' '), 140);
    await fsp.writeFile(path.join(this.dir, `${s.id}.jsonl`), s.events.map((e) => `${JSON.stringify(e)}\n`).join(''));
    this.sessions.set(s.id, s);
    await writeJsonAtomic(path.join(this.dir, `${s.id}.json`), this.metaOf(s));
    this.broadcast(s);
    return this.summary(s);
  }

  /** Moves a paused session to another signed-in account (the caller copies the conversation file first). */
  async setAccount(id, profileId) {
    const s = this.get(id);
    if (s.q) throw httpErr(409, 'Stop the session first');
    const profile = this.profiles.get(profileId);
    const real = await this.whoIs(profile);
    s.profileId = profile.id;
    s.expectedEmail = real.email;
    s.account = real.email;
    await this.ensureEvents(s);
    this.emit(s, { t: 'note', text: `Account changed to ${real.email} (checked with Anthropic).` });
    return this.summary(s);
  }

  async send(id, text, images = null) {
    const s = this.get(id);
    const imgs = checkImages(images);
    text = String(text || '');
    if (!text.trim() && !imgs.length) throw httpErr(400, 'Empty message');
    if (!text.trim()) text = PHOTO_PROMPT;
    await this.ensureEvents(s);
    if (s.q && s.input && !s.input.closed) {
      const names = await this.saveImages(s, imgs);
      this.emit(s, { t: 'user', text, ...(names.length ? { images: names } : {}) });
      s.input.push(userMessage(text, s.sdkSessionId, this.noteFor?.(), imgs));
      clearTimeout(s.idleTimer);
      if (s.state === 'idle') this.setState(s, 'working');
      return this.summary(s);
    }
    if (!s.sdkSessionId) throw httpErr(409, 'This session never started, so it cannot be continued. Start a new one.');
    await this.start(s, text, imgs);
    return this.summary(s);
  }

  /** Keeps a copy of each photo next to the session, so the chat can show it later. Returns the file names. */
  async saveImages(s, imgs) {
    if (!imgs.length) return [];
    const dir = path.join(this.dir, `${s.id}-files`);
    await fsp.mkdir(dir, { recursive: true });
    const stamp = Date.now();
    const names = [];
    for (let i = 0; i < imgs.length; i++) {
      const name = `${stamp}-${i}.${IMAGE_TYPES[imgs[i].mediaType]}`;
      await fsp.writeFile(path.join(dir, name), Buffer.from(imgs[i].data, 'base64'));
      names.push(name);
    }
    return names;
  }

  /** Absolute path of one saved photo of a session (name checked, so it cannot leave the folder). */
  imagePath(id, name) {
    this.get(id);
    if (!IMAGE_NAME_RE.test(String(name))) throw httpErr(404, 'No such photo');
    return path.join(this.dir, `${id}-files`, name);
  }

  /** Starts (or resumes) the Claude process. Verifies the account BEFORE handing over the prompt. */
  async start(s, text, imgs = []) {
    const profile = s.profileId ? this.profiles.get(s.profileId) : this.profiles.chosen();
    if (!profile) throw httpErr(409, 'No Claude account picked for this session.');
    if (!profile.signedIn) throw httpErr(409, `${profile.email || profile.name} is not signed in on the laptop.`);
    // Check who the saved login REALLY is (asked from Anthropic with that login), before Claude gets anything.
    const real = await this.whoIs(profile);
    s.expectedEmail = s.expectedEmail || real.email; // older sessions had no checked email: take the real one
    if (real.email.toLowerCase() !== s.expectedEmail.toLowerCase()) {
      throw httpErr(409, `Not started: this session belongs to ${s.expectedEmail}, but the laptop's "${profile.name}" login is now ${real.email}.`);
    }
    s.account = real.email;
    s.profileId = profile.id;
    if (this.liveCount() >= this.cfg.maxLiveSessions) throw httpErr(429, `Already ${this.cfg.maxLiveSessions} sessions running. Stop one first.`);

    await this.ensureEvents(s);
    s.input = new InputQueue();
    s.abort = new AbortController();
    s.lastError = null;
    const options = {
      cwd: s.cwd,
      abortController: s.abort,
      env: this.profiles.envFor(profile),
      settingSources: ['user', 'project', 'local'],
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      permissionMode: s.permissionMode,
      canUseTool: (tool, input, opts) => this.canUseTool(s, tool, input, opts),
      stderr: (d) => process.env.POCKETDESK_DEBUG && process.stderr.write(`[claude ${s.id.slice(0, 8)}] ${d}`),
    };
    if (s.model && s.model !== 'default') options.model = s.model;
    if (s.effort) options.effort = s.effort;
    if (s.sdkSessionId) options.resume = s.sdkSessionId;
    if (s.permissionMode === 'bypassPermissions') options.allowDangerouslySkipPermissions = true;

    const names = await this.saveImages(s, imgs);
    this.emit(s, { t: 'user', text, ...(names.length ? { images: names } : {}) });
    this.setState(s, 'starting');
    const q = this.queryFn({ prompt: s.input, options });
    s.q = q;
    this.run(s, q);

    this.emit(s, { t: 'note', text: `Account: ${real.email} (checked with Anthropic)` });
    this.setState(s, 'working');
    s.input.push(userMessage(text, s.sdkSessionId, this.noteFor?.(), imgs));
  }

  /** Who the profile's saved login really is. Refuses when it cannot be checked. */
  async whoIs(profile) {
    if (!this.identity) throw httpErr(500, 'Account check is not set up');
    try {
      return await this.identity.verify(profile);
    } catch (e) {
      throw httpErr(e.status || 409, `Could not confirm which account ${profile.name} is (${e.message}). Not starting.`);
    }
  }

  async run(s, q) {
    let failed = false;
    try {
      for await (const m of q) this.handle(s, m);
    } catch (e) {
      if (!s.abort?.signal.aborted) {
        failed = true;
        s.lastError = e.message;
        this.emit(s, { t: 'error', text: `Claude stopped with an error: ${truncate(e.message, 600)}` });
      }
    } finally {
      for (const p of [...s.pending.values()]) p.done({ behavior: 'deny', message: 'Session closed.' }, 'cancelled');
      clearTimeout(s.idleTimer);
      if (s.q === q) {
        s.q = null;
        s.input = null;
      }
      this.setState(s, failed || s.lastError ? 'error' : 'closed');
    }
  }

  handle(s, m) {
    switch (m.type) {
      case 'system':
        if (m.subtype === 'init') {
          s.sdkSessionId = m.session_id || s.sdkSessionId;
          this.emit(s, { t: 'init', model: m.model, mode: m.permissionMode, version: m.claude_code_version });
        } else if (m.subtype === 'compact_boundary') {
          this.emit(s, { t: 'note', text: 'Conversation was compacted to save space.' });
        }
        break;
      case 'assistant': {
        if (m.session_id) s.sdkSessionId = m.session_id;
        if (m.parent_tool_use_id) break; // subagent internals: the Agent tool call/result is shown instead
        if (m.error) this.emit(s, { t: 'error', text: `Claude API problem: ${m.error}` });
        for (const b of m.message?.content || []) {
          if (b.type === 'text' && b.text?.trim()) this.emit(s, { t: 'text', text: b.text });
          else if (b.type === 'tool_use') this.emit(s, { t: 'tool', tid: b.id, name: b.name, summary: summarizeTool(b.name, b.input), detail: truncate(JSON.stringify(b.input, null, 2), 4000) });
        }
        break;
      }
      case 'user': {
        if (m.parent_tool_use_id || m.isSynthetic) break;
        const content = m.message?.content;
        if (!Array.isArray(content)) break;
        for (const b of content) {
          if (b.type === 'tool_result') this.emit(s, { t: 'tool_result', tid: b.tool_use_id, err: !!b.is_error, text: truncate(resultText(b.content), 3000) });
        }
        break;
      }
      case 'rate_limit_event':
        try {
          this.onRateLimit?.(s.profileId, m.rate_limit_info);
        } catch {
          /* never break a session over usage bookkeeping */
        }
        break;
      case 'result': {
        s.turns = (s.turns || 0) + 1;
        const ok = m.subtype === 'success' && !m.is_error;
        this.emit(s, { t: 'result', ok, ms: m.duration_ms, turns: m.num_turns, text: ok ? undefined : truncate(m.result || m.subtype, 800) });
        if (s.pending.size === 0) this.setState(s, 'idle');
        this.push.notify({ title: ok ? 'Claude finished' : 'Claude stopped with a problem', body: s.title, url: `/#/s/${s.id}`, tag: `done-${s.id}` }).catch(() => {});
        this.armIdle(s);
        break;
      }
      default:
        break;
    }
  }

  armIdle(s) {
    clearTimeout(s.idleTimer);
    const ms = Math.max(1, this.cfg.idleSessionMinutes) * 60_000;
    s.idleTimer = setTimeout(() => {
      if (s.state === 'idle' && s.pending.size === 0 && s.input) {
        this.emit(s, { t: 'note', text: `Paused after ${this.cfg.idleSessionMinutes} idle minutes to save memory. Send a message to continue.` });
        s.input.end();
      }
    }, ms);
    s.idleTimer.unref?.();
  }

  canUseTool(s, toolName, input, { signal, decisionReason, blockedPath } = {}) {
    const special = toolName === 'AskUserQuestion' || toolName === 'ExitPlanMode';
    if (!special && s.allowAlways.has(toolName)) return Promise.resolve({ behavior: 'allow', updatedInput: input });
    const pid = uuid();
    const kind = toolName === 'AskUserQuestion' ? 'question' : toolName === 'ExitPlanMode' ? 'plan' : 'tool';
    const ev = { t: 'perm', pid, kind, tool: toolName, summary: summarizeTool(toolName, input), reason: decisionReason ? truncate(decisionReason, 400) : undefined, blockedPath };
    if (kind === 'question') ev.questions = sanitizeQuestions(input.questions);
    else if (kind === 'plan') ev.plan = truncate(input.plan || '', 20000);
    else ev.detail = truncate(JSON.stringify(input, null, 2), 6000);

    return new Promise((resolve) => {
      let finished = false;
      const done = (result, status) => {
        if (finished) return;
        finished = true;
        s.pending.delete(pid);
        this.emit(s, { t: 'perm_done', pid, status });
        if (s.pending.size === 0 && s.state === 'waiting') this.setState(s, 'working');
        else this.broadcast(s);
        resolve(result);
      };
      // one-time token for the Allow / Deny buttons on the phone notification: it answers only THIS prompt
      const token = kind === 'tool' ? randomToken(18) : null;
      s.pending.set(pid, { done, input, toolName, kind, token });
      this.emit(s, ev);
      if (s.state !== 'waiting') this.setState(s, 'waiting');
      signal?.addEventListener('abort', () => done({ behavior: 'deny', message: 'Cancelled.' }, 'cancelled'), { once: true });
      const body = kind === 'question' ? 'Claude has a question' : kind === 'plan' ? 'Claude wants you to approve a plan' : `Allow ${toolName}? ${ev.summary}`;
      const buttons = token ? { actions: [{ action: 'allow', title: 'Allow' }, { action: 'deny', title: 'Deny' }], decide: { sid: s.id, pid, token } } : {};
      this.push.notify({ title: s.title, body, url: `/#/s/${s.id}`, tag: `perm-${pid}`, ...buttons }).catch(() => {});
    });
  }

  /** Allow / Deny pressed on a phone notification. Only works with that prompt's own one-time token. */
  decideByToken(id, pid, token, decision) {
    const s = this.get(id);
    const p = s.pending.get(pid);
    if (!p) throw httpErr(409, 'That request is no longer waiting (it was answered or cancelled).');
    if (!p.token || !safeEqual(String(token || ''), p.token)) throw httpErr(403, 'This notification button is no longer valid');
    if (decision !== 'allow' && decision !== 'deny') throw httpErr(400, 'Unknown decision');
    return this.decide(id, pid, { decision });
  }

  /** decision: allow | always | deny | answer | approve ; answers: {question: answer}; mode: for plan approval */
  decide(id, pid, { decision, answers, note, mode }) {
    const s = this.get(id);
    const p = s.pending.get(pid);
    if (!p) throw httpErr(409, 'That request is no longer waiting (it was answered or cancelled).');
    const why = note ? ` Note from the user: ${String(note).slice(0, 2000)}` : '';
    if (decision === 'deny') {
      const message = p.kind === 'question' ? `The user skipped the question.${why}` : p.kind === 'plan' ? `The user did not approve the plan yet.${why || ' Ask what to change.'}` : `The user denied this from their phone.${why}`;
      p.done({ behavior: 'deny', message }, 'denied');
    } else if (p.kind === 'question') {
      if (decision !== 'answer' || !answers || typeof answers !== 'object') throw httpErr(400, 'Answers missing');
      const clean = {};
      for (const [k, v] of Object.entries(answers)) clean[String(k)] = String(v).slice(0, 2000);
      p.done({ behavior: 'allow', updatedInput: { ...p.input, answers: clean } }, 'answered');
    } else if (p.kind === 'plan') {
      const next = mode === 'acceptEdits' ? 'acceptEdits' : 'default';
      s.permissionMode = next;
      p.done({ behavior: 'allow', updatedInput: p.input, updatedPermissions: [{ type: 'setMode', mode: next, destination: 'session' }] }, 'approved');
    } else if (decision === 'allow' || decision === 'always') {
      if (decision === 'always') s.allowAlways.add(p.toolName);
      p.done({ behavior: 'allow', updatedInput: p.input }, decision === 'always' ? 'always' : 'allowed');
    } else {
      throw httpErr(400, 'Unknown decision');
    }
    return this.summary(s);
  }

  async interrupt(id) {
    const s = this.get(id);
    if (!s.q) throw httpErr(409, 'Not running');
    for (const p of [...s.pending.values()]) p.done({ behavior: 'deny', message: 'The user pressed stop.', interrupt: true }, 'cancelled');
    await s.q.interrupt();
    this.emit(s, { t: 'note', text: 'Stopped by you. Send a message to continue.' });
    return this.summary(s);
  }

  async close(id) {
    const s = this.get(id);
    if (s.q) {
      s.abort.abort();
      s.input?.end();
    }
    return this.summary(s);
  }

  async setMode(id, mode) {
    if (!MODES.includes(mode)) throw httpErr(400, 'Unknown permission mode');
    const s = this.get(id);
    s.permissionMode = mode;
    if (s.q) await s.q.setPermissionMode(mode);
    this.emit(s, { t: 'note', text: `Permission mode: ${mode}` });
    return this.summary(s);
  }

  async remove(id) {
    const s = this.get(id);
    if (s.q) throw httpErr(409, 'Stop the session first');
    this.sessions.delete(id);
    await fsp.rm(path.join(this.dir, `${id}.json`), { force: true });
    await fsp.rm(path.join(this.dir, `${id}.jsonl`), { force: true });
    await fsp.rm(path.join(this.dir, `${id}-files`), { recursive: true, force: true });
    for (const fn of this.hubListeners) fn({ type: 'removed', id });
  }

  async shutdown() {
    for (const s of this.sessions.values()) {
      if (s.q) {
        s.abort.abort();
        s.input?.end();
      }
      clearTimeout(s.saveTimer);
      await writeJsonAtomic(path.join(this.dir, `${s.id}.json`), { ...this.metaOf(s), state: LIVE.has(s.state) ? 'closed' : s.state });
    }
  }
}

const PHOTO_PROMPT = 'Look at the attached photo.';

/** Validates photos sent from the phone: [{ mediaType, data (base64) }], at most 4, each at most 5 MB. */
export function checkImages(images) {
  if (images == null) return [];
  if (!Array.isArray(images)) throw httpErr(400, 'Bad photos');
  if (images.length > MAX_IMAGES) throw httpErr(400, `At most ${MAX_IMAGES} photos per message`);
  return images.map((img) => {
    const mediaType = String(img?.mediaType || '');
    const data = String(img?.data || '');
    if (!IMAGE_TYPES[mediaType]) throw httpErr(400, 'Photos must be JPEG, PNG, WebP or GIF');
    if (!data || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw httpErr(400, 'Bad photo data');
    if (Math.floor(data.length * 3 / 4) > MAX_IMAGE_BYTES) throw httpErr(413, 'A photo is larger than 5 MB');
    return { mediaType, data };
  });
}

function userMessage(text, sessionId, note = null, images = []) {
  // the note (e.g. Travel mode) goes to Claude only; the phone shows the user's own words
  const parts = images.map((img) => ({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } }));
  if (parts.length || note) {
    parts.push({ type: 'text', text });
    if (note) parts.push({ type: 'text', text: `<system-reminder>${note}</system-reminder>` });
  }
  const content = parts.length ? parts : text;
  return { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, session_id: sessionId || '' };
}

function resultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (c.type === 'text' ? c.text : c.type === 'image' ? '[image]' : '')).join('\n');
  return '';
}

function sanitizeQuestions(qs) {
  if (!Array.isArray(qs)) return [];
  return qs.slice(0, 4).map((q) => ({
    question: String(q.question || ''),
    header: String(q.header || ''),
    multiSelect: !!q.multiSelect,
    options: (q.options || []).slice(0, 6).map((o) => ({ label: String(o.label || ''), description: String(o.description || '') })),
  }));
}

/** One short line describing a tool call, for lists and notifications. */
export function summarizeTool(name, input = {}) {
  const short = (p) => {
    const s = String(p || '');
    const parts = s.split(/[\\/]/);
    return parts.length > 3 ? `…/${parts.slice(-3).join('/')}` : s;
  };
  switch (name) {
    case 'Bash':
    case 'PowerShell':
      return truncate(input.description || input.command || '', 160);
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'NotebookEdit':
      return short(input.file_path || input.notebook_path);
    case 'Glob':
    case 'Grep':
      return truncate(`${input.pattern || ''}${input.path ? ` in ${short(input.path)}` : ''}`, 160);
    case 'WebFetch':
      return truncate(input.url || '', 160);
    case 'WebSearch':
      return truncate(input.query || '', 160);
    case 'Agent':
    case 'Task':
      return truncate(input.description || input.prompt || '', 160);
    case 'AskUserQuestion':
      return truncate(input.questions?.[0]?.question || 'Question', 160);
    case 'ExitPlanMode':
      return 'Plan ready for approval';
    default:
      return truncate(Object.values(input).filter((v) => typeof v === 'string')[0] || '', 160);
  }
}
