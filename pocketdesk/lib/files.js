import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { httpErr, randomToken } from './util.js';

const MAX_LIST = 3000;

/** Files access, locked to the configured roots. Every path goes through resolve(). */
export class Files {
  constructor(cfg) {
    this.cfg = cfg;
  }

  roots() {
    return this.cfg.roots.map((r, i) => ({ id: i, name: r.name }));
  }

  isDenied(name) {
    return this.cfg.denyRe.some((re) => re.test(name));
  }

  isHidden(name) {
    return this.cfg.hideRe.some((re) => re.test(name));
  }

  /**
   * Turns (root id, relative path) into a real absolute path that is guaranteed to be inside the root.
   * Rejects "..", NUL, Windows stream/drive syntax (":"), denied names, and symlinks or junctions that
   * point outside the root (checked on the real path).
   */
  async resolve(rootId, rel = '', { mustExist = true } = {}) {
    const root = this.cfg.roots[Number(rootId)];
    if (!root || !Number.isInteger(Number(rootId))) throw httpErr(404, 'Unknown folder');
    const raw = String(rel ?? '').replace(/\\/g, '/');
    if (raw.includes('\0')) throw httpErr(400, 'Bad path');
    const parts = raw.split('/').filter((s) => s && s !== '.');
    for (const p of parts) {
      if (p === '..' || p.includes(':') || /[<>"|?*]/.test(p)) throw httpErr(400, 'Bad path');
      if (this.isDenied(p)) throw httpErr(403, `"${p}" is on the blocked list`);
    }
    const abs = path.join(root.real, ...parts);
    let real;
    try {
      if (mustExist) {
        real = await fsp.realpath(abs);
      } else {
        const parent = await fsp.realpath(path.dirname(abs));
        real = path.join(parent, path.basename(abs));
      }
    } catch (e) {
      if (e.code === 'ENOENT' || e.code === 'ENOTDIR') throw httpErr(404, 'Not found');
      throw e;
    }
    if (!isInside(root.real, real)) throw httpErr(403, 'That is outside your allowed folders');
    // A denied name reached through a link still counts as denied.
    if (this.isDenied(path.basename(real))) throw httpErr(403, 'That file is on the blocked list');
    return { root, rootId: Number(rootId), abs: real, rel: parts.join('/') };
  }

  async list(rootId, rel) {
    const { abs, rel: clean } = await this.resolve(rootId, rel);
    const st = await fsp.stat(abs);
    if (!st.isDirectory()) throw httpErr(400, 'Not a folder');
    const dirents = await fsp.readdir(abs, { withFileTypes: true });
    const items = [];
    let hidden = 0;
    for (const d of dirents) {
      if (this.isDenied(d.name) || this.isHidden(d.name)) {
        hidden++;
        continue;
      }
      if (items.length >= MAX_LIST) break;
      let s;
      try {
        s = await fsp.stat(path.join(abs, d.name));
      } catch {
        continue; // broken link or no access
      }
      items.push({ name: d.name, dir: s.isDirectory(), size: s.isDirectory() ? null : s.size, mtime: s.mtimeMs });
    }
    items.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) : a.dir ? -1 : 1));
    return { path: clean, items, hidden, truncated: dirents.length - hidden > MAX_LIST };
  }

  async readText(rootId, rel) {
    const { abs, rel: clean } = await this.resolve(rootId, rel);
    const st = await fsp.stat(abs);
    if (!st.isFile()) throw httpErr(400, 'Not a file');
    const base = { path: clean, size: st.size, mtime: st.mtimeMs };
    if (st.size > this.cfg.maxTextBytes) return { ...base, tooBig: true };
    const buf = await fsp.readFile(abs);
    if (buf.subarray(0, 8000).includes(0)) return { ...base, binary: true };
    return { ...base, text: buf.toString('utf8') };
  }

  /**
   * Saves text. If baseMtime is given and the file changed since (e.g. Claude edited it), refuses with 409.
   * create=true makes a new file and refuses if one already exists.
   */
  async writeText(rootId, rel, { text, baseMtime, create }) {
    if (typeof text !== 'string') throw httpErr(400, 'text must be a string');
    if (Buffer.byteLength(text) > this.cfg.maxTextBytes) throw httpErr(413, 'File too large to save from the phone');
    const { abs, rel: clean } = await this.resolve(rootId, rel, { mustExist: false });
    let existing = null;
    try {
      existing = await fsp.stat(abs);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    if (create && existing) throw httpErr(409, 'A file with that name already exists');
    if (!create && !existing) throw httpErr(404, 'File no longer exists');
    if (existing && !existing.isFile()) throw httpErr(400, 'Not a file');
    if (existing && baseMtime != null && Math.abs(existing.mtimeMs - Number(baseMtime)) > 1) {
      throw httpErr(409, 'The file changed on the laptop since you opened it', { mtime: existing.mtimeMs });
    }
    const tmp = path.join(path.dirname(abs), `.pocketdesk-${randomToken(6)}.tmp`);
    await fsp.writeFile(tmp, text, 'utf8');
    try {
      await fsp.rename(tmp, abs);
    } catch (e) {
      await fsp.rm(tmp, { force: true });
      throw e;
    }
    const st = await fsp.stat(abs);
    return { path: clean, size: st.size, mtime: st.mtimeMs };
  }

  async mkdir(rootId, rel) {
    const { abs, rel: clean } = await this.resolve(rootId, rel, { mustExist: false });
    await fsp.mkdir(abs);
    return { path: clean };
  }

  /** For downloads: returns path, size and a read stream (optionally a byte range, for video seeking). */
  async openRead(rootId, rel, range = null) {
    const { abs } = await this.resolve(rootId, rel);
    const st = await fsp.stat(abs);
    if (!st.isFile()) throw httpErr(400, 'Not a file');
    const opts = range ? { start: range.start, end: range.end } : {};
    return { abs, size: st.size, mtime: st.mtimeMs, name: path.basename(abs), stream: fs.createReadStream(abs, opts) };
  }

  async statFile(rootId, rel) {
    const { abs } = await this.resolve(rootId, rel);
    const st = await fsp.stat(abs);
    if (!st.isFile()) throw httpErr(400, 'Not a file');
    return { abs, size: st.size, mtime: st.mtimeMs, name: path.basename(abs) };
  }

  /** Which shared root (the most specific one) holds this absolute folder, as { rootId, rel }. */
  locate(abs) {
    let best = null;
    this.cfg.roots.forEach((r, i) => {
      if (isInside(r.real, abs) && (!best || r.real.length > best.len)) best = { rootId: i, len: r.real.length, base: r.real };
    });
    if (!best) throw httpErr(403, 'That folder is not shared with PocketDesk');
    const rel = path.relative(best.base, path.resolve(abs)).split(path.sep).filter(Boolean).join('/');
    return { rootId: best.rootId, rel };
  }

  /** Streams an upload into folder `dirRel`. Never overwrites unless overwrite=true. */
  async upload(rootId, dirRel, name, req, { overwrite = false } = {}) {
    const fileName = path.basename(String(name || '').replace(/\\/g, '/')).trim();
    if (!fileName || fileName === '.' || fileName === '..') throw httpErr(400, 'Missing file name');
    const rel = [dirRel, fileName].filter(Boolean).join('/');
    const { abs, rel: clean } = await this.resolve(rootId, rel, { mustExist: false });
    const dir = await fsp.stat(path.dirname(abs));
    if (!dir.isDirectory()) throw httpErr(400, 'Not a folder');
    if (!overwrite) {
      const exists = await fsp.stat(abs).then(() => true, () => false);
      if (exists) throw httpErr(409, `"${fileName}" already exists in this folder`);
    }
    const limit = this.cfg.maxUploadBytes;
    let seen = 0;
    const counter = new Transform({
      transform(chunk, _enc, cb) {
        seen += chunk.length;
        if (seen > limit) cb(httpErr(413, `Upload is larger than ${Math.round(limit / 1048576)} MB`));
        else cb(null, chunk);
      },
    });
    const tmp = path.join(path.dirname(abs), `.pocketdesk-${randomToken(6)}.upload`);
    try {
      await pipeline(req, counter, fs.createWriteStream(tmp));
      await fsp.rename(tmp, abs);
    } catch (e) {
      await fsp.rm(tmp, { force: true });
      throw e;
    }
    return { path: clean, size: seen };
  }
}

export function isInside(base, target) {
  const b = path.resolve(base).toLowerCase();
  const t = path.resolve(target).toLowerCase();
  return t === b || t.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
}
