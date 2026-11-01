import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { httpErr, uuid } from './util.js';

const MAX_LINES = 3000;
const MAX_RUNNING = 6;
const SCRIPT_RE = /^[A-Za-z0-9:._\-@/]{1,80}$/;
const PORT_RE = /(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]|\[::\]):(\d{2,5})/;
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\x1b[()][A-Z0-9]/g;

/**
 * Fixed commands for a project folder: its own package.json scripts (npm/pnpm/yarn), "install", and any
 * quickCommands written in config.json on the laptop. There is no free-typed terminal: the phone can only
 * pick one of these. Long-running ones (dev servers) keep going until stopped; their output is kept in memory.
 */
export class Tasks {
  constructor(cfg, { files, push, activity, spawnFn = spawn, killFn = killTree } = {}) {
    this.cfg = cfg;
    this.files = files;
    this.push = push;
    this.activity = activity;
    this.spawnFn = spawnFn;
    this.killFn = killFn;
    this.tasks = new Map();
    this.onExit = null; // set by the server (to stop sharing a port when its dev server ends)
  }

  async folder(rootId, rel) {
    const { abs: real } = await this.files.resolve(rootId, rel, { mustExist: true });
    if (!fs.statSync(real).isDirectory()) throw httpErr(400, 'Pick a folder, not a file');
    return real;
  }

  readPackage(dir) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
      return pkg && typeof pkg === 'object' ? pkg : null;
    } catch {
      return null;
    }
  }

  manager(dir) {
    if (fs.existsSync(path.join(dir, 'pnpm-lock.yaml'))) return 'pnpm';
    if (fs.existsSync(path.join(dir, 'yarn.lock'))) return 'yarn';
    return 'npm';
  }

  /** What can be run in this folder. */
  async options(rootId, rel) {
    const dir = await this.folder(rootId, rel);
    const pkg = this.readPackage(dir);
    const pm = this.manager(dir);
    const scripts = pkg?.scripts && typeof pkg.scripts === 'object'
      ? Object.entries(pkg.scripts).filter(([k, v]) => SCRIPT_RE.test(k) && typeof v === 'string').map(([name, cmd]) => ({ name, cmd: cmd.slice(0, 200) }))
      : [];
    return {
      hasPackage: !!pkg,
      manager: pm,
      scripts,
      quick: this.quickList().map((q, i) => ({ id: i, name: q.name, cmd: q.cmd })),
      running: this.list().filter((t) => t.dir.toLowerCase() === dir.toLowerCase()),
    };
  }

  quickList() {
    return (this.cfg.quickCommands || []).filter((q) => q && typeof q.name === 'string' && typeof q.cmd === 'string');
  }

  /** kind: 'script' (name), 'install', 'quick' (id), or 'custom' (cmd, shell: 'cmd' | 'powershell'). */
  async start(rootId, rel, { kind, name, id, cmd, shell }, who) {
    const dir = await this.folder(rootId, rel);
    const pm = this.manager(dir);
    let label;
    let line;
    if (kind === 'script') {
      const pkg = this.readPackage(dir);
      if (!SCRIPT_RE.test(String(name)) || !pkg?.scripts || typeof pkg.scripts[name] !== 'string') throw httpErr(404, `No script called "${name}" in this folder's package.json`);
      label = `${pm} run ${name}`;
      line = label;
    } else if (kind === 'install') {
      if (!this.readPackage(dir)) throw httpErr(400, 'This folder has no package.json');
      label = `${pm} install`;
      line = label;
    } else if (kind === 'quick') {
      const q = this.quickList()[Number(id)];
      if (!q) throw httpErr(404, 'No such quick command');
      label = q.name;
      line = q.cmd;
    } else if (kind === 'custom') {
      if (this.cfg.allowCustomCommands === false) throw httpErr(403, 'Typed commands are turned off in config.json (allowCustomCommands)');
      line = String(cmd || '').trim();
      if (!line) throw httpErr(400, 'Type a command');
      if (line.length > 2000 || /[\0\r\n]/.test(line)) throw httpErr(400, 'One line, at most 2000 characters');
      if (shell === 'powershell') line = `ps> ${line}`;
      label = line.length > 60 ? `${line.slice(0, 57)}…` : line;
    } else throw httpErr(400, 'Unknown kind');

    const same = [...this.tasks.values()].find((t) => t.running && t.dir.toLowerCase() === dir.toLowerCase() && t.line === line);
    if (same) throw httpErr(409, `${label} is already running here`, { id: same.id });
    if (this.list().filter((t) => t.running).length >= MAX_RUNNING) throw httpErr(429, `Already ${MAX_RUNNING} commands running. Stop one first.`);

    const env = { ...process.env, BROWSER: 'none', FORCE_COLOR: '0', NO_COLOR: '1', CI: process.env.CI || '' };
    for (const k of Object.keys(env)) if (/^(CLAUDECODE|CLAUDE_CODE_|CLAUDE_AGENT_SDK_)/.test(k)) delete env[k];
    const [exe, args] = line.startsWith('ps> ')
      ? ['powershell.exe', ['-NoProfile', '-NoLogo', '-Command', line.slice(4)]]
      // cmd.exe does not understand Node's \" escaping, so hand it the line verbatim, wrapped once ("/s" strips that pair)
      : ['cmd.exe', ['/d', '/s', '/c', `"${line}"`]];
    const child = this.spawnFn(exe, args, { cwd: dir, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], windowsVerbatimArguments: exe === 'cmd.exe' });
    child.stdin?.on('error', () => {}); // the program may close its input early
    const t = {
      id: uuid(),
      label,
      line,
      dir,
      rootId: Number(rootId),
      rel: rel || '',
      by: who?.kind === 'device' ? who.device.name : 'Laptop',
      startedAt: Date.now(),
      endedAt: null,
      code: null,
      state: 'running',
      running: true,
      stopRequested: false,
      port: null,
      lines: [],
      seq: 0,
      partial: { out: '', err: '' },
      child,
    };
    this.tasks.set(t.id, t);
    this.add(t, `> ${line}   (in ${dir})`, 'sys');
    child.stdout?.on('data', (b) => this.feed(t, 'out', b));
    child.stderr?.on('data', (b) => this.feed(t, 'err', b));
    child.on('error', (e) => this.add(t, `Could not start: ${e.message}`, 'err'));
    child.on('close', (code) => this.finished(t, code));
    this.activity?.log(who, 'Ran command', `${line} in ${dir}`);
    this.prune();
    return this.summary(t);
  }

  feed(t, stream, buf) {
    const text = t.partial[stream] + buf.toString('utf8').replace(ANSI_RE, '');
    const parts = text.split(/\r?\n/);
    t.partial[stream] = parts.pop();
    if (t.partial[stream].length > 4000) {
      parts.push(t.partial[stream]);
      t.partial[stream] = '';
    }
    for (const p of parts) this.add(t, p.replace(/\r/g, ''), stream);
    // A question without a newline ("Your name? ", "Proceed (y/N)?") would otherwise stay invisible until the answer.
    // If nothing more arrives soon, show the half line as it is.
    clearTimeout(t.flushTimer?.[stream]);
    if (t.partial[stream]) {
      t.flushTimer = t.flushTimer || {};
      t.flushTimer[stream] = setTimeout(() => {
        if (!t.partial[stream]) return;
        this.add(t, t.partial[stream].replace(/\r/g, ''), stream);
        t.partial[stream] = '';
      }, 400);
      t.flushTimer[stream].unref?.();
    }
  }

  add(t, text, stream) {
    t.seq++;
    t.lines.push({ n: t.seq, s: stream, t: text.slice(0, 2000) });
    if (t.lines.length > MAX_LINES) t.lines.splice(0, t.lines.length - MAX_LINES);
    if (!t.port && stream !== 'sys') {
      const m = PORT_RE.exec(text);
      if (m) {
        const p = Number(m[1]);
        if (p >= 1024 && p <= 65535 && p !== this.cfg.port) t.port = p;
      }
    }
  }

  finished(t, code) {
    for (const s of ['out', 'err']) clearTimeout(t.flushTimer?.[s]);
    for (const s of ['out', 'err']) if (t.partial[s]) this.add(t, t.partial[s], s);
    t.partial = { out: '', err: '' };
    t.running = false;
    t.endedAt = Date.now();
    t.code = code;
    t.state = t.stopRequested ? 'stopped' : code === 0 ? 'done' : 'failed';
    t.child = null;
    this.add(t, t.stopRequested ? 'Stopped.' : `Finished with exit code ${code}.`, 'sys');
    this.onExit?.(t);
    const ms = t.endedAt - t.startedAt;
    if (!t.stopRequested && (t.state === 'failed' || ms > 20_000)) {
      this.push?.notify({
        title: t.state === 'done' ? `✓ ${t.label} finished` : `✗ ${t.label} ${t.port ? 'stopped' : 'failed'}`,
        body: `${path.basename(t.dir)} · exit ${code} · ${Math.round(ms / 1000)}s`,
        url: `/#/t/${t.id}`,
        tag: `task-${t.id}`,
      }).catch(() => {});
    }
  }

  get(id) {
    const t = this.tasks.get(id);
    if (!t) throw httpErr(404, 'No such command run');
    return t;
  }

  summary(t) {
    return {
      id: t.id, label: t.label, dir: t.dir, rootId: t.rootId, rel: t.rel, by: t.by, startedAt: t.startedAt, endedAt: t.endedAt,
      code: t.code, state: t.state, running: t.running, port: t.port, lines: t.seq,
      last: t.lines.length ? t.lines[t.lines.length - 1].t.slice(0, 160) : '',
    };
  }

  list() {
    return [...this.tasks.values()].sort((a, b) => b.startedAt - a.startedAt).map((t) => this.summary(t));
  }

  log(id, after = 0) {
    const t = this.get(id);
    const lines = t.lines.filter((l) => l.n > after);
    return { task: this.summary(t), lines, next: t.seq, dropped: t.lines.length && t.lines[0].n > after + 1 };
  }

  /** Types a line into a running command (for prompts like "Continue? (y/n)"). */
  input(id, text) {
    const t = this.get(id);
    if (!t.running || !t.child?.stdin || t.child.stdin.destroyed) throw httpErr(409, 'Not running');
    const v = String(text ?? '');
    if (v.length > 4000) throw httpErr(400, 'Too long');
    t.child.stdin.write(`${v}\n`);
    this.add(t, `< ${v}`, 'in');
    return { ok: true };
  }

  async stop(id, who) {
    const t = this.get(id);
    if (!t.running) return this.summary(t);
    t.stopRequested = true;
    this.add(t, 'Stopping…', 'sys');
    await this.killFn(t.child.pid);
    this.activity?.log(who, 'Stopped command', `${t.label} in ${t.dir}`);
    return this.summary(t);
  }

  remove(id) {
    const t = this.get(id);
    if (t.running) throw httpErr(409, 'Stop it first');
    this.tasks.delete(id);
  }

  /** Keep the last 30 finished runs. */
  prune() {
    const done = [...this.tasks.values()].filter((t) => !t.running).sort((a, b) => a.startedAt - b.startedAt);
    while (done.length > 30) this.tasks.delete(done.shift().id);
  }

  async shutdown() {
    await Promise.all([...this.tasks.values()].filter((t) => t.running).map((t) => {
      t.stopRequested = true;
      return this.killFn(t.child.pid).catch(() => {});
    }));
  }
}

const execQuiet = (file, args) => new Promise((resolve) => execFile(file, args, { windowsHide: true, timeout: 20_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => resolve(err ? '' : stdout)));

/** [{ pid, ppid }] for every process on the laptop. */
async function processTable() {
  const out = await execQuiet('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }']);
  return out.split(/\r?\n/).map((l) => l.trim().split(/\s+/).map(Number)).filter((a) => a.length === 2 && a[0] > 0).map(([pid, ppid]) => ({ pid, ppid }));
}

/**
 * Kills a command and everything it started. `taskkill /T` alone misses processes that are still being
 * started at that moment (npm -> cmd -> node), and orphans keep their dead parent's id, so we remember every
 * id we have seen in the family and sweep a few times until nothing of it is left.
 */
export async function killTree(pid) {
  if (!pid) return;
  if (process.platform !== 'win32') {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      /* gone */
    }
    return;
  }
  const family = new Set([pid]);
  for (let round = 0; round < 4; round++) {
    const table = await processTable();
    for (let grew = true; grew;) {
      grew = false;
      for (const p of table) {
        if (family.has(p.ppid) && !family.has(p.pid) && p.pid !== process.pid) {
          family.add(p.pid);
          grew = true;
        }
      }
    }
    const alive = table.filter((p) => family.has(p.pid)).map((p) => p.pid);
    if (!alive.length) return;
    await Promise.all(alive.map((id) => execQuiet('taskkill.exe', ['/PID', String(id), '/T', '/F'])));
    await new Promise((r) => setTimeout(r, 500));
  }
}
