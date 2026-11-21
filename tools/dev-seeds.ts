// The states minions test, as plain functions over the store (#642): `citadel-dev-copy seed <name>` adds one to
// the running dev copy and prints the route that shows it; a test may call them on its own Store. A feature that
// needs a state no scenario has adds one here rather than in a scratch seed.ts. Each adds a fresh minion (or a few)
// to a scheme named "Seeded", so they work on --data empty and on a copy of the live data alike.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { marksTitle } from '../public/ui/marks.js';
import type { Project, Store, Ticket } from '../src/db.ts';
import { projectDir, projectSharedDir } from '../src/workspace.ts';
import { readAgentFiles } from '../src/review-set.ts';
import { loadTemplates, templateFields, templateVars } from '../src/schedules.ts';
import { projectSlug } from '../src/sessions.ts';
import { inviteHash } from '../src/auth.ts';
import { pacificDay } from '../src/pacific.ts';
import { jobStage, jobView, kindHash, type JobKind } from '../src/machine-jobs.ts';
import { coldKey, loopKey, mailKey, type LoopState } from '../src/minion-relay.ts';
import { CARD_OPTIONS } from '../src/welcome.ts';
import { memoryFolders, readFolder } from '../src/memory-files.ts';
import { checkChanges, countLine } from '../src/memory-curator.ts';
import { templateBlobs } from '../src/kit-sync.ts';
import { addMention } from '../src/mentions.ts';
import { heldPlan, settingsOverlaps } from '../src/instructions-save.ts';

export interface SeedCtx { store: Store; project: Project; dataDir: string; who: string }

/** The "Seeded" scheme, made once, with `login` (the copy's signed-in admin) a member. */
export function seedScheme(store: Store, dataDir: string, login: string): SeedCtx {
  const user = store.listUsers().find((u) => u.login.toLowerCase() === login.toLowerCase());
  const project = store.listProjects().find((p) => p.name === 'Seeded') ?? store.createProject('Seeded', null, user?.id ?? null);
  store.setProjectSettings(project.id, { onboarding: 'skipped' });
  if (user) store.addMember(project.id, user.id);
  return { store, project: store.getProject(project.id)!, dataDir, who: user?.name ?? 'Cara' };
}

/** A minion with its own working folder under the copy's data, as a real one has under projects/<id>/tickets. */
function minion(c: SeedCtx, title: string, fields: Parameters<Store['updateTicket']>[1] = {}, type = 'feature'): Ticket {
  const t = c.store.createTicket({ project_id: c.project.id, title, permission_mode: 'bypassPermissions', created_by: c.who });
  const cwd = join(projectDir(c.dataDir, c.project.id), 'tickets', String(t.id));
  mkdirSync(cwd, { recursive: true });
  c.store.setTicketDir(t.id, cwd, `ticket/${t.number}-seeded`);
  c.store.updateTicket(t.id, { status: 'idle', ...fields });
  c.store.props.set('minion', t.id, c.project.id, { type }, c.who);
  return c.store.getTicket(t.id)!;
}

/** The Seeded scheme's Taskmaster, made once. */
function taskmaster(c: SeedCtx): Ticket {
  let tm = c.store.getCoordinator(c.project.id);
  if (!tm) {
    tm = c.store.createTicket({ project_id: c.project.id, kind: 'coordinator', title: 'Coordinator', permission_mode: 'bypassPermissions', created_by: 'Taskmaster' });
    const cwd = join(projectDir(c.dataDir, c.project.id), 'coordinator');
    mkdirSync(cwd, { recursive: true });
    c.store.setTicketDir(tm.id, cwd, null);
  }
  return tm;
}

/** Writes a minion's chat: each call adds one event a few seconds after the last, ending about now. */
function chat(c: SeedCtx, t: Ticket, steps: number) {
  let at = Date.now() - steps * 7000;
  let n = 0;
  const put = (kind: string, data: unknown) =>
    Number(c.store.db.prepare('INSERT INTO events (ticket_id, kind, data, created_at) VALUES (?, ?, ?, ?)').run(t.id, kind, JSON.stringify(data), (at += 7000)).lastInsertRowid);
  const claude = (data: object) => put('claude', data);
  const said = (text: string) => claude({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
  /** A tool call and, unless `result` is null, its result. */
  const call = (name: string, input: object, result: string | null = 'ok') => {
    const id = `seed_${t.id}_${++n}`;
    claude({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
    if (result !== null) claude({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: result }] } });
    return id;
  };
  return {
    put, said, call,
    asked: (text: string) => put('user_message', { author: c.who, text }),
    init: () => claude({ type: 'system', subtype: 'init', session_id: `seed-${t.id}`, model: 'claude-opus-5-5' }),
    done: (text: string) => claude({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: `seed-${t.id}`, total_cost_usd: 0.42, duration_ms: 95_000 }),
    /** A plan of steps, each with a guess in minutes, the first `finished` done and the next in progress. */
    plan: (steps: [string, number][], finished: number) => {
      call('mcp__thread__plan', { steps: steps.map(([step, minutes], i) => ({ n: i + 1, step, why: `${step}.`, minutes })) });
      for (let i = 0; i <= finished && i < steps.length; i++) {
        const next = i < steps.length - 1 && i < finished ? [{ n: i + 2, status: 'doing' }] : [];
        if (i === 0) call('mcp__thread__plan', { steps: [{ n: 1, status: 'doing' }] });
        if (i < finished) call('mcp__thread__plan', { steps: [{ n: i + 1, status: 'done', outcome: 'Done as planned.' }, ...next] });
      }
    },
  };
}

const hex = () => Math.random().toString(16).slice(2, 14).padEnd(12, '0');
const route = (c: SeedCtx, t: Ticket, eventId?: number) => `#/p/${c.project.id}/t/${t.number}${eventId ? `?e=${eventId}` : ''}`;

/** A claim's queue (#1334): `past` holders an hour apart, a holder mid-plan, and waiting, chained and new minions. */
function claimQueue(c: SeedCtx, past: number): string {
  const name = past >= 3 ? 'pipeline-lane' : 'release-lane', now = Date.now(), hour = 3_600_000;
  const done = Array.from({ length: past }, (_, i) => minion(c, `Lane fix ${i + 1}`, { status: 'closed' }));
  const holder = minion(c, 'Ship trains for every scheme', { status: 'running', last_activity: 'Self-review and ship… 2/4' });
  chat(c, holder, 6).plan([['Read the land queue', 3], ['Batch the ships', 8], ['Run the tests', 6], ['Self-review and ship', 12]], 1);
  const next = minion(c, 'Rollback before fast mode');
  const leader = minion(c, 'CI runner labels');
  const chained = minion(c, 'Fast mode lands', { state: 'parked', note: `starts when #${leader.number} is live` });
  c.store.setSetting('chained-minions', [...(c.store.getSetting<{ ticket: number }[]>('chained-minions') ?? []), { ticket: chained.id, after: leader.id, when: 'live', message: 'Fast mode lands.', from: 'Taskmaster', base: null }]);
  const fresh = minion(c, 'Deploy dry run', { status: 'new' });
  let at = now - (past + 1.5) * hour;
  c.store.claims.take(c.project.id, name, done[0].id, 'Taskmaster', '', at);
  c.store.claims.setQueue(c.project.id, name, [...done.slice(1), holder].map((t) => t.id), 'Taskmaster', at);
  for (let i = 0; i < past; i++) c.store.claims.passOn(c.project.id, name, 'live', (at += hour - i * 600_000));
  c.store.claims.setQueue(c.project.id, name, [next, chained, fresh].map((t) => t.id), 'Taskmaster', at);
  if (past < 3) return `#/p/${c.project.id}/releases/${c.project.id}`;
  const old = minion(c, 'Rotate the backup keys');
  c.store.claims.take(c.project.id, 'backup-keys', old.id, 'Taskmaster', 'until the new key is in every copy', now - 40 * 60_000);
  return `#/p/${c.project.id}/releases/${c.project.id}`;
}

/** A code-made PNG "screenshot" (#960): a settings page as plain boxes, `rects` as [x, y, w, h, rgb]. */
function pngOf(w: number, h: number, rects: [number, number, number, number, number][]): Buffer {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const hit = rects.findLast(([rx, ry, rw, rh]) => x >= rx && x < rx + rw && y >= ry && y < ry + rh);
      const rgb = hit ? hit[4] : 0x1e2024;
      raw.writeUIntBE(rgb, y * (w * 3 + 1) + 1 + x * 3, 3);
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 'latin1');
    data.copy(out, 8);
    out.writeInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  const head = Buffer.alloc(13);
  head.writeUInt32BE(w, 0);
  head.writeUInt32BE(h, 4);
  head.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', head), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
function crc32(b: Buffer): number {
  let c = ~0;
  for (const byte of b) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c;
}

/**
 * The signed-in person as on their first day (#1151's welcome), `done` of its five steps ticked: 1 (only the password),
 * 3 (Claude and a phone too) or 5 (said hi and answered the practice card). Wipes their actions, push devices and Claude
 * link on the copy, so a later look reads them as new.
 */
function firstDay(c: SeedCtx, done: 1 | 3 | 5) {
  const u = c.store.listUsers().find((x) => x.name === c.who)!;
  c.store.db.prepare('DELETE FROM last_actions WHERE name = ?').run(u.name);
  c.store.db.prepare('UPDATE users SET server_login = ? WHERE id = ?').run(done > 1 ? 1 : 0, u.id);
  for (const s of c.store.listPushSubscriptions().filter((x) => x.name === u.name)) c.store.deletePushSubscription(s.endpoint);
  c.store.setSetting(`welcome:${u.id}`, { shown: Date.now(), ...(done === 5 ? { card: CARD_OPTIONS[1] } : {}) });
  if (done > 1) c.store.savePushSubscription(u.name, `https://push.example/${hex()}`, 'seeded', 'seeded');
  if (done === 5) c.store.addEvent(taskmaster(c).id, 'user_message', { author: u.name, text: 'Hi! What are my schemes doing?' });
  return `#/p/${c.project.id}`;
}

export const SCENARIOS: Record<string, { about: string; seed: (c: SeedCtx) => string }> = {
  'welcome-new': { about: "you on your first day: the welcome over Seeded's Taskmaster chat, only the password ticked (#1151)", seed: (c) => firstDay(c, 1) },
  'welcome-half': { about: 'you halfway through the welcome: password, Claude and phone ticked (#1151)', seed: (c) => firstDay(c, 3) },
  'welcome-no-scheme': {
    about: "Rin, invited but in no scheme (#1151): the welcome over the New scheme page says how to get in; sign in by POSTing a password to /api/invite/welcomeseedwelcomeseedwelcome001",
    seed(c) {
      const rin = c.store.listUsers().find((u) => u.login === 'rin') ?? c.store.createUser({ name: 'Rin', login: 'rin' });
      c.store.updateUser(rin.id, { invite_hash: inviteHash('welcomeseedwelcomeseedwelcome001'), invite_expires: Date.now() + 7 * 24 * 3_600_000 });
      c.store.deleteSetting(`welcome:${rin.id}`);
      return '#/';
    },
  },
  'welcome-done': { about: "you with every welcome step done: it says You're set once, then is gone (#1151)", seed: (c) => firstDay(c, 5) },
  'question-card': {
    about: 'a minion waiting on two open question cards: one pick with a recommended option, one multi-select',
    seed(c) {
      const t = minion(c, 'Sidebar badge colours', { note: 'needs a pick: badge colours' });
      const w = chat(c, t, 12);
      w.asked('The unread badges in the sidebar are hard to see in dark mode. Can you fix them?');
      w.init();
      w.call('Read', { file_path: `${t.cwd}/public/sidebar.css` }, '.badge { background: var(--accent); }');
      w.said('Two ways to fix the contrast; which do you want? To check the build first, run this in an admin window:\n\n```powershell-admin\nicacls "C:\\citadel" /grant Users:F\n```\n\nthen this in plain PowerShell:\n\n```powershell\nGet-ChildItem C:\\citadel\n```\n\nand this in WSL:\n\n```wsl\nls ~/citadel\n```');
      const e = w.put('question', { id: hex(), questions: [{ question: 'How should unread badges look in dark mode?', header: 'Badge style', multiSelect: false, options: [
        { label: 'Solid accent', description: 'A filled accent-coloured pill with white text: 7.1:1 contrast.', recommended: true },
        { label: 'Outlined', description: 'A 1px accent outline with accent text: quieter, 4.6:1 contrast.' },
        { label: 'Leave as is', description: 'Keep today\'s look.' },
      ] }] });
      w.put('question', { id: hex(), questions: [{ question: 'Run this first, in an admin PowerShell window, then say which places should reach the new badge?\n\n```powershell-admin\nicacls "C:\\citadel" /grant Users:F\n```\n\nOr in WSL:\n\n```wsl\nls ~/citadel\n```', header: 'Where', multiSelect: true, options: [
        { label: 'Sidebar', description: 'The minions list.', recommended: true },
        { label: 'Tab title', description: 'The (3) in the browser tab.' },
        { label: 'Phone drawer', description: 'The drawer handle on phones.', recommended: true },
      ] }] });
      w.done('Asked which badge style to use.');
      return route(c, t, e);
    },
  },
  'ship-card': {
    about: 'a minion waiting on a ship card (kind merge, the self-review\'s high-risk go, its chip reads "Ship It") and a `gh pr merge` card for main (#1021)',
    seed(c) {
      const t = minion(c, 'Session cookie rotation', { note: 'risk high: needs a go to ship', state: 'ready' });
      const w = chat(c, t, 10);
      w.asked('Rotate the session cookies every week.');
      w.init();
      w.said('Done and reviewed: risk high, since it touches sign-in. It ships only on a go.');
      w.put('approval', { id: hex(), tool: 'Bash', input: { command: 'gh pr merge 41 --squash', description: 'Ship PR 41' }, merge: {
        target: '41', repo: null, method: 'squash', auto: false, admin: false, moved: false,
        pr: { number: 41, title: 'Rotate session cookies weekly', url: 'https://github.com/example/seeded/pull/41', state: 'OPEN', draft: false, head: 'ticket/41-cookies', base: 'main', checks: 'passed', additions: 48, deletions: 6, files: 3, commits: 2 },
      } });
      const e = w.put('question', { id: hex(), kind: 'merge', questions: [{ question: 'Ship this high-risk change? It changes how sign-in cookies rotate.', header: 'Ship It', multiSelect: false, options: [
        { label: 'Ship It', description: 'It goes onto main and goes live after the restart.', recommended: true },
        { label: 'Hold', description: 'It waits on its branch.' },
      ] }] });
      w.done('Asked for the go to ship.');
      return route(c, t, e);
    },
  },
  'feeder-card': {
    about: "a Build 5 feeder's go card (kind merge, stamped into: 5): its chip and option read Merge, not Ship It",
    seed(c) {
      const t = minion(c, 'Feeder: board column', { note: 'risk high: needs a go to merge', state: 'ready' });
      const w = chat(c, t, 11);
      w.asked('Add the board column.');
      w.init();
      w.said('Done and reviewed: risk high. It merges into Build 5 only on a go.');
      const e = w.put('question', { id: hex(), kind: 'merge', into: 5, questions: [{ question: 'Merge this high-risk change into Build 5?', header: 'Merge', multiSelect: false, options: [
        { label: 'Merge', description: 'It goes into build/5, live when the build ships.', recommended: true },
        { label: 'Hold', description: 'It waits on its branch.' },
      ] }] });
      w.done('Asked for the go to merge.');
      return route(c, t, e);
    },
  },
  'plan-card': {
    about: 'a minion with a plan card waiting for Approve or Revise',
    seed(c) {
      const t = minion(c, 'Archive old minions', { note: 'plan waiting for a go' });
      const w = chat(c, t, 10);
      w.asked('Before you change anything, run the plan back to me: how would archiving minions older than 30 days work?');
      w.init();
      w.call('Grep', { pattern: 'closed_at', path: 'src' }, 'src/db.ts:1412: closed_at INTEGER');
      w.said('Here is the plan; nothing is changed until you approve it.');
      const e = w.put('plan', { id: hex(), status: 'pending', summary: 'Archive dismissed minions after 30 days: hidden from the list, kept in the database, back with one click', plan: [
        '## What changes', '', '- A nightly sweep marks minions dismissed **more than 30 days** ago as archived.',
        '- The minions list hides them; a *Show archived* toggle brings them back.', '- Nothing is deleted: their chats, files and branches stay.', '',
        '## Numbers', '', '| Scheme | Dismissed | Over 30 days |', '| --- | ---: | ---: |', '| Citadel | 612 | 431 |', '| Delve | 150 | 98 |', '',
        '## Not doing', '', '1. Deleting worktrees (a separate cleanup).', '2. Archiving open minions.',
      ].join('\n') });
      w.done('Posted the plan for approval.');
      return route(c, t, e);
    },
  },
  'held-instructions': {
    about: "a minion's edit_instructions held on a card (#1162): its new bullet repeats the card rule, so Save anyway, Work it in or Cancel edit; the scheme's Settings page shows the same list before a person's own save",
    seed(c) {
      const old = '## Shipping\nShip once the tests you touched are green.';
      c.store.setProjectInstructions(c.project.id, old, c.who);
      const project = c.store.getProject(c.project.id)!;
      const add = 'Ask with a card for a go, A or B, or an offer of work; tuning details are yours to pick.';
      const edits = [{ find: 'are green.', replace: `are green.\n\n## Cards\n${add}` }];
      const text = old.replace(edits[0].find, edits[0].replace);
      const found = settingsOverlaps({ store: c.store } as never, project, 'scheme', old, text);
      const fromGrunt = ['CLAUDE.md, Working rules: already says to ask with a card before a choice'];
      const t = minion(c, 'Card rule in the scheme text', { note: 'edit held on a card' }, 'chore');
      const w = chat(c, t, 10);
      w.asked('Add a line to our scheme instructions about when to use cards.');
      w.init();
      w.said('Checked what already says it, then made the edit.');
      const by = `#${t.number} for ${c.who}`;
      const e = w.put('plan', { id: hex(), status: 'pending', to: c.who, summary: `Edit to the scheme instructions repeats ${found.length + 1} places`,
        plan: heldPlan('scheme', found, fromGrunt, edits), instructions: { scope: 'scheme', project: project.id, old, text, edits, by, count: found.length + 1 } });
      w.done('Nothing saved yet: the card asks whether to save anyway, work it in or cancel.');
      return route(c, t, e);
    },
  },
  'plan-revision': {
    about: 'a minion whose revised plan card shows what changed against the plan it replaced (#907)',
    seed(c) {
      const t = minion(c, 'Archive old minions', { note: 'revised plan waiting for a go' });
      const w = chat(c, t, 10);
      w.asked('Run the plan back to me before you change anything.');
      w.init();
      const v1 = ['## What changes', '', '- A nightly sweep archives minions dismissed more than 30 days ago.', '- The minions list hides them.', '- Nothing is deleted.', '', '## Numbers', '', '- Citadel: 431 over 30 days', '- Delve: 98 over 30 days', '', '## Not doing', '', '1. Deleting worktrees.', '2. Archiving open minions.'];
      w.put('plan', { id: hex(), status: 'superseded', summary: 'Archive dismissed minions after 30 days', plan: v1.join('\n') });
      w.asked('Make the window 60 days, and add a toggle to show them.');
      const v2 = v1.map((l) => l.replace('30 days ago', '60 days ago').replace('over 30 days', 'over 60 days')).filter((l) => !l.startsWith('- Delve')).flatMap((l) => (l === '- The minions list hides them.' ? [l, '- A *Show archived* toggle brings them back.'] : [l]));
      const e = w.put('plan', { id: hex(), status: 'pending', summary: 'Archive dismissed minions after 60 days, with a show-archived toggle', plan: v2.join('\n') });
      w.done('Posted the revised plan.');
      return route(c, t, e);
    },
  },
  'choices-card': {
    about: 'a choices card (#804): a mock kit page with three takes to pick from, and the card that opens it',
    seed(c) {
      const t = minion(c, 'Header layout takes', { note: 'needs picks on the takes page' });
      const kit = join(import.meta.dirname, '..', 'kit', 'skills', 'docs-and-mocks', 'starter');
      for (const f of ['mockkit.js', 'mockkit.css']) copyFileSync(join(kit, f), join(t.cwd!, f));
      // A screenshot on the page, to draw on before Send (#946).
      writeFileSync(join(t.cwd!, 'header-today.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="960" height="120"><rect width="960" height="120" fill="#f5f2ec"/>'
        + '<circle cx="40" cy="60" r="10" fill="#c2410c"/><text x="64" y="70" font-family="sans-serif" font-size="28" fill="#222">2 FEATURE: Header layout</text>'
        + '<rect x="620" y="40" width="140" height="40" rx="8" fill="none" stroke="#999"/><rect x="780" y="40" width="140" height="40" rx="8" fill="none" stroke="#999"/></svg>');
      const page = join(t.cwd!, 'header-takes.html');
      writeFileSync(page, `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Header layout takes</title><link rel="stylesheet" href="mockkit.css"></head><body class="mk"><main class="mk-page">
<h1>Header layout takes</h1><p>Three ways to lay out the chat header. Pick one, then press Send.</p>
<p><img alt="Today's header" src="header-today.svg" width="480"></p><div id="takes"></div></main>
<script src="mockkit.js"></script><script>
mock.boards('#takes', { boards: [
  { id: 'A', title: 'Title left, chips right', note: 'Today\\'s order with the chips pulled right.', rec: true },
  { id: 'B', title: 'Two rows', note: 'Title on top, chips under it.' },
  { id: 'C', title: 'Chips in a menu', note: 'One line; chips behind a button.' },
], render: (b) => '<div style="padding:12px;border:1px solid #8884;border-radius:8px">' + mock.esc(b.title) + '</div>' });
</script></body></html>`);
      const w = chat(c, t, 8);
      w.asked('Mock up a few header layouts for me to pick from.');
      w.init();
      w.said('Three takes are on the page the card below opens.');
      const e = w.put('question', { id: hex(), questions: [], doc: { path: page, title: 'Header layout takes' } });
      w.done('Asked with a choices card.');
      return route(c, t, e);
    },
  },
  'secret-card': {
    about: 'a secret card (#838): a masked field whose value goes to the secret store, and a settled one saved earlier',
    seed(c) {
      const t = minion(c, 'Log in to the reader site', { note: 'needs the site password' });
      const w = chat(c, t, 6);
      w.asked('Log in to the reader site and fetch the latest chapter.');
      w.init();
      w.said('The site wants a password. Save it on the card below and I\'ll use it from the env.');
      const settled = { at: Date.now() - 3_600_000, by: 'Josh', saved: 'READER_USER', scope: 'scheme' };
      w.put('question', { id: hex(), questions: [], secret: { name: 'READER_USER', scope: 'scheme', why: 'The username for the reader site.' }, settled });
      const e = w.put('question', { id: hex(), questions: [], secret: { name: 'READER_SITE_PW', scope: 'person', why: 'The reader site\'s password, for logging in as you.' } });
      w.done('Asked with a secret card.');
      return route(c, t, e);
    },
  },
  'direct-card': {
    about: 'cards addressed to one person (#687): a question and a notice to you, a question to Josh, and one to you from a second scheme',
    seed(c) {
      const opts = [
        { label: '3 slots', description: 'Fine now the desktop runners take the suite.', recommended: true },
        { label: 'Stay at 2', description: 'Load on perigee still spikes past 100.' },
      ];
      const josh = c.store.findUser('name', 'Josh') ?? c.store.createUser({ name: 'Josh', login: 'josh' });
      c.store.addMember(c.project.id, josh.id);
      const t = minion(c, 'Heavy job slots', { note: 'asked two people' });
      const w = chat(c, t, 10);
      w.asked('Check whether the heavy slots can go to 3, then do it.');
      w.init();
      w.said('Asked with the cards below.');
      const e = w.put('question', { id: hex(), to: c.who, questions: [{ question: 'Can the heavy-job slots go from 2 to 3?', header: 'Slots', multiSelect: false, options: opts }] });
      w.put('question', { id: hex(), to: 'Josh', questions: [{ question: 'Is your runner box fine with a third slot?', header: 'Runner', multiSelect: false, options: opts }] });
      w.put('question', { id: hex(), to: c.who, questions: [], notice: 'The perigee load alarm is muted until 6 pm PST while the suite reruns.' });
      w.done('Asked two people.');
      // A second scheme you are in, whose Taskmaster asks you: shown in this scheme's Needs-you list too.
      const other = c.store.listProjects().find((p) => p.name === 'Seeded elsewhere') ?? c.store.createProject('Seeded elsewhere', null, c.store.findUser('name', c.who)?.id ?? null);
      c.store.setProjectSettings(other.id, { onboarding: 'skipped' });
      const me = c.store.findUser('name', c.who);
      if (me) c.store.addMember(other.id, me.id);
      const tm = c.store.listTickets(other.id).find((x) => x.kind === 'coordinator')
        ?? c.store.createTicket({ project_id: other.id, kind: 'coordinator', title: 'Taskmaster', permission_mode: 'default', created_by: c.who });
      c.store.addEvent(tm.id, 'plan', { id: hex(), status: 'pending', to: c.who, summary: 'Move the nightly backup to 3 am PST', plan: '- Change the timer to 03:00 PST.\n- Nothing else moves.' });
      return route(c, t, e);
    },
  },
  'mid-turn': {
    about: 'a minion mid-turn: a five-step plan with two done, one in progress and a Bash call still running',
    seed(c) {
      const t = minion(c, 'Faster minions list', { status: 'running', last_activity: 'Running tests… 2/5' }, 'bug');
      const w = chat(c, t, 30);
      w.asked('The minions list takes two seconds to load on Citadel. Find out why and fix it.');
      w.init();
      w.plan([['Measure the slow load', 3], ['Find the slow query', 5], ['Add the index', 4], ['Run the tests', 8], ['Self-review and land', 12]], 2);
      w.said('Cause: `listTickets` reads every event for the last-activity line, 56k rows for Citadel. An index on `(ticket_id, kind, id)` takes it to 40 ms.');
      w.call('Edit', { file_path: `${t.cwd}/src/db.ts`, old_string: 'CREATE INDEX', new_string: 'CREATE INDEX IF NOT EXISTS' }, 'The file has been updated.');
      w.call('Bash', { command: 'tools/citadel-node --test test/list-tickets.test.ts', description: 'Run the minions list tests' }, null);
      return route(c, t);
    },
  },
  'spend-alert': {
    about: 'a minion mid-turn whose turn passed $25: the spend alert card with Stop and Keep going (#723); no real turn runs, so its buttons stay hidden as on an earlier turn; Needs you lists it, the row\'s red badge needs a live turn',
    seed(c) {
      const t = minion(c, 'Rework the land queue', { status: 'running', last_activity: 'Reviewing the diff… 4/5' });
      const w = chat(c, t, 12);
      w.asked('Rework the land queue so two lands never wait on each other\'s tests.');
      w.init();
      w.said('Three Grunts are reviewing the queue code in parallel; I\'ll merge what they find.');
      w.call('Agent', { description: 'Review the land queue', prompt: 'Review tools/land.sh…' }, null);
      const turn = Date.now() - 48 * 60_000;
      const e = w.put('spend', { text: 'This turn has used about $26 in 48 min.', usd: 26, stage: 25, turn });
      // Needs you lists the alert from the saved turn; the row's red badge needs a live turn, so it shows only on a real one.
      c.store.setSetting(`turn:${t.id}`, { resumes: 0, startedAt: turn, spend: { usd: 26, fired: 1, alert: { stage: 25, event: e, at: Date.now() - 60_000 } } });
      return route(c, t, e);
    },
  },
  starting: {
    about: 'a minion just created: its first turn is setting up and it has no task list yet (#696)',
    seed(c) {
      const t = minion(c, 'Progress line from the start', { status: 'new' }, 'bug');
      const w = chat(c, t, 2);
      w.asked('The bar line should be there before the task list exists.');
      w.init();
      w.call('Bash', { command: 'git log -1', description: 'Check the base' }, null);
      return route(c, t);
    },
  },
  parked: {
    about: 'a parked minion waiting on another minion going live, with Unpark left of Send (#718, #726)',
    seed(c) {
      const t = minion(c, 'Follow-up after the deploy', { state: 'parked', note: 'waiting on #700 going live' }, 'feature');
      const w = chat(c, t, 2);
      w.asked('Pick this up once #700 is live.');
      w.init();
      w.said('Parked until #700 is live; Citadel wakes me then.');
      // One message already read (no longer held) and one still waiting: the bubble says "Not sent yet" with Unpark and send (#910).
      c.store.addEvent(t.id, 'user_message', { text: 'Also keep the old redirect.', author: c.who, mail: true, parked: true });
      const row = c.store.addEvent(t.id, 'user_message', { text: 'Please start with the docs page first.', author: c.who, mail: true, parked: true });
      c.store.setSetting(`mail:${t.id}`, [{ author: c.who, text: 'Please start with the docs page first.', images: [], id: row.id, parked: '2026-11-17 19:35' }]);
      return route(c, t);
    },
  },
  'limit-accounts': {
    about: 'a minion waiting on the usage limit with two linked Claude accounts both limited: one weekly, one 5-hour (#819), for the banner',
    seed(c) {
      const t = minion(c, 'Waits on two limited accounts', { state: 'limited', note: 'Usage limit, resumes soon', person_id: c.store.findUser('name', c.who)?.id }, 'feature');
      const w = chat(c, t, 2);
      w.asked('Carry on with the build.');
      w.init();
      const now = Date.now();
      c.store.setSetting('limit-resumes', [{ ticket: t.id, at: now + 2 * 3_600_000, tries: 1, tz: 'America/Los_Angeles', accounts: [
        { n: 1, label: 'one@example.com', until: now + 2 * 3_600_000 - 180_000 },
        { n: 2, label: 'two@example.com', until: now + 5 * 86_400_000, here: true, kind: 'weekly' }] }]);
      return route(c, t);
    },
  },
  'held-brief': {
    about: 'a parked minion chained on a leader, holding a long brief and one message left for it (#728)',
    seed(c) {
      const leader = minion(c, 'Flask and charm auras');
      const t = minion(c, 'Flask timers start on the press', { state: 'parked', note: `starts when #${leader.number} is merged` });
      const brief = ['Make the flask timers start on the press, not on the buff.', '', '**Build**', ...Array.from({ length: 8 }, (_, i) => `- Step ${i + 1}: change the aura \`timer${i + 1}\` so it reads the press, then check it against #${leader.number}'s charm auras.`), '', 'Ship it by the usual route.'].join('\n');
      c.store.setSetting('chained-minions', [...(c.store.getSetting<{ ticket: number }[]>('chained-minions') ?? []), { ticket: t.id, after: leader.id, when: 'merged', message: brief, from: 'Taskmaster', base: null }]);
      c.store.addEvent(t.id, 'note', { text: `Created by Taskmaster; its brief is held until #${leader.number} ${leader.title}'s work is merged. Messages to it wait for that start; Unpark starts it now.` });
      c.store.addEvent(t.id, 'user_message', { text: 'Remember the charm timers too.', author: c.who, mail: true, parked: true });
      return route(c, t);
    },
  },
  'claim-queue': {
    about: 'a claim with a queue on the Releases page (#1334): three past holders for the estimate, a holder on step 2 of 4, then one waiting, one chained and one not started; plus an old claim with a note and no queue',
    seed(c) { return claimQueue(c, 3); },
  },
  'claim-queue-new': {
    about: 'a claim with a queue and too little history for a time estimate (#1334)',
    seed(c) { return claimQueue(c, 1); },
  },
  landing: {
    about: 'a minion whose turn ended on hand_off_land while the server ships it: working, by the server (#727)',
    seed(c) {
      const t = minion(c, 'Show server work as working', {}, 'bug');
      const w = chat(c, t, 24);
      w.asked('Minions whose land the server runs look idle. Show them as working.');
      w.init();
      w.plan([['Expose server work', 4], ['Show it as working', 6], ['Self-review and land', 10]], 3);
      w.call('mcp__thread__hand_off_land', { summary: 'server work shows as working', risk: 'low', reason: 'front end and one view field' }, 'Handed off: the server runs tools/land.sh.');
      w.done('Handed off the land; the server reports how it goes.');
      // Only the hand-off, no started file: the landing reads as not begun, so LandHandoffs leaves it pending.
      const dir = join(c.dataDir, 'run', 'landings', String(t.id));
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'handoff.json'), JSON.stringify({ summary: 'server work shows as working', risk: 'low', reason: 'seeded', args: [] }));
      return route(c, t);
    },
  },
  'long-chat': {
    about: 'a finished minion with a long chat: markdown headings, lists, a table, code, an image and a file card',
    seed(c) {
      const t = minion(c, 'Usage report for October', { state: 'complete', note: 'report ready: usage-october.md' }, 'research');
      copyFileSync(join(import.meta.dirname, '..', 'public', 'icon-512.png'), join(t.cwd, 'chart.png'));
      const report = join(t.cwd, 'usage-october.md');
      writeFileSync(report, '# October usage\n\n| Scheme | Share |\n| --- | ---: |\n| Citadel | 71% |\n| Delve | 22% |\n| Peek | 7% |\n');
      const w = chat(c, t, 60);
      for (let i = 1; i <= 6; i++) {
        w.asked(i === 1 ? 'How much did each scheme use in October? Break it down by model.' : `Follow-up ${i}: can you split that by week, and say what drove the peak?`);
        w.init();
        w.call('Bash', { command: `sqlite3 -readonly coordinator.db "SELECT … week ${i}"`, description: 'Sum usage by scheme and model' }, 'Citadel|opus|412.50\nDelve|sonnet|88.10');
        w.said([
          `## Week ${i}`, '', `Citadel used **${40 + i * 7}%** of the week's meter; Delve *${20 - i}%*.`, '',
          '| Scheme | Opus | Sonnet | Fable |', '| --- | ---: | ---: | ---: |', `| Citadel | ${300 + i * 12} | 41 | ${i * 9} |`, `| Delve | 61 | ${80 + i} | 0 |`, '',
          '- Peaks follow land jams: each retry re-reads the whole context.', '- Grunts were **18%** of the total.', '',
          '```sql', 'SELECT project_id, model, SUM(cost_usd) FROM turns GROUP BY 1, 2;', '```', '',
          ...(i === 6 ? [`![Usage by week](${t.cwd}/chart.png)`, '', `[The full report](${report})`] : []),
        ].join('\n'));
        w.done(`Week ${i} summarised.`);
      }
      return route(c, t);
    },
  },
  'marked-picture': {
    about: 'someone pasted a screenshot and the minion answered with a box, an arrow, a pin and a label drawn over it (#960)',
    seed(c) {
      const t = minion(c, 'Where do I start a fresh session?', { state: 'ready', note: 'pointed at the button' });
      const [w, h] = [1280, 800];
      const png = pngOf(w, h, [[0, 0, 1280, 64, 0x2b2e34], [24, 20, 160, 24, 0x5a5f69], [960, 14, 150, 36, 0x3d7bd9], [1130, 14, 126, 36, 0x3a3e46],
        [0, 64, 260, 736, 0x24272c], [24, 96, 210, 30, 0x3a3e46], [24, 140, 210, 30, 0x31343a], [24, 184, 210, 30, 0x31343a],
        [300, 104, 940, 120, 0x2b2e34], [300, 248, 700, 120, 0x2b2e34], [300, 392, 940, 120, 0x2b2e34], [300, 690, 940, 80, 0x31343a]]);
      const name = `${hex()}${hex()}.png`;
      const uploads = join(projectDir(c.dataDir, c.project.id), 'uploads', String(t.id));
      const shared = join(projectDir(c.dataDir, c.project.id), 'shared', String(t.id));
      for (const dir of [uploads, shared]) {
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, name), png);
      }
      const px = (x: number, y: number) => ({ x: (x * w) / 100, y: (y * h) / 100 });
      const title = marksTitle(w, h, [
        { tool: 'box', colour: 'red', pts: [px(74, 1), px(87.5, 7.5)] },
        { tool: 'arrow', colour: 'red', pts: [px(55, 22), px(73, 7)] },
        { tool: 'pin', colour: 'red', n: 1, pts: [px(89.5, 4.2)] },
        { tool: 'label', colour: 'red', text: 'Fresh session', pts: [px(48, 25)] },
        { tool: 'box', colour: 'yellow', pts: [px(1.5, 11), px(19, 16.5)] },
      ]);
      const ch = chat(c, t, 1);
      ch.put('user_message', { author: c.who, text: 'Where do I click to start a fresh session?', images: [name] });
      ch.call('mcp__thread__mark_image', { image: join(uploads, name), alt: 'Where Fresh session is', marks: [] }, 'Put this line in your reply as it is.');
      ch.said([
        'It\'s the blue button at the top right (**1**). The yellow box is the minion you\'re on.', '',
        `![Where Fresh session is](${join(shared, name)} "${title}")`,
      ].join('\n'));
      ch.done('Pointed.');
      return route(c, t);
    },
  },
  'media-chat': {
    about: 'a minion whose reply links a clip, a panorama and two screenshots, for the viewer\'s lightbox, scrubber and panner (#833)',
    seed(c) {
      const t = minion(c, 'Record the onboarding flow', { state: 'complete', note: 'clips and screens in the chat' });
      // Code-made media from the design-system demo (docs/design-system/media), never a real app's.
      const media = join(import.meta.dirname, '..', 'docs', 'design-system', 'media');
      for (const f of ['clip.webm', 'panorama.svg', 'screen-1.svg', 'screen-2.svg']) copyFileSync(join(media, f), join(t.cwd, f));
      const w = chat(c, t, 1);
      w.asked('Can you record the onboarding flow and grab the screens?');
      w.said([
        'Recorded it, and the two screens it passes through:', '',
        `![The flow, 8 s](${t.cwd}/clip.webm)`, '', `![The view from the top](${t.cwd}/panorama.svg)`, '',
        `![Settings](${t.cwd}/screen-1.svg)`, `![Minions](${t.cwd}/screen-2.svg)`,
      ].join('\n'));
      w.done('Recorded.');
      return route(c, t);
    },
  },
  budget: {
    about: 'a minion past twice its budget, beside five past features at $5 each: the header chip reads "$14 of about $5.00" in amber (#1114)',
    seed(c) {
      for (let i = 0; i < 5; i++) {
        const done = minion(c, `Past feature ${i + 1}`, { status: 'closed' });
        c.store.recordTurn(done.id, { session_id: `budget-${done.id}`, ended_at: Date.now(), session_cost_usd: 5 });
      }
      const t = minion(c, 'Costs more than usual');
      c.store.recordTurn(t.id, { session_id: `budget-${t.id}`, ended_at: Date.now(), session_cost_usd: 14 });
      return route(c, t);
    },
  },
  board: {
    about: 'the minions list with a minion in each state, types, notes and a build',
    seed(c) {
      const rows: [string, Parameters<Store['updateTicket']>[1], string][] = [
        ['Merge the rail icons', { state: 'ready', note: 'tested, risk low; needs a go to ship', replies: JSON.stringify(['Ship it']) }, 'feature'],
        ['Phone drawer swipe', { state: 'try', note: 'preview up: try the drawer on a phone' }, 'feature'],
        ['Release notes page', { state: 'parked', note: 'waiting on #12 going live' }, 'feature'],
        ['GitHub token expiry', { state: 'blocked', note: 'needs a new token from Cara' }, 'bug'],
        ['Audit of slow pages', { state: 'complete', note: 'report: reports/slow-pages.md' }, 'research'],
        ['Fix flaky land test', { state: 'outside', note: 'CI running on the fix' }, 'bug'],
        ['Rename the inbox', { state: 'pending-deploy', note: 'deployed, live after the restart' }, 'chore'],
        ['Build 7: new rail', { build: 7, note: 'two of four parts merged' }, 'feature'],
        ['Rail settings', { build: 7, status: 'running', last_activity: 'Writing the settings page… 1/3' }, 'feature'],
        ['Export to CSV', { state: 'parked', note: 'on hold until Cara picks a format' }, 'feature'],
      ];
      const made = rows.map(([title, fields, type]) => minion(c, title, fields, type));
      // Release notes waits on wake_when_live (a commit that never goes live), so it sits under Waiting, not Parked (#718).
      const waits = c.store.getSetting<object[]>('wake-when-live') ?? [];
      c.store.setSetting('wake-when-live', [...waits, { ticket: made[2].id, commit: '0'.repeat(40), reason: 'waiting on #12 going live', since: null }]);
      return `#/p/${c.project.id}`;
    },
  },
  schemes: {
    about: 'five more schemes you are in, one of them hidden, for the schemes shelf and dragging it into order (#649)',
    seed(c) {
      const user = c.store.listUsers().find((u) => u.name === c.who);
      for (const name of ['Bramble', 'Cinder', 'Ember', 'Juniper', 'Quarry']) {
        const p = c.store.listProjects().find((x) => x.name === name) ?? c.store.createProject(name, null, user?.id ?? null);
        c.store.setProjectSettings(p.id, { onboarding: 'skipped' });
        if (user) c.store.addMember(p.id, user.id);
        if (user && name === 'Quarry') c.store.setProjectHidden(user.id, p.id, true);
      }
      return `#/p/${c.project.id}`;
    },
  },
  'waiting-on-you': {
    about: 'two schemes (Seeded, Delve) with every kind of "waiting on you" row (#1121): your card, Josh\'s card, replies for you and for Josh, ready, try, done and idle',
    seed(c) {
      const josh = c.store.findUser('name', 'Josh') ?? c.store.createUser({ name: 'Josh', login: 'josh' });
      const user = c.store.listUsers().find((u) => u.name === c.who);
      const delve = c.store.listProjects().find((x) => x.name === 'Delve') ?? c.store.createProject('Delve', null, user?.id ?? null);
      c.store.setProjectSettings(delve.id, { onboarding: 'skipped' });
      for (const p of [c.project.id, delve.id]) { c.store.addMember(p, josh.id); if (user) c.store.addMember(p, user.id); }
      const card = (s: SeedCtx, title: string, note: string, to?: string) => {
        const t = minion(s, title, { note });
        if (to) s.store.props.set('minion', t.id, s.project.id, { assigned: to }, s.who);
        chat(s, t, 2).put('question', { id: hex(), ...(to ? { to } : {}), questions: [{ question: 'Which way?', header: 'Pick', options: [{ label: 'A', recommended: true }, { label: 'B' }] }] });
      };
      const replies = (s: SeedCtx, title: string, note: string, to?: string) => {
        const t = minion(s, title, { note, replies: JSON.stringify(['Ship it']) });
        if (to) s.store.props.set('minion', t.id, s.project.id, { assigned: to }, s.who);
      };
      card(c, 'Memory curator you approve', 'grilling: 7 design questions on one card');
      card(c, 'Build 7 balance leftovers', 'run-back and 3 cards waiting for Josh', 'Josh');
      replies(c, 'Merge the rail icons', 'tested, risk low; needs a go');
      minion(c, 'Splitwise receipts', { state: 'try', note: 'live: add key, try one real receipt' });
      minion(c, 'Heavy-slot history read-back', { state: 'complete', note: 'report: reports/heavy-slot-week.md' });
      minion(c, 'Build 5: For people', { note: 'build/5 made; waiting for feeders to merge in' });
      const d: SeedCtx = { ...c, project: c.store.getProject(delve.id)! };
      card(d, "Ideas: how Peek's minions work", '32 ideas on the choices page; waiting on picks');
      card(d, 'Retiree portraits', 'two takes on one card for Josh', 'Josh');
      replies(d, 'Chapter 3 balance pass', 'tested; needs his go', 'Josh');
      minion(d, 'Confirm replacing a retiree', { state: 'ready', note: 'PR #237 green, ready to merge into Build 8' });
      minion(d, 'Dungeon tiles atlas', { note: 'shipped; nothing asked' });
      return `#/p/${c.project.id}`;
    },
  },
  home: {
    about: 'Home (#1140): waiting-on-you\'s two schemes plus a Taskmaster card in Delve, a minion working in each, three ships since yesterday and two weeks of past ones; open #/home',
    seed(c) {
      SCENARIOS['waiting-on-you'].seed(c);
      const delve = c.store.listProjects().find((x) => x.name === 'Delve')!;
      const d: SeedCtx = { ...c, project: c.store.getProject(delve.id)! };
      chat(d, taskmaster(d), 2).put('plan', { id: hex(), summary: 'Start the chapter 4 minions', plan: '1. Tiles\n2. Foes', status: 'pending' });
      minion(c, 'Rail icons sweep', { status: 'running', last_activity: 'Running tests' });
      minion(d, 'Foe sprites, round 2', { status: 'running', last_activity: 'Drawing' });
      const shipped = (s: SeedCtx, title: string, text: string) => chat(s, minion(s, title, { status: 'closed' }), 1).put('note', { text });
      shipped(c, 'Usage bar in the top bar', 'Shipped 1a2b3c4 "#1201: usage bar": the usage bar shows your week. Risk low: front end only. Live now.');
      shipped(d, 'Chapter 2 balance', 'Shipped 5d6e7f8 "#240: chapter 2": foes hit 10% softer in chapter 2. Risk medium: numbers. Live now.');
      shipped(d, 'Build 8 merge', 'Merged 9a8b7c6 into build/8: a feeder. Risk low: x.');
      // Two weeks of ships for Home's activity bars (#1217); a follow-up ship of the same minion counts once a day.
      const past = (s: SeedCtx, title: string, daysAgo: number[]) => {
        const t = minion(s, title, { status: 'closed' });
        for (const n of daysAgo) c.store.db.prepare('INSERT INTO events (ticket_id, kind, data, created_at) VALUES (?, ?, ?, ?)')
          .run(t.id, 'note', JSON.stringify({ text: `Shipped ${hex().slice(0, 7)}: ${title}. Risk low: x.` }), Date.now() - n * 86_400_000);
      };
      [[1, 1], [2], [3, 5], [5], [6, 9], [9], [12], [4]].forEach((days, i) => past(c, `Past fix ${i + 1}`, days));
      [[2], [3], [3], [7, 8], [10], [11, 13]].forEach((days, i) => past(d, `Past level ${i + 1}`, days));
      return `#/p/${c.project.id}`;
    },
  },
  mentions: {
    about: '@mentions (#1149): Josh, a member of Seeded, mentions you in a minion\'s chat; your Needs you shows it, and typing @ in a chat box opens the member picker',
    seed(c) {
      const josh = c.store.findUser('name', 'Josh') ?? c.store.createUser({ name: 'Josh', login: 'josh' });
      c.store.addMember(c.project.id, josh.id);
      const t = minion(c, 'Export button', { state: 'ready', note: 'tested, risk low' });
      const w = chat(c, t, 4);
      w.asked('Add an export button to the report page.');
      w.said('Done: the button is on the report page.');
      const text = `@${c.who} can you look at this before it ships?`;
      const id = w.put('user_message', { author: 'Josh', text, mentions: [c.who] });
      addMention(c.store, c.who, { ticketId: t.id, projectId: c.project.id, eventId: id, at: c.store.lastEventOf(t.id, 'user_message')!.created_at, by: 'Josh', text });
      return `#/p/${c.project.id}`;
    },
  },
  'taskmaster-chat': {
    about: 'the scheme page with a long Taskmaster chat and 30 minions, for scrolling every column',
    seed(c) {
      const tm = taskmaster(c);
      const w = chat(c, tm, 80);
      for (let i = 1; i <= 20; i++) {
        w.asked(`Round ${i}: where do the minions stand, and what should start next?`);
        w.init();
        w.said([`## Round ${i}`, '', `- #${i} is **ready**: tested, risk low.`, `- #${i + 1} is waiting on a pick.`, '', 'Next: start a minion for the rail settings once #12 is live.'].join('\n'));
        w.done(`Round ${i} summarised.`);
      }
      for (let i = 1; i <= 30; i++) minion(c, `Seeded minion ${i}`, { note: `note for minion ${i}` }, i % 3 ? 'feature' : 'bug');
      return `#/p/${c.project.id}`;
    },
  },
  'busy-scheme': {
    about: 'a scheme as big as Citadel\'s own (#1077): a long Taskmaster chat, 20 open minions with 5 running, and 1,244 dismissed ones, for tools/typing-lag.ts and the closed-list checks (#1330)',
    seed(c) {
      const tm = taskmaster(c);
      const w = chat(c, tm, 400);
      for (let i = 1; i <= 100; i++) {
        w.asked(`Round ${i}: where do the minions stand, and what should start next?`);
        w.init();
        w.said([`## Round ${i}`, '', `- #${i} is **ready**: tested, risk low.`, `- #${i + 1} is waiting on a pick.`, '', 'Next: start a minion for the rail settings once #12 is live.'].join('\n'));
        w.done(`Round ${i} summarised.`);
      }
      const states = [{ state: 'ready', note: 'tested, risk low' }, { state: 'parked', note: 'waiting on another minion' }, { state: 'outside', note: 'CI running' }, {}];
      for (let i = 1; i <= 20; i++) minion(c, `Busy minion ${i}`, i <= 5 ? { status: 'running', last_activity: 'Running commands' } : states[i % 4], i % 3 ? 'feature' : 'bug');
      for (let i = 1; i <= 1244; i++) minion(c, `Dismissed minion ${i}: a change that shipped a while ago`, { status: 'closed', ...(i % 10 ? {} : { state: 'ready', note: `shipped, note ${i}` }) }, i % 3 ? 'feature' : 'bug');
      return `#/p/${c.project.id}`;
    },
  },
  'taskmaster-split': {
    about: 'a scheme split into per-person Taskmasters (#919, #920): yours, Josh\'s and the Overlord, each with a chat, an Overlord alert and a card for everyone; to see his side, sign Josh in with an invite link: the copy\'s password signs in admins only',
    seed(c) {
      const tm = taskmaster(c);
      const josh = c.store.findUser('name', 'Josh') ?? c.store.createUser({ name: 'Josh', login: 'josh' });
      c.store.addMember(c.project.id, josh.id);
      const mine = chat(c, tm, 8);
      mine.asked('Where does the export minion stand?');
      mine.init();
      mine.said('#12 is **ready**: tested, risk low. It lands after #14.');
      mine.done('Answered.');
      const own = c.store.splitScheme(c.project.id, josh.id);
      const ovl = c.store.getOverlord(c.project.id)!;
      for (const t of [own, ovl]) c.store.updateTicket(t.id, { status: 'idle' });
      const j = chat(c, own, 6);
      j.put('user_message', { author: 'Josh', text: 'Start a minion for the runner box\'s third slot.' });
      j.init();
      j.said('Started #15 for the third runner slot.');
      j.done('Started.');
      const o = chat(c, ovl, 6);
      o.said('Checking CI on main after the last land.');
      o.put('note', { text: 'CI on main fell back to perigee: the desktop runner is offline.', everyone: true });
      o.put('note', { text: 'Cleaned up 4 worktrees today, 504 MiB freed', detail: 'ticket/1001-a  120 MiB\nticket/1002-b  384 MiB', everyone: true });
      o.put('note', { text: '📋 Taskmaster updated the Citadel-wide instructions', everyone: true });
      const opts = [{ label: 'Wait for the desktop', recommended: true }, { label: 'Run on perigee' }];
      o.put('question', { id: hex(), everyone: true, questions: [{ question: 'Hold lands until the desktop runner is back?', header: 'CI', multiSelect: false, options: opts }] });
      return `#/p/${c.project.id}`;
    },
  },
  'agent-relays': {
    about: 'a minion and the Taskmaster messaging each other: a brief, relays both ways, held mail from another scheme\'s Taskmaster, collapsed and shortened replies, and a person\'s messages (#693)',
    seed(c) {
      const tm = taskmaster(c);
      const t = minion(c, 'Sidebar badge colours', { note: 'tested, risk low; landing' });
      const long = Array.from({ length: 20 }, (_, i) => `Badge ${i + 1}: its unread count sat at 2.9:1 on the dark panel, so it moves to the accent pill with near-black text, 7.1:1.`).join(' ');
      const m = chat(c, t, 14);
      m.put('user_message', { author: 'Taskmaster', brief: true, text: `${c.who}, 2026-11-14: "The unread badges in the sidebar are hard to see in dark mode." Fix their contrast, self-review and land.` });
      m.init();
      m.said('Reading the sidebar styles first.');
      m.call('Read', { file_path: `${t.cwd}/public/sidebar.css` }, '.badge { background: var(--accent); }');
      m.said(long);
      m.done('Fixed.');
      m.put('user_message', { author: 'Taskmaster', text: `Josh, via the Taskmaster: "Keep the badge round on phones too." Check it at 390 px before you land.` });
      m.asked('Also make the count bold, please.');
      m.said('Done: the count is bold and the badge stays round at 390 px.');
      const w = chat(c, tm, 10);
      w.asked('Where does the badge fix stand?');
      w.said(`#${t.number} has fixed the contrast and is checking phones before it lands.`);
      w.put('user_message', { author: `#${t.number} ${t.title}`, text: `#${t.number} is live (abc1234), risk low: the sidebar badges pass 4.5:1 in both modes and stay round on phones.` });
      w.put('user_message', { author: `Taskmaster of Delve, for ${c.who}, a Citadel member`, mail: true, cold: true, text: 'Delve asks for the same badge fix in its own sidebar, if the change can be shared.' });
      w.said('Checking whether Delve can take the shared style.');
      w.call('Read', { file_path: 'public/ui/badge.css' }, '.badge {}');
      w.said(`#${t.number} is live. Delve's Taskmaster asked for the same fix; it reaches them through Citadel UI on their next load, so nothing to start.`);
      return route(c, t);
    },
  },
  'minion-copies': {
    about: 'the Taskmaster chat with a run of copies of minion-to-minion messages (one grouped row), a person\'s message, then a second run (#924)',
    seed(c) {
      const tm = taskmaster(c);
      const [a, b, d] = [1, 2, 3].map((i) => minion(c, `Feeder ${i}`));
      const w = chat(c, tm, 4);
      w.asked('Where do the feeders stand?');
      const copy = (from: typeof a, to: typeof a, text: string) => w.put('minion_copy', { author: `#${from.number} ${from.title}`, from: from.number, to: to.number, text });
      copy(a, b, 'I changed src/foo.ts: rebase before you touch it');
      copy(b, a, 'Rebased, thanks. Taking the tests next.');
      copy(a, d, 'Heads up: the schema column is renamed on main.');
      copy(d, b, 'Seen; I will carry it into my branch.');
      w.said('Nothing for me to do on those.');
      copy(b, d, 'Done on my side.');
      return `#/p/${c.project.id}`;
    },
  },
  'relay-tracking': {
    about: 'the Taskmaster chat after one minion queued the same relay to 8 minions, one call each (#1001): 8 queued "for your tracking" rows then 8 went-out rows, to see them collapse into groups',
    seed(c) {
      const tm = taskmaster(c);
      const sender = minion(c, 'Peek Auras relay');
      const to = Array.from({ length: 8 }, (_, i) => minion(c, `Receiver ${i + 1}`));
      const w = chat(c, tm, 4);
      w.asked('Did the relay go to every feeder?');
      const who = `#${sender.number} ${sender.title}`;
      const note = (text: string) => w.put('user_message', { author: who, mail: true, text: `(for your tracking; nothing to do) ${text}` });
      for (const m of to) note(`#${sender.number} will send this to #${m.number} once 9cef328 is live: From #${sender.number}: the new aura route is live; rebase before you touch it.`);
      w.said('Those are queued.');
      for (const m of to) note(`#${sender.number}'s relay to #${m.number} went out`);
      note(`#${sender.number} cancelled its relay to #${to[0].number}.`);
      return `#/p/${c.project.id}`;
    },
  },
  'held-mail': {
    about: 'a minion with held mail waiting for its next turn (#1067, #1252): a cold hold from two senders, one a loop-guard hold, so its chat shows the held rows with a small Deliver, the loop hold\'s Continue card, and the list its loop badge',
    seed(c) {
      const tm = taskmaster(c);
      const other = minion(c, 'Rail settings page');
      const t = minion(c, 'Sidebar badge colours', { note: 'waiting on its next turn' });
      const m = chat(c, t, 12);
      m.asked('Fix the unread badges\' contrast in dark mode.');
      m.init();
      m.said('Fixed the contrast; checking phones next.');
      m.done('Fixed.');
      const held = (author: string, text: string, extra: object = {}) => {
        const id = m.put('user_message', { author, text, mail: true, cold: true, ...extra });
        return { author, text, images: [], id, from: tm.id };
      };
      const mail = [
        held('Taskmaster', 'Josh asks whether the badge stays round at 390 px. Check it before you ship.', { need: 'ask' }),
        held('Taskmaster', '(for your tracking; nothing to do) #12 shipped the rail tokens you build on.', { need: 'fyi' }),
        held('Citadel', `#${other.number} shipped 4f2a91c: the rail colours moved to tokens; rebase before you touch sidebar.css.`, { note: true }),
      ];
      c.store.setSetting(mailKey(t.id), mail);
      c.store.setSetting(coldKey(t.id), Date.now() - 40 * 60_000);
      const now = Date.now();
      const loop: LoopState = { sent: Array.from({ length: 8 }, (_, i) => now - (20 - i) * 60_000), held: [
        { to: t.id, author: 'Taskmaster', text: 'Run the badge tests again and report the counts.', from: tm.id, at: now - 5 * 60_000 },
        { to: t.id, author: 'Taskmaster', text: 'And screenshot the dark sidebar.', from: tm.id, at: now - 4 * 60_000 },
      ] };
      c.store.setSetting(loopKey(t.id), loop);
      return route(c, t);
    },
  },
  'held-mail-working': {
    about: 'working minions with mail from another minion queued for their next turn (#1067): no inbox card, the light dashed "not sent yet" row in the log and "N queued" on the working line; the route is the one with a single message, the next minion has two in a run',
    seed(c) {
      const from = minion(c, 'Aura success loop');
      const by = `#${from.number} Aura success loop`;
      const working = (title: string, texts: string[]) => {
        const t = minion(c, title, { status: 'running', last_activity: 'Running tests… 2/4', session_id: `seed-held-working-${texts.length}` });
        const m = chat(c, t, 12);
        m.asked(`Build the ${title.toLowerCase()}.`);
        m.init();
        m.said('Writing it; the first two tests pass.');
        c.store.setSetting(mailKey(t.id), texts.map((text) => ({ author: by, text, images: [], id: m.put('user_message', { author: by, text, mail: true, need: 'fyi', from: from.id }), from: from.id })));
        return t;
      };
      const one = working('Aura replay harness', [`From #${from.number} (aura success loop): your brief's optional part 4 can reuse my fixture in test/aura.test.ts.`]);
      working('Aura sound cues', ['The success chime now fires once per aura.', 'And the fixture covers the gold aura too.']);
      return route(c, one);
    },
  },
  'side-thread': {
    about: 'a minion mid-turn with side threads (#932): yours answered with a follow-up, and Josh\'s still looking; and an idle minion whose Ask on the side shows the cold cost first',
    seed(c) {
      const t = minion(c, 'Speed up the land queue', { status: 'running', last_activity: 'Running tests… 3/5', session_id: 'seed-side-1' });
      const w = chat(c, t, 12);
      w.asked('Make lands stop waiting on each other\'s tests.');
      w.init();
      w.said('Running the land tests now; this takes a few minutes.');
      w.call('Bash', { command: 'citadel-test test/land.test.ts', description: 'Run the land tests' }, null);
      const q = w.put('side', { thread: null, by: c.who, uid: 0, q: 'Is it stuck, or still running the tests?' });
      w.put('side_answer', { thread: q, ask: q, ok: true, cost_usd: 0.06, text: 'Still running: `citadel-test` started 4 minutes ago and is on `test/land.test.ts` (pid 81234, 3% CPU). Nothing looks stuck.' });
      const f = w.put('side', { thread: q, by: c.who, uid: 0, q: 'How long do those usually take?' });
      w.put('side_answer', { thread: q, ask: f, ok: true, cost_usd: 0.03, text: 'About 6 minutes on perigee; the last three runs took 5:40, 6:10 and 6:05.' });
      w.put('side', { thread: null, by: 'Josh', uid: 0, q: 'Which branch is this on?' });
      const cold = minion(c, 'Rename the turn folder', { status: 'idle', session_id: 'seed-side-2' });
      chat(c, cold, 3).asked('Rename the turn folder to runs/.');
      c.store.setSetting(`context:${cold.id}`, 180_000);
      c.store.recordTurn(cold.id, { session_id: 'seed-side-2', ended_at: Date.now() - 3 * 3600_000, session_cost_usd: 1.2 });
      return route(c, t);
    },
  },
  'wco-fixture': {
    about: 'the run-on-windows WCO rig\'s fixture contraption (open, at port $WCO_FIXTURE_PORT) and a minion with an artifact',
    seed(c) {
      const port = Number(process.env.WCO_FIXTURE_PORT) || 1;
      // Open paths only, so the identity keys are never used: placeholders, not a real key pair.
      if (c.store.getContraption('wco-fixture')) c.store.updateContraption('wco-fixture', { port });
      else c.store.createContraption({ name: 'wco-fixture', title: 'WCO fixture', icon: null, port, home_scheme: c.project.id, open_paths: '["/"]', relay_paths: '[]', repo: null, branch: null, folder: null, default_model: null, turn_cap: null, identity_public: '', identity_private: '', key_hash: `wco-fixture-${hex()}`, keys_at: Date.now() });
      const t = minion(c, 'WCO rig artifact');
      const page = '<!doctype html><title>WCO artifact</title><p>An artifact under the frame.</p>';
      const file = join(t.cwd!, 'wco-artifact.html');
      writeFileSync(file, page);
      // Linked in a reply too, so the artifact scan keeps it.
      chat(c, t, 1).said(`[The artifact](${file})`);
      c.store.syncArtifacts(t, [{ path: 'wco-artifact.html', size: page.length, mtime: Date.now() }]);
      return `#/p/${c.project.id}`;
    },
  },
  'gpu-jobs': {
    about: 'a minion\'s GPU jobs on a seeded desktop in every state (needs go, queued outside hours, running, paused resumable and frozen, done, failed), and that desktop on the Machines page (#859)',
    seed(c) {
      const owner = c.store.listUsers().find((u) => u.name === c.who);
      const m = c.store.createMachine(`seeded-desktop-${hex().slice(0, 4)}`, hex(), c.who, owner?.id ?? null);
      c.store.updateMachine(m.id, { jobs: JSON.stringify({ folders: ['audiobooks', 'models'], max_limit_h: 8, gpu: true }), job_settings: JSON.stringify({ start: '23:00', end: '08:00', until: null, paused: false }) });
      c.store.setMachineProjects(m.id, [c.project.id]);
      const t = minion(c, 'Transcribe the audiobook', { note: 'GPU jobs on the desktop' });
      const machine = c.store.getMachine(m.id)!;
      const w = chat(c, t, 30);
      const now = Date.now();
      const kinds: Record<string, JobKind> = {
        whisperx: { name: 'whisperx', image: 'ghcr.io/m-bain/whisperx:3.3', command: ['whisperx', '--model', 'large-v3', '/in/chapter.wav', '-o', '/out'], reads: ['audiobooks'], gpu: true, network: false, resumable: true, max_limit_s: 4 * 3600 } as JobKind,
        tts: { name: 'xtts-render', image: 'ghcr.io/coqui-ai/xtts:0.22', command: ['python', 'render.py', '--voice', '/in/voice.wav'], reads: ['models'], gpu: true, network: false, resumable: false, max_limit_s: 6 * 3600 } as JobKind,
      };
      c.store.allowJobKind(m.id, kindHash(kinds.whisperx), 'whisperx', JSON.stringify(kinds.whisperx), c.who);
      const add = (kind: JobKind, state: string, fields: Parameters<Store['updateMachineJob']>[1], ago: number, when: 'hours' | 'now' = 'hours', reason = '') => {
        const j = c.store.addMachineJob({ machine_id: m.id, project_id: c.project.id, ticket_id: t.id, contraption_id: null, asked_by: `#${t.number} ${t.title}`, kind_name: kind.name, kind: JSON.stringify(kind), kind_hash: kindHash(kind), inputs: JSON.stringify([{ name: 'chapter-07.wav', size: 412_000_000, sha256: hex(), path: '/dev/null' }]), limit_s: 2 * 3600, run_when: when, reason, state, created_at: now - ago });
        c.store.updateMachineJob(j.id, fields);
        return c.store.getMachineJob(j.id)!;
      };
      const log = (lines: string[]) => lines.join('\n');
      const jobs = [
        add(kinds.whisperx, 'done', { go: 'standing', go_by: c.who, started_at: now - 5 * 3600e3, ended_at: now - 4.2 * 3600e3, run_s: 2830, gpu_busy_s: 2510, outputs: JSON.stringify([{ path: 'chapter-05.srt', size: 48_210, uploaded: true }, { path: 'chapter-05.json', size: 912_400, uploaded: true }]), upload_bytes: 960_610, live: JSON.stringify({ log_tail: log(['[whisperx] aligning 1,204 segments', '[whisperx] wrote /out/chapter-05.srt', 'done in 47:10']) }), exit_code: 0 }, 5.2 * 3600e3),
        add(kinds.tts, 'failed', { go: 'hours', go_by: c.who, started_at: now - 3 * 3600e3, ended_at: now - 2.9 * 3600e3, run_s: 312, gpu_busy_s: 290, exit_code: 137, error: 'Out of GPU memory (exit 137)', live: JSON.stringify({ log_tail: log(['loading xtts v2…', 'torch.OutOfMemoryError: CUDA out of memory. Tried to allocate 2.00 GiB', 'Killed']) }) }, 3.1 * 3600e3),
        add(kinds.tts, 'needs-go', {}, 40 * 60e3, 'now', 'The narrator wants chapter 8 by tomorrow morning'),
        add(kinds.whisperx, 'queued', { go: 'standing', go_by: c.who }, 25 * 60e3),
        add(kinds.tts, 'paused', { go: 'now', go_by: c.who, paused_by: 'owner', started_at: now - 70 * 60e3, run_s: 1460, gpu_busy_s: 1300, live: JSON.stringify({ held_vram_mb: 14_200, log_tail: log(['rendering sentence 412/1,880']) }), live_at: now - 9 * 60e3 }, 75 * 60e3),
        add(kinds.whisperx, 'paused', { go: 'standing', go_by: c.who, paused_by: 'hours', started_at: now - 9 * 3600e3, run_s: 1700, gpu_busy_s: 1500, live: JSON.stringify({ log_tail: log(['[whisperx] transcribing 61%']) }), live_at: now - 7 * 3600e3 }, 10 * 3600e3),
        add(kinds.whisperx, 'running', { go: 'now', go_by: c.who, started_at: now - 34 * 60e3, run_s: 2010, gpu_busy_s: 1880, live: JSON.stringify({ gpu_pct: 87, vram_mb: 9_830, log_tail: log(['[whisperx] loading large-v3', '[whisperx] transcribing chapter-07.wav', '[whisperx] 42% (1:12:04 of 2:51:30)']) }), live_at: now - 20e3 }, 36 * 60e3, 'now', 'Cara asked for chapter 7 tonight'),
      ];
      const waits = (j: typeof jobs[number]) => (j.state === 'queued' ? 'outside job hours (opens 11:00 PM PST)' : null);
      const viewOf = (j: typeof jobs[number]) => jobView(j, { machine: machine.name, waits: waits(j), decider: owner?.id ?? null, ticketNumber: t.number });
      w.asked('Transcribe chapters 5 to 8 on my desktop, and render chapter 8 with the narrator voice.');
      w.init();
      w.said('Queuing them on the desktop as GPU jobs; each shows below as it goes.');
      let first = 0;
      for (const j of jobs) {
        if (j.state === 'needs-go') {
          const k = JSON.parse(j.kind) as JobKind;
          w.put('question', { id: hex(), job: j.id, to: c.who, questions: [{ header: 'GPU job go', question: `#${t.number} wants to run job #${j.id} "${k.name}" on ${machine.name} NOW.`, options: [
            { label: 'Run in job hours', description: 'Queue it; it starts once job hours open.' },
            { label: 'Run now', description: "Start it as soon as the machine is free, outside job hours too; job hours ending won't pause it.", recommended: true },
            { label: 'Always allow this kind', description: 'Run this one in job hours, and let this exact recipe run in job hours from now on without asking.' },
            { label: 'No', description: 'Refuse it; the minion that asked is told.' },
          ] }], recipe: { machine: machine.name, asked_by: j.asked_by, when: j.run_when, reason: j.reason, limit_s: j.limit_s, kind: k, inputs: [{ name: 'chapter-08.wav', size: 398_000_000 }] } });
        }
        // A paused or ended job's card moved down once already: its first place keeps the note.
        if (j.state !== 'needs-go' && j.state !== 'queued') w.put('job', { job: j.id, stage: 'waiting', view: { ...viewOf(j), state: 'queued' } });
        const e = w.put('job', { job: j.id, stage: jobStage(j.state), view: viewOf(j) });
        first ||= e;
      }
      w.done('Seven jobs on the desktop: one waits on your go.');
      return route(c, t, first);
    },
  },
  skills: {
    about: "the Skills page (#1062): the Seeded scheme's minions running kit skills and Grunts over a few turns (edits, an error, ships), a repo folder with a skill of its own, and grilling turned off",
    seed(c) {
      const repo = join(c.dataDir, 'seeded-repo');
      mkdirSync(join(repo, '.claude', 'skills', 'release-notes'), { recursive: true });
      writeFileSync(join(repo, '.claude', 'skills', 'release-notes', 'SKILL.md'), '---\nname: release-notes\ndescription: Writes the release notes from the shipped minions since the last release. Use before cutting a release.\n---\n');
      c.store.setProjectRepoDir(c.project.id, repo);
      c.store.setProjectSettings(c.project.id, { skills_off: 'grilling' });
      const turn = (t: Ticket, steps: ((w: ReturnType<typeof chat>) => void)[], shipped: boolean) => {
        const w = chat(c, t, 40);
        for (const step of steps) step(w);
        if (shipped) w.put('note', { text: 'Shipped 1a2b3c4 to main' });
      };
      const skill = (name: string) => (w: ReturnType<typeof chat>) => w.call('Skill', { skill: `citadel:${name}` }, `Launching skill: citadel:${name}`);
      const grunt = (type?: string) => (w: ReturnType<typeof chat>) => w.call('Agent', { description: 'Review the diff', prompt: '…', ...(type ? { subagent_type: type } : {}) }, 'Done.');
      const edit = (w: ReturnType<typeof chat>) => w.call('Edit', { file_path: '/repo/src/app.ts', old_string: 'a', new_string: 'b' });
      const fail = (w: ReturnType<typeof chat>) => {
        const id = w.call('Bash', { command: 'npm test' }, null);
        w.put('claude', { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: true, content: '2 tests failed' }] } });
      };
      const ship = (w: ReturnType<typeof chat>) => w.call('mcp__thread__hand_off_land', { summary: 'the fix', risk: 'low' });
      const end = (w: ReturnType<typeof chat>) => w.done('Done.');
      const bug1 = minion(c, 'Export drops the last row', { status: 'closed' }, 'bug');
      turn(bug1, [skill('bug-fixing'), grunt('Explore'), edit, fail, skill('diagnosing-bugs'), edit, skill('self-review'), grunt('citadel:reviewer'), ship, end], true);
      const bug2 = minion(c, 'Login loops on Safari', { status: 'closed' }, 'bug');
      turn(bug2, [skill('bug-fixing'), edit, skill('self-review'), grunt('citadel:reviewer'), ship, end], true);
      // A bug minion that never opened bug-fixing though its brief named it: a miss and a "named, never opened" row (#1082).
      const bug3 = minion(c, 'CSV import trims leading zeros', { status: 'closed' }, 'bug');
      turn(bug3, [(w) => w.asked('Zip codes lose their leading zero on import. Open citadel:bug-fixing first and prove it with a failing test.'), edit, skill('self-review'), ship, end], true);
      const feat = minion(c, 'Dark mode toggle', { status: 'closed' }, 'feature');
      turn(feat, [skill('grilling'), end, skill('docs-and-mocks'), edit, skill('subagents'), grunt(), edit, skill('self-review'), grunt('citadel:reviewer'), ship, end], true);
      const idea = minion(c, 'Ideas for onboarding', {}, 'ideation');
      turn(idea, [skill('docs-and-mocks'), skill('subagents'), grunt('Explore'), grunt('Explore'), end], false);
      turn(taskmaster(c), [skill('subagents'), grunt('Explore'), end], false);
      return `#/p/${c.project.id}/skills (Orders → Skills in "${c.project.name}")`;
    },
  },
  memory: {
    about: "Orders → Memory (#1058, #1071): the Seeded scheme with a repo folder and six Claude Code memory notes of four kinds in the server login's config dir, one naming a closed minion, two with dates (one passed, one soon), and an index that leaves two out",
    seed(c) {
      const repo = join(c.dataDir, 'seeded-repo');
      mkdirSync(repo, { recursive: true });
      c.store.setProjectRepoDir(c.project.id, repo);
      const closed = minion(c, 'Old export fix', { status: 'closed' }, 'bug');
      // The copy's own config dir (previews.ts), so a test or a stray run never writes into the real one.
      const dir = join(c.dataDir, 'claude', 'projects', projectSlug(repo), 'memory');
      mkdirSync(dir, { recursive: true });
      const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
      // [file, name, description, body, kind, listed in MEMORY.md]
      const notes: [string, string, string, string, string, boolean][] = [
        ['released-means-released', 'Released means released', 'A target is live only when its people can get that version', 'Cara 2026-11-18: say "released" only once people can get the build.', 'feedback', true],
        ['ship-not-land', 'Ship, not land', 'Cara picked "land", then reversed to "ship" the same day', 'In everything people read, a change going onto main is "shipping".', 'feedback', false],
        ['for-cara-next-time', 'For Cara next time', 'Still owed to Cara', `Owed: the export check from #${closed.number}, and the Android units.`, 'project', true],
        ['fable-burst', 'Fable burst', 'Hard jobs on Fable the week of Nov 14', `Recheck after ${day(-5)}.`, 'project', true],
        ['effort-keep-high', 'Taskmaster effort', 'Cara: keep high', `Recheck after ${day(2)}; cut cost via wakes and context, not effort.`, 'user', true],
        ['perigee-shell', 'Perigee shell is fish', 'Hand people fish syntax or bash -c', 'A bash for-loop just hangs waiting for `end`.', 'reference', false],
      ];
      for (const [file, name, description, body, kind] of notes) writeFileSync(join(dir, `${file}.md`), `---\nname: ${name}\ndescription: ${description}\nmetadata:\n  type: ${kind}\n---\n\n${body}\n`);
      writeFileSync(join(dir, 'MEMORY.md'), notes.filter((n) => n[5]).map(([file, name, description]) => `- [${name}](${file}.md) — ${description}`).join('\n') + '\n');
      return `#/p/${c.project.id}/memory (Orders → Memory in "${c.project.name}")`;
    },
  },
  'memory-tidy': {
    about: 'Orders → Memory, Curator (#1111): the memory scenario plus an open memory tidy from a curator run (an edit, an index line, a delete, a flag) and an applied one that Put back can still undo',
    seed(c) {
      SCENARIOS.memory.seed(c);
      const repo = c.store.getProject(c.project.id)!.repo_dir!;
      const folder = memoryFolders(repo, [{ label: 'server', configDir: join(c.dataDir, 'claude') }])[0];
      const view = readFolder(folder, () => false);
      const old = c.store.memoryProposals.create({ project_id: c.project.id, ticket_id: null, folder: folder.id, changes: checkChanges(view, [{ action: 'index', file: 'perigee-shell.md', line: '- [Perigee shell is fish](perigee-shell.md) — hand people fish syntax', reason: 'Not in the index, so no session finds it' }]) }, Date.now() - 6 * 86_400_000).proposal;
      c.store.memoryProposals.decide(old.id, { status: 'applied', changes: old.changes.map((x) => ({ ...x, outcome: 'applied' })), backup: [{ file: 'perigee-shell.md', text: readFileSync(join(folder.dir, 'perigee-shell.md'), 'utf8'), line: null }], by: c.who }, Date.now() - 6 * 86_400_000);
      const run = minion(c, 'Memory curator', {}, 'chore');
      const changes = checkChanges(view, [
        { action: 'edit', file: 'released-means-released.md', text: '---\nname: Released means released\ndescription: A target is live only when its people can get that version; ship, not land\nmetadata:\n  type: feedback\n---\n\nCara 2026-11-18: say "released" only once people can get the build.\nIn everything people read, a change going onto main is "shipping" (merged in from ship-not-land).\n', line: '- [Released means released](released-means-released.md) — live only when people can get it; ship, not land', reason: 'ship-not-land says the same kind of thing: merged into this note' },
        { action: 'delete', file: 'ship-not-land.md', reason: 'Merged into released-means-released' },
        { action: 'index', file: 'perigee-shell.md', line: '- [Perigee shell is fish](perigee-shell.md) — hand people fish syntax or bash -c', reason: 'Not in the index, so no session finds it' },
        { action: 'delete', file: 'fable-burst.md', reason: 'Its recheck date passed five days ago' },
        { action: 'flag', file: 'for-cara-next-time.md', reason: 'Names a closed minion; live state: make it a pointer' },
      ]);
      const { proposal } = c.store.memoryProposals.create({ project_id: c.project.id, ticket_id: run.id, folder: folder.id, changes });
      c.store.addEvent(run.id, 'plan', { id: `memory-${proposal.id}`, status: 'pending', summary: `Memory tidy: ${countLine(changes)}`, plan: changes.map((x) => `- **${x.action}** \`${x.file}\`: ${x.reason}`).join('\n'), memory: { proposal: proposal.id, project: c.project.id, counts: countLine(changes) } });
      return `#/p/${c.project.id}/memory (Orders → Memory in "${c.project.name}"; the card is in #${run.number})`;
    },
  },
  decisions: {
    about:"Orders → Decisions (#1064): the memory scenario plus a git repo for the Seeded scheme (CLAUDE.md, a rule still saying \"land\", two ADRs, the second reversing the first by name), scheme instructions, and the Citadel-wide instructions' Land then Ship edit of Nov 19 in their history",
    seed(c) {
      SCENARIOS.memory.seed(c);
      if (!c.store.listUsers().some((u) => u.name === 'Josh')) c.store.createUser({ name: 'Josh', login: 'josh' });
      const repo = c.store.getProject(c.project.id)!.repo_dir!;
      const env = { ...process.env, GIT_AUTHOR_NAME: 'Seed', GIT_AUTHOR_EMAIL: 'seed@example.invalid', GIT_COMMITTER_NAME: 'Seed', GIT_COMMITTER_EMAIL: 'seed@example.invalid' };
      const sh = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe', env });
      const put = (path: string, text: string) => { mkdirSync(join(repo, path, '..'), { recursive: true }); writeFileSync(join(repo, path), text); };
      // A second seed starts the repo over, so ADR 0002 is its own commit again.
      for (const d of ['.git', 'docs', '.claude']) rmSync(join(repo, d), { recursive: true, force: true });
      execFileSync('git', ['init', '-q', '-b', 'main', repo]);
      put('CLAUDE.md', '# CLAUDE.md\n\n- **Decisions log (ADRs):** `docs/adr/`.\n- Screens are checked at two widths (Josh, 2026-11-12: "desktop and phone, every time").\n');
      put('.claude/rules/words.md', '# Words\n\n- Say land for a change reaching main (Cara, 2026-11-19, picked "Land" and, for `fold`, "Retire it").\n- Old CI rule (Cara, 2026-11-10: "Keep failing, log it").\n');
      put('docs/adr/0001-ci-red.md', '# 0001: A red CI run fails the land\n\nDate: 2026-11-10.\nCara, 2026-11-10, on #12\'s card: "Keep failing, log it".\n');
      sh('add', '-A');
      sh('commit', '-qm', 'Rules and the first ADR');
      put('docs/adr/0002-rerun-flakes.md', '# 0002: A red run that is red only on flakes gets one fresh run\n\nDate: 2026-11-15.\nCara, 2026-11-15, on #31\'s card: "Rerun CI on flake-only red".\n\nThis reverses Cara\'s 2026-11-10 "Keep failing, log it" for the CI gate.\n');
      sh('add', '-A');
      sh('commit', '-qm', 'ADR 0002');
      c.store.setProjectUpstream(c.project.id, 'https://github.com/caraminden/seeded', null);
      c.store.setProjectInstructions(c.project.id, '## Shipping\nShip small fixes without asking (Cara, 2026-10-27: "move fast").\n\n## Pictures\nImages by code (Cara, 2026-11-14: "image via code should ABSOLUTELY be the default").\n', c.who);
      const land = 'Land, not merge (Cara, 2026-11-19, picked "Land" and, for `fold`, "Retire it": "fold was just for major builds"). A change going onto main is "landing".\n\n- No reflow without input (Cara, 2026-11-16: "UI reflowing without a user input should be avoided").\n- Fable only for the hardest work (Josh, 2026-11-13: "only for really complex or high risk things").\n';
      const ship = land.replace(/^Land, not merge \([^\n]*/, 'Ship, not land or merge (Cara, 2026-11-19: she first picked "Land", then later that day, on #1020\'s card, picked `Ship` over keeping "land"; for `fold` she picked "Retire it": "fold was just for major builds"). A change going onto main is "shipping".');
      c.store.setAppInstructions(land, c.who);
      c.store.setAppInstructions(ship, 'Taskmaster');
      return `#/p/${c.project.id}/decisions (Orders → Decisions in "${c.project.name}")`;
    },
  },
  ideas: {
    about: 'Orders → Ideas (#1150): a choices page in the Seeded scheme with Build it / Later / Cut bars and a Send, a handoff for one pick that a minion started from and shipped, a pick another minion is still building, a Later pick waiting over two weeks, and a loose handoff',
    seed(c) {
      if (!c.store.listUsers().some((u) => u.name === 'Josh')) c.store.createUser({ name: 'Josh', login: 'josh' });
      const shared = projectSharedDir(c.dataDir, c.project.id);
      mkdirSync(join(shared, 'mockups', 'ideas'), { recursive: true });
      mkdirSync(join(shared, 'handoffs'), { recursive: true });
      const page = join(shared, 'mockups', 'ideas', 'ideas.html');
      writeFileSync(page, "<!doctype html><title>Ideas</title><h1>Ideas</h1><script>const opts = [{ v: 'go', label: 'Build it' }, { v: 'later', label: 'Later' }, { v: 'skip', label: 'Cut' }];\nmock.picks({ collection: 'ideas', options: opts });</script>");
      const day = 86_400_000;
      const at = (ago: number) => new Date(Date.now() - ago * day).toISOString();
      c.store.writeArtifactData(c.project.id, page, [
        { key: 'db/ideas/A1', value: JSON.stringify({ v: 'go', by: 'Josh', at: at(3), note: 'One page for every sound, please' }) },
        { key: 'db/ideas/A2', value: JSON.stringify({ v: 'go', by: 'Josh', at: at(3) }) },
        { key: 'db/ideas/B1', value: JSON.stringify({ v: 'later', by: 'Josh', at: at(20), note: 'After the audio work' }) },
        { key: 'db/ideas/B2', value: JSON.stringify({ v: 'later', by: 'Josh', at: at(3) }) },
        { key: 'db/ideas/C1', value: JSON.stringify({ v: 'skip', by: 'Josh', at: at(3) }) },
        { key: 'db/ideas/C2', value: JSON.stringify({ v: 'go', by: 'Josh', at: at(3), note: 'Small one, do it first' }) },
      ], 'Josh');
      const idea = minion(c, 'Ideas for the audio pass');
      c.store.addEvent(idea.id, 'user_message', { author: 'Josh', text: 'Picks on "Ideas":\n- A1 A sound board: Build it. "One page for every sound, please"\n- A2 Quieter footsteps: Build it\n- B1 A music mixer: Later. "After the audio work"\n- B2 Voice lines per room: Later\n- C1 Random ambience: Cut\n- C2 A mute key: Build it. "Small one, do it first"', comment: { path: page, about: 'Ideas' } });
      const handoff = (name: string, title: string, card: string) => {
        writeFileSync(join(shared, 'handoffs', name), `# Handoff: ${title} (${card})\n\nFrom #${idea.number}'s ideas page, card ${card}: \`${page}\`.\n**Pick (Josh):** Build it.\n`);
        return join(shared, 'handoffs', name);
      };
      const board = minion(c, 'Sound board');
      c.store.addEvent(board.id, 'user_message', { author: 'Taskmaster', text: `Start from the handoff \`${handoff('handoff-sound-board.md', 'a sound board', 'A1')}\`.` });
      const mute = minion(c, 'Mute key');
      c.store.addEvent(mute.id, 'user_message', { author: 'Taskmaster', text: `Start from the handoff \`${handoff('handoff-mute-key.md', 'a mute key', 'C2')}\`.` });
      c.store.addEvent(mute.id, 'note', { text: 'Shipped 1a2b3c4 "Mute key": M toggles every sound. Risk low: front end only. Live now.' });
      writeFileSync(join(shared, 'handoffs', 'handoff-save-slots.md'), '# Handoff: three save slots\n\nFrom the Taskmaster, after a chat with Josh.\n');
      return `#/p/${c.project.id}/ideas (Orders → Ideas in "${c.project.name}"): A1 started by #${board.number}, C2 built by #${mute.number}, B1 pinned as Later over two weeks`;
    },
  },
  ci: {
    about: 'the CI page (#968): the Seeded scheme with CI on GitHub, a ringing problem and a quiet one, verdicts (one green that skipped a job), a queue, runs and runners with what they run, desktop load, each run linking its minion (#1019), a quieted workflow with a red verdict, greyed (#990), the queued jobs of the landing minion as one row (#1019); the CI chip turns red',
    seed(c) {
      c.store.setProjectUpstream(c.project.id, 'https://github.com/caraminden/seeded', null);
      c.store.setProjectSettings(c.project.id, { ci_quiet: 'pilot.yml' });
      const now = Date.now();
      const iso = (min: number) => new Date(now - min * 60_000).toISOString();
      const url = (id: number) => `https://github.com/caraminden/seeded/actions/runs/${id}`;
      // The minions the runs test (#1019): one in review on its branch, one landing, one whose land is main's verdict.
      // #1063: the Test health tab: fast mode with a red pinned on one minion, and flaky files (one already has a minion on it).
      c.store.setProjectSettings(c.project.id, { land_mode: 'fast' });
      c.store.setSetting(`fast-mode:${c.project.id}`, { verified: 'a1b2c3d4e5f6a7b8', reds: [{ ids: ['test/aura-outline.test.ts'], sha: '9f8e7d6c5b4a3210', ticket: null, n: 12, at: now - 11 * 60_000 }], landed: {} });
      const onIt = minion(c, 'Flaky test: test/previews.test.ts');
      const seen = minion(c, 'Port the overlay', { status: 'closed' });
      for (const [file, n, src] of [['test/apps.test.ts', 17, 'in CI'], ['test/previews.test.ts', 12, 'smoke'], ['test/machines.test.ts', 9, 'run-tests'], ['test/checkpoint.test.ts', 4, 'in CI']] as const)
        for (let i = 0; i < n; i++) c.store.addFlakeEvents(c.project.id, i === 0 ? seen.id : null, 'a1b2c3d', now - (i * 20 + 3) * 3_600_000 / 2, [{ file, source: src, detail: `✖ ${file} › case ${i} (timed out after 5000ms)` }]);
      // #1120: a fix with 30 of its 50 proving runs clean, and a held one that flaked again (reopened).
      c.store.addFlakeFix(c.project.id, 'test/apps.test.ts', onIt.id, now - 26 * 3_600_000, { clean_runs: 30 });
      c.store.addFlakeFix(c.project.id, 'test/machines.test.ts', seen.id, now - 80 * 3_600_000, { reopened: 1 });
      const [review, landing, landed] = [minion(c, 'Sound tab in settings'), minion(c, 'Drag panels between monitors', { status: 'closed' }), minion(c, 'Aura vanishes when its outline is removed', { status: 'closed' }, 'bug')];
      const run = (id: number, name: string, branch: string, min: number, status: string, conclusion: string | null, event = 'push', who: Ticket | null = null) => ({ id, name, branch, event, status, conclusion, at: iso(min), url: url(id), minion: who?.number ?? null });
      c.store.setSetting(`ci-health:view:${c.project.id}`, {
        at: now - 2 * 60_000, slug: 'caraminden/seeded', branch: 'main',
        runners: [
          { name: 'DESKTOP-G248IJ8-desktop', status: 'offline', busy: false, labels: ['self-hosted', 'Windows', 'seeded-ci'], job: null, offlineSince: now - 42 * 60_000 },
          { name: 'DESKTOP-G248IJ8-linux', status: 'online', busy: true, labels: ['self-hosted', 'Linux', 'seeded-ci-linux'], job: 'tests (linux)', offlineSince: null },
        ],
        // #1019's Running now: the linux runner busy with the landing minion's tests, a hosted lint, nine jobs behind the one runner.
        running: [
          { name: 'tests (linux)', runner: 'DESKTOP-G248IJ8-linux', since: iso(12), run: 9103, branch: `land/${landing.branch}`, event: 'push', minion: landing.number },
          { name: 'lint', runner: 'GitHub Actions 3', since: iso(3), run: 9103, branch: `land/${landing.branch}`, event: 'push', minion: landing.number },
        ],
        queues: [
          { labels: ['seeded-ci-linux', 'self-hosted'], jobs: 9, runners: 1 },
          { labels: ['seeded-ci', 'self-hosted'], jobs: 8, runners: 0 },
        ],
        // Tonight's Peek Auras-shaped queue (#1019): the landing minion's five jobs in a row, one for the minion in review, two scheduled.
        waiting: [
          ...['screen', 'e2e', 'capture', 'windows', 'bench'].map((name, i) => ({ name, labels: ['self-hosted', 'seeded-ci'], since: iso(40 - i), run: 9103, branch: `land/${landing.branch}`, event: 'push', minion: landing.number })),
          { name: 'windows build', labels: ['self-hosted', 'seeded-ci'], since: iso(31), run: 9104, branch: review.branch!, event: 'pull_request', minion: review.number },
          ...['drift', 'drift (windows)'].map((name, i) => ({ name, labels: ['self-hosted', 'seeded-ci'], since: iso(20 - i), run: 9105, branch: 'main', event: 'schedule', minion: null })),
        ],
        workflows: [
          { name: 'tests', file: 'tests.yml', verdict: run(9101, 'tests', 'main', 55, 'completed', 'success', 'push', landed), skipped: ['windows build'] },
          { name: 'drift', file: 'drift.yml', verdict: run(9090, 'drift', 'main', 190, 'completed', 'failure', 'schedule'), skipped: [] },
          { name: 'release', file: 'release.yml', verdict: null, skipped: [] },
          // Quieted (TWIReader #990): its last run failed, drawn grey and tagged quiet.
          { name: 'audiobook pilot', file: 'pilot.yml', verdict: run(9080, 'audiobook pilot', 'main', 600, 'completed', 'failure', 'workflow_dispatch'), skipped: [] },
        ],
        runs: [
          run(9104, 'tests', review.branch!, 31, 'queued', null, 'pull_request', review),
          run(9103, 'tests', `land/${landing.branch}`, 12, 'in_progress', null, 'push', landing),
          run(9101, 'tests', 'main', 55, 'completed', 'success', 'push', landed),
          run(9100, 'tests', 'main', 70, 'completed', 'success'),
          run(9099, 'tests', review.branch!, 80, 'completed', 'cancelled', 'pull_request', review),
          run(9090, 'drift', 'main', 190, 'completed', 'failure', 'schedule'),
        ],
      });
      // #1019: CI desktop load on Overview, collapsed to a line of CPU and memory: the PC's agent sampled every 30 s for 20 min.
      const pc = c.store.createMachine(`seeded-ci-pc-${hex().slice(0, 4)}`, hex(), c.who);
      c.store.addRunnerLoads(Array.from({ length: 40 }, (_, i) => ({ machine: pc.id, at: now - (39 - i) * 30_000, data: JSON.stringify({
        at: now - (39 - i) * 30_000, host: 'DESKTOP-G248IJ8', os: 'windows', cores: 32, cpu: 40 + (i % 7) * 5, mem_total: 64 * 2 ** 30, mem_free: 22 * 2 ** 30,
        disk_total: 2e12, disk_free: 6e11, queue: 1, pressure: null, idle_sec: 900, temp: null, hv: null, restarts: [],
        runners: [{ name: 'DESKTOP-G248IJ8-linux', repo: 'caraminden/seeded', dir: 'C:\\actions-runner-seeded-linux', cpu: 20, mem: 3 * 2 ** 30 }],
      }) })));
      // #992: the red has a fix minion; the stuck one links to the Taskmaster's wake entry.
      // #1078: three reds: a fix minion at work (with its re-run), one closed with the red still open, and none yet.
      const fix = minion(c, 'Fix the red drift run 9090', { status: 'running', last_activity: 'Finding the cause… · 2 of 4 done', note: 'the drift check reads a stale fixture' }, 'bug');
      const gone = minion(c, 'Main red: lint.yml run 9091', { status: 'closed', note: 'fixed the lint rule' }, 'bug');
      const heard = c.store.addEvent(taskmaster(c).id, 'user_message', { author: 'Citadel', text: 'Seeded: CI: 1 job on self-hosted, seeded-ci has waited for a runner. Start a fix minion now.' });
      c.store.setSetting('ci-health:wake-at', { [`${c.project.id}:stuck:self-hosted,seeded-ci`]: { project: c.project.id, entry: heard.id } });
      c.store.setSetting(`ci-health:${c.project.id}`, {
        offline: {}, sent: {},
        problems: [
          { key: 'stuck:self-hosted,seeded-ci', title: 'CI, Seeded: 1 job on self-hosted, seeded-ci has waited for a runner since 31 min ago.', why: 'every runner that serves self-hosted, seeded-ci (DESKTOP-G248IJ8-desktop) is offline, since 42 min ago', fix: 'turn on or wake DESKTOP-G248IJ8, or start its runner service' },
          { key: 'red:drift.yml', title: 'CI, Seeded: drift.yml is red on main (run 9090).', why: 'the newest drift.yml verdict on main is red; its Taskmaster heard 3 h ago', fix: `the Taskmaster starts a fix minion naming run 9090; fix minion #${fix.number} started`, quiet: true, fixMinion: { number: fix.number!, closed: false }, rerun: { sha: 'a1b2c3d', url: 'https://github.com/caraminden/seeded/actions/runs/9120', state: 'running' } },
          { key: 'red:lint.yml', title: 'CI, Seeded: lint.yml is still red on main, and is still red after fix minion #' + gone.number + ' closed', why: 'run 9095 on main, made after it closed, failed too, so the fix did not hold', fix: `reopen #${gone.number} or start another fix minion naming run 9095`, fixMinion: { number: gone.number!, closed: true } },
          { key: 'red:nightly.yml', title: 'CI, Seeded: nightly.yml is red on main (run 9096).', why: 'the newest nightly.yml verdict on main is red; its Taskmaster heard 12 min ago', fix: 'the Taskmaster starts a fix minion naming run 9096', quiet: true, noFix: { ringsAt: now + 48 * 60_000, late: false } },
        ],
      });
      return `#/p/${c.project.id}/ci`;
    },
  },
  'ci-desktop-over': {
    about: 'the CI page with every scheme clear and its desktop overloaded (#1085): the toned "why the chip is yellow" row above the scheme list; seed `ci` for the scheme-red case',
    seed(c) {
      c.store.setProjectUpstream(c.project.id, 'https://github.com/caraminden/seeded', null);
      const now = Date.now();
      c.store.setSetting(`ci-health:view:${c.project.id}`, {
        at: now - 60_000, slug: 'caraminden/seeded', branch: 'main',
        runners: [{ name: 'DESKTOP-G248IJ8-linux', status: 'online', busy: false, labels: ['self-hosted', 'Linux', 'seeded-ci-linux'], job: null, offlineSince: null }],
        running: [], queues: [], waiting: [], workflows: [], runs: [],
      });
      c.store.setSetting(`ci-health:${c.project.id}`, { offline: {}, sent: {}, problems: [] });
      const pc = c.store.createMachine(`seeded-ci-pc-${hex().slice(0, 4)}`, hex(), c.who);
      // Someone is at the PC (idle_sec 0) and the CPU sits at 90% or more: the rule's "Overloading".
      c.store.addRunnerLoads(Array.from({ length: 40 }, (_, i) => ({ machine: pc.id, at: now - (39 - i) * 30_000, data: JSON.stringify({
        at: now - (39 - i) * 30_000, host: 'DESKTOP-G248IJ8', os: 'windows', cores: 32, cpu: 92 + (i % 5), mem_total: 64 * 2 ** 30, mem_free: 22 * 2 ** 30,
        disk_total: 2e12, disk_free: 6e11, queue: 12, pressure: null, idle_sec: 0, temp: null, hv: null, restarts: [],
        runners: [{ name: 'DESKTOP-G248IJ8-linux', repo: 'caraminden/seeded', dir: 'C:\\actions-runner-seeded-linux', cpu: 20, mem: 3 * 2 ** 30 }],
      }) })));
      return `#/p/${c.project.id}/ci`;
    },
  },
  'land-line': {
    about: "a scheme that lands with the kit's land template, on its Releases page (#1007): one landing, three waiting in an order set by hand, one from an old branch that can't move; on two targets",
    seed(c) {
      const repo = join(projectDir(c.dataDir, c.project.id), 'repo');
      const sh = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_NAME: 'Seed', GIT_AUTHOR_EMAIL: 'seed@example.invalid', GIT_COMMITTER_NAME: 'Seed', GIT_COMMITTER_EMAIL: 'seed@example.invalid' } });
      const put = (path: string, text: string) => {
        mkdirSync(join(repo, path, '..'), { recursive: true });
        writeFileSync(join(repo, path), text);
      };
      rmSync(repo, { recursive: true, force: true }); // seeded again: a fresh line, not the last one's
      mkdirSync(repo, { recursive: true });
      execFileSync('git', ['init', '-q', '-b', 'main', repo]);
      // Two targets: a Windows and a Linux build, each a release job; the land script follows .order (the template's queue_order).
      const job = (os: string) => `  ${os}-release:\n    runs-on: ${os === 'windows' ? 'windows-latest' : 'ubuntu-latest'}\n    steps:\n      - run: gh release upload v1 out.zip\n`;
      put('.github/workflows/release.yml', `name: release\non: push\njobs:\n${job('windows')}${job('linux')}`);
      put('tools/land.sh', '#!/usr/bin/env bash\nqueue_order() {\n  :\n}\n');
      sh('add', '-A');
      sh('commit', '-qm', 'seed');
      c.store.setProjectRepoDir(c.project.id, repo);
      // The queue's tickets name pid 1 with its start time, so they read as alive with nothing left running.
      const stat = readFileSync('/proc/1/stat', 'utf8');
      const one = `1 ${stat.slice(stat.lastIndexOf(') ') + 2).split(' ')[19]}`;
      const q = join(repo, '.git', 'land-queue');
      mkdirSync(q, { recursive: true });
      const lands: [string, boolean][] = [['Tell the agent a rule was taken out', true], ['Windows installer icon', true], ['Overlay fades on focus loss', true], ['Companion log rotation', true], ['Old branch: tray menu', false]];
      const made: Ticket[] = [];
      lands.forEach(([title, orders], i) => {
        const t = minion(c, title, { note: 'landing' });
        made.push(t);
        // Each branch changes a file both builds ship, so its land is on both targets.
        sh('checkout', '-q', '-b', t.branch!);
        put(`src/change-${i}.txt`, `${title}\n`);
        sh('add', '-A');
        sh('commit', '-qm', title);
        sh('checkout', '-q', 'main');
        const holds = i === 0;
        writeFileSync(join(q, String(i + 1).padStart(10, '0')), [one, holds ? String(Math.floor(Date.now() / 1000) - 240) : '0', t.branch, holds ? 'waiting for CI on 63df22a8 since 21:52' : 'waiting', '-', '-', '-', ...(orders ? ['order'] : [])].join('\n') + '\n');
        // A handed-off land the server reads as still running: its started time ahead, so no pid is needed (HostJobs' start grace).
        const dir = join(c.dataDir, 'run', 'landings', String(t.id));
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'handoff.json'), JSON.stringify({ summary: title, risk: 'low', reason: 'seeded', args: [] }));
        writeFileSync(join(dir, 'started'), String(Date.now() + 365 * 86400e3));
        writeFileSync(join(dir, 'output.log'), holds ? 'queue: got the land lock\n' : `queue: ${['2nd', '3rd', 'next', '4th'][i - 1]} in line for the land lock\n`); // as .order has them
      });
      writeFileSync(join(q, '.order'), `# ${c.who} moved #4 to land next\n0000000004\n0000000002\n0000000003\n`);
      // Who placed them (#1358): the person's drag of the 4th pins it; the Taskmaster moved the 2nd, with its reason.
      const at = Date.now();
      c.store.setSetting(`ship-line:${c.project.id}`, { history: [], placed: {
        [`t${made[3].id}`]: { by: c.who, at: at - 40 * 60_000, taskmaster: false },
        [`t${made[1].id}`]: { by: `${c.project.name} Taskmaster`, at: at - 5 * 60_000, taskmaster: true, reason: 'a fix for the Windows build that is red on main' },
      } });
      return `#/p/${c.project.id}/releases/${c.project.id}`;
    },
  },
  'schedule-runs': {
    about: 'a scheme with a template row beside a hand-made copy, plus Threadspace (no Test audit), with run history, outcomes and costs (#1057)',
    seed(c) {
      const user = c.store.listUsers().find((u) => u.name === c.who);
      const day = 864e5;
      const now = Date.now();
      const scheme = (name: string) => {
        const p = c.store.listProjects().find((x) => x.name === name) ?? c.store.createProject(name, null, user?.id ?? null);
        c.store.setProjectSettings(p.id, { onboarding: 'skipped' });
        if (user) c.store.addMember(p.id, user.id);
        return p;
      };
      // The Seeded scheme gets the Genesis Tree case (a template row beside a hand-made copy); Threadspace is the left-out case.
      const gt = c.project;
      scheme('Threadspace');
      const t = loadTemplates().get('code-health')!;
      const vars = templateVars(c.store, c.dataDir, gt.id);
      const row = c.store.schedules.create({ project_id: gt.id, ...templateFields(t, gt, 'Never push.', vars), created_by: c.who });
      c.store.schedules.create({ project_id: gt.id, name: 'Code health', cron: '0 4 * * 1', brief: 'Hand-made copy.', type: 'chore', created_by: c.who });
      const runMinions: [string, Parameters<Store['updateTicket']>[1], number][] = [
        ['Code health run', { status: 'idle', state: 'complete', note: '3 findings, 1 PR opened' }, 2.41],
        ['Code health run', { status: 'idle', state: 'ready', note: 'needs a go on the split' }, 1.87],
        ['Code health run', { status: 'error', note: null }, 0.2],
        ['Code health run', { status: 'running', note: 'reading src/' }, 0.5],
      ];
      runMinions.forEach(([title, fields, cost], i) => {
        const tk = c.store.createTicket({ project_id: gt.id, title, permission_mode: 'bypassPermissions', created_by: c.who });
        c.store.updateTicket(tk.id, fields);
        c.store.recordTurn(tk.id, { ended_at: now, session_cost_usd: cost, session_id: `seed-${tk.id}` });
        c.store.schedules.ran(row.id, { ticketId: tk.id }, now - (28 - i * 7) * day);
        if (i < 3) c.store.schedules.ran(row.id, { skip: `Skipped: 1 minion since last run (needs 3)` }, now - (27 - i * 7) * day);
      });
      return `#/p/${gt.id}`;
    },
  },
  'review-set': {
    about: "the Seeded scheme's Reviewers and critics page (#1054): a Taste panel of two critics and its referee, a blocking critic that always fails and holds a minion's ship, an order, hand-offs, run dots, a pass rate and two recorded verdicts; an art critic handing off to its own Art professor teacher, and the kit's Professor under the others, each with fixes that held or didn't (#1089)",
    seed(c) {
      const r = c.store.reviews;
      const id = c.project.id;
      const t = minion(c, 'New onboarding screens', { note: 'held by the copy critic' });
      const mk = (slug: string, name: string, kind: string, f: Record<string, unknown> = {}) => r.get(id, slug) ?? r.create(id, { slug, name, kind, stage: 'work', trial: false, triggers: { diff: ['public/**'] }, body: `## What it checks\n\n${name}.\n`, ...f } as never, c.who);
      mk('layout-critic', 'Layout critic', 'critic', { panel: 'Taste' });
      mk('colour-critic', 'Colour critic', 'critic', { panel: 'Taste' });
      mk('taste-referee', 'Taste referee', 'referee', { panel: 'Taste' });
      mk('copy-critic', 'Copy critic', 'critic', { gate: 'block', on_fail: [{ after: 1, to: 'layout-critic' }, { after: 3, to: 'person' }] });
      mk('a11y-checker', 'Accessibility checker', 'checker', { stage: 'ship', context: { requester: true } });
      r.ensureBuiltIns(id);
      // The scheme's own agent files (#1089): a shader critic read from its repo, its text live, and a sound one since deleted.
      // Its own folder under the copy's data, always: it commits there, and another seed may have pointed Seeded at this repo (status).
      const repo = join(projectDir(c.dataDir, id), 'repo');
      mkdirSync(join(repo, '.claude', 'agents'), { recursive: true });
      c.store.setProjectRepoDir(id, repo);
      writeFileSync(join(repo, '.claude', 'agents', 'shader-critic.md'), '---\nname: shader-critic\ndescription: Judges a new or changed shader in motion, against the look bible\n---\n\nYou judge shaders from a clip, never a still.\n\n## Blockers\n\n- Banding in a gradient\n- A flash brighter than the UI\n');
      writeFileSync(join(repo, '.claude', 'agents', 'sound-critic.md'), '---\nname: sound-critic\ndescription: Judges new sounds\n---\nListen.\n');
      r.ensureAgents(id, readAgentFiles(repo));
      rmSync(join(repo, '.claude', 'agents', 'sound-critic.md'));
      r.save(id, 'shader-critic', { body: 'Our water shader foams at the shore: judge the foam line too.\n' }, c.who, 'Edited by hand');
      mk('art-professor', 'Art professor', 'teacher', { triggers: {}, body: '## For fixes\n\nRead the palette ramp first; name a tone, a pixel size and a frame range.\n' });
      mk('art-critic', 'Art critic', 'critic', { triggers: { creative: 'new or changed art' }, on_fail: [{ after: 2, to: 'art-professor' }, { after: 3, to: 'person' }] });
      const now = Date.now();
      // Teacher runs (#1089): the critic's round after each fix, pass when the fix held.
      ([['art-professor', 3, 'pass'], ['art-professor', 3, 'pass'], ['art-professor', 3, 'fail'], ['art-professor', 3, 'pass'], ['professor', 3, 'fail'], ['professor', 3, 'pass']] as const)
        .forEach(([slug, round, verdict], i) => r.recordRun(id, slug, { ticketId: t.id, minion: `#${t.number}`, round, verdict }, now - (6 - i) * 5_400_000));
      const runs: [string, number, string][] = [['layout-critic', 1, 'pass'], ['layout-critic', 1, 'fail'], ['layout-critic', 2, 'pass'], ['layout-critic', 1, 'pass'], ['colour-critic', 1, 'fail'], ['colour-critic', 1, 'pass'], ['taste-referee', 1, 'pass'], ['a11y-checker', 1, 'ask']];
      runs.forEach(([slug, round, verdict], i) => r.recordRun(id, slug, { ticketId: t.id, minion: `#${t.number}`, round, verdict }, now - (runs.length - i) * 3_600_000));
      for (let i = 0; i < 6; i++) r.recordRun(id, 'copy-critic', { ticketId: t.id, minion: `#${t.number}`, round: 1, verdict: 'fail' }, now - (6 - i) * 1_800_000);
      r.recordVerdict(id, 'colour-critic', { person: 'Josh', words: 'The muted grey on the empty state is fine: it is meant to be quiet.', ticketId: t.id, minion: `#${t.number}` }, now - 3_000_000);
      r.recordVerdict(id, 'copy-critic', { person: c.who, words: 'It should have caught "Click here" on the welcome button.', ticketId: t.id, minion: `#${t.number}` }, now - 600_000);
      // At a glance (#1094): a month of commits, most outside public/ where the critics look, so the hint has gaps; a
      // review skill in the repo; two minions closed this week, one judged; and two more schemes for the Every scheme tab.
      mkdirSync(join(repo, '.claude', 'skills', 'level-review'), { recursive: true });
      writeFileSync(join(repo, '.claude', 'skills', 'level-review', 'SKILL.md'), '---\nname: level-review\ndescription: Review a new or changed level for pacing and fairness. Use when a level file changes.\n---\n\nPlay it through twice.\n');
      const g = (...a: string[]) => execFileSync('git', ['-C', repo, ...a], { stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_NAME: 'Seed', GIT_AUTHOR_EMAIL: 'seed@example.invalid', GIT_COMMITTER_NAME: 'Seed', GIT_COMMITTER_EMAIL: 'seed@example.invalid' } });
      g('init', '-q');
      const files = ['app/server/rooms.ts', 'app/server/save.ts', 'app/server/net.ts', 'app/shared/types.ts', 'app/shared/maths.ts', 'public/menu.js', 'public/hud.css', 'levels/forest.json', 'test/rooms.test.ts', 'docs/notes.md'];
      for (let i = 0; i < 24; i++) {
        const f = files[(i * 7) % files.length];
        mkdirSync(join(repo, f, '..'), { recursive: true });
        writeFileSync(join(repo, f), `// change ${i}\n`);
        g('add', '-A');
        const at = new Date(now - (25 - i) * 86_400_000).toISOString();
        execFileSync('git', ['-C', repo, 'commit', '-q', '-m', `change ${i}`], { stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_NAME: 'Seed', GIT_AUTHOR_EMAIL: 'seed@example.invalid', GIT_COMMITTER_NAME: 'Seed', GIT_COMMITTER_EMAIL: 'seed@example.invalid', GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at } });
      }
      const judged = minion(c, 'Menu polish', { status: 'closed' });
      r.recordRun(id, 'layout-critic', { ticketId: judged.id, minion: `#${judged.number}`, round: 1, verdict: 'pass' }, now - 900_000);
      minion(c, 'Save file fix', { status: 'closed' });
      const user = c.store.findUser('name', c.who);
      for (const [name, critic] of [['Seeded two', true], ['Seeded quiet', false]] as const) {
        const p = c.store.listProjects().find((x) => x.name === name) ?? c.store.createProject(name, null, user?.id ?? null);
        if (user) c.store.addMember(p.id, user.id);
        if (!critic || r.get(p.id, 'map-critic')) continue;
        r.ensureBuiltIns(p.id);
        r.create(p.id, { slug: 'map-critic', name: 'Map critic', kind: 'critic', stage: 'work', trial: true, triggers: { diff: ['maps/**'] }, body: '## What it checks\n\nMaps.\n' } as never, c.who);
      }
      return `#/p/${id}/reviews`;
    },
  },
  'kit-sync': {
    about: "kit files sync themselves (#1100): Seeded runs Citadel's code, and Green, Red and Elsewhere carry the kit's land.sh from one change back (Red's check fails, Elsewhere's GitHub origin can't be pushed). A dev copy is a preview, whose kit sync timer is off (on copied data it would branch real schemes' repos): lift server.ts's guard on it in an edit you don't commit, start the copy, seed within 20 s, and one kit sync card lands in Seeded's Taskmaster chat",
    seed(c) {
      const kit = join(import.meta.dirname, '..');
      const template = 'kit/skills/scheme-setup/templates/land.sh';
      const old = execFileSync('git', ['-C', kit, 'log', '-2', '--format=%H', '--', template], { encoding: 'utf8' }).trim().split('\n')[1];
      const id = { GIT_AUTHOR_NAME: 'Seed', GIT_AUTHOR_EMAIL: 'seed@example.invalid', GIT_COMMITTER_NAME: 'Seed', GIT_COMMITTER_EMAIL: 'seed@example.invalid' };
      const git = (repo: string, ...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: { ...process.env, ...id } });
      // Seeded is the home scheme: its repo holds the commit the copy runs, as Citadel's does.
      const home = join(projectDir(c.dataDir, c.project.id), 'repo');
      rmSync(home, { recursive: true, force: true });
      execFileSync('git', ['clone', '-q', '--no-checkout', kit, home]);
      c.store.setProjectRepoDir(c.project.id, home);
      taskmaster(c);
      const user = c.store.listUsers().find((u) => u.name === c.who);
      const scheme = (name: string, local: string, origin: (dir: string) => string) => {
        const p = c.store.listProjects().find((x) => x.name === name) ?? c.store.createProject(name, null, user?.id ?? null);
        c.store.setProjectSettings(p.id, { onboarding: 'skipped' });
        if (user) c.store.addMember(p.id, user.id);
        const dir = join(projectDir(c.dataDir, p.id), 'repo');
        rmSync(join(projectDir(c.dataDir, p.id), 'kit-sync'), { recursive: true, force: true });
        rmSync(dir, { recursive: true, force: true });
        mkdirSync(join(dir, 'tools'), { recursive: true });
        execFileSync('git', ['init', '-q', '-b', 'main', dir]);
        writeFileSync(join(dir, 'tools', 'land.sh'), git(kit, 'show', `${old}:${template}`), { mode: 0o755 });
        writeFileSync(join(dir, 'tools', 'land.local.sh'), local);
        writeFileSync(join(dir, 'README.md'), `${name}\n`);
        git(dir, 'add', '-A');
        git(dir, 'commit', '-qm', 'seed');
        git(dir, 'remote', 'add', 'origin', origin(dir));
        if (!origin(dir).startsWith('https:')) {
          rmSync(origin(dir), { recursive: true, force: true });
          git(dir, 'clone', '-q', '--bare', dir, origin(dir));
        }
        c.store.setProjectRepoDir(p.id, dir);
        taskmaster({ ...c, project: c.store.getProject(p.id)! });
      };
      const bare = (dir: string) => join(dir, '..', 'origin.git');
      scheme('Green', "CHECK='true'\nSMOKE_CMD='echo smoke ok'\n", bare);
      scheme('Red', "CHECK='true'\nSMOKE_CMD='echo the smoke test failed >&2; exit 3'\n", bare);
      scheme('Elsewhere', "CHECK='true'\nSMOKE_CMD='true'\n", () => 'https://github.com/citadel-kit-sync-seed/no-such-repo.git');
      // The last look saw the templates as they were before the newest land.sh change: the next look starts a round.
      c.store.setSetting('kit-sync', { blobs: templateBlobs(kit, old) });
      return `#/p/${c.project.id}`;
    },
  },
  'inbox-full': {
    about: 'a Needs-you inbox of 25 minions waiting on people, enough to scroll it open (#668)',
    seed(c) {
      const states = ['ready', 'complete', 'try'] as const;
      for (let i = 1; i <= 25; i++) minion(c, `Waiting minion ${i}`, { state: states[i % 3], note: `needs you ${i}` });
      return `#/p/${c.project.id}`;
    },
  },
  status: {
    about: 'the Status page (#1123): a week of memory and disk samples, boots (one a crash), stalls and ships on this copy\'s own scheme, and two apps with deploys (one failed), errors and turns; one app sits in a second scheme whose only member is Mia, signed in by POSTing a password to /api/invite/statusseedstatusseedstatusseed01, to see the page as a member of another scheme',
    seed(c) {
      const now = Date.now();
      const HOUR = 3_600_000;
      const db = c.store.db;
      // This copy runs this repo, so the Seeded scheme counts as Citadel's own: its releases are the ships.
      c.store.setProjectRepoDir(c.project.id, process.cwd());
      for (let t = now - 8 * 24 * HOUR; t <= now; t += 15 * 60_000) {
        const wave = Math.sin(t / (6 * HOUR));
        c.store.addHostSample({ at: t, mem_total: 64e9, mem_avail: Math.round(64e9 * (0.42 + 0.12 * wave)), disk_total: 2e12, disk_free: Math.round(2e12 * (0.31 - 0.04 * ((t - now) / (8 * 24 * HOUR) + 1))), load1: 2 + wave, rss: 450e6 });
      }
      const sha = (n: number) => `${n}`.repeat(40).slice(0, 40);
      c.store.addHealthEvent('boot', now - 6 * 24 * HOUR, sha(1), 'a ship: new code 11111111');
      c.store.addHealthEvent('boot', now - 3 * 24 * HOUR, sha(2), 'a ship: new code 22222222');
      c.store.addHealthEvent('boot', now - 3 * 24 * HOUR + 4 * HOUR, sha(2), 'a restart on the same code: a crash, the watchdog or by hand');
      c.store.addHealthEvent('boot', now - 9 * HOUR, sha(3), 'a ship: new code 33333333');
      for (const [ago, s] of [[5, 0.8], [30, 1.4], [50, 6.2], [100, 2.1], [140, 0.6], [150, 0.9], [175, 3.3]] as const)
        c.store.addHealthEvent('loop-lag', now - ago * HOUR, sha(3), `The event loop was held for ${s} s: sqlite`);
      for (let i = 0; i < 22; i++) {
        const start = now - (i * 8.3 + 2) * HOUR;
        c.store.addRelease({ project_id: c.project.id, target: 'citadel-server', version: sha(i % 9), changes: JSON.stringify([{ title: `#${1100 + i}: a seeded change` }]), started_at: start, live_at: start + (240 + (i % 5) * 90) * 1000, outcome: 'live', stages: JSON.stringify({ line: 40 + (i % 3) * 20, rebase: 12, test: 130 + (i % 5) * 60, deploy: 40, restart: 18 }) });
      }
      // A slow day (#1132): three ships two days ago whose tail is well past 10 minutes, so the chart's spike and the waterfall show.
      for (const [ago, line, test] of [[50, 700, 380], [48, 90, 1100], [46, 60, 200]] as const) {
        const start = now - ago * HOUR;
        c.store.addRelease({ project_id: c.project.id, target: 'citadel-server', version: sha(7), changes: '[]', started_at: start, live_at: start + (line + 12 + test + 58) * 1000, outcome: 'live', stages: JSON.stringify({ line, rebase: 12, test, deploy: 40, restart: 18 }) });
      }
      const mia = c.store.listUsers().find((u) => u.login === 'mia') ?? c.store.createUser({ name: 'Mia', login: 'mia' });
      const token = 'statusseedstatusseedstatusseed01'; // the about line names it
      c.store.updateUser(mia.id, { invite_hash: inviteHash(token), invite_expires: now + 7 * 24 * HOUR });
      // Scheme 2 is Citadel's (GLOBAL_OWNER: its members see every scheme), so Mia's scheme must not take that id.
      if (!c.store.getProject(2)) c.store.createProject('Citadel', null, null);
      const peekScheme = c.store.listProjects().find((p) => p.name === 'Peek Auras') ?? c.store.createProject('Peek Auras', null, mia.id);
      c.store.addMember(peekScheme.id, mia.id);
      const me = c.store.listUsers().find((u) => u.name === c.who) ?? mia;
      c.store.addMember(peekScheme.id, me.id);
      const app = (name: string, title: string, home: number, port: number) => c.store.getContraption(name) ?? (c.store.createContraption({ name, title, icon: null, port, home_scheme: home, open_paths: '["/"]', relay_paths: '[]', repo: null, branch: null, folder: null, default_model: null, turn_cap: null, identity_public: '', identity_private: '', key_hash: `${name}-${hex()}`, keys_at: now }), c.store.getContraption(name)!);
      const peek = app('peek-auras', 'Peek Auras', peekScheme.id, 29_311);
      const ledger = app('ledger', 'Ledger', c.project.id, 29_312);
      const deploy = (name: string, ago: number, took: number, outcome: string) => c.store.addContraptionDeploy({ name, from_sha: null, to_sha: hex().padEnd(40, '0'), by: 'Mia', started_at: now - ago * HOUR, finished_at: now - ago * HOUR + took * 1000, outcome, stages: JSON.stringify({ build: Math.round(took * 0.6), restart: Math.round(took * 0.4) }), changes: '[]' });
      for (const [ago, took, out] of [[150, 70, 'deployed'], [120, 95, 'deployed'], [74, 64, 'deployed'], [50, 180, 'failed'], [49, 88, 'deployed'], [26, 72, 'deployed'], [3, 81, 'deployed']] as const) deploy('peek-auras', ago, took, out);
      deploy('ledger', 30, 140, 'deployed');
      deploy('ledger', 2, 210, 'failed');
      const err = (id: number, ago: number, kind: string, key: string, sample: string) => c.store.addContraptionError(id, pacificDay(now - ago * HOUR), kind, key, sample, now - ago * HOUR);
      for (let i = 0; i < 14; i++) err(peek.id, 2 + i * 9, i % 3 ? 'http 5xx' : 'client', i % 3 ? 'GET /api/auras' : 'TypeError', i % 3 ? '502 from the aura service' : "Cannot read properties of null (reading 'glow')");
      err(ledger.id, 1, 'tool', 'search', 'no tool named search');
      const turn = (id: number, uid: number, ago: number, tokens: number) => {
        const t = c.store.startContraptionTurn(id, uid, hex());
        c.store.endContraptionTurn(t, 'done', { input: tokens / 10, output: tokens / 20, cacheRead: tokens * 0.85, cacheWrite: 0 });
        db.prepare('UPDATE contraption_turns SET started_at = ? WHERE id = ?').run(now - ago * HOUR, t);
      };
      for (let i = 0; i < 30; i++) turn(peek.id, i % 4 ? mia.id : me.id, 1 + i * 6, 40_000 + (i % 7) * 9000);
      for (let i = 0; i < 6; i++) turn(ledger.id, me.id, 3 + i * 20, 25_000);
      return `#/p/${c.project.id}/status`;
    },
  },
};
