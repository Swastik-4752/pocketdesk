import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { httpErr, readJson, writeJsonAtomic } from './util.js';

/**
 * Claude Code login profiles on this laptop (the same ones the `mc` tool uses):
 *   main            -> ~/.claude            (its .claude.json lives at ~/.claude.json)
 *   .claude-account2, ~/.claude-profiles/*  -> CLAUDE_CONFIG_DIR folders
 * PocketDesk runs Claude on exactly ONE of them, picked on the laptop.
 */
export class Profiles {
  constructor(cfg) {
    this.file = path.join(cfg.dataDir, 'account.json');
    this.home = process.env.POCKETDESK_HOME || os.homedir();
    this.state = readJson(this.file, { profileId: null, email: null });
    this.identity = null; // set by the server: knows who each saved login REALLY is
  }

  /** Asks Anthropic who every signed-in profile really is (errors are ignored; those stay unverified). */
  async refreshIdentities() {
    if (!this.identity) return;
    await Promise.allSettled(this.scan().filter((p) => p.signedIn).map((p) => this.identity.verify(this.get(p.id))));
  }

  scan() {
    const home = this.home;
    const list = [{ id: 'main', dir: path.join(home, '.claude'), json: path.join(home, '.claude.json'), isMain: true }];
    const account2 = path.join(home, '.claude-account2');
    if (isDir(account2)) list.push({ id: '.claude-account2', dir: account2, json: path.join(account2, '.claude.json') });
    const profRoot = path.join(home, '.claude-profiles');
    if (isDir(profRoot)) {
      for (const name of fs.readdirSync(profRoot)) {
        const dir = path.join(profRoot, name);
        if (isDir(dir)) list.push({ id: `profiles/${name}`, dir, json: path.join(dir, '.claude.json') });
      }
    }
    return list.map((p) => {
      const j = readJson(p.json, {});
      const fileEmail = j?.oauthAccount?.emailAddress || null;
      const real = this.identity?.known(p.id) || null;
      return {
        ...p,
        name: p.isMain ? 'main (~/.claude)' : p.id,
        signedIn: fs.existsSync(path.join(p.dir, '.credentials.json')),
        // The info file can be rewritten by the desktop app; the verified login wins.
        email: real?.email || fileEmail,
        verified: !!real,
        fileEmail,
        org: real?.org || j?.oauthAccount?.organizationName || null,
      };
    });
  }

  /** Laptop-only view: every profile with its email so the right one can be picked. */
  listForLaptop() {
    return this.scan().map(({ id, name, signedIn, email, verified, fileEmail, org }) => ({ id, name, signedIn, email, verified, fileMismatch: verified && fileEmail && fileEmail.toLowerCase() !== email.toLowerCase() ? fileEmail : null, org, chosen: id === this.state.profileId }));
  }

  /** One profile by id (any signed-in profile can run a session; the chosen one is only the default). */
  get(id) {
    const p = this.scan().find((x) => x.id === id);
    if (!p) throw httpErr(404, 'No such Claude account on the laptop');
    return { id: p.id, name: p.name, email: p.email, org: p.org, signedIn: p.signedIn, dir: p.dir, json: p.json, isMain: !!p.isMain };
  }

  /** What the phone sees: accounts with email, which one is the default. No folder paths. */
  listPublic() {
    return this.scan().map(({ id, name, signedIn, email, verified, org }) => ({ id, name, signedIn, email, verified, org, isDefault: id === this.state.profileId }));
  }

  chosen() {
    if (!this.state.profileId) return null;
    const p = this.scan().find((x) => x.id === this.state.profileId);
    if (!p) return null;
    return { id: p.id, name: p.name, email: p.email, verified: p.verified, signedIn: p.signedIn, dir: p.dir, json: p.json, isMain: !!p.isMain };
  }

  async choose(id) {
    const p = this.scan().find((x) => x.id === id);
    if (!p) throw httpErr(404, 'No such profile');
    if (!p.signedIn) throw httpErr(400, 'That profile is not signed in. Sign it in first (mc login <name>).');
    this.state = { profileId: p.id, chosenAt: Date.now() };
    await writeJsonAtomic(this.file, this.state);
    return this.chosen();
  }

  /**
   * Environment for the Claude process: pins the chosen profile and strips anything that would make
   * Claude use a different account or an API key instead (so it can never fall back to another login).
   */
  envFor(profile) {
    const env = { ...process.env };
    for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDECODE', 'CLAUDE_PID']) delete env[k];
    // Drop everything a parent Claude (e.g. the desktop app) passes down: host auth, account ids, sockets.
    for (const k of Object.keys(env)) if (/^(CLAUDE_CODE_|CLAUDE_AGENT_SDK_)/i.test(k)) delete env[k];
    if (profile.isMain) delete env.CLAUDE_CONFIG_DIR;
    else env.CLAUDE_CONFIG_DIR = profile.dir;
    return env;
  }
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
