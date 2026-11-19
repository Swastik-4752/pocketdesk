import os from 'node:os';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { httpErr } from './util.js';

const execP = promisify(execFile);
const PEEK_GRANT_MS = 10 * 60_000; // after typing the PIN, screen peek works for 10 minutes
const SOUND_MS = 60_000; // the find-my-laptop alarm stops by itself after a minute
const POWER_DELAY_S = 60; // restart / shutdown wait a minute, so they can be cancelled
const MAX_CLIP = 1024 * 1024;

/**
 * Laptop control from the phone: screen peek (view only), clipboard both ways, send links / files / notes to the
 * laptop, find-my-laptop (alarm + where it is), and restart / shutdown with a minute to cancel.
 * The PIN-gated ones (peek, restart, shutdown) ask for the PIN again even when the phone is unlocked.
 */
export class Desk {
  constructor(cfg, { win, lock, files, status, activity, runFn = execP, home = process.env.POCKETDESK_HOME || os.homedir(), now = Date.now }) {
    Object.assign(this, { cfg, win, lock, files, status, activity, runFn, home, now });
    this.peekGrants = new Map(); // deviceId -> until
    this.soundTimer = null;
    this.pendingPower = null; // { action, at }
  }

  // ---------- PIN re-check for the sensitive actions ----------
  needPin(who, pin) {
    if (who?.kind !== 'device' || !this.lock.enabled()) return;
    if (pin == null || pin === '') throw httpErr(401, 'Type your PIN', { needPin: true });
    if (!this.lock.checkPin(pin)) throw httpErr(401, 'Wrong PIN', { needPin: true });
  }

  // ---------- screen peek ----------
  peekState(who) {
    const needs = who?.kind === 'device' && this.lock.enabled();
    const until = needs ? this.peekGrants.get(who.device.id) || 0 : Infinity;
    return { pinNeeded: needs && until < this.now(), until: Number.isFinite(until) ? until : null };
  }

  startPeek(who, pin) {
    this.needPin(who, pin);
    if (who?.kind === 'device') this.peekGrants.set(who.device.id, this.now() + PEEK_GRANT_MS);
    this.activity.log(who, 'Screen peek started');
    return this.peekState(who);
  }

  async screenshot(who, width) {
    if (this.peekState(who).pinNeeded) throw httpErr(401, 'Type your PIN to see the screen', { needPin: true });
    const w = Math.max(320, Math.min(2560, Number(width) || 1280));
    const r = await this.win.screenshot(w, w > 1600 ? 70 : 60).catch((e) => {
      throw httpErr(409, e.message.replace(/^Exception calling .*?: /, ''));
    });
    return Buffer.from(r.jpeg, 'base64');
  }

  // ---------- clipboard ----------
  async clipboard(who) {
    const r = await this.win.clipGet();
    this.activity.log(who, 'Read laptop clipboard', r.png ? 'picture' : `${(r.text || '').length} characters`);
    return { text: r.text ?? null, image: r.png ? `data:image/png;base64,${r.png}` : null };
  }

  async setClipboard(who, text) {
    text = String(text ?? '');
    if (text.length > MAX_CLIP) throw httpErr(413, 'Text is larger than 1 MB');
    await this.win.clipSet(text);
    this.activity.log(who, 'Set laptop clipboard', `${text.length} characters`);
    return { ok: true, length: text.length };
  }

  // ---------- send to laptop ----------
  inboxDir() {
    return path.join(this.home, 'Downloads', 'From phone');
  }

  /** Where shared files go: { rootId, rel, path }. Made on first use. */
  async inbox() {
    const dir = this.inboxDir();
    await fsp.mkdir(dir, { recursive: true });
    const loc = this.files.locate(dir);
    return { ...loc, path: dir };
  }

  /** Opens a web link in the laptop's default browser. Only http(s). */
  async openUrl(who, url) {
    let u;
    try {
      u = new URL(String(url || '').trim());
    } catch {
      throw httpErr(400, 'That is not a web link');
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw httpErr(400, 'Only http and https links can be opened');
    if (process.platform !== 'win32') throw httpErr(400, 'Only supported on Windows');
    // rundll32 hands the URL to the default browser without going through a shell
    await this.runFn('rundll32.exe', ['url.dll,FileProtocolHandler', u.href], { windowsHide: true });
    this.activity.log(who, 'Opened link on laptop', u.host);
    return { ok: true, url: u.href };
  }

  /** Appends a note (text / link shared from the phone) to "From phone/Notes from phone.md". */
  async saveNote(who, { title, text, url }) {
    const body = [title, text, url].map((x) => String(x || '').trim()).filter(Boolean);
    if (!body.length) throw httpErr(400, 'Nothing to save');
    const all = body.join('\n');
    if (all.length > 100_000) throw httpErr(413, 'Note is too long');
    const { path: dir } = await this.inbox();
    const file = path.join(dir, 'Notes from phone.md');
    const stamp = new Date(this.now()).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
    await fsp.appendFile(file, `\n## ${stamp}\n\n${all}\n`);
    this.activity.log(who, 'Saved note on laptop', `${all.length} characters`);
    return { ok: true, file };
  }

  // ---------- find my laptop ----------
  async findStart(who) {
    const r = await this.win.soundStart();
    clearTimeout(this.soundTimer);
    this.soundTimer = setTimeout(() => this.findStop().catch(() => {}), SOUND_MS);
    this.soundTimer.unref?.();
    this.activity.log(who, 'Find my laptop: alarm on');
    return { playing: true, fullVolume: r.fullVolume, stopsInSec: SOUND_MS / 1000 };
  }

  async findStop(who) {
    clearTimeout(this.soundTimer);
    this.soundTimer = null;
    const r = await this.win.soundStop();
    if (who) this.activity.log(who, 'Find my laptop: alarm off');
    return { playing: false, stopped: r.stopped };
  }

  /** Where the laptop is, as far as it can tell: Wi-Fi name, addresses, battery, how long awake. */
  async where() {
    const out = { host: os.hostname(), wifi: null, addresses: [], tailscale: null, battery: null, uptimeSec: Math.round(os.uptime()), at: this.now() };
    try {
      const { stdout } = await this.runFn('netsh.exe', ['wlan', 'show', 'interfaces'], { timeout: 8000, windowsHide: true });
      out.wifi = parseWifi(stdout);
    } catch {
      /* no Wi-Fi adapter */
    }
    for (const [name, list] of Object.entries(os.networkInterfaces())) {
      for (const a of list || []) {
        if (a.internal || a.family !== 'IPv4') continue;
        if (a.address.startsWith('100.') && /tailscale/i.test(name)) out.tailscale = a.address;
        else if (!a.address.startsWith('169.254.')) out.addresses.push({ name, address: a.address });
      }
    }
    try {
      out.battery = (await this.status.get()).battery;
    } catch {
      /* ignore */
    }
    return out;
  }

  // ---------- restart / shutdown ----------
  async power(who, action, pin) {
    if (!this.cfg.allowPowerActions) throw httpErr(403, 'Power actions are turned off in config.json');
    if (process.platform !== 'win32') throw httpErr(400, 'Only supported on Windows');
    if (action === 'cancel') {
      await this.runFn('shutdown.exe', ['/a'], { windowsHide: true }).catch(() => {
        throw httpErr(409, 'Nothing to cancel (no restart or shutdown is waiting)');
      });
      this.pendingPower = null;
      this.activity.log(who, 'Power', 'cancelled restart/shutdown');
      return { ok: true, message: 'Cancelled. The laptop keeps running.' };
    }
    if (action !== 'restart' && action !== 'shutdown') throw httpErr(400, 'Unknown action');
    this.needPin(who, pin);
    const by = who?.kind === 'device' ? who.device.name : 'the laptop';
    await this.runFn('shutdown.exe', [action === 'restart' ? '/r' : '/s', '/t', String(POWER_DELAY_S), '/c', `PocketDesk: ${action} requested from ${by}`], { windowsHide: true });
    this.pendingPower = { action, at: this.now() + POWER_DELAY_S * 1000 };
    this.activity.log(who, 'Power', `${action} in ${POWER_DELAY_S} s`);
    return {
      ok: true,
      pending: this.pendingPower,
      message: action === 'restart'
        ? `Restarting in ${POWER_DELAY_S} seconds. PocketDesk comes back only after someone signs in to Windows on the laptop.`
        : `Shutting down in ${POWER_DELAY_S} seconds. The phone cannot turn it back on.`,
    };
  }

  powerState() {
    if (this.pendingPower && this.pendingPower.at < this.now()) this.pendingPower = null;
    return { pending: this.pendingPower };
  }
}

export function parseWifi(text) {
  const get = (k) => {
    const m = new RegExp(`^\\s*${k}\\s*:\\s*(.+)$`, 'mi').exec(text);
    return m ? m[1].trim() : null;
  };
  const state = get('State');
  if (!state) return null;
  return { connected: /^connected$/i.test(state), ssid: get('SSID'), signal: get('Signal') };
}
