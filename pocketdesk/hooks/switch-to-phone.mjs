// Claude Code "UserPromptSubmit" hook, installed in every account's settings.json by PocketDesk.
// Type "switch to phone" (or "move to mobile", "continue on phone"…) in ANY Claude Code chat on this laptop and
// that chat is handed to PocketDesk on your phone. The prompt itself is not sent to Claude.
// Every other prompt passes straight through untouched (this script exits silently).
// While PocketDesk Travel mode is on, every other prompt gets a short note telling Claude to keep local work light.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const TRAVEL_NOTE = 'PocketDesk Travel mode is ON: the laptop is closed in a bag on battery, with the CPU slowed down to keep it cool. '
  + 'Keep local work light: avoid builds, full test suites, npm/pip installs, Docker, dev servers and searches over the whole disk. '
  + 'Prefer small, targeted commands (one test file, one type-check of the changed file). If a heavy step is really needed, '
  + 'finish everything else first, then say which commands to run once the laptop is out of the bag.';

const TRAVEL_FILE = path.join(process.env.POCKETDESK_DATA || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data'), 'travel.json');

export function travelNote(file = TRAVEL_FILE) {
  try {
    const st = JSON.parse(fs.readFileSync(file, 'utf8'));
    return st.active && st.lightWork ? TRAVEL_NOTE : null;
  } catch {
    return null;
  }
}

const MATCH = /^\W*(?:(?:please|pls|ok|okay|now|ab)\s+)*(?:switch|move|shift|continue|send|transfer|hand\s*off|handoff|go|take)\b[\w\s]{0,30}?\b(?:phone|mobile)\b[\s.!]*$/i;
const PORT = Number(process.env.POCKETDESK_PORT || 8765);

export function wantsPhone(prompt) {
  const p = String(prompt || '').trim();
  return p.length > 0 && p.length <= 80 && MATCH.test(p);
}

function readStdin() {
  return new Promise((resolve) => {
    let s = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => (s += d));
    process.stdin.on('end', () => resolve(s));
    setTimeout(() => resolve(s), 3000).unref();
  });
}

function post(body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: '/api/handoff', method: 'POST', timeout: 25_000,
      headers: { 'content-type': 'application/json', 'content-length': data.length, 'x-pocketdesk': '1', host: `127.0.0.1:${PORT}` },
    }, (res) => {
      let s = '';
      res.on('data', (d) => (s += d));
      res.on('end', () => {
        let j = {};
        try {
          j = JSON.parse(s);
        } catch {
          /* not json */
        }
        if (res.statusCode >= 400) reject(new Error(j.error || `PocketDesk answered ${res.statusCode}`));
        else resolve(j);
      });
    });
    req.on('timeout', () => req.destroy(new Error('PocketDesk did not answer in time')));
    req.on('error', reject);
    req.end(data);
  });
}

async function main() {
  let input = {};
  try {
    input = JSON.parse(await readStdin());
  } catch {
    return; // not something we understand: let the prompt through
  }
  if (!wantsPhone(input.prompt)) {
    const note = travelNote();
    if (note) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: note } }));
    return;
  }
  let reason;
  try {
    // CLAUDE_CONFIG_DIR tells PocketDesk which account this chat runs on (unset = the main ~/.claude login)
    const r = await post({ session_id: input.session_id, transcript_path: input.transcript_path, cwd: input.cwd, config_dir: process.env.CLAUDE_CONFIG_DIR || null });
    reason = r.message || 'Moved to your phone.';
  } catch (e) {
    reason = `Could not move this chat to the phone: ${e.code === 'ECONNREFUSED' ? 'PocketDesk is not running (run scripts\\start-phone-access.ps1)' : e.message}`;
  }
  process.stdout.write(JSON.stringify({ decision: 'block', reason }));
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) main();
