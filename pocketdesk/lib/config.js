import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { globRe } from './util.js';

export const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const DEFAULTS = {
  host: '127.0.0.1',
  port: 8765,
  roots: [],
  deny: ['.env', '.env.*', '*.pem', '*.key', 'id_rsa*', '.credentials.json'],
  hideInListing: ['node_modules', '.git'],
  maxTextBytes: 2 * 1024 * 1024,
  maxUploadBytes: 100 * 1024 * 1024,
  allDrives: false,
  maxLiveSessions: 3,
  idleSessionMinutes: 20,
  allowPowerActions: true,
  allowedTailscaleUsers: [],
};

/**
 * Loads config.json (or the file in POCKETDESK_CONFIG) and resolves every root to its real path.
 * Roots that do not exist are dropped with a warning instead of failing the whole server.
 */
export function loadConfig(file = process.env.POCKETDESK_CONFIG || path.join(APP_DIR, 'config.json')) {
  let user;
  try {
    user = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`Cannot read config file ${file}: ${e.message}. (In JSON, write Windows paths with \\\\ or /.)`);
  }
  const cfg = { ...DEFAULTS, ...user };
  cfg.dataDir = path.resolve(process.env.POCKETDESK_DATA || user.dataDir || path.join(APP_DIR, 'data'));
  const listed = (cfg.roots || []).map((r) => ({ name: String(r.name || path.basename(r.path)), path: path.resolve(r.path) }));
  if (cfg.allDrives && process.platform === 'win32') {
    for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
      const drive = `${letter}:\\`;
      if (fs.existsSync(drive) && !listed.some((r) => r.path.toLowerCase() === drive.toLowerCase())) listed.push({ name: `${letter}: drive`, path: drive });
    }
  }
  cfg.roots = listed
    .filter((r) => {
      try {
        if (!fs.statSync(r.path).isDirectory()) throw new Error('not a folder');
        r.real = fs.realpathSync.native(r.path);
        return true;
      } catch (e) {
        console.warn(`[config] skipping root "${r.path}": ${e.message}`);
        return false;
      }
    });
  cfg.denyRe = cfg.deny.map(globRe);
  cfg.hideRe = cfg.hideInListing.map(globRe);
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  return cfg;
}
