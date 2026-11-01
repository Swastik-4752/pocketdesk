import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const KEEP_IN_MEMORY = 1000;

/** Append-only record of everything done through PocketDesk: who, what, when. */
export class Activity {
  constructor(cfg) {
    this.file = path.join(cfg.dataDir, 'activity.jsonl');
    this.items = [];
    this.chain = Promise.resolve();
    try {
      const lines = fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean).slice(-KEEP_IN_MEMORY);
      for (const l of lines) {
        try {
          this.items.push(JSON.parse(l));
        } catch {
          /* torn line */
        }
      }
    } catch {
      /* first run */
    }
  }

  /** who: { kind, device } from Auth.identify, or a plain string like 'PocketDesk'. */
  log(who, action, detail = '') {
    const by = typeof who === 'string' ? who : who?.kind === 'device' ? who.device.name : 'Laptop';
    const item = { at: Date.now(), by, action, detail: String(detail).slice(0, 300) };
    this.items.push(item);
    if (this.items.length > KEEP_IN_MEMORY) this.items.splice(0, this.items.length - KEEP_IN_MEMORY);
    const line = `${JSON.stringify(item)}\n`;
    this.chain = this.chain.then(() => fsp.appendFile(this.file, line)).catch((e) => console.error('[activity]', e.message));
    return item;
  }

  list(limit = 200) {
    return this.items.slice(-limit).reverse();
  }
}
