import path from 'node:path';
import crypto from 'node:crypto';
import { httpErr, readJson, writeJsonAtomic } from './util.js';

const MAX_TRIES = 5;
const BLOCK_MS = 15 * 60_000;
const REMOVE_AFTER = 10;

/**
 * Optional PIN on top of pairing. When a PIN is set, a paired phone must type it after being idle for
 * `lockMinutes`. 5 wrong PINs block that device for 15 minutes; 10 in a row unpair it.
 * The laptop itself is never locked (it is already behind the Windows login).
 */
export class Lock {
  constructor(cfg) {
    this.file = path.join(cfg.dataDir, 'security.json');
    this.state = { pin: null, lockMinutes: 15, tailscaleUsers: [], actionsWhileLocked: false, ...readJson(this.file, {}) };
    this.unlockedUntil = new Map(); // deviceId -> ms
    this.fails = new Map(); // deviceId -> { count, blockedUntil }
  }

  enabled() {
    return !!this.state.pin;
  }

  settings() {
    return { pinSet: this.enabled(), lockMinutes: this.state.lockMinutes, tailscaleUsers: [...this.state.tailscaleUsers], actionsWhileLocked: !!this.state.actionsWhileLocked };
  }

  checkPin(pin) {
    if (!this.enabled()) return true;
    const { salt, hash } = this.state.pin;
    return crypto.timingSafeEqual(crypto.scryptSync(String(pin ?? ''), salt, 32), Buffer.from(hash, 'hex'));
  }

  async setTailscaleUsers(list) {
    this.state.tailscaleUsers = list.map((s) => String(s).slice(0, 100));
    await writeJsonAtomic(this.file, this.state);
    return this.settings();
  }

  /** Allow / Deny buttons on notifications keep working while this phone is PIN-locked. */
  async setActionsWhileLocked(on) {
    this.state.actionsWhileLocked = !!on;
    await writeJsonAtomic(this.file, this.state);
    return this.settings();
  }

  lockAll() {
    this.unlockedUntil.clear();
  }

  async setPin(pin, lockMinutes) {
    if (pin != null) {
      if (!/^\d{4,8}$/.test(String(pin))) throw httpErr(400, 'PIN must be 4 to 8 digits');
      const salt = crypto.randomBytes(16).toString('hex');
      this.state.pin = { salt, hash: crypto.scryptSync(String(pin), salt, 32).toString('hex') };
      this.unlockedUntil.clear(); // every phone has to type the new PIN
    }
    if (lockMinutes != null) {
      const m = Number(lockMinutes);
      if (!Number.isInteger(m) || m < 1 || m > 1440) throw httpErr(400, 'Lock time must be 1 to 1440 minutes');
      this.state.lockMinutes = m;
    }
    await writeJsonAtomic(this.file, this.state);
    return this.settings();
  }

  async clearPin() {
    this.state.pin = null;
    await writeJsonAtomic(this.file, this.state);
    return this.settings();
  }

  isLocked(deviceId) {
    if (!this.enabled()) return false;
    return (this.unlockedUntil.get(deviceId) || 0) < Date.now();
  }

  /** Sliding window: every request from an unlocked device keeps it unlocked a bit longer. */
  touch(deviceId) {
    if (this.enabled() && !this.isLocked(deviceId)) this.unlockedUntil.set(deviceId, Date.now() + this.state.lockMinutes * 60_000);
  }

  lockNow(deviceId) {
    this.unlockedUntil.delete(deviceId);
  }

  /** Returns { ok } or throws. `onTooMany` is called when the device should be unpaired. */
  async unlock(deviceId, pin, onTooMany) {
    if (!this.enabled()) return { ok: true };
    const f = this.fails.get(deviceId) || { count: 0, blockedUntil: 0 };
    if (f.blockedUntil > Date.now()) throw httpErr(429, `Too many wrong PINs. Try again in ${Math.ceil((f.blockedUntil - Date.now()) / 60000)} min.`);
    if (this.checkPin(pin)) {
      this.fails.delete(deviceId);
      this.unlockedUntil.set(deviceId, Date.now() + this.state.lockMinutes * 60_000);
      return { ok: true };
    }
    f.count++;
    if (f.count >= REMOVE_AFTER) {
      this.fails.delete(deviceId);
      await onTooMany?.();
      throw httpErr(401, 'Too many wrong PINs. This device was unpaired.');
    }
    if (f.count % MAX_TRIES === 0) f.blockedUntil = Date.now() + BLOCK_MS;
    this.fails.set(deviceId, f);
    throw httpErr(401, `Wrong PIN (${MAX_TRIES - (f.count % MAX_TRIES || MAX_TRIES)} tries left before a 15-minute block)`);
  }
}
