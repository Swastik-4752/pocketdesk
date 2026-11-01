import os from 'node:os';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { httpErr } from './util.js';

const run = promisify(execFile);
const CACHE_MS = 15_000;

/** Laptop status (battery, disk, memory, Claude processes) and lock/sleep actions. */
export class Status {
  constructor(cfg) {
    this.cfg = cfg;
    this.cache = null;
  }

  async get({ fresh = false } = {}) {
    if (!fresh && this.cache && Date.now() - this.cache.at < CACHE_MS) return this.cache.value;
    const [battery, claudeProcs, disks, temperatureC] = await Promise.all([battery_(), claudeProcesses(), this.disks(), temperature()]);
    const value = {
      host: os.hostname(),
      uptimeSec: Math.round(os.uptime()),
      memory: { totalMb: Math.round(os.totalmem() / 1048576), freeMb: Math.round(os.freemem() / 1048576) },
      battery,
      temperatureC,
      claudeProcesses: claudeProcs,
      disks,
      at: Date.now(),
    };
    this.cache = { at: Date.now(), value };
    return value;
  }

  async disks() {
    const seen = new Map();
    for (const r of this.cfg.roots) {
      const drive = path.parse(r.real).root;
      if (seen.has(drive)) continue;
      try {
        const s = await fsp.statfs(drive);
        seen.set(drive, { drive, freeGb: +(s.bavail * s.bsize / 1e9).toFixed(1), totalGb: +(s.blocks * s.bsize / 1e9).toFixed(1) });
      } catch {
        /* ignore */
      }
    }
    return [...seen.values()];
  }

  async power(action) {
    if (!this.cfg.allowPowerActions) throw httpErr(403, 'Power actions are turned off in config.json');
    if (process.platform !== 'win32') throw httpErr(400, 'Only supported on Windows');
    if (action === 'lock') {
      await run('rundll32.exe', ['user32.dll,LockWorkStation']);
      return { ok: true, message: 'Laptop screen locked. Claude keeps running.' };
    }
    if (action === 'sleep') {
      // Answer first; sleep a moment later so the phone gets the reply.
      setTimeout(() => {
        execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
          "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Application]::SetSuspendState('Suspend', $false, $false)"]);
      }, 1500);
      return { ok: true, message: 'Laptop is going to sleep. Everything stops until you open the lid.' };
    }
    throw httpErr(400, 'Unknown action');
  }
}

async function battery_() {
  if (process.platform !== 'win32') return null;
  try {
    const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_Battery | Select-Object -First 1 EstimatedChargeRemaining,BatteryStatus | ConvertTo-Json -Compress'], { timeout: 10_000, windowsHide: true });
    if (!stdout.trim()) return null;
    const b = JSON.parse(stdout);
    // BatteryStatus: 1 = discharging, 2 = on AC, 3 = full, 4/5 = low/critical, 6-9 = charging
    const st = Number(b.BatteryStatus);
    return { percent: b.EstimatedChargeRemaining, pluggedIn: ![1, 4, 5].includes(st), charging: [6, 7, 8, 9].includes(st) || st === 2 };
  } catch {
    return null;
  }
}

/** Highest ACPI thermal-zone reading in °C (Windows reports tenths of Kelvin). Not every laptop exposes a real CPU sensor. */
async function temperature() {
  if (process.platform !== 'win32') return null;
  try {
    const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_PerfFormattedData_Counters_ThermalZoneInformation | ForEach-Object { $_.HighPrecisionTemperature }'], { timeout: 10_000, windowsHide: true });
    const vals = stdout.split(/\s+/).map(Number).filter((v) => v > 2000 && v < 4500).map((v) => v / 10 - 273.15);
    return vals.length ? Math.round(Math.max(...vals) * 10) / 10 : null;
  } catch {
    return null;
  }
}

async function claudeProcesses() {
  if (process.platform !== 'win32') return null;
  try {
    const { stdout } = await run('tasklist.exe', ['/FI', 'IMAGENAME eq claude.exe', '/FO', 'CSV', '/NH'], { timeout: 10_000, windowsHide: true });
    return stdout.split(/\r?\n/).filter((l) => /^"claude\.exe"/i.test(l)).length;
  } catch {
    return null;
  }
}
