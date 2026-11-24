// The whole-app UI sweep (#471): every screen and common state of Citadel, shot at desktop and phone
// widths on a dev copy of the live data, with the ui-measure numbers beside each shot, for the
// citadel:critic Grunts (the UI screenshots critic) to judge. Re-run it after a batch of fixes.
//
//   node tools/ui-sweep.ts [--out <dir, default $TMPDIR/ui-sweep-out>] [--db <copy>] [--only name,name] [--list] [--keep]
//
// It snapshots the live database read-only and scrubs it as citadel-dev-copy does (src/db-copy.ts,
// src/previews.ts), and starts this worktree's server.ts in preview mode (no turns, pushes, machines or
// GitHub) on a free random port. Not on the dev copy itself: the shared folders below go in before boot. It signs in as the
// first admin with a cookie it issues itself, so no password is needed. --db reuses a copy (it is
// scrubbed again). --keep leaves the server up and prints its URL and cookie, for poking at by hand.
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Auth } from '../src/auth.ts';
import { copyDb } from '../src/db-copy.ts';
import { freePort } from '../src/ports.ts';
import { previewEnv, scrub } from '../src/previews.ts';
import { measure } from '../kit/skills/critique/scripts/ui-measure.mjs';

const root = resolve(import.meta.dirname, '..');
const LIVE_DB = join(homedir(), '.local/share/claude-coordinator/coordinator.db');

/** What ui-measure returns per screen, as far as this script reads it: browser results are untyped JSON. */
interface Measured {
  ok: boolean;
  error?: string;
  counts: Record<string, number>;
  pages: { width: number; shot?: string; shot_after_click?: string }[];
}

/** One screen's line in index.json. */
interface IndexEntry {
  name: string;
  about: string;
  flow: boolean;
  hash: string;
  counts: Record<string, number>;
  error?: string;
  shots: string[];
}

interface Screen {
  name: string;
  /** What it is and what it should read as: the critic's brief. */
  about: string;
  /** The hash route, '' for the front door. */
  hash: string;
  /** Run in the page before the shot: open a menu, scroll, click a tab. Async; `sleep(ms)` and `$(sel)` are there. */
  before?: string;
  /** Only this width (desktop 1440, phone 390). */
  widths?: number[];
  /** Click this with the network slowed, and shoot after (rule 23). */
  click?: string;
  /** Signed out. */
  anon?: boolean;
  flow?: boolean;
}

const S = 2; // Citadel's scheme id in the live data
const helpers = `const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const $ = (s) => document.querySelector(s);
const until = async (s, ms = 8000) => { for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) { const el = typeof s === 'string' ? $(s) : s(); if (el) return el; } throw new Error('never showed: ' + s); };
const phone = innerWidth <= 800;
const drawer = async (side) => { const b = $('.citadel-drawer-handle.' + side); if (!b) throw new Error('no ' + side + ' drawer handle'); b.click(); await sleep(500); };
const scrollChatTo = async (sel) => { await until(sel); await sleep(600); const el = [...document.querySelectorAll(sel)].at(-1); el.scrollIntoView({ block: 'center' }); await sleep(400); el.scrollIntoView({ block: 'center' }); };
`;

// Minions in the live data that show a state; a re-run months on may need new picks (the copy is live).
const T = { plan: 475, cardsForJosh: 441, images: 464, ultra: 476, long: 466, other: 474 };

export const SCREENS: Screen[] = [
  { name: 'login', anon: true, hash: '', about: 'The sign-in page: login and password form.' },
  { name: 'invite-bad', anon: true, hash: '#/invite/not-a-real-link', about: 'An invite link that is no longer valid: the set-a-password form says so.' },
  { name: 'taskmaster', hash: `#/p/${S}`, about: "A scheme's front page: the Taskmaster chat in the middle, the overview panel on the left, the minions list on the right (phone: the chat, with the panels as drawers)." },
  { name: 'minions-list', hash: `#/p/${S}`, widths: [390], before: `await drawer('right');`, about: 'Phone: the minions list drawer, grouped by build and type, with the new-minion box, search and filters.' },
  { name: 'overview-drawer', hash: `#/p/${S}`, widths: [390], before: `await drawer('left');`, about: 'Phone: the overview drawer (shelf of artifacts, settings link and the like).' },
  {
    name: 'minions-search',
    hash: `#/p/${S}`,
    before: `if (phone) await drawer('right'); const s = await until('.thread-search input, input.thread-search, .thread-search'); const i = s.matches('input') ? s : s.querySelector('input'); i.value = 'usage'; i.dispatchEvent(new Event('input', { bubbles: true })); await sleep(400);`,
    about: 'The minions list filtered by a search for "usage".',
  },
  {
    name: 'minions-empty-search',
    hash: `#/p/${S}`,
    before: `if (phone) await drawer('right'); const s = await until('.thread-search input, input.thread-search, .thread-search'); const i = s.matches('input') ? s : s.querySelector('input'); i.value = 'zzqxnothing'; i.dispatchEvent(new Event('input', { bubbles: true })); await sleep(400);`,
    about: 'The minions list with a search that matches nothing: the empty state.',
  },
  { name: 'prop-filter', hash: `#/p/${S}`, before: `if (phone) await drawer('right'); const f = await until('.prop-filter select, .prop-filter button'); f.click(); f.focus(); await sleep(300);`, about: "The minions list's property filter, opened." },
  { name: 'schedules', hash: `#/p/${S}`, before: `if (phone) await drawer('right'); (await until('.schedules-btn')).click(); await sleep(500);`, about: "The scheme's scheduled minions, shown in the minions panel in place of the list." },
  { name: 'inbox-open', hash: `#/p/${S}`, before: `if (phone) await drawer('right'); const t = await until('.inbox-toggle'); t.click(); await sleep(400);`, about: 'The Needs-you inbox strip at the top of the minions list, opened: everything waiting on a person.' },
  { name: 'new-scheme', hash: `#/p/${S}`, before: `if (phone) await drawer('left'); (await until('#schemes-shelf .add')).click(); await sleep(400);`, about: 'The New scheme dialog.' },
  { name: 'chat-plan-open', hash: `#/p/${S}/t/${T.plan}`, before: `await until('.pcard'); await sleep(800); const c = $('.to-card:not([hidden])'); if (c) { c.click(); await sleep(800); } else await scrollChatTo('.pcard');`, about: 'A minion chat with a plan card waiting for Approve or Revise.' },
  { name: 'chat-questions', hash: `#/p/${S}/t/${T.cardsForJosh}`, before: `await scrollChatTo('.qcard');`, about: 'A minion chat with open question cards (multiple choice with a recommended option).' },
  { name: 'chat-answered', hash: `#/p/${S}/t/${T.long}`, before: `await scrollChatTo('.qcard');`, about: 'A finished minion chat with answered cards, the readout and long messages.' },
  { name: 'chat-images', hash: `#/p/${S}/t/${T.images}`, before: `await scrollChatTo('.msg img, #log img');`, about: 'A minion chat whose replies show images and file cards.' },
  { name: 'chat-table', hash: `#/p/${S}`, before: `await scrollChatTo('.msg table, table');`, about: 'The Taskmaster chat scrolled to a long markdown table in a reply.' },
  { name: 'chat-failed', hash: '#/p/1/t/111', before: `await scrollChatTo('.note.error');`, about: 'A minion chat (another scheme) where a turn failed with an API error.' },
  { name: 'chat-ultrareview', hash: `#/p/${S}/t/${T.ultra}`, about: 'A sealed minion waiting on ultra review runs.' },
  {
    name: 'composer-typed',
    hash: `#/p/${S}/t/${T.plan}`,
    before: `const b = await until('.composer textarea'); b.focus(); b.value = 'A longer message that wraps onto a few lines so we can see how the composer grows.\\nSecond line\\nThird line'; b.dispatchEvent(new Event('input', { bubbles: true })); await sleep(300);`,
    about: 'The composer under a chat, focused with a three-line message typed.',
  },
  { name: 'ultra-review-dialog', hash: `#/p/${S}/t/${T.plan}`, before: `const b = await until(() => [...document.querySelectorAll('button')].find((x) => /^Ultra/.test(x.textContent.trim()))); b.click(); await sleep(500);`, about: "The Ultra review dialog, opened from a minion chat's head." },
  { name: 'artifacts', hash: `#/p/${S}/artifacts`, about: "The scheme's artifacts browser: files minions linked, with search and filters." },
  { name: 'shared-files', hash: `#/p/${S}/shared`, about: "The scheme's shared files list." },
  { name: 'shared-handoff', hash: `#/s/${S}/handoffs%2Fburst-ui-flow-sweep.md`, about: 'A shared Markdown handoff opened in the file viewer, with its Start-as-minion button.' },
  { name: 'settings-instructions', hash: `#/p/${S}/instructions`, about: "Orders → the scheme's instructions editor." },
  { name: 'settings-app-instructions', hash: `#/p/${S}/app-instructions`, about: 'Settings → Citadel-wide instructions editor.' },
  { name: 'settings-approvals', hash: `#/p/${S}/approvals`, about: 'Orders → Minion rules: what the scheme asks a person before doing, plugins, list groups and CI.' },
  { name: 'settings-properties', hash: `#/p/${S}/properties`, about: "Orders → Properties: the scheme's property registry." },
  { name: 'settings-members', hash: `#/p/${S}/members`, about: 'Settings → Members of the scheme.' },
  { name: 'settings-people', hash: `#/p/${S}/people`, about: 'Settings → People (admins): everyone, invites and resets.' },
  { name: 'settings-contraptions', hash: `#/p/${S}/contraptions`, about: 'Settings → Contraptions (admins): personal apps, who each is enabled for.' },
  { name: 'settings-account', hash: `#/p/${S}/account`, about: 'Settings → Your account: linked Claude, GitHub, Codex, password.' },
  { name: 'settings-machines', hash: `#/p/${S}/machines`, about: 'Settings → Machines: computers lent to the scheme, and the line to connect one.' },
  { name: 'not-found', hash: `#/p/${S}/t/999999`, about: 'A link to a minion that does not exist: the error state.' },
  { name: 'empty-scheme', hash: '#/p/__EMPTY__', before: `if (phone) await drawer('right');`, about: 'A brand-new scheme with no minions yet: the empty states of the chat and the minions list.' },
  // Flows: a click with the network slowed, shot after (rule 23: the result shows at once).
  {
    name: 'flow-send',
    flow: true,
    widths: [1440],
    hash: `#/p/${S}/t/${T.other}`,
    before: `const b = await until('.composer textarea'); b.focus(); b.value = 'Looks good, build it.'; b.dispatchEvent(new Event('input', { bubbles: true })); await sleep(200);`,
    click: '.composer button[type=submit], .composer .send',
    about: 'Flow: sending a message in a minion chat. Shot right after the click with a slow network.',
  },
  {
    name: 'flow-send-phone',
    flow: true,
    widths: [390],
    hash: `#/p/${S}/t/${T.ultra}`,
    before: `const b = await until('.composer textarea'); b.focus(); b.value = 'Looks good, build it.'; b.dispatchEvent(new Event('input', { bubbles: true })); await sleep(200);`,
    click: '.composer button[type=submit], .composer .send',
    about: 'Flow (phone): sending a message in a minion chat. Shot right after the click with a slow network.',
  },
  {
    name: 'flow-answer-card',
    flow: true,
    hash: `#/p/${S}/t/${T.cardsForJosh}`,
    before: `await scrollChatTo('.qcard, .question-card');`,
    click: '.qcard button.opt, .qcard .options button, .question-card button',
    about: 'Flow: answering a question card by tapping an option. Shot right after the click with a slow network.',
  },
  // Only one open plan in the live data, and approving settles it: one width.
  {
    name: 'flow-approve-plan',
    flow: true,
    widths: [390],
    hash: `#/p/${S}/t/${T.plan}`,
    before: `await scrollChatTo('.pcard'); [...[...document.querySelectorAll('.pcard')].at(-1).querySelectorAll('button')].find((b) => b.textContent.trim() === 'Approve').dataset.sweep = 'go';`,
    click: '[data-sweep=go]',
    about: 'Flow (phone): approving a plan card. Shot right after the click with a slow network.',
  },
];

function args(argv: string[]) {
  const o: { out: string; db?: string; only?: string[]; list: boolean; keep: boolean } = { out: join(process.env.TMPDIR || tmpdir(), 'ui-sweep-out'), list: false, keep: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') o.out = resolve(argv[++i]);
    else if (a === '--db') o.db = resolve(argv[++i]);
    else if (a === '--only') o.only = argv[++i].split(',');
    else if (a === '--list') o.list = true;
    else if (a === '--keep') o.keep = true;
    else throw new Error(`unknown argument ${a}`);
  }
  return o;
}

async function main() {
  const o = args(process.argv.slice(2));
  if (o.list) {
    for (const s of SCREENS) console.log(`${s.name.padEnd(26)} ${s.hash}`);
    return;
  }
  const dir = join(process.env.TMPDIR || tmpdir(), `ui-sweep-${process.pid}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const db = join(dir, 'coordinator.db');
  await copyDb(o.db ?? LIVE_DB, db);
  scrub(db);
  // Plus an empty scheme for the empty states.
  const copy = new DatabaseSync(db);
  // The picked minions' own shared folders, so their chats' images load.
  const ownShared = Object.values(T)
    .map((n) => (copy.prepare('SELECT id FROM tickets WHERE project_id = ? AND number = ?').get(S, n) as { id: number } | undefined)?.id)
    .filter(Boolean);
  const admin = copy.prepare('SELECT id, name FROM users WHERE admin = 1 ORDER BY id LIMIT 1').get() as { id: number; name: string };
  const emptyId = Number((copy.prepare("INSERT INTO projects (name, owner_id, created_at) VALUES ('Sweep empty', ?, datetime('now')) RETURNING id").get(admin.id) as { id: number })?.id ?? 0);
  copy.close();
  const shared = join(homedir(), `.local/share/claude-coordinator/projects/${S}/shared/project`);
  mkdirSync(join(dir, `projects/${S}/shared`), { recursive: true });
  for (const id of ownShared) {
    const from = join(homedir(), `.local/share/claude-coordinator/projects/${S}/shared/${id}`);
    if (existsSync(from)) execFileSync('rsync', ['-a', `${from}/`, join(dir, `projects/${S}/shared/${id}/`)]);
  }
  if (existsSync(shared)) execFileSync('rsync', ['-a', '--exclude=inbox', `${shared}/`, join(dir, `projects/${S}/shared/project/`)]);

  const port = await freePort();
  const password = randomBytes(16).toString('hex');
  const secret = randomBytes(32).toString('hex');
  const server = spawn(process.execPath, [join(root, 'server.ts')], {
    cwd: root,
    env: previewEnv(port, dir, password, secret),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  server.stdout!.on('data', (d) => (log = (log + d).slice(-4000)));
  server.stderr!.on('data', (d) => (log = (log + d).slice(-4000)));
  const stop = () => {
    if (server.exitCode === null) server.kill();
  };
  process.on('exit', stop);
  const base = `http://127.0.0.1:${port}/`;
  for (const end = Date.now() + 60_000; ; await new Promise((r) => setTimeout(r, 200))) {
    if (server.exitCode !== null) throw new Error(`server exited during boot:\n${log}`);
    if (Date.now() > end) throw new Error(`server did not answer in 60 s:\n${log}`);
    const ok = await fetch(`${base}api/health`).then(
      (r) => r.ok,
      () => false,
    );
    if (ok) break;
  }
  const cookie = new Auth(password, secret).issueCookie(admin, false).split(';')[0];
  // A cold copy answers the scheme page's calls in up to 20 s on a busy box, past ui-measure's 15 s wait.
  for (const u of [`api/projects/${S}`, 'api/projects', `api/projects/${S}/artifacts`]) await fetch(base + u, { headers: { cookie } }).catch(() => {});
  if (o.keep) console.log(`server ${base} (pid ${server.pid})\ncookie ${cookie}\nempty scheme ${emptyId}`);

  mkdirSync(o.out, { recursive: true });
  const screens = SCREENS.filter((s) => !o.only || o.only.includes(s.name));
  const index: IndexEntry[] = [];
  for (const s of screens) {
    const hash = s.hash.replace('__EMPTY__', String(emptyId));
    const shots = join(dir, 'shots', s.name);
    rmSync(shots, { recursive: true, force: true });
    const scheme = hash.match(/^#\/p\/(\d+)/)?.[1];
    if (scheme && !s.anon) await fetch(`${base}api/projects/${scheme}`, { headers: { cookie } }).catch(() => {});
    const run = () =>
      measure({
        urls: [base + hash],
        widths: s.widths ?? [1440, 390],
        settle: 700,
        cookies: s.anon ? [] : [cookie],
        headers: [],
        ignore: [],
        dark: false,
        // #app fills before a slow route finishes: wait it out, or the shot catches the page spinner.
        shots,
        before: `${helpers}\nawait until(() => (document.body.classList.contains('navigating') ? null : document.body), 20000);\n${s.before ?? 'await sleep(300);'}`,
        click: s.click,
        sweep: false,
        wait: s.anon ? 'form' : '#app > *',
      });
    // One retry: a busy box sometimes misses the 15 s load wait.
    const r: Measured = await run()
      .catch(() => run())
      .catch((e: Error) => ({ ok: false, error: e.message, pages: [], counts: {} }));
    const pages = (r.pages ?? []).map((p) => {
      for (const k of ['shot', 'shot_after_click'] as const) {
        if (!p[k]) continue;
        const to = join(o.out, `${s.name}-${p.width}${k === 'shot' ? '' : '-click'}.png`);
        renameSync(p[k], to);
        p[k] = to;
      }
      return p;
    });
    writeFileSync(join(o.out, `${s.name}.json`), JSON.stringify({ ...r, pages }, null, 1) + '\n');
    index.push({ name: s.name, about: s.about, flow: !!s.flow, hash, counts: r.counts, error: r.error, shots: pages.flatMap((p) => [p.shot, p.shot_after_click].filter((x): x is string => !!x)) });
    console.log(
      `${s.name}: ${
        r.error
          ? `ERROR ${r.error}`
          : r.ok
            ? 'clean'
            : Object.entries(r.counts)
                .map(([k, v]) => `${v} ${k}`)
                .join(', ')
      }`,
    );
  }
  // --only re-shoots a few: keep the other screens' entries, in SCREENS order.
  const prev: IndexEntry[] = existsSync(join(o.out, 'index.json')) ? JSON.parse(readFileSync(join(o.out, 'index.json'), 'utf8')) : [];
  const byName = new Map([...prev, ...index].map((e) => [e.name, e]));
  writeFileSync(join(o.out, 'index.json'), JSON.stringify(SCREENS.map((s) => byName.get(s.name)).filter(Boolean), null, 1) + '\n');
  if (o.keep) {
    console.log('--keep: Ctrl-C (or kill this pid) stops the server');
    await new Promise(() => {});
  }
  stop();
  rmSync(dir, { recursive: true, force: true });
  // Findings are the point of a sweep; a screen that couldn't be shot is a failure.
  if (index.some((e) => e.error)) process.exitCode = 1;
}

if (import.meta.main) await main();
