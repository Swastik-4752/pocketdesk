import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { httpErr, sha256 } from './util.js';

export const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.avif', '.heic', '.heif']);
export const VIDEO_EXT = new Set(['.mp4', '.m4v', '.mov', '.webm', '.mkv', '.avi', '.3gp', '.wmv']);
const MAX_PARALLEL = 3;
const KEEP_DAYS = 30;

export function mediaKind(name) {
  const ext = path.extname(String(name)).toLowerCase();
  return IMAGE_EXT.has(ext) ? 'image' : VIDEO_EXT.has(ext) ? 'video' : null;
}

/** Finds ffmpeg: config "ffmpeg", then PATH, then the usual C:\ffmpeg install. */
export function findFfmpeg(cfg) {
  if (cfg.ffmpeg && fs.existsSync(cfg.ffmpeg)) return cfg.ffmpeg;
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    const p = path.join(dir, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
    if (dir && fs.existsSync(p)) return p;
  }
  try {
    for (const d of fs.readdirSync('C:\\ffmpeg')) {
      const p = path.join('C:\\ffmpeg', d, 'bin', 'ffmpeg.exe');
      if (fs.existsSync(p)) return p;
    }
  } catch {
    /* none */
  }
  return null;
}

/**
 * Small JPEG thumbnails for photos and videos, made with ffmpeg and cached in data/thumbs
 * (keyed by path + size + modified time, so an edited file gets a new one). Old ones are cleaned after 30 days.
 */
export class Thumbs {
  constructor(cfg, { files, ffmpeg = findFfmpeg(cfg), runFn = runFfmpeg } = {}) {
    this.files = files;
    this.ffmpeg = ffmpeg;
    this.runFn = runFn;
    this.dir = path.join(cfg.dataDir, 'thumbs');
    fs.mkdirSync(this.dir, { recursive: true });
    this.active = 0;
    this.queue = [];
    this.inflight = new Map();
    this.cleanup().catch(() => {});
  }

  available() {
    return !!this.ffmpeg;
  }

  async get(rootId, rel, width = 320) {
    const w = [160, 320, 640, 1280].includes(Number(width)) ? Number(width) : 320;
    const f = await this.files.statFile(rootId, rel);
    const kind = mediaKind(f.name);
    if (!kind) throw httpErr(400, 'Not a photo or video');
    if (!this.ffmpeg) throw httpErr(501, 'ffmpeg is not installed, so there are no thumbnails');
    const key = sha256(`${f.abs.toLowerCase()}|${f.size}|${f.mtime}|${w}`).slice(0, 40);
    const out = path.join(this.dir, `${key}.jpg`);
    if (fs.existsSync(out)) return out;
    if (!this.inflight.has(key)) {
      const p = this.limit(() => this.make(f.abs, out, kind, w)).finally(() => this.inflight.delete(key));
      this.inflight.set(key, p);
    }
    await this.inflight.get(key);
    return out;
  }

  limit(fn) {
    return new Promise((resolve, reject) => {
      const go = () => {
        this.active++;
        fn().then(resolve, reject).finally(() => {
          this.active--;
          this.queue.shift()?.();
        });
      };
      if (this.active < MAX_PARALLEL) go();
      else this.queue.push(go);
    });
  }

  async make(src, out, kind, w) {
    const tmp = `${out}.${process.pid}.tmp.jpg`;
    const scale = `scale='min(${w},iw)':-2`;
    const args = kind === 'video'
      ? ['-hide_banner', '-loglevel', 'error', '-ss', '1', '-i', src, '-frames:v', '1', '-vf', scale, '-q:v', '5', '-y', tmp]
      : ['-hide_banner', '-loglevel', 'error', '-i', src, '-frames:v', '1', '-vf', scale, '-q:v', '4', '-y', tmp];
    try {
      if (kind === 'video') {
        await this.runFn(this.ffmpeg, args).catch(() => {});
        // videos shorter than 1 s: take the very first frame instead
        if (!fs.existsSync(tmp)) await this.runFn(this.ffmpeg, args.filter((a, i) => !(a === '-ss' || args[i - 1] === '-ss')));
      } else {
        await this.runFn(this.ffmpeg, args);
      }
      if (!fs.existsSync(tmp)) throw new Error('no picture came out');
      await fsp.rename(tmp, out);
    } catch (e) {
      await fsp.rm(tmp, { force: true });
      throw httpErr(415, `Could not make a preview (${String(e.message).split('\n')[0].slice(0, 160)})`);
    }
  }

  async cleanup() {
    const old = Date.now() - KEEP_DAYS * 86400_000;
    for (const n of await fsp.readdir(this.dir)) {
      const p = path.join(this.dir, n);
      const st = await fsp.stat(p).catch(() => null);
      if (st && (st.atimeMs < old && st.mtimeMs < old)) await fsp.rm(p, { force: true });
    }
  }
}

function runFfmpeg(exe, args) {
  return new Promise((resolve, reject) => {
    execFile(exe, args, { windowsHide: true, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }, (err, _o, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve()));
  });
}
