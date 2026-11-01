import path from 'node:path';
import crypto from 'node:crypto';
import { httpErr, randomToken, readJson, safeEqual, sha256, uuid, writeJsonAtomic } from './util.js';

const COOKIE = 'pd_dev';
const PAIR_TTL_MS = 5 * 60 * 1000;
const PAIR_MAX_TRIES = 5;
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * Who may use PocketDesk:
 *  - "laptop": a browser on this laptop talking straight to 127.0.0.1 (no proxy headers). It can pair devices
 *    and change the account; nothing else on the network can reach that port because it binds to 127.0.0.1.
 *  - "device": a paired phone/tablet coming through `tailscale serve`, carrying its own device cookie.
 */
export class Auth {
  constructor(cfg) {
    this.cfg = cfg;
    this.file = path.join(cfg.dataDir, 'devices.json');
    this.devices = readJson(this.file, []);
    this.pairing = null; // { code, expires, tries }
    this.lastSeenDirty = false;
    setInterval(() => this.flushLastSeen(), 60_000).unref();
  }

  isLocal(req) {
    const addr = req.socket.remoteAddress || '';
    const loopback = addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
    const proxied = req.headers['x-forwarded-for'] || req.headers['tailscale-user-login'] || req.headers['x-forwarded-host'];
    const host = String(req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
    return loopback && !proxied && LOCAL_HOSTS.has(host);
  }

  /** Returns { kind: 'laptop' } or { kind: 'device', device } or null. */
  identify(req) {
    if (this.isLocal(req)) return { kind: 'laptop' };
    if (!this.tailscaleAllowed(req)) return null;
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (!token) return null;
    const hash = sha256(token);
    const device = this.devices.find((d) => safeEqual(d.hash, hash));
    if (!device) return null;
    if (Date.now() - (device.lastSeen || 0) > 60_000) {
      device.lastSeen = Date.now();
      this.lastSeenDirty = true;
    }
    return { kind: 'device', device };
  }

  /** Tailscale logins allowed in (config.json list + the Setup switch). Empty = any device in your tailnet. */
  allowedLogins() {
    return [...(this.cfg.allowedTailscaleUsers || []), ...(this.extraAllowed?.() || [])].map((s) => String(s).toLowerCase());
  }

  tailscaleAllowed(req) {
    const allowed = this.allowedLogins();
    if (!allowed.length) return true;
    return allowed.includes(String(req.headers['tailscale-user-login'] || '').toLowerCase());
  }

  /** Throws 401 unless the request is from the laptop or a paired device. */
  require(req) {
    const who = this.identify(req);
    if (!who) throw httpErr(401, 'This device is not paired');
    return who;
  }

  requireLaptop(req) {
    if (!this.isLocal(req)) throw httpErr(403, 'Only allowed from the laptop itself');
    return { kind: 'laptop' };
  }

  /** Blocks cross-site form posts: every state-changing call must send this custom header. */
  checkCsrf(req) {
    if (req.method === 'GET' || req.method === 'HEAD') return;
    if (req.headers['x-pocketdesk'] !== '1') throw httpErr(403, 'Missing request header');
  }

  newPairingCode() {
    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    this.pairing = { code, expires: Date.now() + PAIR_TTL_MS, tries: 0 };
    return { code, expires: this.pairing.expires };
  }

  pairingStatus() {
    if (!this.pairing || this.pairing.expires < Date.now()) return null;
    return { code: this.pairing.code, expires: this.pairing.expires };
  }

  /** Swaps a valid pairing code for a long-lived device token. The code works once. */
  async pair(code, name, userAgent, tailscaleLogin) {
    const p = this.pairing;
    if (!p || p.expires < Date.now()) throw httpErr(400, 'No pairing code is active. Make one on the laptop first.');
    const allowed = this.allowedLogins();
    if (allowed.length && !allowed.includes(String(tailscaleLogin || '').toLowerCase())) throw httpErr(403, 'Only your own Tailscale login may pair a device');
    p.tries++;
    if (p.tries > PAIR_MAX_TRIES) {
      this.pairing = null;
      throw httpErr(429, 'Too many wrong codes. Make a new code on the laptop.');
    }
    if (!safeEqual(String(code || '').trim(), p.code)) throw httpErr(401, 'Wrong code');
    this.pairing = null;
    const token = randomToken(32);
    const device = {
      id: uuid(),
      name: String(name || 'Phone').slice(0, 40),
      hash: sha256(token),
      created: Date.now(),
      lastSeen: Date.now(),
      userAgent: String(userAgent || '').slice(0, 200),
      tailscaleLogin: tailscaleLogin ? String(tailscaleLogin).slice(0, 100) : null,
    };
    this.devices.push(device);
    await this.save();
    return { device: publicDevice(device), token };
  }

  listDevices() {
    return this.devices.map(publicDevice);
  }

  async removeDevice(id) {
    const before = this.devices.length;
    this.devices = this.devices.filter((d) => d.id !== id);
    if (this.devices.length === before) throw httpErr(404, 'No such device');
    await this.save();
  }

  cookieFor(token, req) {
    const secure = req.headers['x-forwarded-proto'] === 'https' || !!req.headers['tailscale-user-login'];
    return `${COOKIE}=${token}; Path=/; Max-Age=${365 * 86400}; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
  }

  clearCookie() {
    return `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict`;
  }

  async save() {
    await writeJsonAtomic(this.file, this.devices);
  }

  flushLastSeen() {
    if (!this.lastSeenDirty) return;
    this.lastSeenDirty = false;
    this.save().catch((e) => console.error('[auth] save failed', e));
  }
}

function publicDevice(d) {
  return { id: d.id, name: d.name, created: d.created, lastSeen: d.lastSeen, userAgent: d.userAgent, tailscaleLogin: d.tailscaleLogin };
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
