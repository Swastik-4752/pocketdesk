import path from 'node:path';
import * as webpush from 'web-push';
import { readJson, writeJsonAtomic } from './util.js';

/**
 * Phone notifications (Web Push). Keys are made on this laptop; the push service only ever sees
 * encrypted payloads, and payloads are kept short (no code, no file contents).
 */
export class Push {
  constructor(cfg) {
    this.keysFile = path.join(cfg.dataDir, 'vapid.json');
    this.subsFile = path.join(cfg.dataDir, 'push-subscriptions.json');
    let keys = readJson(this.keysFile, null);
    if (!keys) {
      keys = webpush.generateVAPIDKeys();
      writeJsonAtomic(this.keysFile, keys).catch((e) => console.error('[push] cannot save keys', e));
    }
    this.keys = keys;
    webpush.setVapidDetails('mailto:pocketdesk@localhost.invalid', keys.publicKey, keys.privateKey);
    this.subs = readJson(this.subsFile, []); // [{ deviceId, sub }]
  }

  publicKey() {
    return this.keys.publicKey;
  }

  async subscribe(deviceId, sub) {
    if (!sub || typeof sub.endpoint !== 'string' || !sub.keys) throw new Error('Bad subscription');
    this.subs = this.subs.filter((s) => s.sub.endpoint !== sub.endpoint);
    this.subs.push({ deviceId, sub: { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } } });
    await writeJsonAtomic(this.subsFile, this.subs);
  }

  deviceIds() {
    return [...new Set(this.subs.map((s) => s.deviceId))];
  }

  async removeAll() {
    this.subs = [];
    await writeJsonAtomic(this.subsFile, this.subs);
  }

  async removeDevice(deviceId) {
    this.subs = this.subs.filter((s) => s.deviceId !== deviceId);
    await writeJsonAtomic(this.subsFile, this.subs);
  }

  /** Sends to every subscribed device; drops subscriptions the push service says are gone. */
  async notify({ title, body, url, tag, actions, decide, only }) {
    // `only`: send to these device ids only (e.g. not to the device that caused the alert)
    const subs = only ? this.subs.filter((s) => only.includes(s.deviceId)) : this.subs;
    if (!subs.length) return;
    const payload = JSON.stringify({ title, body: String(body || '').slice(0, 180), url, tag, actions, decide });
    const dead = [];
    await Promise.all(subs.map(async (s) => {
      try {
        await webpush.sendNotification(s.sub, payload, { TTL: 3600, urgency: 'high' });
      } catch (e) {
        if (e.statusCode === 404 || e.statusCode === 410) dead.push(s.sub.endpoint);
        else console.warn('[push] send failed', e.statusCode || e.message);
      }
    }));
    if (dead.length) {
      this.subs = this.subs.filter((s) => !dead.includes(s.sub.endpoint));
      await writeJsonAtomic(this.subsFile, this.subs);
    }
  }
}
