import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { APP_DIR } from './config.js';

const SCRIPT = path.join(APP_DIR, 'lib', 'travel-helper.ps1');
const CALL_TIMEOUT_MS = 60_000;

/**
 * Windows side of Travel mode: one long-lived Windows PowerShell process (lib/travel-helper.ps1) that keeps
 * its compiled helpers loaded, so pausing apps, pinning cores and reading power settings costs no recompile.
 * It starts on first use and quits after a few idle minutes. Nothing here needs admin rights.
 */
export class WinHelper {
  constructor({ idleMs = 5 * 60_000 } = {}) {
    this.idleMs = idleMs;
    this.child = null;
    this.seq = 0;
    this.waiting = new Map();
    this.buf = '';
    this.idleTimer = null;
  }

  start() {
    if (this.child) return;
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => this.onData(d));
    child.stderr.on('data', (d) => process.env.POCKETDESK_DEBUG && process.stderr.write(`[travel-helper] ${d}`));
    child.stdin.on('error', () => {});
    child.on('exit', () => {
      if (this.child === child) this.child = null;
      for (const [, w] of this.waiting) w.reject(new Error('Windows helper stopped'));
      this.waiting.clear();
    });
  }

  onData(d) {
    this.buf += d;
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line.startsWith('{')) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      const w = this.waiting.get(msg.id);
      if (!w) continue;
      this.waiting.delete(msg.id);
      clearTimeout(w.timer);
      if (msg.ok) w.resolve(msg.result);
      else w.reject(new Error(msg.error || 'Windows helper failed'));
    }
  }

  call(op, args = {}) {
    if (process.platform !== 'win32') return Promise.reject(new Error('This only works on Windows'));
    this.start();
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.stop(), this.idleMs);
    this.idleTimer.unref();
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error(`Windows helper did not answer (${op})`));
      }, CALL_TIMEOUT_MS);
      this.waiting.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ id, op, args })}\n`);
    });
  }

  stop() {
    clearTimeout(this.idleTimer);
    if (this.child) {
      this.child.stdin.end();
      const c = this.child;
      setTimeout(() => c.kill(), 3000).unref();
      this.child = null;
    }
  }

  // ---- the operations Travel mode uses ----
  cores() { return this.call('cores'); }
  procs() { return this.call('procs'); }
  suspend(items) { return this.call('suspend', { items }); }
  resume(items) { return this.call('resume', { items }); }
  pin(items, mask, eco) { return this.call('pin', { items, mask: String(mask), eco: !!eco }); }
  unpin(items) { return this.call('unpin', { items }); }
  powerGet() { return this.call('powerGet'); }
  powerSet(scheme, values) { return this.call('powerSet', { scheme, values }); }
  bluetooth(state) { return this.call('bluetooth', state ? { state } : {}); }
  async bootTime() { return Date.parse((await this.call('bootTime')).at); }

  // ---- screen peek, clipboard, find my laptop ----
  screenshot(width, quality) { return this.call('screenshot', { width, quality }); }
  clipGet() { return this.call('clipGet'); }
  clipSet(text) { return this.call('clipSet', { text }); }
  soundStart() { return this.call('soundStart'); }
  soundStop() { return this.call('soundStop'); }

  /** Sleep or hibernate a moment later, so the phone still gets the answer. */
  sleep(hibernate) {
    setTimeout(() => {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Application]::SetSuspendState('${hibernate ? 'Hibernate' : 'Suspend'}', $false, $false)`], { windowsHide: true });
    }, 2000).unref?.();
  }
}
