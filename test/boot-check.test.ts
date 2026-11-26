// tools/boot-check.ts on a database with a contraption enabled for the admin it signs in as, whose
// service is down (#257): the copy runs with its own SESSION_SECRET, so the contraption's sealed key
// doesn't open there either, and Citadel's page must still boot without a console error.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
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

test('the stand-in executable leaves the Claude config path available as a directory', { timeout: 60_000 }, async () => {
  const dir = join(root, 'config-directory');
  mkdirSync(join(dir, 'public'), { recursive: true });
  mkdirSync(join(dir, 'src'));
  const db = join(dir, 'coordinator.db');
  new Store(db).db.close();
  writeFileSync(join(dir, 'src', 'db.ts'), `export * from ${JSON.stringify(join(repo, 'src', 'db.ts'))};\n`);
  const seen = join(dir, 'seen.txt');
  // Stop after inspecting the actual server environment: this test needs no browser or real launcher.
  writeFileSync(
    join(dir, 'server.ts'),
    `import { mkdirSync, writeFileSync } from 'node:fs';
mkdirSync(process.env.CLAUDE_CONFIG_DIR + '/projects/memory', { recursive: true });
writeFileSync(${JSON.stringify(seen)}, 'config directory created');
process.exit(1);
`,
  );
  await promisify(execFile)(process.execPath, [join(repo, 'tools', 'boot-check.ts'), dir, db], { timeout: 50_000 }).catch(() => {});
  assert.equal(readFileSync(seen, 'utf8'), 'config directory created');
});

test('the boot copy uses its stand-in Claude even when the server login has Codex enabled', { skip: !hasChromium, timeout: 200_000 }, async () => {
  const dir = join(root, 'codex-enabled');
  mkdirSync(dir);
  const db = join(dir, 'coordinator.db');
  const store = new Store(db);
  const admin = store.createUser({ name: 'Boot', login: 'boot', admin: true, server_login: true });
  const project = store.createProject('Codex enabled', null);
  store.setProjectRepoDir(project.id, dir);
  store.createTicket({ project_id: project.id, kind: 'coordinator', title: 'Taskmaster', permission_mode: 'default', created_by: 'boot' });
  // A stand-in volume: only the presence of auth.json is inspected, never its contents.
  const home = join(dir, 'volume');
  mkdirSync(join(home, '.codex'), { recursive: true });
  writeFileSync(join(home, '.codex', 'auth.json'), '{}');
  store.setSetting(`container_home:${admin.id}`, home);
  store.setSetting(`codex:on:user:${admin.id}`, true);
  store.db.close();
  const run = await promisify(execFile)(process.execPath, [join(repo, 'tools', 'boot-check.ts'), repo, db], { timeout: 190_000 }).then(
    ({ stderr }) => ({ ok: true, out: stderr }),
    (err) => ({ ok: false, out: String(err.stderr) }),
  );
  assert.ok(run.ok, run.out);
  assert.match(run.out, /a Taskmaster turn started/);
  assert.match(run.out, /a minion turn started/);
  const original = new Store(db);
  assert.equal(original.getSetting(`container_home:${admin.id}`), home);
  assert.equal(original.getSetting(`codex:on:user:${admin.id}`), true);
  original.db.close();
});

test("a contraption whose service is down and whose keys don't open in the copy: the app still boots clean", { skip: !hasChromium && 'no headless Chromium (the boot check needs one)', timeout: 200_000 }, async () => {
  const db = join(root, 'coordinator.db');
  const store = new Store(db);
  const admin = store.createUser({ name: 'Boot', login: 'boot', admin: true, server_login: true });
  const c = new Contraptions(store, 'live-secret-'.repeat(4), join(root, 'keys'));
  const row = c.register({ name: 'mandate', title: 'Mandate', port: await deadPort(), icon: '/icons/icon.svg', home_scheme: null, open_paths: '[]', default_model: null, turn_cap: null });
  store.setContraptionUser(row.id, admin.id, true, admin.id);
  store.db.close();

  const run = await promisify(execFile)(process.execPath, [join(repo, 'tools', 'boot-check.ts'), repo, db], { timeout: 190_000 }).then(
    ({ stdout }) => ({ ok: true, out: stdout }),
    (err) => ({ ok: false, out: `${err.stderr}` }),
  );
  assert.ok(run.ok, run.out.slice(0, 2000));
});

// The smoke pass after the boot (#486): a database with a Taskmaster, a minion with a long chat and
// scheme instructions; a copy of this checkout passes, and each copy with one of the historical breaks
// put back fails, naming the call. Run together, each with its own server and Chromium; a burn-in off CI caps how many
// at once with CITADEL_TEST_CONCURRENCY (#2073).
describe('the smoke pass through the turn tools, the file viewer and the launch arguments', { concurrency: Number(process.env.CITADEL_TEST_CONCURRENCY) || true, skip: !hasChromium && 'no headless Chromium (the boot check needs one)' }, () => {
  const dir = join(root, 'smoke');
  const db = join(dir, 'coordinator.db');
  mkdirSync(dir);
  const store = new Store(db);
  store.createUser({ name: 'Boot', login: 'boot', admin: true, server_login: true });
  // Another scheme, which the Citadel scheme's Taskmaster (scheme 2, asked by an admin) reads too (#656): git rules for
  // its open minions' worktrees, never its closed ones (#661: counting closed ones passed Claude Code's 2 MiB cap).
  const other = store.createProject('Other', null);
  store.setProjectRepoDir(other.id, join(dir, 'other-repo'));
  for (let i = 0; i < 700; i++) {
    const t = store.createTicket({ project_id: other.id, title: `Closed ${i}`, permission_mode: 'default', created_by: 'boot' });
    // Short, fixed paths (never made): the budget test below must not hang on how long the test's temp folder is.
    store.setTicketDir(t.id, `/x/${'w'.repeat(40)}/${i}`, null);
    store.updateTicket(t.id, { status: 'closed' });
  }
  for (let i = 0; i < 5; i++) store.setTicketDir(store.createTicket({ project_id: other.id, title: `Open ${i}`, permission_mode: 'default', created_by: 'boot' }).id, `/x/open/${i}`, null);
  const p = store.createProject('Smoke', null);
  assert.equal(p.id, 2, 'the smoke scheme is the Citadel scheme (GLOBAL_OWNER)');
  store.setProjectInstructions(p.id, '\nShip small changes.\nSecond line.', 'boot');
  store.createTicket({ project_id: p.id, kind: 'coordinator', title: 'Taskmaster', permission_mode: 'default', created_by: 'boot' });
  store.createTicket({ project_id: p.id, title: 'Short chat', permission_mode: 'default', created_by: 'boot' });
  const long = store.createTicket({ project_id: p.id, title: 'Long chat', permission_mode: 'default', created_by: 'boot' });
  // Past one page of the chat (#120).
  for (let i = 0; i < 300; i++) store.addEvent(long.id, 'user_message', { author: 'Boot', text: `Message ${i}` });
  // A git rule per open minion's worktree goes in the Taskmaster's settings when its scheme has a repo.
  store.setProjectRepoDir(p.id, join(dir, 'repo'));
  mkdirSync(join(dir, 'repo'));
  for (let i = 0; i < 70; i++) {
    const wt = join(dir, 'projects', String(p.id), 'tickets', String(i));
    mkdirSync(wt, { recursive: true });
    store.setTicketDir(store.createTicket({ project_id: p.id, title: `Worktree ${i}`, permission_mode: 'default', created_by: 'boot' }).id, wt, null);
  }
  store.db.close();

  /** A copy of this checkout with `file`'s `from` replaced by `to`, the break under test. */
  function brokenCheckout(name: string, file: string, from: string, to: string): string {
    const checkout = join(dir, name);
    for (const part of ['server.ts', 'package.json', 'src', 'public', 'kit', 'tools']) cpSync(join(repo, part), join(checkout, part), { recursive: true });
    const text = readFileSync(join(checkout, file), 'utf8');
    assert.ok(text.includes(from), `${file} no longer has the line this fixture breaks: ${from}`);
    writeFileSync(join(checkout, file), text.replace(from, to));
    return checkout;
  }
  const bootCheck = (checkout: string) =>
    promisify(execFile)(process.execPath, [join(repo, 'tools', 'boot-check.ts'), checkout, db], { timeout: 190_000 }).then(
      ({ stderr }) => ({ ok: true, out: `${stderr}` }),
      (err) => ({ ok: false, out: `${err.stderr}` }),
    );

  test('a healthy checkout passes, reading the longest chat and the instructions', { timeout: 200_000 }, async () => {
    const run = await bootCheck(repo);
    assert.ok(run.ok, run.out.slice(0, 2000));
    assert.match(run.out, /the Taskmaster of scheme 2, with 70 open minions and every scheme's reads \(5 open minions in other schemes\)/);
    // The repo, the live checkout, 71 worktrees (with the boot check's own minion), the other scheme's repo and its 5 open minions'.
    assert.match(run.out, new RegExp(`Taskmaster turn started \\(\\d+ tools; read_ticket #${long.number}; largest argument \\d+ bytes; settings.json \\d+ bytes, git rules for 79 folders\\)`));
  });

  // #2003: on a busy box the server answers a read its readers are slow on with a 503 to ask again. The page and the turn
  // poll ask again, as the app does; here the first ask of each read gets that 503.
  test("a server whose readers ask for a retry passes, the page's reads and the turn poll's", { timeout: 200_000 }, async () => {
    const from = '  const ask = (req: IncomingMessage, res: ServerResponse) => {\n';
    const checkout = brokenCheckout('retry', 'src/front.ts', from, `const asked = new Set<string>();\n${from}    if (!asked.has(req.url ?? '')) {\n      asked.add(req.url ?? '');\n      return busy(res);\n    }\n`);
    const run = await bootCheck(checkout);
    assert.ok(run.ok, run.out.slice(0, 3000));
    assert.match(run.out, /a Taskmaster turn started/);
  });

  // #43: a new import the pinned copy of mcp.ts lacked (the pinner follows only `from './x'`), so every turn's tool server died on start.
  test('a tool server that dies on start fails it', { timeout: 200_000 }, async () => {
    const checkout = brokenCheckout('no-tool-server', 'src/mcp.ts', "import { createInterface } from 'node:readline';", "import { createInterface } from 'node:readline';\nimport './appname-extra.ts';");
    writeFileSync(join(checkout, 'src', 'appname-extra.ts'), '');
    const run = await bootCheck(checkout);
    assert.equal(run.ok, false);
    assert.match(run.out, /turn started, but: The (coordinator|thread) MCP server exited before answering initialize/);
  });

  // #120: /events started paging by default, and read_ticket, still reading the bare route, failed on every minion (#142).
  test('a read_ticket that fails on a long chat fails it', { timeout: 200_000 }, async () => {
    const checkout = brokenCheckout('paged-read', 'src/mcp-minions.ts', '`/api/tickets/${n}/events?after=0`', '`/api/tickets/${n}/events`');
    const run = await bootCheck(checkout);
    assert.equal(run.ok, false);
    assert.match(run.out, /A Taskmaster turn started, but: MCP read_ticket failed/);
  });

  // #157: #144 dropped res from the handler, so the viewer's details of every linked file threw.
  test('a file-details route that throws fails it', { timeout: 200_000 }, async () => {
    const checkout = brokenCheckout('no-file-info', 'src/routes/files.ts', 'const { res, url, app, ticket } = ctx;', 'const { url, app, ticket } = ctx;');
    const run = await bootCheck(checkout);
    assert.equal(run.ok, false);
    assert.match(run.out, /The file viewer's details of a linked file \(GET \/api\/tickets\/\d+\/file\?path=boot-check\.md&info\) answered 500/);
  });

  test('a launch argument over 100 KiB fails it', { timeout: 200_000 }, async () => {
    const checkout = brokenCheckout('big-argument', 'src/turn-launch.ts', "  args.push('--settings', join(dir, 'settings.json'));", "  args.push('--settings', join(dir, 'settings.json'), '--append-system-prompt', 'x'.repeat(110 * 1024));");
    const run = await bootCheck(checkout);
    assert.equal(run.ok, false);
    assert.match(run.out, /turn started, but: The largest launch argument is 112640 bytes, over 100 KiB/);
  });

  // #661: git rules for every minion's worktree, closed ones included, took the Citadel Taskmaster's every-scheme
  // settings.json past Claude Code's 2 MiB cap. Put back for other schemes, the 700 closed minions above pass the 1 MiB budget.
  test('a launch file that grows with closed minions fails it', { timeout: 200_000 }, async () => {
    const checkout = brokenCheckout('closed-minions', 'src/runner.ts', ".filter((t) => t.status !== 'closed' && t.cwd)", '.filter((t) => t.cwd)');
    const run = await bootCheck(checkout);
    assert.equal(run.ok, false);
    assert.match(run.out, /A Taskmaster turn started, but: The launch's settings\.json is \d+ bytes, over the 1024 KiB budget for a launch file \(Claude Code refuses a settings file past 2 MiB\)/);
  });

  // #92: the Taskmaster's inline --settings held a git rule per worktree and passed Linux's 128 KiB cap at about 90 of
  // them. Put back inline, the 70 open minions' worktrees in this database take it past the cap in the copy,
  // and its spawn fails as it did live (the test above holds the 100 KiB line; without the mirror this one passes).
  test('a launch argument that grows with the worktrees fails it', { timeout: 200_000 }, async () => {
    const checkout = brokenCheckout('inline-settings', 'src/turn-launch.ts', "  args.push('--settings', join(dir, 'settings.json'));", "  args.push('--settings', JSON.stringify(settings));");
    const run = await bootCheck(checkout);
    assert.equal(run.ok, false);
    assert.match(run.out, /A Taskmaster turn could not start \([^)]*\): Could not start claude: spawn E2BIG/);
  });
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
  writeFileSync(
    join(checkout, 'server.ts'),
    `import { DatabaseSync } from 'node:sqlite';
import { writeFileSync } from 'node:fs';
const db = new DatabaseSync(process.env.DATA_DIR + '/coordinator.db', { readOnly: true });
const row = db.prepare("SELECT value FROM settings WHERE key = 'ultrareview_running'").get();
writeFileSync(${JSON.stringify(seen)}, row ? String(row.value) : 'none');
process.exit(1);
`,
  );
  await promisify(execFile)(process.execPath, [join(repo, 'tools', 'boot-check.ts'), checkout, db], { timeout: 50_000 }).catch(() => {});
  assert.equal(readFileSync(seen, 'utf8'), 'none');
});
