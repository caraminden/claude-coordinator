// tools/boot-check.ts on a database with a contraption enabled for the admin it signs in as, whose
// service is down (#257): the copy runs with its own SESSION_SECRET, so the contraption's sealed key
// doesn't open there either, and Citadel's page must still boot without a console error.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { promisify } from 'node:util';
import { Contraptions } from '../src/contraptions.ts';
import { Store } from '../src/db.ts';

const repo = join(import.meta.dirname, '..');
const root = mkdtempSync(join(tmpdir(), 'boot-check-test-'));
after(() => rmSync(root, { recursive: true, force: true }));

/** A port nothing listens on: bound once, then let go. */
async function deadPort(): Promise<number> {
  const s = createServer().listen(0, '127.0.0.1');
  await new Promise((r) => s.once('listening', r));
  const { port } = s.address() as { port: number };
  await new Promise((r) => s.close(r));
  return port;
}

const cache = join(homedir(), '.cache', 'ms-playwright');
const hasChromium = existsSync(cache) && readdirSync(cache).some((d) => /^chromium_headless_shell-\d+$/.test(d));

test('a contraption whose service is down and whose keys don\'t open in the copy: the app still boots clean', { skip: !hasChromium && 'no headless Chromium (the boot check needs one)', timeout: 200_000 }, async () => {
  const db = join(root, 'coordinator.db');
  const store = new Store(db);
  const admin = store.createUser({ name: 'Boot', login: 'boot', admin: true, server_login: true });
  const c = new Contraptions(store, 'live-secret-'.repeat(4), join(root, 'keys'));
  const row = c.register({ name: 'mandate', title: 'Mandate', port: await deadPort(), icon: '/icons/icon.svg', home_scheme: null, open_paths: '[]', default_model: null, turn_cap: null });
  store.setContraptionUser(row.id, admin.id, true, admin.id);
  store.db.close();

  const run = await promisify(execFile)(process.execPath, [join(repo, 'tools', 'boot-check.ts'), repo, db], { timeout: 190_000 })
    .then(({ stdout }) => ({ ok: true, out: stdout }), (err) => ({ ok: false, out: `${err.stderr}` }));
  assert.ok(run.ok, run.out.slice(0, 2000));
});

// The live ultra review's record names its live working folder, which a server that recovers it would
// delete; the copy must not carry it, whatever the checked server.ts does with it (#468 S08-1).
test("the copy the checked server boots on has no running ultra review's record", { timeout: 60_000 }, async () => {
  const dir = join(root, 'ultrareview');
  const db = join(dir, 'coordinator.db');
  mkdirSync(dir);
  const store = new Store(db);
  store.setSetting('ultrareview_running', { dir: join(dir, 'live-review'), pid: 1 });
  store.db.close();
  // A checkout whose server.ts only notes what the copy holds, then exits.
  const checkout = join(dir, 'checkout');
  mkdirSync(join(checkout, 'public'), { recursive: true });
  mkdirSync(join(checkout, 'src'));
  writeFileSync(join(checkout, 'src', 'db.ts'), `export * from ${JSON.stringify(join(repo, 'src', 'db.ts'))};\n`);
  const seen = join(checkout, 'seen.txt');
  writeFileSync(join(checkout, 'server.ts'), `import { DatabaseSync } from 'node:sqlite';
import { writeFileSync } from 'node:fs';
const db = new DatabaseSync(process.env.DATA_DIR + '/coordinator.db', { readOnly: true });
const row = db.prepare("SELECT value FROM settings WHERE key = 'ultrareview_running'").get();
writeFileSync(${JSON.stringify(seen)}, row ? String(row.value) : 'none');
process.exit(1);
`);
  await promisify(execFile)(process.execPath, [join(repo, 'tools', 'boot-check.ts'), checkout, db], { timeout: 50_000 }).catch(() => {});
  assert.equal(readFileSync(seen, 'utf8'), 'none');
});
