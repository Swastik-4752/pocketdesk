import path from 'node:path';
import { httpErr, readJson, uuid, writeJsonAtomic } from './util.js';

const MAX = 40;

/**
 * Saved prompt buttons: one tap starts Claude with a prompt you use often (optionally in a fixed folder),
 * or drops it into the message box of an open session. Kept in data/prompts.json.
 */
export class Prompts {
  constructor(cfg) {
    this.cfg = cfg;
    this.file = path.join(cfg.dataDir, 'prompts.json');
    this.items = readJson(this.file, null) || DEFAULT_PROMPTS.map((p) => ({ id: uuid(), ...p }));
  }

  list() {
    return this.items.map((p) => ({ ...p, rootName: p.rootId != null ? this.cfg.roots[p.rootId]?.name || '?' : null }));
  }

  /** Replaces the whole list (the phone edits it as one list). */
  async save(list) {
    if (!Array.isArray(list)) throw httpErr(400, 'Bad list');
    if (list.length > MAX) throw httpErr(400, `At most ${MAX} saved prompts`);
    const clean = list.map((p) => {
      const name = String(p?.name || '').trim().slice(0, 40);
      const text = String(p?.text || '').trim();
      if (!name) throw httpErr(400, 'Every saved prompt needs a name');
      if (!text) throw httpErr(400, `"${name}" has no prompt text`);
      if (text.length > 4000) throw httpErr(400, `"${name}" is longer than 4000 characters`);
      const out = { id: /^[\w-]{1,40}$/.test(String(p.id || '')) ? String(p.id) : uuid(), name, text };
      if (p.rootId != null && p.rootId !== '') {
        const rootId = Number(p.rootId);
        if (!Number.isInteger(rootId) || !this.cfg.roots[rootId]) throw httpErr(400, `"${name}": unknown folder`);
        const rel = String(p.rel || '').replace(/\\/g, '/');
        if (rel.split('/').some((x) => x === '..' || x.includes(':'))) throw httpErr(400, `"${name}": bad folder`);
        out.rootId = rootId;
        out.rel = rel;
      }
      return out;
    });
    this.items = clean;
    await writeJsonAtomic(this.file, clean);
    return { prompts: this.list() };
  }
}

const DEFAULT_PROMPTS = [
  { name: 'What changed?', text: 'Summarise what changed in this project since yesterday (git log and uncommitted changes) in a few short points.' },
  { name: 'Run tests + summary', text: 'Run this project\'s tests and give me a short summary: what passed, what failed, and the likely cause of each failure. Do not change any code.' },
  { name: 'Explain this folder', text: 'Explain what this folder/project does, its main parts, and how to run it, in plain words.' },
];
