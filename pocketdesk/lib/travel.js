import fsp from 'node:fs/promises';
import path from 'node:path';
import { httpErr, readJson, writeJsonAtomic } from './util.js';
import { TRAVEL_NOTE } from '../hooks/switch-to-phone.mjs';

/**
 * Travel mode: keep Claude working with the lid closed in a bag for 30-90 minutes, as cool as possible.
 *
 *  - Pauses (does not close) the apps you pick, so they make no heat and resume exactly where they were.
 *  - Keeps running: PocketDesk, the Claude desktop app, Claude in terminals, everything they started, Tailscale, Windows.
 *  - Power plan: turbo boost off, CPU speed capped, CPU "energy preference" to full power-saving, Windows energy
 *    saver on, lid "do nothing" for the trip. The old values are saved first and put back at the end.
 *  - Claude and what it runs go onto the 4 efficiency cores, in Windows efficiency mode.
 *  - Bluetooth off for the trip.
 *  - Claude is told to avoid heavy local work; heavy Project-tab commands wait until the trip ends.
 *  - Ends by itself: timer (with a 5-minute warning and a grace period while Claude still works), "sleep when
 *    Claude is done", charger plugged in, or the laptop waking up (lid opened). Then everything comes back.
 * Survives a PocketDesk restart (state in data/travel.json); after a reboot it just puts the power plan back.
 */

export const LEVELS = {
  coolest: { label: 'Coolest', cpuMax: 60, freqMax: 1600, epp: 100 },
  cool: { label: 'Cool', cpuMax: 85, freqMax: 2200, epp: 90 },
};
const DURATIONS = [15, 30, 45, 60, 90, 120];
const TICK_MS = 30_000;
const SCAN_EVERY = 2; // rescan processes every 2nd tick
const WARN_BEFORE_MS = 5 * 60_000;
const GRACE_MS = 10 * 60_000;
const DONE_IDLE_MS = 3 * 60_000;
const NEVER_BUSY_IDLE_MS = 15 * 60_000;
const SLEEP_NOTICE_MS = 60_000;
const BUSY_TRANSCRIPT_MS = 150_000;
const DRAIN_WINDOW_MS = 6 * 60_000;
const DRAIN_PER_MIN = 1.0;
const MAX_QUEUE = 5;

/** Never paused: Windows shell pieces that live outside C:\Windows, and things the trip itself needs. */
const NEVER = new Set(['tailscale-ipn', 'tailscaled', 'tailscale', 'nvdisplay.container', 'audiodg', 'ctfmon', 'textinputhost', 'dwm', 'explorer',
  'sihost', 'shellexperiencehost', 'startmenuexperiencehost', 'searchhost', 'runtimebroker', 'securityhealthsystray', 'conhost', 'openconsole',
  'widgets', 'lockapp', 'msmpeng', 'nissrv', 'powershell', 'pwsh']);
/** Paused by default (when not running Claude): apps that are known to make heat in the background. */
const HEAVY = new Set(['chrome', 'msedge', 'firefox', 'brave', 'opera', 'vivaldi', 'code', 'cursor', 'windsurf', 'electron', 'discord', 'spotify',
  'slack', 'teams', 'ms-teams', 'whatsapp', 'telegram', 'docker desktop', 'steam', 'steamwebhelper', 'epicgameslauncher', 'onedrive', 'notion',
  'figma', 'obs64', 'vlc', 'zoom', 'postman', 'idea64', 'pycharm64', 'webstorm64', 'studio64', 'blender', 'unity', 'gamebar', 'xboxpcapp']);
/** Generic runtimes: show the folder so you can tell which app it is. */
const GENERIC = new Set(['electron', 'node', 'python', 'pythonw', 'java', 'javaw', 'dotnet']);

const HEAVY_SCRIPT = /^(build|test|tests|dev|start|serve|e2e|lint|typecheck|type-check|check|preview|watch)\b|[:-](build|test|dev|e2e|watch)\b/i;
const HEAVY_CMD = /\b(npm|pnpm|yarn|bun)\s+(i|install|ci|add|run\s+(build|test|dev|start|e2e|lint|typecheck|watch)|test|build|dev|start)\b|\b(next|vite|nest|tsc|webpack|turbo|nx)\s+(build|dev|start)?|\btsc\b|\bdocker\b|\bgradlew?\b|\bmvnw?\b|\bcargo\s+(build|test|run)\b|\bpytest\b|\bjest\b|\bvitest\b|\bplaywright\b|\bprisma\s+(generate|migrate)\b|\bmake\b|\bffmpeg\b|\bpip\s+install\b|\bgo\s+(build|test)\b/i;

export class Travel {
  constructor(cfg, { win, status, push, activity, sessions, tasks, laptopChats, now = Date.now, pid = process.pid } = {}) {
    this.cfg = cfg;
    this.win = win;
    this.status = status;
    this.push = push;
    this.activity = activity;
    this.sessions = sessions;
    this.tasks = tasks;
    this.laptopChats = laptopChats;
    this.now = now;
    this.pid = pid;
    this.file = path.join(cfg.dataDir, 'travel.json');
    this.prefsFile = path.join(cfg.dataDir, 'travel-prefs.json');
    this.st = readJson(this.file, { active: false });
    this.prefs = { minutes: 60, level: 'cool', sleepWhenDone: true, endOnCharger: true, endAction: 'sleep', bluetoothOff: true, ecores: true, lightWork: true, unticked: [], ticked: [], ...readJson(this.prefsFile, {}) };
    this.timer = null;
    this.lastTick = null;
    this.ticks = 0;
    this.busyLock = Promise.resolve();
  }

  // ---------- lifecycle ----------

  /** Called once at server start: picks up a trip that was running when PocketDesk stopped. */
  async resumeAfterRestart() {
    if (!this.st.active) return;
    try {
      const boot = await this.win.bootTime();
      if (boot > this.st.startedAt) {
        // The laptop restarted: paused apps and pinned processes are gone, only the power plan needs putting back.
        this.st.paused = [];
        this.st.pinned = [];
        await this.end('restart');
        return;
      }
    } catch (e) {
      console.warn('[travel] cannot read boot time', e.message);
    }
    this.startTimer();
  }

  startTimer() {
    if (this.timer) return;
    this.lastTick = this.now();
    this.timer = setInterval(() => this.serial(() => this.tick()).catch((e) => console.error('[travel]', e.message)), TICK_MS);
    this.timer.unref?.();
  }

  stopTimer() {
    clearInterval(this.timer);
    this.timer = null;
  }

  /** One thing at a time: start, end, tick and the buttons never overlap. */
  serial(fn) {
    const run = this.busyLock.then(fn, fn);
    this.busyLock = run.catch(() => {});
    return run;
  }

  async save() {
    await writeJsonAtomic(this.file, this.st);
  }

  async notify(title, body, tag = 'travel') {
    this.activity?.log('PocketDesk', 'Travel mode', `${title}${body ? ` - ${body}` : ''}`);
    await this.push?.notify({ title, body, url: '/#/travel', tag }).catch(() => {});
  }

  // ---------- what runs, what pauses ----------

  /** Splits the laptop's processes into: kept (Claude and friends), pausable app groups, and what to pin. */
  classify(scan) {
    const procs = scan.procs.filter((p) => p.own);
    const byPid = new Map(procs.map((p) => [p.pid, p]));
    const kids = new Map();
    for (const p of procs) {
      if (!kids.has(p.ppid)) kids.set(p.ppid, []);
      kids.get(p.ppid).push(p);
    }
    const lname = (p) => String(p.name || '').toLowerCase();
    const desc = (roots) => {
      const out = new Set();
      const stack = [...roots];
      while (stack.length) {
        const pid = stack.pop();
        if (out.has(pid)) continue;
        out.add(pid);
        for (const k of kids.get(pid) || []) stack.push(k.pid);
      }
      return out;
    };
    const workRoots = procs.filter((p) => p.pid === this.pid || lname(p) === 'claude').map((p) => p.pid);
    if (!workRoots.includes(this.pid)) workRoots.push(this.pid);
    const work = desc(workRoots); // Claude, PocketDesk and everything they started: keeps running, goes on E-cores
    const tailscale = desc(procs.filter((p) => lname(p).startsWith('tailscale')).map((p) => p.pid));
    const keep = new Set([...work, ...tailscale]);
    // Whole apps that must keep running: Claude itself, Tailscale, and the programs HOSTING Claude. A copy of an app that
    // Claude merely started (say a test Chrome) stays running on its own, but does not protect your own copy of that app.
    const appKeep = new Set([...workRoots, ...tailscale]);
    for (const pid of workRoots) {
      // the programs hosting Claude (a terminal, an editor) must not freeze either, or Claude blocks writing to them
      let p = byPid.get(pid);
      const seen = new Set();
      while (p && !seen.has(p.pid)) {
        seen.add(p.pid);
        keep.add(p.pid);
        appKeep.add(p.pid);
        p = byPid.get(p.ppid);
      }
    }
    const windir = String(scan.windir || 'C:\\Windows').toLowerCase();
    const groups = new Map();
    const keptApps = new Map();
    for (const p of procs) {
      if (!p.path) continue;
      const key = p.path.toLowerCase();
      if (key.startsWith(`${windir}\\`)) continue;
      const g = groups.get(key) || { key, exe: path.win32.basename(p.path), name: p.desc || p.name, hint: null, pids: [], keptPids: [], memMb: 0, cpuSec: 0, window: false, kept: false };
      if (GENERIC.has(lname(p))) g.hint = path.win32.dirname(p.path).replace(/^C:\\Users\\[^\\]+\\/i, '~\\').split('\\').slice(-4).join('\\');
      if (appKeep.has(p.pid) || NEVER.has(lname(p))) g.kept = true;
      if (keep.has(p.pid)) g.keptPids.push(p.pid);
      else {
        g.pids.push(p.pid);
        g.memMb += p.memMb || 0;
        g.cpuSec += p.cpuSec || 0;
        g.window = g.window || !!p.window;
      }
      groups.set(key, g);
    }
    for (const g of groups.values()) {
      const n = g.kept ? g.pids.length + g.keptPids.length : g.keptPids.length;
      if (!n) continue;
      const label = g.kept ? keptLabel(g) : `${g.name} (started by Claude)`;
      if (label) keptApps.set(label, (keptApps.get(label) || 0) + n);
    }
    const pausable = [...groups.values()].filter((g) => !g.kept && g.pids.length).map((g) => ({
      ...g, heavy: HEAVY.has(g.exe.replace(/\.exe$/i, '').toLowerCase()),
    })).map((g) => ({ ...g, suggested: g.heavy || (g.window && g.cpuSec >= 60) })) // known heat makers, or open apps that really use the CPU
      .sort((a, b) => Number(b.suggested) - Number(a.suggested) || b.cpuSec - a.cpuSec);
    return { procs, byPid, kids, keep, work, pausable, kept: [...keptApps].map(([name, count]) => ({ name, count })), desc };
  }

  /** The list shown before starting: which apps pause (ticked) and which keep running. */
  async preview() {
    const [scan, cores] = await Promise.all([this.win.procs(), this.win.cores().catch(() => null)]);
    const c = this.classify(scan);
    const e = eCoreMask(cores);
    return {
      active: !!this.st.active,
      prefs: this.publicPrefs(),
      levels: Object.entries(LEVELS).map(([id, l]) => ({ id, label: l.label })),
      durations: DURATIONS,
      ecores: e ? { count: e.count, of: cores.logical } : null,
      apps: c.pausable.map((g) => ({
        key: g.key, name: g.name, exe: g.exe, hint: g.hint, count: g.pids.length, memMb: g.memMb, cpuSec: g.cpuSec, window: g.window,
        pause: this.prefs.unticked.includes(g.key) ? false : this.prefs.ticked.includes(g.key) ? true : g.suggested,
      })),
      kept: c.kept,
    };
  }

  publicPrefs() {
    const { unticked, ticked, ...rest } = this.prefs;
    return rest;
  }

  // ---------- start / end ----------

  start(opts = {}, who) {
    return this.serial(() => this.start_(opts, who));
  }

  async start_(opts, who) {
    if (this.st.active) throw httpErr(409, 'Travel mode is already on');
    const minutes = Number(opts.minutes ?? this.prefs.minutes);
    if (!DURATIONS.includes(minutes)) throw httpErr(400, `Pick ${DURATIONS.join(', ')} minutes`);
    const level = opts.level ?? this.prefs.level;
    if (!LEVELS[level]) throw httpErr(400, 'Unknown cooling level');
    const endAction = opts.endAction ?? this.prefs.endAction;
    if (!['sleep', 'hibernate'].includes(endAction)) throw httpErr(400, 'End action must be sleep or hibernate');
    const flag = (k) => (k in opts ? !!opts[k] : !!this.prefs[k]);
    const settings = { minutes, level, endAction, sleepWhenDone: flag('sleepWhenDone'), endOnCharger: flag('endOnCharger'), bluetoothOff: flag('bluetoothOff'), ecores: flag('ecores'), lightWork: flag('lightWork') };

    const scan = await this.win.procs();
    const c = this.classify(scan);
    const chosen = Array.isArray(opts.pause) ? new Set(opts.pause.map((k) => String(k).toLowerCase())) : null;
    const pauseGroups = c.pausable.filter((g) => (chosen ? chosen.has(g.key) : g.suggested));
    // remember the choice for next time
    if (chosen) {
      this.prefs.unticked = c.pausable.filter((g) => g.suggested && !chosen.has(g.key)).map((g) => g.key).slice(0, 200);
      this.prefs.ticked = c.pausable.filter((g) => !g.suggested && chosen.has(g.key)).map((g) => g.key).slice(0, 200);
    }
    Object.assign(this.prefs, settings);
    await writeJsonAtomic(this.prefsFile, this.prefs);

    const now = this.now();
    let battery = null;
    try {
      battery = (await this.status.get({ fresh: true })).battery;
    } catch {
      /* unknown */
    }
    this.st = {
      active: true, startedAt: now, endsAt: now + minutes * 60_000, ...settings,
      by: who?.kind === 'device' ? who.device.name : 'Laptop',
      pauseKeys: pauseGroups.map((g) => g.key), paused: [], pinned: [], power: null, btPrev: null, eMask: null,
      warned: false, graceUntil: null, idleSince: null, wasBusy: false, sleepAt: null, sleptAt: null,
      sawUnplugged: battery ? !battery.pluggedIn : false, drain: [], drainAlerted: false, queue: [], problems: [],
    };
    await this.save(); // from here on a crash is recoverable

    // 1) power plan
    try {
      const cur = await this.win.powerGet();
      this.st.power = { scheme: cur.scheme, saved: cur.values };
      await this.save();
      await this.win.powerSet(cur.scheme, travelValues(level, cur.values));
    } catch (e) {
      this.st.problems.push(`Power settings: ${e.message}`);
    }
    // 2) Bluetooth
    if (settings.bluetoothOff) {
      try {
        const bt = await this.win.bluetooth();
        if (bt.present && bt.state === 'On') {
          this.st.btPrev = 'On';
          await this.save();
          const r = await this.win.bluetooth('Off');
          if (r.result && r.result !== 'Allowed') this.st.problems.push(`Bluetooth: ${r.result}`);
        }
      } catch (e) {
        this.st.problems.push(`Bluetooth: ${e.message}`);
      }
    }
    // 3) Claude and its work onto the efficiency cores
    if (settings.ecores) {
      try {
        const e = eCoreMask(await this.win.cores());
        this.st.eMask = e ? String(e.mask) : '0';
        await this.pinNew(c);
      } catch (e) {
        this.st.problems.push(`Efficiency cores: ${e.message}`);
      }
    }
    // 4) pause the chosen apps (and whatever they started)
    try {
      await this.pauseNew(c);
    } catch (e) {
      this.st.problems.push(`Pausing apps: ${e.message}`);
    }
    await this.save();
    this.startTimer();
    const apps = new Set(this.st.paused.map((p) => p.app)).size;
    this.activity?.log(this.st.by, 'Travel mode on', `${minutes} min, ${LEVELS[level].label}, ${apps} apps paused`);
    await this.notify('Travel mode is on', `${minutes} min · ${apps} apps paused · CPU ${LEVELS[level].label.toLowerCase()}. Close the lid and go.`);
    return this.state();
  }

  /** Pause processes of the chosen apps (and anything they started) that are not paused yet. */
  async pauseNew(c) {
    const keys = new Set(this.st.pauseKeys);
    const already = new Set(this.st.paused.map((p) => `${p.pid}:${p.created}`));
    const roots = c.procs.filter((p) => p.path && keys.has(p.path.toLowerCase()) && !c.keep.has(p.pid)).map((p) => p.pid);
    const want = [...c.desc(roots)].map((pid) => c.byPid.get(pid)).filter((p) => p && !c.keep.has(p.pid) && p.created && p.created !== '0'
      && !NEVER.has(String(p.name).toLowerCase()) && !already.has(`${p.pid}:${p.created}`));
    if (!want.length) return 0;
    const res = await this.win.suspend(want.map((p) => ({ pid: p.pid, created: p.created })));
    let n = 0;
    for (const r of res) {
      const p = want.find((x) => x.pid === r.pid);
      if (r.ok && p) {
        this.st.paused.push({ pid: p.pid, created: p.created, name: p.name, app: p.path ? p.path.toLowerCase() : p.name });
        n++;
      }
    }
    return n;
  }

  /** Put Claude's processes (and new ones it started) onto the efficiency cores. */
  async pinNew(c) {
    if (this.st.eMask == null) return 0;
    const already = new Set(this.st.pinned.map((p) => `${p.pid}:${p.created}`));
    const want = [...c.work].map((pid) => c.byPid.get(pid)).filter((p) => p && p.created && p.created !== '0' && !already.has(`${p.pid}:${p.created}`));
    if (!want.length) return 0;
    const res = await this.win.pin(want.map((p) => ({ pid: p.pid, created: p.created })), BigInt(this.st.eMask), true);
    let n = 0;
    for (const r of res) {
      const p = want.find((x) => x.pid === r.pid);
      if (r.ok && p) {
        this.st.pinned.push({ pid: p.pid, created: p.created, mask: r.prev });
        n++;
      }
    }
    return n;
  }

  end(reason = 'manual', who) {
    return this.serial(() => this.end_(reason, who));
  }

  async end_(reason, who) {
    const st = this.st;
    if (!st.active) return this.state();
    this.stopTimer();
    const problems = [];
    // power first, so the laptop is back to full speed while the apps wake up
    if (st.power) {
      try {
        await this.win.powerSet(st.power.scheme, st.power.saved);
      } catch (e) {
        problems.push(`Power settings: ${e.message}`);
      }
    }
    let resumed = 0;
    if (st.paused?.length) {
      try {
        const r = await this.win.resume(st.paused.map(({ pid, created }) => ({ pid, created })));
        resumed = r.filter((x) => x.ok).length;
      } catch (e) {
        problems.push(`Resuming apps: ${e.message}`);
      }
    }
    if (st.pinned?.length) {
      try {
        await this.win.unpin(st.pinned.map(({ pid, created, mask }) => ({ pid, created, mask })));
      } catch (e) {
        problems.push(`Efficiency cores: ${e.message}`);
      }
    }
    if (st.btPrev === 'On') {
      try {
        await this.win.bluetooth('On');
      } catch (e) {
        problems.push(`Bluetooth: ${e.message}`);
      }
    }
    const queue = st.queue || [];
    const mins = Math.round((this.now() - st.startedAt) / 60000);
    this.st = { active: false, last: { startedAt: st.startedAt, endedAt: this.now(), reason, minutes: mins, apps: new Set((st.paused || []).map((p) => p.app)).size, resumed, problems: [...(st.problems || []), ...problems] } };
    await this.save();
    const why = REASONS[reason] || reason;
    this.activity?.log(who?.kind === 'device' ? who.device.name : 'PocketDesk', 'Travel mode off', `${why}; after ${mins} min`);
    await this.notify('Travel mode ended', `${why}. Apps are back, power settings restored${problems.length ? ` (${problems.length} problem${problems.length > 1 ? 's' : ''}: see PocketDesk)` : ''}.`);
    // commands that waited for the trip to end
    for (const q of queue) {
      try {
        await this.tasks?.start(q.rootId, q.rel, q.body, q.who);
      } catch (e) {
        await this.notify('A waiting command did not start', `${q.label}: ${e.message}`);
      }
    }
    if (queue.length) await this.notify('Waiting commands started', queue.map((q) => q.label).join(', '));
    return this.state();
  }

  // ---------- the minute-by-minute watcher ----------

  async tick() {
    const st = this.st;
    if (!st.active) return;
    const now = this.now();
    const gap = this.lastTick ? now - this.lastTick : 0;
    this.lastTick = now;
    this.ticks++;

    if (gap > 4 * TICK_MS) {
      // the laptop was asleep (we put it to sleep, or the lid was opened after it slept): the trip is over
      await this.end_(st.sleptAt ? 'woke' : 'woke-other');
      return;
    }
    if (st.sleptAt) {
      if (now - st.sleptAt < 3 * 60_000) return;
      st.sleptAt = null; // asked to sleep, but it did not
      st.problems.push('The laptop did not go to sleep when asked');
      await this.notify('Laptop did not go to sleep', 'It is still running in Travel mode. Check it when you can.');
    }

    // charger and battery drain
    let b = null;
    try {
      b = (await this.status.get({ fresh: true })).battery;
    } catch {
      /* unknown */
    }
    if (b) {
      if (!b.pluggedIn) st.sawUnplugged = true;
      if (st.endOnCharger && b.pluggedIn && st.sawUnplugged) {
        await this.end_('charger');
        return;
      }
      if (!b.pluggedIn) {
        st.drain.push({ at: now, pct: b.percent });
        st.drain = st.drain.filter((d) => now - d.at <= DRAIN_WINDOW_MS);
        const first = st.drain[0];
        const span = (now - first.at) / 60000;
        if (span >= 4 && !st.drainAlerted) {
          const rate = (first.pct - b.percent) / span;
          if (rate >= DRAIN_PER_MIN) {
            st.drainAlerted = true;
            let extra = '';
            if (st.level !== 'coolest' && st.power) {
              st.level = 'coolest';
              await this.win.powerSet(st.power.scheme, travelValues('coolest', st.power.saved)).catch(() => {});
              extra = ' Switched the CPU to Coolest.';
            }
            await this.notify(`Battery dropping fast (${rate.toFixed(1)}%/min)`, `Something heavy is running, so the laptop is probably warm.${extra}`, 'travel-drain');
          }
        }
      } else st.drain = [];
    }

    // keep new processes paused / on the efficiency cores
    if (this.ticks % SCAN_EVERY === 0) {
      try {
        const c = this.classify(await this.win.procs());
        await this.pauseNew(c);
        await this.pinNew(c);
        this.trimLists(c);
      } catch (e) {
        console.warn('[travel] rescan', e.message);
      }
    }

    const busy = await this.busy();
    this.lastBusy = { ...busy, at: now };
    if (busy.busy) st.wasBusy = true;

    // timer
    if (!st.warned && now >= st.endsAt - WARN_BEFORE_MS && now < st.endsAt) {
      st.warned = true;
      await this.notify('Travel mode: 5 minutes left', busy.busy ? 'Claude is still working. Add time in PocketDesk if you need it.' : 'Then the laptop goes to sleep.');
    }
    if (now >= st.endsAt) {
      if (!busy.busy) return this.goSleep('time');
      if (!st.graceUntil) {
        st.graceUntil = now + GRACE_MS;
        await this.save();
        await this.notify('Travel time is up, Claude is still working', 'The laptop sleeps in 10 minutes. Open PocketDesk and press +15 min to keep going.');
        return;
      }
      if (now >= st.graceUntil) return this.goSleep('time');
    }

    // sleep when Claude is done
    if (st.sleepWhenDone) {
      if (busy.busy) {
        st.idleSince = null;
        if (st.sleepAt) {
          st.sleepAt = null;
          await this.notify('Claude started again', 'Not going to sleep.');
        }
      } else {
        st.idleSince = st.idleSince || now;
        const idle = now - st.idleSince;
        if (st.sleepAt && now >= st.sleepAt) return this.goSleep('done');
        if (!st.sleepAt && ((st.wasBusy && idle >= DONE_IDLE_MS) || idle >= NEVER_BUSY_IDLE_MS)) {
          st.sleepAt = now + SLEEP_NOTICE_MS;
          await this.notify(st.wasBusy ? 'Claude is done: laptop sleeps in 1 minute' : 'Nothing is running: laptop sleeps in 1 minute', 'Open PocketDesk and press "Stay awake" to stop it.');
        }
      }
    }
    await this.save();
  }

  /** Forget processes that have exited, so the lists stay small. */
  trimLists(c) {
    const alive = (p) => {
      const x = c.byPid.get(p.pid);
      return x && x.created === p.created;
    };
    this.st.paused = this.st.paused.filter(alive);
    this.st.pinned = this.st.pinned.filter(alive);
  }

  async goSleep(reason) {
    const st = this.st;
    st.sleptAt = this.now();
    st.sleepAt = null;
    await this.save();
    await this.notify(st.endAction === 'hibernate' ? 'Laptop is hibernating' : 'Laptop is going to sleep',
      `${SLEEP_REASONS[reason] || reason}. Open the lid to wake it: Travel mode then ends and your apps come back.`);
    this.activity?.log('PocketDesk', 'Travel mode: sleep', SLEEP_REASONS[reason] || reason);
    this.win.sleep(st.endAction === 'hibernate');
  }

  /** Is Claude (or a command) still working? Phone sessions, Project-tab commands, and any laptop chat written to just now. */
  async busy() {
    const reasons = [];
    for (const s of this.sessions?.list?.() || []) {
      if (['starting', 'working'].includes(s.state)) reasons.push(`Claude: ${s.title}`);
      else if (s.state === 'waiting') reasons.push(`Claude is waiting for you: ${s.title}`);
    }
    for (const t of this.tasks?.list?.() || []) if (t.running && !t.port) reasons.push(`Command: ${t.label}`);
    try {
      const cutoff = this.now() - BUSY_TRANSCRIPT_MS;
      for (const { dir } of this.laptopChats?.projectsDirs?.() || []) {
        for (const sub of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
          if (!sub.isDirectory()) continue;
          const folder = path.join(dir, sub.name);
          for (const n of await fsp.readdir(folder).catch(() => [])) {
            if (!n.endsWith('.jsonl')) continue;
            const s = await fsp.stat(path.join(folder, n)).catch(() => null);
            if (s && s.mtimeMs >= cutoff) {
              reasons.push(`Laptop chat in ${sub.name.replace(/^C--Users-[^-]+-?/i, '') || 'home'}`);
              break;
            }
          }
        }
      }
    } catch {
      /* ignore */
    }
    return { busy: reasons.length > 0, reasons };
  }

  // ---------- buttons while travelling ----------

  extend(minutes = 15) {
    return this.serial(async () => {
      if (!this.st.active) throw httpErr(409, 'Travel mode is off');
      const m = Number(minutes);
      if (![15, 30].includes(m)) throw httpErr(400, 'Add 15 or 30 minutes');
      const endsAt = Math.max(this.st.endsAt, this.now()) + m * 60_000;
      if (endsAt - this.st.startedAt > 4 * 3600_000) throw httpErr(400, 'A trip can last at most 4 hours');
      this.st.endsAt = endsAt;
      this.st.graceUntil = null;
      this.st.sleepAt = null;
      this.st.warned = false;
      await this.save();
      return this.state();
    });
  }

  stayAwake() {
    return this.serial(async () => {
      if (!this.st.active) throw httpErr(409, 'Travel mode is off');
      this.st.sleepAt = null;
      this.st.sleepWhenDone = false;
      this.st.idleSince = null;
      await this.save();
      return this.state();
    });
  }

  setLevel(level) {
    return this.serial(async () => {
      if (!this.st.active) throw httpErr(409, 'Travel mode is off');
      if (!LEVELS[level]) throw httpErr(400, 'Unknown cooling level');
      if (this.st.power) await this.win.powerSet(this.st.power.scheme, travelValues(level, this.st.power.saved));
      this.st.level = level;
      await this.save();
      return this.state();
    });
  }

  sleepNow() {
    return this.serial(async () => {
      if (!this.st.active) throw httpErr(409, 'Travel mode is off');
      await this.goSleep('asked');
      return this.state();
    });
  }

  // ---------- heavy commands wait for the trip to end ----------

  /** True when this Project-tab command would heat the laptop. */
  static isHeavy(body = {}, quickCmd = null) {
    if (body.kind === 'install') return true;
    if (body.kind === 'script') return HEAVY_SCRIPT.test(String(body.name || ''));
    if (body.kind === 'custom') return HEAVY_CMD.test(String(body.cmd || ''));
    if (body.kind === 'quick') return HEAVY_CMD.test(String(quickCmd || ''));
    return false;
  }

  holds(body, quickCmd) {
    return !!(this.st.active && !body.force && Travel.isHeavy(body, quickCmd));
  }

  queueTask(rootId, rel, body, who) {
    return this.serial(async () => {
      if (!this.st.active) throw httpErr(409, 'Travel mode is off');
      if (this.st.queue.length >= MAX_QUEUE) throw httpErr(429, `At most ${MAX_QUEUE} commands can wait`);
      const { kind, name, id, cmd, shell } = body;
      const label = kind === 'script' ? `run ${name}` : kind === 'install' ? 'install' : kind === 'custom' ? String(cmd).slice(0, 60) : `quick #${id}`;
      this.st.queue.push({ rootId: Number(rootId), rel: rel || '', body: { kind, name, id, cmd, shell, force: true }, label, who: who?.kind === 'device' ? { kind: 'device', device: { id: who.device.id, name: who.device.name } } : { kind: 'laptop' }, at: this.now() });
      await this.save();
      return { queued: true, label, waiting: this.st.queue.length };
    });
  }

  dropQueued(index) {
    return this.serial(async () => {
      if (!this.st.active) throw httpErr(409, 'Travel mode is off');
      this.st.queue.splice(Number(index), 1);
      await this.save();
      return this.state();
    });
  }

  /** The note Claude gets with each message while travelling (null when not travelling). */
  claudeNote() {
    return this.st.active && this.st.lightWork ? TRAVEL_NOTE : null;
  }

  // ---------- state for the app ----------

  state() {
    const st = this.st;
    if (!st.active) return { active: false, prefs: this.publicPrefs(), last: st.last || null };
    const now = this.now();
    return {
      active: true,
      startedAt: st.startedAt,
      endsAt: st.endsAt,
      leftMs: Math.max(0, st.endsAt - now),
      graceUntil: st.graceUntil,
      sleepAt: st.sleepAt,
      sleptAt: st.sleptAt,
      level: st.level,
      levelLabel: LEVELS[st.level]?.label,
      minutes: st.minutes,
      sleepWhenDone: st.sleepWhenDone,
      endOnCharger: st.endOnCharger,
      endAction: st.endAction,
      bluetoothOff: st.btPrev === 'On',
      ecores: st.eMask != null && st.eMask !== '0',
      lightWork: st.lightWork,
      apps: [...new Set(st.paused.map((p) => p.app))].map((k) => path.win32.basename(k)),
      pausedCount: st.paused.length,
      pinnedCount: st.pinned.length,
      queue: st.queue.map((q, i) => ({ i, label: q.label, at: q.at })),
      problems: st.problems,
      by: st.by,
      busy: this.lastBusy || null,
    };
  }

  /** Short line for the banner on every screen. */
  summary() {
    if (!this.st.active) return null;
    return { active: true, endsAt: this.st.endsAt, sleepAt: this.st.sleepAt, graceUntil: this.st.graceUntil };
  }
}

const REASONS = {
  manual: 'You turned it off',
  woke: 'The laptop woke up (lid opened)',
  'woke-other': 'The laptop woke up after sleeping',
  charger: 'The charger was plugged in',
  restart: 'The laptop restarted',
};
const SLEEP_REASONS = { time: 'Travel time is up', done: 'Claude finished its work', asked: 'You asked it to sleep' };

/** Power values for the trip, from the saved ones: only keys this laptop has are touched. */
export function travelValues(level, saved) {
  const l = LEVELS[level];
  const both = (v) => ({ ac: v, dc: v });
  const want = {
    cpuMax: both(l.cpuMax), cpuMax1: both(l.cpuMax),
    freqMax: both(l.freqMax), freqMax1: both(l.freqMax),
    boost: both(0),
    epp: both(l.epp), epp1: both(l.epp),
    lid: both(0),
    saver: { ac: saved?.saver?.ac ?? 0, dc: 100 },
  };
  const out = {};
  for (const [k, v] of Object.entries(want)) if (saved && k in saved) out[k] = v;
  return out;
}

/** Logical-processor mask of the efficiency cores (null when the CPU has only one kind of core). */
export function eCoreMask(cores) {
  const list = cores?.cores || [];
  if (!list.length) return null;
  const effs = [...new Set(list.map((c) => c.eff))];
  if (effs.length < 2) return null;
  const low = Math.min(...effs);
  let mask = 0n;
  let count = 0;
  for (const c of list) if (c.eff === low) {
    mask |= BigInt(c.mask);
    count++;
  }
  return { mask, count };
}

function keptLabel(g) {
  const p = g.key;
  const exe = g.exe.toLowerCase();
  if (exe === 'claude.exe' && p.includes('\\windowsapps\\')) return 'Claude desktop app';
  if (exe === 'claude.exe') return 'Claude Code (terminal)';
  if (exe.startsWith('tailscale')) return 'Tailscale';
  if (exe === 'node.exe') return 'PocketDesk / Claude tools (Node)';
  if (exe === 'windowsterminal.exe' || exe === 'openconsole.exe') return 'Terminal running Claude';
  if (exe === 'code.exe' || exe === 'cursor.exe') return `${g.name} (runs Claude)`;
  if (NEVER.has(exe.replace(/\.exe$/, ''))) return null;
  return g.name;
}
