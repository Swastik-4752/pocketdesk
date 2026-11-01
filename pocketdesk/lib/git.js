import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { httpErr } from './util.js';

const MAX_DIFF = 400 * 1024;
const MAX_FILES = 500;

/**
 * Git for one project folder: status, diff, stage/unstage, commit, pull (fast-forward only), push.
 * Deliberately missing: discard, reset, stash, force-push, branch delete. Nothing here can lose work.
 * Git never asks for a password here (it fails instead of hanging), so pushes need saved credentials.
 */
export class Git {
  constructor(cfg, { files, activity, runFn = runGit } = {}) {
    this.files = files;
    this.activity = activity;
    this.runFn = runFn;
  }

  async top(rootId, rel) {
    const { abs: real } = await this.files.resolve(rootId, rel, { mustExist: true });
    if (!fs.statSync(real).isDirectory()) throw httpErr(400, 'Pick a folder');
    let out;
    try {
      out = await this.runFn(real, ['rev-parse', '--show-toplevel']);
    } catch (e) {
      if (/not a git repository/i.test(e.message)) throw httpErr(409, 'This folder is not inside a git repository');
      if (/bad config line/i.test(e.message)) throw httpErr(409, `This folder has no git repository of its own, so git looked in a parent folder whose .git/config is broken (${e.message})`);
      throw httpErr(409, `Git: ${e.message}`);
    }
    const top = out.trim().replace(/\//g, '\\');
    return { dir: real, top };
  }

  async status(rootId, rel) {
    const { top } = await this.top(rootId, rel);
    const out = await this.runFn(top, ['status', '--porcelain=v1', '-b', '-z', '--untracked-files=all'], { env: { GIT_OPTIONAL_LOCKS: '0' } });
    const parts = out.split('\0').filter((x) => x !== '');
    const head = parts[0]?.startsWith('## ') ? parts.shift().slice(3) : '';
    const branch = parseBranch(head);
    const files = [];
    for (let i = 0; i < parts.length; i++) {
      const e = parts[i];
      const x = e[0];
      const y = e[1];
      const file = e.slice(3);
      let from = null;
      if (x === 'R' || x === 'C' || y === 'R' || y === 'C') from = parts[++i] || null;
      files.push({
        path: file,
        from,
        staged: x !== ' ' && x !== '?' && x !== '!',
        unstaged: y !== ' ',
        untracked: x === '?',
        conflict: x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D'),
        code: `${x}${y}`,
      });
    }
    const remotes = (await this.runFn(top, ['remote']).catch(() => '')).split(/\r?\n/).filter(Boolean);
    return { top, ...branch, remotes, files: files.slice(0, MAX_FILES), total: files.length };
  }

  async knownFile(top, file) {
    if (typeof file !== 'string' || !file || file.startsWith('-') || file.includes('\0')) throw httpErr(400, 'Bad file name');
    const st = await this.runFn(top, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', file], { env: { GIT_OPTIONAL_LOCKS: '0' } });
    return st;
  }

  async diff(rootId, rel, file, { staged = false } = {}) {
    const { top } = await this.top(rootId, rel);
    const st = await this.knownFile(top, file);
    let text;
    if (st.startsWith('??')) {
      try {
        text = await this.runFn(top, ['diff', '--no-index', '--no-color', '--', '/dev/null', file]);
      } catch (e) {
        if (e.code === 1 && e.stdout != null) text = e.stdout; // "files differ" is exit code 1
        else throw e;
      }
    } else {
      text = await this.runFn(top, ['diff', '--no-color', ...(staged ? ['--cached'] : []), '--', file]);
    }
    const cut = text.length > MAX_DIFF;
    return { file, staged, text: cut ? text.slice(0, MAX_DIFF) : text, cut };
  }

  async log(rootId, rel) {
    const { top } = await this.top(rootId, rel);
    let out = '';
    try {
      out = await this.runFn(top, ['log', '-n', '15', '--pretty=format:%h%x1f%an%x1f%at%x1f%s']);
    } catch {
      return { commits: [] }; // no commits yet
    }
    return {
      commits: out.split('\n').filter(Boolean).map((l) => {
        const [hash, author, at, subject] = l.split('\x1f');
        return { hash, author, at: Number(at) * 1000, subject };
      }),
    };
  }

  async stage(rootId, rel, list, who) {
    const { top } = await this.top(rootId, rel);
    const files = await this.checkList(top, list);
    await this.runFn(top, ['add', '--', ...files]);
    this.activity?.log(who, 'Git stage', `${files.length} file(s) in ${top}`);
    return { ok: true };
  }

  async unstage(rootId, rel, list, who) {
    const { top } = await this.top(rootId, rel);
    const files = await this.checkList(top, list);
    try {
      await this.runFn(top, ['restore', '--staged', '--', ...files]);
    } catch (e) {
      if (!/could not resolve HEAD|bad revision 'HEAD'/i.test(e.message)) throw e;
      await this.runFn(top, ['rm', '--cached', '--quiet', '--', ...files]); // no commits yet
    }
    this.activity?.log(who, 'Git unstage', `${files.length} file(s) in ${top}`);
    return { ok: true };
  }

  async checkList(top, list) {
    if (!Array.isArray(list) || !list.length || list.length > MAX_FILES) throw httpErr(400, 'Pick some files');
    for (const f of list) if (typeof f !== 'string' || !f || f.startsWith('-') || f.includes('\0')) throw httpErr(400, 'Bad file name');
    return list;
  }

  async commit(rootId, rel, { message, all }, who) {
    const msg = String(message || '').trim();
    if (!msg) throw httpErr(400, 'Write a commit message');
    if (msg.length > 5000) throw httpErr(400, 'Commit message is too long');
    const { top } = await this.top(rootId, rel);
    if (all) await this.runFn(top, ['add', '-A']);
    let out;
    try {
      out = await this.runFn(top, ['commit', '-m', msg], { timeout: 120_000 });
    } catch (e) {
      throw httpErr(409, cleanGitError(e));
    }
    this.activity?.log(who, 'Git commit', `${msg.split('\n')[0].slice(0, 120)} (${top})`);
    return { ok: true, output: out.trim().slice(0, 4000) };
  }

  async pull(rootId, rel, who) {
    const { top } = await this.top(rootId, rel);
    let out;
    try {
      out = await this.runFn(top, ['pull', '--ff-only'], { timeout: 120_000, both: true });
    } catch (e) {
      throw httpErr(409, cleanGitError(e));
    }
    this.activity?.log(who, 'Git pull', top);
    return { ok: true, output: out.trim().slice(0, 4000) };
  }

  async push(rootId, rel, { setUpstream } = {}, who) {
    const { top } = await this.top(rootId, rel);
    const args = ['push'];
    if (setUpstream) {
      const remotes = (await this.runFn(top, ['remote'])).split(/\r?\n/).filter(Boolean);
      if (!remotes.includes('origin')) throw httpErr(409, 'This repository has no remote called origin');
      args.push('-u', 'origin', 'HEAD');
    }
    let out;
    try {
      out = await this.runFn(top, args, { timeout: 120_000, both: true });
    } catch (e) {
      const text = cleanGitError(e);
      throw httpErr(409, text, { noUpstream: /has no upstream branch/i.test(text) });
    }
    this.activity?.log(who, 'Git push', top);
    return { ok: true, output: out.trim().slice(0, 4000) };
  }
}

export function parseBranch(head) {
  // "main...origin/main [ahead 1, behind 2]" | "No commits yet on main" | "HEAD (no branch)" | "main"
  const out = { branch: null, upstream: null, ahead: 0, behind: 0, detached: false };
  if (!head) return out;
  let m = /^No commits yet on (.+)$/.exec(head) || /^Initial commit on (.+)$/.exec(head);
  if (m) return { ...out, branch: m[1], noCommits: true };
  if (head.startsWith('HEAD (no branch)')) return { ...out, detached: true, branch: 'HEAD' };
  m = /^(.+?)(?:\.\.\.(\S+))?(?: \[(.+)\])?$/.exec(head);
  if (!m) return out;
  out.branch = m[1];
  out.upstream = m[2] || null;
  for (const part of (m[3] || '').split(',').map((s) => s.trim())) {
    const a = /^ahead (\d+)$/.exec(part);
    const b = /^behind (\d+)$/.exec(part);
    if (a) out.ahead = Number(a[1]);
    if (b) out.behind = Number(b[1]);
    if (part === 'gone') out.upstreamGone = true;
  }
  return out;
}

function cleanGitError(e) {
  return String(e.stderr || e.stdout || e.message || 'git failed').replace(/\r/g, '').trim().slice(0, 2000);
}

/** Runs git in `cwd`. Resolves stdout (or stdout+stderr with `both`); rejects with { code, stdout, stderr, message }. */
export function runGit(cwd, args, { env = {}, timeout = 30_000, both = false } = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-c', 'core.quotepath=false', '-c', 'color.ui=false', ...args], {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_ASKPASS: '', SSH_ASKPASS: '', ...env },
      timeout,
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
    }, (err, stdout, stderr) => {
      if (err) {
        const e = new Error(String(stderr || err.message).trim());
        e.code = err.code;
        e.stdout = stdout;
        e.stderr = stderr;
        return reject(e);
      }
      resolve(both ? `${stdout}${stderr}` : stdout);
    });
  });
}
