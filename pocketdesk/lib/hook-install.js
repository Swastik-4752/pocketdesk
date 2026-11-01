import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, writeJsonAtomic } from './util.js';

const HOOK_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'hooks', 'switch-to-phone.mjs');
const MARK = 'switch-to-phone.mjs';

export function hookCommand(nodeExe = process.execPath) {
  const fwd = (p) => p.replace(/\\/g, '/');
  return `"${fwd(nodeExe)}" "${fwd(HOOK_FILE)}"`;
}

const isOurs = (h) => typeof h?.command === 'string' && h.command.includes(MARK);

/**
 * Adds / removes the "switch to phone" hook in each Claude account's settings.json, next to whatever hooks are
 * already there (nothing else is touched). A one-time copy of the original is kept as settings.json.before-pocketdesk.
 */
export class HookInstaller {
  constructor(profiles, { nodeExe } = {}) {
    this.profiles = profiles;
    this.command = hookCommand(nodeExe);
  }

  fileFor(p) {
    return path.join(p.dir, 'settings.json');
  }

  status() {
    return this.profiles.scan().map((p) => {
      const file = this.fileFor(p);
      let installed = false;
      let error = null;
      if (fs.existsSync(file)) {
        try {
          const j = JSON.parse(fs.readFileSync(file, 'utf8'));
          installed = (j?.hooks?.UserPromptSubmit || []).some((g) => (g.hooks || []).some(isOurs));
        } catch (e) {
          error = `settings.json is not valid JSON (${e.message})`;
        }
      }
      return { id: p.id, name: p.name, email: p.email, installed, error };
    });
  }

  async install() {
    const results = [];
    for (const p of this.profiles.scan()) {
      const file = this.fileFor(p);
      try {
        const exists = fs.existsSync(file);
        const j = exists ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
        if (exists && !fs.existsSync(`${file}.before-pocketdesk`)) fs.copyFileSync(file, `${file}.before-pocketdesk`);
        j.hooks = j.hooks && typeof j.hooks === 'object' ? j.hooks : {};
        const groups = Array.isArray(j.hooks.UserPromptSubmit) ? j.hooks.UserPromptSubmit : [];
        // drop an older copy of ours (e.g. node moved), keep everyone else's
        const kept = groups.map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !isOurs(h)) })).filter((g) => g.hooks.length);
        kept.push({ hooks: [{ type: 'command', command: this.command, timeout: 30 }] });
        j.hooks.UserPromptSubmit = kept;
        await writeJsonAtomic(file, j);
        results.push({ id: p.id, ok: true });
      } catch (e) {
        results.push({ id: p.id, ok: false, error: e.message });
      }
    }
    return results;
  }

  async remove() {
    const results = [];
    for (const p of this.profiles.scan()) {
      const file = this.fileFor(p);
      if (!fs.existsSync(file)) continue;
      try {
        const j = readJson(file, null);
        if (!j?.hooks?.UserPromptSubmit) continue;
        j.hooks.UserPromptSubmit = j.hooks.UserPromptSubmit.map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !isOurs(h)) })).filter((g) => g.hooks.length);
        if (!j.hooks.UserPromptSubmit.length) delete j.hooks.UserPromptSubmit;
        await writeJsonAtomic(file, j);
        results.push({ id: p.id, ok: true });
      } catch (e) {
        results.push({ id: p.id, ok: false, error: e.message });
      }
    }
    return results;
  }
}
