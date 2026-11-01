import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { httpErr, readJson } from './util.js';

const MODELS_TTL = 30 * 60_000;
const USAGE_TTL = 60_000;
const TIMEOUT = 60_000;

/**
 * Asks Claude Code (on one account) for facts without sending any prompt, so it uses no tokens:
 * which account it is, the exact model list (with effort levels), and plan usage limits.
 * Starts a Claude process, waits for its start-up handshake, asks, then closes it.
 */
export class Probe {
  constructor(profiles, { queryFn = sdkQuery } = {}) {
    this.profiles = profiles;
    this.queryFn = queryFn;
    this.cache = new Map(); // profileId -> { at, usageAt, account, models, usage, error }
    this.inflight = new Map();
    this.live = new Map(); // profileId -> { at, windows } from real Claude replies (most trustworthy)
  }

  /** Called with the rate-limit info that comes back with every real Claude reply. */
  recordLive(profileId, info) {
    if (!profileId || !info) return;
    const src = info.unifiedWindows || (info.rateLimitType ? { [info.rateLimitType]: { utilization: info.utilization, resetsAt: info.resetsAt } } : null);
    if (!src) return;
    const prev = this.live.get(profileId)?.windows || {};
    const windows = { ...prev };
    for (const [k, w] of Object.entries(src)) {
      if (!w || w.utilization == null) continue;
      windows[k] = { percent: w.utilization <= 1 ? Math.round(w.utilization * 1000) / 10 : w.utilization, resetsAt: w.resetsAt ? new Date(w.resetsAt * 1000).toISOString() : null };
    }
    this.live.set(profileId, { at: Date.now(), windows });
  }

  liveFor(profileId) {
    const l = this.live.get(profileId);
    if (!l) return null;
    const LABEL = { five_hour: 'Current session (5 hours)', seven_day: 'Weekly · all models', seven_day_opus: 'Weekly · Opus', seven_day_sonnet: 'Weekly · Sonnet' };
    return { at: l.at, windows: Object.entries(l.windows).map(([k, w]) => ({ label: LABEL[k] || k, ...w })) };
  }

  async models(profileId) {
    const c = this.cache.get(profileId);
    if (c?.models && Date.now() - c.at < MODELS_TTL) return c;
    return this.run(profileId);
  }

  async usage(profileId, { fresh = false } = {}) {
    const c = this.cache.get(profileId);
    if (!fresh && c && Date.now() - (c.usageAt || 0) < USAGE_TTL) return c;
    return this.run(profileId);
  }

  run(profileId) {
    if (this.inflight.has(profileId)) return this.inflight.get(profileId);
    const p = this.doRun(profileId).finally(() => this.inflight.delete(profileId));
    this.inflight.set(profileId, p);
    return p;
  }

  async doRun(profileId) {
    const profile = this.profiles.get(profileId);
    if (!profile.signedIn) throw httpErr(409, `${profile.email || profile.name} is not signed in on the laptop`);
    const abort = new AbortController();
    const never = { [Symbol.asyncIterator]: () => ({ next: () => new Promise((resolve) => abort.signal.addEventListener('abort', () => resolve({ done: true, value: undefined }))) }) };
    const q = this.queryFn({
      prompt: never,
      options: { abortController: abort, env: this.profiles.envFor(profile), settingSources: ['user'], permissionMode: 'default', canUseTool: async () => ({ behavior: 'deny', message: 'probe' }) },
    });
    const drain = (async () => {
      try {
        for await (const _ of q) { /* nothing is sent, nothing expected */ }
      } catch {
        /* closed */
      }
    })();
    const timeout = (ms) => new Promise((_, rej) => setTimeout(() => rej(new Error('Claude did not answer in time')), ms).unref?.());
    const out = { profileId, at: Date.now(), usageAt: Date.now(), account: null, models: null, usage: null, error: null };
    try {
      const info = await Promise.race([q.accountInfo(), timeout(TIMEOUT)]);
      out.account = { email: info?.email || null, plan: info?.subscriptionType || null, org: info?.organization || null };
      const [models, usage] = await Promise.all([
        Promise.race([q.supportedModels(), timeout(TIMEOUT)]).catch((e) => ({ error: e.message })),
        typeof q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET === 'function'
          ? Promise.race([q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }), timeout(TIMEOUT)]).catch((e) => ({ error: e.message }))
          : { error: 'This Claude Code version cannot report usage' },
      ]);
      out.models = Array.isArray(models) ? models.map(cleanModel) : null;
      if (models?.error) out.error = models.error;
      out.usage = usage?.error ? { error: usage.error } : cleanUsage(usage);
      // Claude Code caches this answer; record when Anthropic actually produced it.
      const cached = readJson(profile.json, {})?.cachedUsageUtilization;
      if (out.usage && !out.usage.error) out.usage.dataAt = cached?.fetchedAtMs || null;
    } catch (e) {
      out.error = e.message;
    } finally {
      abort.abort();
      await Promise.race([drain, new Promise((r) => setTimeout(r, 3000))]);
    }
    const prev = this.cache.get(profileId);
    // Keep the last good model list if this run could not get one.
    if (!out.models && prev?.models) out.models = prev.models;
    this.cache.set(profileId, out);
    return out;
  }
}

function cleanModel(m) {
  return {
    value: m.value,
    displayName: m.displayName || m.value,
    description: m.description || '',
    efforts: m.supportsEffort ? m.supportedEffortLevels || [] : [],
    fast: !!m.supportsFastMode,
  };
}

function cleanUsage(u) {
  if (!u) return null;
  const rl = u.rate_limits || null;
  const win = (w, label) => (w && (w.utilization != null || w.resets_at) ? { label, percent: w.utilization, resetsAt: w.resets_at } : null);
  const windows = rl
    ? [
      win(rl.five_hour, 'Current session (5 hours)'),
      win(rl.seven_day, 'Weekly · all models'),
      win(rl.seven_day_opus, 'Weekly · Opus'),
      win(rl.seven_day_sonnet, 'Weekly · Sonnet'),
      ...(rl.model_scoped || []).map((m) => win(m, `Weekly · ${m.display_name}`)),
    ].filter(Boolean)
    : [];
  const extra = rl?.extra_usage?.is_enabled
    ? { percent: rl.extra_usage.utilization, used: rl.extra_usage.used_credits, limit: rl.extra_usage.monthly_limit, currency: rl.extra_usage.currency || null }
    : null;
  return { plan: u.subscription_type || null, available: !!u.rate_limits_available, windows, extra };
}
