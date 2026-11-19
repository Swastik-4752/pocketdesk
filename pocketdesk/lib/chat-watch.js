import fsp from 'node:fs/promises';

const TICK_MS = 30_000;
const RECENT_MS = 30 * 60_000; // only chats written in the last 30 minutes are watched
const QUIET_DONE_MS = 45_000; // a finished turn must stay quiet this long (the app writes a few lines after it)
const TAIL_BYTES = 128 * 1024;

/**
 * "Done" and "stuck" alerts that PocketDesk's own sessions do not already send:
 *  - a Claude chat on the LAPTOP (desktop app, terminal, VS Code) finished its turn, or has been sitting on a
 *    tool call for a while (usually it is waiting for you to approve it on the laptop);
 *  - a PocketDesk session has been "working" with no progress for a long time.
 * It only reads the chat files; it never changes anything.
 */
export class ChatWatch {
  constructor({ laptopChats, sessions, push, activity, settings, now = Date.now }) {
    this.laptopChats = laptopChats;
    this.sessions = sessions;
    this.push = push;
    this.activity = activity;
    this.settings = settings; // () => { laptopDone, laptopWaitMin, stuckMin }
    this.now = now;
    this.files = new Map(); // id -> { mtime, active, doneFor, waitFor }
    this.stuck = new Map(); // phone session id -> updatedAt it was reported for
    this.primed = false;
    this.timer = null;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick().catch((e) => console.error('[watch]', e.message)), TICK_MS);
    this.timer.unref();
    setTimeout(() => this.tick().catch(() => {}), 8000).unref();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  async send(title, body, url, tag) {
    this.activity?.log('PocketDesk', 'Alert', `${title}${body ? ` - ${body}` : ''}`);
    await this.push?.notify({ title, body, url, tag }).catch(() => {});
  }

  /** One check. Exposed for tests. */
  async tick() {
    const cfg = this.settings();
    await this.checkPhoneSessions(cfg);
    await this.checkLaptopChats(cfg);
    this.primed = true;
  }

  async checkPhoneSessions(cfg) {
    if (!(cfg.stuckMin > 0)) return;
    const now = this.now();
    for (const s of this.sessions.list()) {
      if (s.state !== 'working') {
        this.stuck.delete(s.id);
        continue;
      }
      const quiet = now - s.updatedAt;
      if (quiet < cfg.stuckMin * 60_000 || this.stuck.get(s.id) === s.updatedAt) continue;
      this.stuck.set(s.id, s.updatedAt);
      await this.send('Claude has made no progress', `${s.title}: nothing new for ${Math.round(quiet / 60000)} min. It may be stuck, or running a long command.`, `/#/s/${s.id}`, `stuck-${s.id}`);
    }
  }

  async checkLaptopChats(cfg) {
    if (!cfg.laptopDone && !(cfg.laptopWaitMin > 0)) return;
    const now = this.now();
    // PocketDesk's own running sessions send their own alerts
    const ownLive = new Set(this.sessions.list().filter((s) => s.sdkSessionId && ['starting', 'working', 'waiting', 'idle'].includes(s.state)).map((s) => s.sdkSessionId));
    const all = await this.laptopChats.allFiles();
    const seen = new Set();
    for (const f of all) {
      if (now - f.mtime > RECENT_MS) break; // newest first
      seen.add(f.id);
      const st = this.files.get(f.id);
      if (!st) {
        // first sight: if it is still being written it counts as active, but never alert on startup
        this.files.set(f.id, { mtime: f.mtime, active: this.primed || now - f.mtime < QUIET_DONE_MS, doneFor: null, waitFor: null });
        continue;
      }
      if (f.mtime !== st.mtime) {
        st.mtime = f.mtime;
        st.active = true;
        continue;
      }
      if (!st.active || ownLive.has(f.id) || now - f.mtime < QUIET_DONE_MS) continue;
      const last = await lastTurn(f.file).catch(() => null);
      if (!last) continue;
      if (last.done) {
        st.active = false;
        if (!cfg.laptopDone || st.doneFor === f.mtime) continue;
        st.doneFor = f.mtime;
        const name = await this.title(f);
        await this.send('Laptop Claude finished', name, `/#/pc/${f.id}`, `lapdone-${f.id}`);
      } else if (last.tool && cfg.laptopWaitMin > 0 && now - f.mtime >= cfg.laptopWaitMin * 60_000 && st.waitFor !== last.toolId) {
        st.waitFor = last.toolId;
        const name = await this.title(f);
        await this.send('Laptop Claude may need you', `${name}: waiting ${Math.round((now - f.mtime) / 60000)} min on ${last.tool}. If it asks to approve something, answer on the laptop (or continue the chat on the phone).`, `/#/pc/${f.id}`, `lapwait-${f.id}`);
      }
    }
    for (const id of this.files.keys()) if (!seen.has(id)) this.files.delete(id);
  }

  async title(f) {
    const meta = await this.laptopChats.meta(f).catch(() => null);
    const t = meta?.title || meta?.lastPrompt || meta?.firstPrompt || 'a laptop chat';
    const where = meta?.entrypoint === 'claude-desktop' ? 'Desktop app' : meta?.entrypoint === 'cli' ? 'Terminal' : null;
    const short = String(t).replace(/\s+/g, ' ').slice(0, 90);
    return where ? `${short} (${where})` : short;
  }
}

/**
 * The last main-thread step of a Claude Code chat file: { done: true } when the assistant ended its turn,
 * { tool, toolId } when it stopped on a tool call (running it, or waiting for approval), else {}.
 */
export async function lastTurn(file) {
  const fh = await fsp.open(file, 'r');
  let text;
  try {
    const { size } = await fh.stat();
    const n = Math.min(TAIL_BYTES, size);
    const buf = Buffer.alloc(n);
    await fh.read(buf, 0, n, size - n);
    text = buf.toString('utf8');
  } finally {
    await fh.close();
  }
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    let o;
    try {
      o = JSON.parse(lines[i]);
    } catch {
      continue; // the first line may be cut, or a line is half-written
    }
    if (o.isSidechain || (o.type !== 'assistant' && o.type !== 'user')) continue;
    if (o.type === 'user') {
      const c = o.message?.content;
      // a tool result means Claude is thinking about it now; a typed prompt means a new turn started
      return Array.isArray(c) && c.some((b) => b.type === 'tool_result') ? { thinking: true } : { prompt: true };
    }
    const m = o.message || {};
    const tool = (m.content || []).find((b) => b.type === 'tool_use');
    if (tool) return { tool: tool.name, toolId: tool.id };
    if (m.stop_reason === 'end_turn' || m.stop_reason === 'stop_sequence') return { done: true };
    return {};
  }
  return null;
}
