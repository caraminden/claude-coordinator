// One round of the down-alert watchdog (src/watchdog.ts), run by deploy/citadel-watchdog.service every
// 5 minutes. `--dry-run` prints what it found and would send, and saves and sends nothing.
// Environment: DATA_DIR (Citadel's, default ~/.local/share/claude-coordinator), WATCHDOG_STATE (its
// state file, default $STATE_DIRECTORY/state.json), WATCHDOG_MINUTES (default 10), CITADEL_SYSTEMCTL (a stand-in systemctl, for tests).
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { loadVapidKeys, postPush } from '../src/push.ts';
import { readBackups, backupProblems } from '../src/backup-freshness.ts';
import { answer, check, recipients, step, targets, unitState, type WatchState } from '../src/watchdog.ts';
import { thrown } from '../src/thrown.ts';

const env = process.env;
const dry = process.argv.includes('--dry-run');
const home = homedir();
const dataDir = env.DATA_DIR || join(home, '.local/share/claude-coordinator');
const stateFile = env.WATCHDOG_STATE || join(env.STATE_DIRECTORY || join(home, '.local/state/citadel-watchdog'), 'state.json');
const minutes = Number(env.WATCHDOG_MINUTES) || 10;
const systemctl = env.CITADEL_SYSTEMCTL || 'systemctl';

const db = new DatabaseSync(join(dataDir, 'coordinator.db'), { readOnly: true });
let prev: WatchState = {};
try {
  prev = JSON.parse(readFileSync(stateFile, 'utf8'));
} catch (err) {
  if (thrown(err).code !== 'ENOENT') console.error(`Starting afresh: ${stateFile} unreadable (${thrown(err).message})`);
}

const now = Date.now();
// WATCHDOG_CITADEL_PORT: tests point it at a stand-in, never the live port.
const found = await check(targets(db, home, Number(env.WATCHDOG_CITADEL_PORT) || undefined), { unitState: (u) => unitState(u, systemctl), answer });
// A missed or failed night is one more finding (admins only: its key isn't an app's), pushed like a down alert once it has lasted the threshold, #1142.
const appRows = db.prepare('SELECT name, title FROM contraptions ORDER BY name').all() as { name: string; title: string }[];
const missing = backupProblems(await readBackups(dataDir, home, appRows, now), now);
found.set('backup', { title: 'Nightly backup', finding: missing.length ? missing.join('; ') : null });
const { messageFor, sent, unsent } = step(prev, found, now, minutes * 60_000);
const message = messageFor(null);
const down = [...found].filter(([, f]) => f.finding).map(([, f]) => `${f.title}: ${f.finding}`);
console.log(`${found.size} watched, ${down.length ? `down: ${down.join('; ')}` : 'all up'}`);

let next = sent;
if (message) {
  // Each device hears what's theirs: an admin everything, a contraption's owner only theirs.
  const subs = recipients(db)
    .map((s) => ({ ...s, msg: messageFor(s.only) }))
    .filter((s) => s.msg);
  for (const s of subs) console.log(`${dry ? 'Would push' : 'Pushing'} to ${s.name}${s.only ? ' (owner)' : ''}: ${s.msg!.title}: ${s.msg!.body}`);
  if (!subs.length) console.log(`No device to push to: ${message.title}: ${message.body}`);
  // Never make a key pair here: loadVapidKeys would, and a new one orphans every subscription.
  const keyFile = join(dataDir, 'vapid.json');
  let delivered = false;
  if (dry) delivered = true;
  else if (!existsSync(keyFile)) console.error(`No ${keyFile}: nothing to sign pushes with.`);
  else {
    const keys = loadVapidKeys(dataDir);
    // The subject the server signs with (server.ts): a push service may refuse another.
    const stored = db.prepare("SELECT value FROM settings WHERE key = 'push_subject'").get() as { value: string } | undefined;
    const subject = env.PUSH_SUBJECT ?? (stored ? JSON.parse(stored.value) : null) ?? 'https://localhost';
    const results = await Promise.all(
      subs.map((s) =>
        postPush(s, s.msg!, keys, subject).then(
          async (res) => (res.ok || console.error(`Push to ${s.name} answered ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`), res.ok),
          (err) => (console.error(`Push to ${s.name} failed: ${err.message}`), false),
        ),
      ),
    );
    // One device that got it is enough: the alert is out (a phone that missed it hears the all-clear).
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
