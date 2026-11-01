import path from 'node:path';
import { httpErr, readJson, writeJsonAtomic } from './util.js';

const TICK_MS = 60_000;
const DEFAULTS = { batteryLow: 20, unplugged: true, hotC: 90, backOnline: true, wake: true, laptopDone: true, laptopWaitMin: 5, stuckMin: 15, newDevice: true };

/**
 * Phone alerts about the laptop itself: low battery, charger pulled out, too hot, internet back after an
 * outage, and woke up from sleep / PocketDesk restarted. Checked once a minute.
 */
export class Alerts {
  constructor(cfg, { status, push, activity, fetchFn = globalThis.fetch, now = Date.now } = {}) {
    this.file = path.join(cfg.dataDir, 'alerts.json');
    this.settings = { ...DEFAULTS, ...readJson(this.file, {}) };
    this.status = status;
    this.push = push;
    this.activity = activity;
    this.fetchFn = fetchFn;
    this.now = now;
    this.s = { lastTick: null, plugged: null, lowSent: false, criticalSent: false, hotSent: false, offlineSince: null, failStreak: 0, startedSent: false };
    this.timer = null;
  }

  get() {
    return { ...this.settings };
  }

  async set(patch) {
    const next = { ...this.settings };
    if ('batteryLow' in patch) next.batteryLow = intIn(patch.batteryLow, 0, 95, 'Battery level');
    if ('hotC' in patch) next.hotC = intIn(patch.hotC, 0, 110, 'Temperature');
    if ('laptopWaitMin' in patch) next.laptopWaitMin = intIn(patch.laptopWaitMin, 0, 120, 'Waiting time');
    if ('stuckMin' in patch) next.stuckMin = intIn(patch.stuckMin, 0, 240, 'No-progress time');
    for (const k of ['unplugged', 'backOnline', 'wake', 'laptopDone', 'newDevice']) if (k in patch) next[k] = !!patch[k];
    this.settings = next;
    await writeJsonAtomic(this.file, next);
    return this.get();
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.check().catch((e) => console.error('[alerts]', e.message)), TICK_MS);
    this.timer.unref();
    setTimeout(() => this.check().catch(() => {}), 5000).unref();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  async send(title, body, tag) {
    this.activity?.log('PocketDesk', 'Alert', `${title}${body ? ` - ${body}` : ''}`);
    await this.push?.notify({ title, body, url: '/#/laptop', tag }).catch(() => {});
  }

  async online() {
    try {
      await this.fetchFn('https://fcm.googleapis.com/', { method: 'HEAD', signal: AbortSignal.timeout(8000) });
      return true; // any HTTP answer means the internet works
    } catch {
      return false;
    }
  }

  /** One check. Exposed for tests. */
  async check() {
    const now = this.now();
    const cfg = this.settings;
    const gap = this.s.lastTick ? now - this.s.lastTick : 0;
    const first = this.s.lastTick == null;
    this.s.lastTick = now;

    const up = await this.online();
    if (!up) {
      this.s.failStreak++;
      if (this.s.failStreak >= 2 && !this.s.offlineSince) this.s.offlineSince = now - TICK_MS;
    } else {
      if (this.s.offlineSince && cfg.backOnline) {
        const mins = Math.max(1, Math.round((now - this.s.offlineSince) / 60000));
        await this.send('Laptop is back online', `It had no internet for about ${mins} min.`, 'online');
      }
      this.s.offlineSince = null;
      this.s.failStreak = 0;
    }

    if (cfg.wake && up) {
      if (first && !this.s.startedSent) {
        this.s.startedSent = true;
        await this.send('PocketDesk started', 'The laptop (or PocketDesk) was restarted. Earlier Claude sessions are paused; open one to continue it.', 'start');
      } else if (gap > 3 * TICK_MS) {
        await this.send('Laptop woke up', `It was asleep or frozen for about ${Math.round(gap / 60000)} min. Long jobs may have been interrupted.`, 'wake');
      }
    }

    let st = null;
    try {
      st = await this.status.get({ fresh: true });
    } catch {
      return;
    }
    const b = st.battery;
    if (b) {
      if (this.s.plugged === true && !b.pluggedIn && cfg.unplugged) await this.send('Charger unplugged', `The laptop is on battery (${b.percent}%).`, 'power');
      this.s.plugged = b.pluggedIn;
      if (b.pluggedIn || b.percent > cfg.batteryLow + 5) {
        this.s.lowSent = false;
        this.s.criticalSent = false;
      }
      if (!b.pluggedIn && cfg.batteryLow > 0) {
        if (b.percent <= Math.min(10, cfg.batteryLow) && !this.s.criticalSent) {
          this.s.criticalSent = true;
          this.s.lowSent = true;
          await this.send(`Battery critical: ${b.percent}%`, 'The laptop will shut down soon. Plug it in or save your work.', 'battery');
        } else if (b.percent <= cfg.batteryLow && !this.s.lowSent) {
          this.s.lowSent = true;
          await this.send(`Battery low: ${b.percent}%`, 'Plug the laptop in to keep Claude running.', 'battery');
        }
      }
    }
    const t = st.temperatureC;
    if (t != null && cfg.hotC > 0) {
      if (t >= cfg.hotC && !this.s.hotSent) {
        this.s.hotSent = true;
        await this.send(`Laptop is hot: ${Math.round(t)}°C`, 'Check that the vents are not blocked (e.g. lid closed inside a bag).', 'hot');
      } else if (t < cfg.hotC - 5) this.s.hotSent = false;
    }
  }
}

function intIn(v, lo, hi, label) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < lo || n > hi) throw httpErr(400, `${label} must be ${lo} to ${hi}`);
  return n;
}
