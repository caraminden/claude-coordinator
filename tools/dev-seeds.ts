// The states minions test, as plain functions over the store (#642): `citadel-dev-copy seed <name>` adds one to
// the running dev copy and prints the route that shows it; a test may call them on its own Store. A feature that
// needs a state no scenario has adds one here rather than in a scratch seed.ts. Each adds a fresh minion (or a few)
// to a scheme named "Seeded", so they work on --data empty and on a copy of the live data alike.
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Project, Store, Ticket } from '../src/db.ts';
import { projectDir } from '../src/workspace.ts';

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
      steps.forEach(([subject, estimate], i) => call('TaskCreate', { subject, description: `${subject}.`, metadata: { estimate } }, `Task #${i + 1} created successfully: ${subject}`));
      for (let i = 0; i <= finished && i < steps.length; i++) {
        call('TaskUpdate', { taskId: String(i + 1), status: 'in_progress' }, `Updated task #${i + 1} status`);
        if (i < finished) call('TaskUpdate', { taskId: String(i + 1), status: 'completed', metadata: { outcome: 'Done as planned.' } }, `Updated task #${i + 1} status`);
      }
    },
  };
}

const hex = () => Math.random().toString(16).slice(2, 14).padEnd(12, '0');
const route = (c: SeedCtx, t: Ticket, eventId?: number) => `#/p/${c.project.id}/t/${t.number}${eventId ? `?e=${eventId}` : ''}`;

export const SCENARIOS: Record<string, { about: string; seed: (c: SeedCtx) => string }> = {
  'question-card': {
    about: 'a minion waiting on two open question cards: one pick with a recommended option, one multi-select',
    seed(c) {
      const t = minion(c, 'Sidebar badge colours', { note: 'needs a pick: badge colours' });
      const w = chat(c, t, 12);
      w.asked('The unread badges in the sidebar are hard to see in dark mode. Can you fix them?');
      w.init();
      w.call('Read', { file_path: `${t.cwd}/public/sidebar.css` }, '.badge { background: var(--accent); }');
      w.said('Two ways to fix the contrast; which do you want?');
      const e = w.put('question', { id: hex(), questions: [{ question: 'How should unread badges look in dark mode?', header: 'Badge style', multiSelect: false, options: [
        { label: 'Solid accent', description: 'A filled accent-coloured pill with white text: 7.1:1 contrast.', recommended: true },
        { label: 'Outlined', description: 'A 1px accent outline with accent text: quieter, 4.6:1 contrast.' },
        { label: 'Leave as is', description: 'Keep today\'s look.' },
      ] }] });
      w.put('question', { id: hex(), questions: [{ question: 'Which places should the new badge reach?', header: 'Where', multiSelect: true, options: [
        { label: 'Sidebar', description: 'The minions list.', recommended: true },
        { label: 'Tab title', description: 'The (3) in the browser tab.' },
        { label: 'Phone drawer', description: 'The drawer handle on phones.', recommended: true },
      ] }] });
      w.done('Asked which badge style to use.');
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
  board: {
    about: 'the minions list with a minion in each state, types, notes and a build',
    seed(c) {
      const rows: [string, Parameters<Store['updateTicket']>[1], string][] = [
        ['Merge the rail icons', { state: 'ready', note: 'tested, risk low; needs a go to land', replies: JSON.stringify(['Land it']) }, 'feature'],
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
  'inbox-full': {
    about: 'a Needs-you inbox of 25 minions waiting on people, enough to scroll it open (#668)',
    seed(c) {
      const states = ['ready', 'complete', 'try'] as const;
      for (let i = 1; i <= 25; i++) minion(c, `Waiting minion ${i}`, { state: states[i % 3], note: `needs you ${i}` });
      return `#/p/${c.project.id}`;
    },
  },
};
