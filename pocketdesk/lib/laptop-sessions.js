import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { httpErr, truncate } from './util.js';
import { summarizeTool } from './claude.js';

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEAD = 256 * 1024;
const TAIL = 256 * 1024;
const LIST_TTL = 10_000;
const MAX_IMPORT = 1500;
const MODES = ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'];
const ENTRY_LABEL = { 'claude-desktop': 'Desktop app', cli: 'Terminal', 'sdk-ts': 'PocketDesk / SDK', 'sdk-py': 'SDK', 'claude-vscode': 'VS Code', 'claude-jetbrains': 'JetBrains' };

/**
 * Claude Code conversations that live on the laptop, so a chat started in the desktop app or a terminal can be
 * read in full on the phone and continued there (PocketDesk resumes the same conversation id, same folder).
 *
 * The `mc` profiles share ONE history folder (their projects\ folders are junctions to ~/.claude/projects),
 * so a conversation file does not say which account ran it. We show each chat once and suggest an account:
 * the one PocketDesk ran it on, the one the "switch to phone" hook reports, or the desktop app's folder (main).
 */
export class LaptopSessions {
  constructor(cfg, { profiles, sessions, files, push, activity }) {
    this.cfg = cfg;
    this.profiles = profiles;
    this.sessions = sessions;
    this.files = files;
    this.push = push;
    this.activity = activity;
    this.metaCache = new Map(); // file -> { key, meta }
    this.listCache = null;
  }

  /** Distinct history folders: [{ dir, real, profiles: [profile…] }]. */
  projectsDirs() {
    const byReal = new Map();
    for (const p of this.profiles.scan()) {
      const dir = path.join(p.dir, 'projects');
      if (!isDir(dir)) continue;
      let real = dir;
      try {
        real = fs.realpathSync.native(dir);
      } catch {
        /* keep */
      }
      const key = real.toLowerCase();
      if (!byReal.has(key)) byReal.set(key, { dir: real, real, profiles: [] });
      byReal.get(key).profiles.push(p);
    }
    return [...byReal.values()];
  }

  /** Every conversation file, newest first: [{ file, id, folder, base, mtime, size }]. */
  async allFiles() {
    const out = [];
    for (const { dir, profiles } of this.projectsDirs()) {
      let subs = [];
      try {
        subs = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const sub of subs) {
        if (!sub.isDirectory()) continue;
        const folder = path.join(dir, sub.name);
        let names = [];
        try {
          names = await fsp.readdir(folder);
        } catch {
          continue;
        }
        for (const n of names) {
          if (!n.endsWith('.jsonl') || !ID_RE.test(n.slice(0, -6))) continue;
          const file = path.join(folder, n);
          const st = await fsp.stat(file).catch(() => null);
          if (st?.isFile() && st.size > 0) out.push({ file, id: n.slice(0, -6), folder: sub.name, base: dir, sharedBy: profiles, mtime: st.mtimeMs, size: st.size });
        }
      }
    }
    return out.sort((a, b) => b.mtime - a.mtime);
  }

  /** Which account most likely ran this chat: { profile, sure, why }. */
  guessAccount(f, meta) {
    const scan = this.profiles.scan();
    const phone = this.sessions.list().find((s) => s.sdkSessionId === f.id);
    const byId = (id) => scan.find((p) => p.id === id);
    if (phone && byId(phone.profileId)) return { profile: byId(phone.profileId), sure: true, why: 'PocketDesk ran it on this account' };
    if (meta.entrypoint === 'claude-desktop') {
      const main = scan.find((p) => p.isMain);
      if (main) return { profile: main, sure: false, why: 'desktop app chat' };
    }
    const def = this.profiles.chosen();
    const p = (def && byId(def.id)) || f.sharedBy?.find((x) => x.signedIn) || scan.find((x) => x.signedIn) || scan[0];
    return { profile: p, sure: false, why: 'unknown: your accounts share one chat history' };
  }

  async list({ limit = 40 } = {}) {
    if (!this.listCache || Date.now() - this.listCache.at > LIST_TTL) this.listCache = { at: Date.now(), files: await this.allFiles() };
    const phoneBySdk = new Map(this.sessions.list().filter((s) => s.sdkSessionId).map((s) => [s.sdkSessionId, s]));
    const out = [];
    for (const f of this.listCache.files) {
      const meta = await this.meta(f).catch(() => null);
      if (!meta || !meta.firstPrompt) continue; // empty / probe sessions
      const phone = phoneBySdk.get(f.id);
      const guess = this.guessAccount(f, meta);
      out.push({
        id: f.id,
        account: guess.sure ? guess.profile.email || guess.profile.name : null,
        title: meta.title || truncate(meta.firstPrompt.replace(/\s+/g, ' '), 90),
        firstPrompt: truncate(meta.firstPrompt.replace(/\s+/g, ' '), 200),
        lastPrompt: meta.lastPrompt ? truncate(meta.lastPrompt.replace(/\s+/g, ' '), 200) : null,
        cwd: meta.cwd,
        where: meta.entrypoint ? ENTRY_LABEL[meta.entrypoint] || meta.entrypoint : null,
        updatedAt: f.mtime,
        size: f.size,
        activeNow: Date.now() - f.mtime < 120_000,
        phoneSession: phone ? { id: phone.id, state: phone.state } : null,
      });
      if (out.length >= limit) break;
    }
    return { sessions: out };
  }

  /** Cheap facts from the start and end of a conversation file (cached by size + mtime). */
  async meta(f) {
    const key = `${f.size}|${f.mtime}`;
    const hit = this.metaCache.get(f.file);
    if (hit?.key === key) return hit.meta;
    const fh = await fsp.open(f.file, 'r');
    let head;
    let tail;
    try {
      const hb = Buffer.alloc(Math.min(HEAD, f.size));
      await fh.read(hb, 0, hb.length, 0);
      head = hb.toString('utf8');
      const tl = Math.min(TAIL, f.size);
      const tb = Buffer.alloc(tl);
      await fh.read(tb, 0, tl, f.size - tl);
      tail = tb.toString('utf8');
    } finally {
      await fh.close();
    }
    const meta = { firstPrompt: null, cwd: null, entrypoint: null, title: null, lastPrompt: null, model: null, effort: null, mode: null };
    for (const line of head.split('\n')) {
      const j = parse(line);
      if (!j) continue;
      if (!meta.cwd && j.cwd) meta.cwd = j.cwd;
      if (!meta.entrypoint && j.entrypoint) meta.entrypoint = j.entrypoint;
      if (!meta.firstPrompt && j.type === 'user' && !j.isSidechain && !j.isMeta) {
        const t = userText(j.message?.content);
        if (t && !isNoise(t)) meta.firstPrompt = t;
      }
      if (meta.firstPrompt && meta.cwd && meta.entrypoint) break;
    }
    for (const line of tail.split('\n')) {
      const j = parse(line);
      if (!j) continue;
      if (j.type === 'custom-title' && j.customTitle) meta.title = j.customTitle;
      else if (j.type === 'summary' && j.summary && !meta.title) meta.title = j.summary;
      else if (j.type === 'last-prompt' && j.lastPrompt) meta.lastPrompt = j.lastPrompt;
      else if (j.type === 'assistant' && !j.isSidechain) {
        meta.model = j.requestedModel || j.message?.model || meta.model;
        meta.effort = j.effort || meta.effort;
      } else if (j.type === 'user' && j.permissionMode) meta.mode = j.permissionMode;
      if (j.cwd) meta.cwd = j.cwd;
    }
    this.metaCache.set(f.file, { key, meta });
    if (this.metaCache.size > 3000) this.metaCache.delete(this.metaCache.keys().next().value);
    return meta;
  }

  /** Finds a conversation file by id in any history folder. */
  async find(id) {
    if (!ID_RE.test(String(id))) throw httpErr(400, 'Bad session id');
    for (const { dir, profiles } of this.projectsDirs()) {
      let subs = [];
      try {
        subs = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const sub of subs) {
        if (!sub.isDirectory()) continue;
        const file = path.join(dir, sub.name, `${id}.jsonl`);
        const st = await fsp.stat(file).catch(() => null);
        if (st?.isFile()) return { file, id, folder: sub.name, base: dir, sharedBy: profiles, mtime: st.mtimeMs, size: st.size };
      }
    }
    throw httpErr(404, 'That conversation is not on the laptop (any more)');
  }

  /** The whole conversation as PocketDesk chat events (the same shapes the session view draws). */
  async transcript(id, { limit = 400 } = {}) {
    const f = await this.find(id);
    const meta = await this.meta(f);
    const events = parseTranscript(await fsp.readFile(f.file, 'utf8'));
    const lim = Math.max(50, Math.min(MAX_IMPORT, Number(limit) || 400));
    const phone = this.sessions.list().find((s) => s.sdkSessionId === id) || null;
    const guess = this.guessAccount(f, meta);
    return {
      info: {
        id, cwd: meta.cwd, title: meta.title || truncate(meta.firstPrompt || '', 90),
        where: meta.entrypoint ? ENTRY_LABEL[meta.entrypoint] || meta.entrypoint : null, model: meta.model, effort: meta.effort, mode: meta.mode,
        updatedAt: f.mtime, activeNow: Date.now() - f.mtime < 120_000,
        suggestedAccount: guess.profile?.id || null, accountSure: guess.sure, accountWhy: guess.why,
        desktopNote: this.desktopNote(meta),
        phoneSession: phone ? { id: phone.id, state: phone.state } : null,
      },
      total: events.length,
      events: events.slice(-lim),
    };
  }

  /** The desktop app signs in on its own; PocketDesk may have no login for that account. */
  desktopNote(meta) {
    if (meta.entrypoint !== 'claude-desktop') return null;
    const main = this.profiles.scan().find((p) => p.isMain);
    if (!main?.fileEmail || !main.email || main.fileEmail.toLowerCase() === main.email.toLowerCase()) return null;
    return `On the laptop this chat ran in the Claude desktop app as ${main.fileEmail}. PocketDesk has no login for that account, so pick which of your accounts continues it (the default is ${main.email}).`;
  }

  /** Makes (or refreshes) the phone copy of a laptop conversation, paused and ready for your next message. */
  async continueOnPhone({ id, accountId, configDir, model, effort, permissionMode }, who, origin = 'phone') {
    const f = await this.find(id);
    const meta = await this.meta(f);
    if (!meta.cwd) throw httpErr(409, 'This conversation does not say which folder it ran in');
    const where = this.files.locate(meta.cwd);
    await this.files.resolve(where.rootId, where.rel); // still exists, not blocked
    const existing = this.sessions.list().find((s) => s.sdkSessionId === id);
    if (existing) {
      const s = this.sessions.get(existing.id);
      if (s.q) return { session: existing, already: true };
      await this.sessions.remove(existing.id); // re-read: the laptop may have added messages since
    }
    let account = null;
    if (accountId) account = this.profiles.get(accountId);
    else if (configDir) account = this.profiles.scan().find((p) => samePath(p.dir, configDir)) || null;
    if (!account) account = this.guessAccount(f, meta).profile;
    if (!account) throw httpErr(409, 'No Claude account to continue with');
    account = this.profiles.get(account.id);
    if (!account.signedIn) throw httpErr(409, `${account.email || account.name} is not signed in on the laptop, so it cannot continue this chat. Pick another account.`);
    await this.copyTo(f, account);
    const all = parseTranscript(await fsp.readFile(f.file, 'utf8'));
    const events = all.slice(-MAX_IMPORT);
    const notes = [];
    if (all.length > events.length) notes.unshift(`${all.length - events.length} older messages are not shown here, but Claude still has them.`);
    const dn = this.desktopNote(meta);
    if (dn) notes.push(dn);
    const s = await this.sessions.adopt({
      rootId: where.rootId,
      rel: where.rel,
      cwd: meta.cwd,
      title: meta.title || meta.firstPrompt,
      profileId: account.id,
      sdkSessionId: id,
      model: model || meta.model || 'default',
      effort: effort || (['low', 'medium', 'high', 'xhigh', 'max'].includes(meta.effort) ? meta.effort : null),
      permissionMode: MODES.includes(permissionMode) ? permissionMode : MODES.includes(meta.mode) ? meta.mode : 'default',
      events,
      notes: [...notes, `Moved here from the laptop${meta.entrypoint ? ` (${ENTRY_LABEL[meta.entrypoint] || meta.entrypoint})` : ''}. It will continue on ${account.email || account.name}. Send a message to continue. Don't keep typing in the laptop window at the same time.`],
      origin,
    });
    this.activity?.log(who, origin === 'hook' ? 'Switched chat to phone' : 'Continued laptop chat on phone', `${s.title} (${s.account})`);
    this.listCache = null;
    return { session: s, already: false };
  }

  /** Makes sure the account's history folder has the conversation (no-op when the folders are shared). */
  async copyTo(f, account) {
    const destBase = path.join(account.dir, 'projects');
    let destReal = destBase;
    try {
      destReal = fs.realpathSync.native(destBase);
    } catch {
      /* not there yet */
    }
    if (samePath(destReal, f.base)) return;
    const destDir = path.join(destBase, f.folder);
    await fsp.mkdir(destDir, { recursive: true });
    const dest = path.join(destDir, `${f.id}.jsonl`);
    const st = await fsp.stat(dest).catch(() => null);
    if (!st || st.mtimeMs < f.mtime) await fsp.copyFile(f.file, dest);
  }

  /** Change the account of a paused phone session. */
  async switchAccount(sessionId, accountId, who) {
    const s = this.sessions.get(sessionId);
    if (s.q) throw httpErr(409, 'Stop the session first');
    const account = this.profiles.get(accountId);
    if (!account.signedIn) throw httpErr(409, `${account.email || account.name} is not signed in on the laptop`);
    if (s.sdkSessionId) {
      const f = await this.find(s.sdkSessionId).catch(() => null);
      if (f) await this.copyTo(f, account);
    }
    const out = await this.sessions.setAccount(sessionId, account.id);
    this.activity?.log(who, 'Changed session account', `${s.title} -> ${out.account}`);
    return out;
  }

  /** Called by the "switch to phone" hook inside any Claude Code session on the laptop. */
  async handoff({ session_id: id, transcript_path: tp, config_dir: configDir }) {
    if (!ID_RE.test(String(id || ''))) throw httpErr(400, 'Bad session id');
    const real = await fsp.realpath(String(tp || '')).catch(() => null);
    // compare with the real folder too: the account folders' projects\ are junctions to one shared history
    const owner = real && this.projectsDirs().find(({ dir, real: realDir }) => isInside(realDir || dir, real) || isInside(dir, real));
    if (!owner || path.basename(real) !== `${id}.jsonl`) throw httpErr(400, 'That conversation is not in a Claude account folder PocketDesk knows');
    const running = this.sessions.list().find((s) => s.sdkSessionId === id);
    if (running && this.sessions.get(running.id).q) return { ok: true, sessionId: running.id, message: 'This chat is already running on your phone (PocketDesk).' };
    // CLAUDE_CONFIG_DIR of the session that typed it = the account it runs on (none = ~/.claude)
    const dir = configDir || this.profiles.scan().find((p) => p.isMain)?.dir;
    const { session } = await this.continueOnPhone({ id, configDir: dir }, 'Laptop', 'hook');
    this.push?.notify({ title: '📱 Moved to your phone', body: session.title, url: `/#/s/${session.id}`, tag: `handoff-${session.id}` }).catch(() => {});
    return {
      ok: true,
      sessionId: session.id,
      message: `📱 Moved to your phone: "${session.title}" (continues on ${session.account}). Open PocketDesk on the phone, from the notification or the Claude tab, and keep chatting there. Don't type here meanwhile. To come back to the laptop later, run /resume in Claude in this folder (or: claude --resume ${id}).`,
    };
  }
}

// ---------- transcript parsing ----------

function parse(line) {
  if (!line || line[0] !== '{') return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function userText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((b) => (b.type === 'text' ? b.text : b.type === 'image' ? '[image]' : '')).filter(Boolean).join('\n');
}

const NOISE_RE = /^\s*<(command-name|command-message|command-args|local-command-stdout|local-command-stderr|system-reminder|local-command-caveat|bash-input|bash-stdout|bash-stderr)>/;
function isNoise(t) {
  return NOISE_RE.test(t) || /^\[Request interrupted by user/.test(t);
}

function resultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (c.type === 'text' ? c.text : c.type === 'image' ? '[image]' : '')).join('\n');
  return '';
}

/** Claude Code JSONL -> [{ seq, at, t: user|text|tool|tool_result|note, ... }] (main thread only). */
export function parseTranscript(text) {
  const out = [];
  const add = (at, ev) => out.push({ seq: out.length + 1, at, ...ev });
  for (const line of text.split('\n')) {
    const j = parse(line);
    if (!j || j.isSidechain) continue;
    const at = Date.parse(j.timestamp) || 0;
    if (j.type === 'user') {
      if (j.isCompactSummary) {
        add(at, { t: 'note', text: 'The conversation was compacted here (older part summarised for Claude).' });
        continue;
      }
      if (j.isMeta) continue;
      const c = j.message?.content;
      if (typeof c === 'string') {
        if (c.trim() && !isNoise(c)) add(at, { t: 'user', text: c });
        else if (/<command-name>/.test(c)) {
          const m = /<command-name>([^<]*)<\/command-name>/.exec(c);
          if (m) add(at, { t: 'note', text: `Command: ${m[1]}` });
        }
        continue;
      }
      if (!Array.isArray(c)) continue;
      const texts = [];
      for (const b of c) {
        if (b.type === 'tool_result') add(at, { t: 'tool_result', tid: b.tool_use_id, err: !!b.is_error, text: truncate(resultText(b.content), 3000) });
        else if (b.type === 'text' && b.text && !isNoise(b.text)) texts.push(b.text);
        else if (b.type === 'image') texts.push('[image]');
      }
      if (texts.length) add(at, { t: 'user', text: texts.join('\n') });
    } else if (j.type === 'assistant') {
      for (const b of j.message?.content || []) {
        if (b.type === 'text' && b.text?.trim()) add(at, { t: 'text', text: b.text });
        else if (b.type === 'tool_use') add(at, { t: 'tool', tid: b.id, name: b.name, summary: summarizeTool(b.name, b.input || {}), detail: truncate(JSON.stringify(b.input, null, 2), 4000) });
      }
    } else if (j.type === 'system' && j.subtype === 'compact_boundary') {
      add(at, { t: 'note', text: 'Conversation compacted.' });
    }
  }
  return out;
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isInside(base, target) {
  const b = path.resolve(base).toLowerCase();
  const t = path.resolve(target).toLowerCase();
  return t.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
}

function samePath(a, b) {
  return path.resolve(String(a)).toLowerCase() === path.resolve(String(b)).toLowerCase();
}
