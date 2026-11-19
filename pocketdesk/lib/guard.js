import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tailscaleExe } from './share.js';

const execP = promisify(execFile);
const UNPAIRED_EVERY_MS = 6 * 3600_000; // one "unpaired device" alert per address per 6 hours
const WHOIS_TTL_MS = 3600_000;
const MAX_IPS = 6;
const LIVE = ['starting', 'working', 'waiting', 'idle'];

/**
 * Login alerts and the panic button.
 *  - A new device paired → the other devices get a notification.
 *  - An UNPAIRED device opened PocketDesk (it reached the pairing screen) → notification with its Tailscale name.
 *  - A paired device's login was used from a different Tailscale device (a copied cookie) → notification.
 *  - Panic: notify, stop every Claude session and command, stop dev-server sharing, unpair every device, lock the laptop.
 */
export class Guard {
  constructor({ auth, push, activity, sessions, tasks, share, lock, settings, whoisFn = defaultWhois, lockScreenFn = defaultLockScreen, now = Date.now }) {
    Object.assign(this, { auth, push, activity, sessions, tasks, share, lock, settings, whoisFn, lockScreenFn, now });
    this.unpairedSent = new Map(); // ip -> ms
    this.whoisCache = new Map(); // ip -> { at, info }
  }

  static clientIp(req) {
    const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    return xff || null;
  }

  async whois(ip) {
    const hit = this.whoisCache.get(ip);
    if (hit && this.now() - hit.at < WHOIS_TTL_MS) return hit.info;
    let info = null;
    try {
      info = await this.whoisFn(ip);
    } catch {
      /* Tailscale not answering: alert with the address only */
    }
    this.whoisCache.set(ip, { at: this.now(), info });
    return info;
  }

  async describe(ip, req) {
    const w = await this.whois(ip);
    const login = req.headers['tailscale-user-login'] || w?.login || null;
    const machine = w?.machine ? `${w.machine}${w.os ? ` (${w.os})` : ''}` : ip;
    return { machine, login, text: `${machine}${login ? ` · ${login}` : ''}` };
  }

  /** Called for requests that came through Tailscale. who = Auth.identify() result (null when not paired). */
  async observe(req, who, pathname) {
    if (!this.settings().newDevice) return;
    const ip = Guard.clientIp(req);
    if (!ip) return;
    if (!who) {
      if (pathname !== '/api/me' && pathname !== '/api/pair') return; // one alert per page open, not per call
      const last = this.unpairedSent.get(ip) || 0;
      if (this.now() - last < UNPAIRED_EVERY_MS) return;
      this.unpairedSent.set(ip, this.now());
      const d = await this.describe(ip, req);
      this.activity.log('PocketDesk', 'Unpaired device opened PocketDesk', d.text);
      await this.push.notify({ title: 'Someone opened PocketDesk', body: `An unpaired device reached the pairing screen: ${d.text}. If that was not you, check Setup → Only allow my own Tailscale login.`, url: '/#/laptop', tag: 'visitor' }).catch(() => {});
      return;
    }
    if (who.kind !== 'device') return;
    const dev = who.device;
    if (!Array.isArray(dev.ips)) dev.ips = [];
    if (dev.ips.includes(ip)) return;
    const first = dev.ips.length === 0;
    dev.ips = [...dev.ips, ip].slice(-MAX_IPS);
    await this.auth.save().catch(() => {});
    if (first) return; // devices paired before this feature: learn their address quietly
    const d = await this.describe(ip, req);
    this.activity.log('PocketDesk', 'Device login used from a new Tailscale device', `${dev.name}: ${d.text}`);
    await this.push.notify({ title: `${dev.name}'s login used from another device`, body: `${d.text}. If that was not you, press Panic (Laptop → Security) or remove ${dev.name} in Setup.`, url: '/#/laptop', tag: `newip-${dev.id}` }).catch(() => {});
  }

  /** A device just paired: tell the OTHER devices, and remember its address. */
  async paired(device, req) {
    const ip = Guard.clientIp(req);
    const stored = this.auth.devices.find((d) => d.id === device.id);
    if (stored && ip) {
      stored.ips = [ip];
      await this.auth.save().catch(() => {});
    }
    if (!this.settings().newDevice) return;
    const d = ip ? await this.describe(ip, req) : { text: req.headers['tailscale-user-login'] || '' };
    const others = this.push.deviceIds().filter((id) => id !== device.id);
    if (!others.length) return;
    await this.push.notify({ title: `New device paired: ${device.name}`, body: `${d.text}. If that was not you, remove it in Setup on the laptop, or press Panic.`, url: '/#/laptop', tag: 'paired', only: others }).catch(() => {});
  }

  /** The panic button. Order: tell the phones first (their subscriptions go next), then stop, unpair, lock. */
  async panic(who) {
    const by = who?.kind === 'device' ? who.device.name : 'the laptop';
    const out = { sessions: 0, commands: 0, shares: 0, devices: this.auth.devices.length, locked: false };
    await this.push.notify({ title: 'PocketDesk: panic button pressed', body: `By ${by}. Claude stopped, every device unpaired, laptop screen locked.`, url: '/', tag: 'panic' }).catch(() => {});
    for (const s of this.sessions.list()) {
      if (!LIVE.includes(s.state)) continue;
      try {
        await this.sessions.close(s.id);
        out.sessions++;
      } catch {
        /* already gone */
      }
    }
    for (const t of this.tasks.list()) {
      if (t.state !== 'running') continue;
      try {
        await this.tasks.stop(t.id, who);
        out.commands++;
      } catch {
        /* already gone */
      }
    }
    try {
      for (const sh of await this.share.list()) {
        await this.share.unshare(sh.port).catch(() => {});
        out.shares++;
      }
    } catch {
      /* Tailscale not answering */
    }
    this.lock.lockAll();
    this.auth.devices = [];
    this.auth.pairing = null;
    await this.auth.save();
    await this.push.removeAll();
    try {
      await this.lockScreenFn();
      out.locked = true;
    } catch {
      /* not on Windows */
    }
    this.activity.log(who || 'Laptop', 'PANIC button', `stopped ${out.sessions} Claude session(s), ${out.commands} command(s), ${out.shares} share(s); unpaired ${out.devices} device(s)`);
    return out;
  }
}

async function defaultWhois(ip) {
  if (!/^[\d.:a-fA-F]+$/.test(ip)) return null;
  const { stdout } = await execP(tailscaleExe(), ['whois', '--json', ip], { timeout: 8000, windowsHide: true });
  const j = JSON.parse(stdout);
  const n = j.Node || {};
  return {
    machine: n.ComputedName || n.Hostinfo?.Hostname || (n.Name ? String(n.Name).split('.')[0] : null),
    os: n.Hostinfo?.OS || null,
    login: j.UserProfile?.LoginName || null,
  };
}

function defaultLockScreen() {
  if (process.platform !== 'win32') return Promise.reject(new Error('not Windows'));
  return execP('rundll32.exe', ['user32.dll,LockWorkStation'], { windowsHide: true });
}
