import fs from 'node:fs';
import net from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { httpErr } from './util.js';

const execP = promisify(execFile);

export function tailscaleExe() {
  const full = 'C:\\Program Files\\Tailscale\\tailscale.exe';
  return fs.existsSync(full) ? full : 'tailscale';
}

/** What Tailscale says about this laptop. */
export async function tailscaleInfo(port, runFn = defaultRun) {
  const info = { installed: false, running: false, dnsName: null, url: null, serving: false, loginName: null };
  try {
    const { stdout } = await runFn(['status', '--json'], 8000);
    info.installed = true;
    const st = JSON.parse(stdout);
    info.running = st.BackendState === 'Running';
    info.dnsName = st.Self?.DNSName?.replace(/\.$/, '') || null;
    const uid = st.Self?.UserID;
    info.loginName = (uid != null && st.User?.[uid]?.LoginName) || null;
    if (info.dnsName) info.url = `https://${info.dnsName}`;
  } catch (e) {
    info.installed = e.code !== 'ENOENT';
    return info;
  }
  try {
    const { stdout } = await runFn(['serve', 'status', '--json'], 8000);
    info.serving = stdout.includes(`127.0.0.1:${port}`) || stdout.includes(`localhost:${port}`);
  } catch {
    /* ignore */
  }
  return info;
}

function defaultRun(args, timeout = 20_000) {
  return execP(tailscaleExe(), args, { timeout, windowsHide: true });
}

/** Which loopback address a local server answers on (dev servers sometimes listen on ::1 only). */
function probe(host, port) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port, timeout: 1500 }, () => {
      s.destroy();
      resolve(true);
    });
    s.on('error', () => resolve(false));
    s.on('timeout', () => {
      s.destroy();
      resolve(false);
    });
  });
}

/**
 * "Open on phone" for a dev server: `tailscale serve` puts http://127.0.0.1:<port> on
 * https://<laptop>.ts.net:<port+10000>, reachable ONLY from devices in your own tailnet.
 * PocketDesk's own address (port 443) is never touched.
 */
export class Share {
  constructor(cfg, { runFn = defaultRun, probeFn = probe } = {}) {
    this.cfg = cfg;
    this.runFn = runFn;
    this.probeFn = probeFn;
  }

  httpsPortFor(port) {
    return port + 10000 <= 65535 ? port + 10000 : port;
  }

  checkPort(port) {
    const p = Number(port);
    if (!Number.isInteger(p) || p < 1024 || p > 65535) throw httpErr(400, 'Port must be 1024 to 65535');
    if (p === this.cfg.port) throw httpErr(400, 'That is PocketDesk itself');
    return p;
  }

  async list() {
    let st;
    try {
      st = JSON.parse((await this.runFn(['serve', 'status', '--json'], 8000)).stdout || '{}');
    } catch (e) {
      if (e.code === 'ENOENT') throw httpErr(409, 'Tailscale is not installed');
      return [];
    }
    const out = [];
    for (const [hostPort, web] of Object.entries(st.Web || {})) {
      const m = /^(.+):(\d+)$/.exec(hostPort);
      if (!m || m[2] === '443') continue;
      const proxy = web?.Handlers?.['/']?.Proxy || '';
      const pm = /:(\d+)\/?$/.exec(proxy);
      out.push({ httpsPort: Number(m[2]), port: pm ? Number(pm[1]) : null, target: proxy, url: `https://${m[1]}:${m[2]}` });
    }
    return out;
  }

  async share(port) {
    const p = this.checkPort(port);
    const host = (await this.probeFn('127.0.0.1', p)) ? '127.0.0.1' : (await this.probeFn('::1', p)) ? '[::1]' : null;
    if (!host) throw httpErr(409, `Nothing is answering on port ${p} on the laptop yet`);
    const https = this.httpsPortFor(p);
    try {
      await this.runFn(['serve', '--bg', `--https=${https}`, `http://${host}:${p}`]);
    } catch (e) {
      throw httpErr(502, `Tailscale would not share it: ${String(e.stderr || e.message).trim().slice(0, 300)}`);
    }
    const info = await tailscaleInfo(this.cfg.port, this.runFn);
    return { port: p, httpsPort: https, url: info.dnsName ? `https://${info.dnsName}:${https}` : null };
  }

  async unshare(port) {
    const p = this.checkPort(port);
    const https = this.httpsPortFor(p);
    try {
      await this.runFn(['serve', `--https=${https}`, 'off']);
    } catch (e) {
      const msg = String(e.stderr || e.message);
      if (!/not found|does not exist|no serve config/i.test(msg)) throw httpErr(502, `Tailscale would not stop it: ${msg.trim().slice(0, 300)}`);
    }
    return { ok: true };
  }
}
