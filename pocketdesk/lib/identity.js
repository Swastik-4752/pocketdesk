import fs from 'node:fs';
import path from 'node:path';
import { httpErr, sha256 } from './util.js';

const TTL = 30 * 60_000;
const PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile';

/**
 * Finds out who a profile's saved login REALLY belongs to, by asking Anthropic with that login's own token.
 *
 * Why: Claude Code reports the email from its .claude.json file, and the Claude desktop app rewrites that file
 * with ITS account. So the file (and `claude auth status`, and the SDK's accountInfo()) can name one person
 * while the saved token belongs to another. The token is what actually gets used, so the token is what we check.
 * The token is only ever sent to api.anthropic.com and is never logged or stored by PocketDesk.
 */
export class Identity {
  constructor({ fetchFn = globalThis.fetch, refreshFn = null } = {}) {
    this.fetchFn = fetchFn;
    this.refreshFn = refreshFn; // starts Claude briefly so it renews an expired token
    this.cache = new Map(); // sha256(token) -> identity
    this.byProfile = new Map(); // profileId -> last identity
  }

  readToken(profile) {
    try {
      const c = JSON.parse(fs.readFileSync(path.join(profile.dir, '.credentials.json'), 'utf8')).claudeAiOauth;
      return c?.accessToken ? { token: c.accessToken, expiresAt: Number(c.expiresAt) || 0 } : null;
    } catch {
      return null;
    }
  }

  async ask(token) {
    const r = await this.fetchFn(PROFILE_URL, {
      headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' },
      signal: AbortSignal.timeout(15_000),
    });
    if (r.status === 401 || r.status === 403) return { expired: true };
    if (!r.ok) throw httpErr(502, `Anthropic did not answer who this login is (HTTP ${r.status})`);
    const j = await r.json();
    const email = j?.account?.email || j?.account?.email_address;
    if (!email) throw httpErr(502, 'Anthropic did not say which account this login is');
    return { email, name: j.account.display_name || j.account.full_name || null, org: j.organization?.name || null };
  }

  /** Returns { email, name, org, at } for the profile's saved login, or throws. */
  async verify(profile) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const t = this.readToken(profile);
      if (!t) throw httpErr(409, `${profile.name} has no saved login on the laptop`);
      const key = sha256(t.token);
      const hit = this.cache.get(key);
      if (hit && Date.now() - hit.at < TTL) {
        this.byProfile.set(profile.id, hit);
        return hit;
      }
      const expired = t.expiresAt && t.expiresAt < Date.now() + 60_000;
      if (!expired) {
        const r = await this.ask(t.token);
        if (!r.expired) {
          const v = { ...r, at: Date.now() };
          this.cache.set(key, v);
          this.byProfile.set(profile.id, v);
          return v;
        }
      }
      if (attempt === 0 && this.refreshFn) {
        await this.refreshFn(profile).catch(() => {});
        continue;
      }
      throw httpErr(409, `The saved login for ${profile.name} has expired. Sign it in again on the laptop.`);
    }
    throw httpErr(409, 'Could not check the login');
  }

  known(profileId) {
    return this.byProfile.get(profileId) || null;
  }
}
