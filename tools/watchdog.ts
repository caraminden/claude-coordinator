// One round of the down-alert watchdog (src/watchdog.ts), run by deploy/citadel-watchdog.service every
// 5 minutes. `--dry-run` prints what it found and would send, and saves and sends nothing.
// Environment: DATA_DIR (Citadel's, default ~/.local/share/claude-coordinator), WATCHDOG_STATE (its
// state file, default $STATE_DIRECTORY/state.json), WATCHDOG_MINUTES (default 10), WATCHDOG_TO
// (owner or admins, default owner), CITADEL_SYSTEMCTL (a stand-in systemctl, for tests).
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { loadVapidKeys, postPush } from '../src/push.ts';
import { answer, check, recipients, step, targets, unitState, type WatchState } from '../src/watchdog.ts';

const env = process.env;
const dry = process.argv.includes('--dry-run');
const home = homedir();
const dataDir = env.DATA_DIR || join(home, '.local/share/claude-coordinator');
const stateFile = env.WATCHDOG_STATE || join(env.STATE_DIRECTORY || join(home, '.local/state/citadel-watchdog'), 'state.json');
const minutes = Number(env.WATCHDOG_MINUTES) || 10;
const who = env.WATCHDOG_TO === 'admins' ? 'admins' : 'owner';
const systemctl = env.CITADEL_SYSTEMCTL || 'systemctl';

const db = new DatabaseSync(join(dataDir, 'coordinator.db'), { readOnly: true });
let prev: WatchState = {};
try {
  prev = JSON.parse(readFileSync(stateFile, 'utf8'));
} catch (err: any) {
  if (err.code !== 'ENOENT') console.error(`Starting afresh: ${stateFile} unreadable (${err.message})`);
}

const now = Date.now();
const found = await check(targets(db, home), { unitState: (u) => unitState(u, systemctl), answer });
const { message, sent, unsent } = step(prev, found, now, minutes * 60_000);
const down = [...found].filter(([, f]) => f.finding).map(([, f]) => `${f.title}: ${f.finding}`);
console.log(`${found.size} watched, ${down.length ? `down: ${down.join('; ')}` : 'all up'}`);

let next = sent;
if (message) {
  const subs = recipients(db, who);
  console.log(`${dry ? 'Would push' : 'Pushing'} to ${subs.length} device(s) of ${who}: ${message.title}: ${message.body}`);
  // Never make a key pair here: loadVapidKeys would, and a new one orphans every subscription.
  const keyFile = join(dataDir, 'vapid.json');
  let delivered = false;
  if (dry) delivered = true;
  else if (!existsSync(keyFile)) console.error(`No ${keyFile}: nothing to sign pushes with.`);
  else {
    const keys = loadVapidKeys(dataDir);
    const results = await Promise.all(subs.map((s) => postPush(s, message, keys, 'https://localhost').then(
      async (res) => (res.ok || console.error(`Push to ${s.name} answered ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`), res.ok),
      (err) => (console.error(`Push to ${s.name} failed: ${err.message}`), false))));
    delivered = results.some(Boolean);
  }
  // Undelivered: keep it unsaid, so the next round tries again.
  if (!delivered) next = unsent;
}
if (!dry) {
  mkdirSync(dirname(stateFile), { recursive: true });
  writeFileSync(`${stateFile}.tmp`, JSON.stringify(next));
  renameSync(`${stateFile}.tmp`, stateFile);
}
db.close();
