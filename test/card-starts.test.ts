import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { leftForPeople } from '../src/card-starts.ts';
import type { Project, Ticket } from '../src/db.ts';
import type { CabalRow } from '../src/db/cabals.ts';
import { agentToken, bootServer, mintedAgentToken, until } from './helpers.ts';
import { json } from './typed.ts';

// A pick on a card starts the minion (#2050; Josh, 2026-11-25, picked "Start" on #2031's page; docs/adr/0038): an option's
// `start` makes the minion when a person picks it plainly, with no Taskmaster turn, as that person's, child of the card's owner.

type Ev = { id: number; kind: string; data: string };
type Row = { id: number; number: number; title: string; parent: number | null; person_id: number | null; model: string; effort: string; project_id: number };
type Held = { items: { text: string }[] } | null;

/** The answer message to card `id`, among a chat's events (other messages may come after it). */
const answerTo = (events: Ev[], id: string) => events.find((e) => e.kind === 'user_message' && JSON.parse(e.data).answer?.questionId === id)?.data ?? '';

test("a plain pick of a start option starts that minion as the picker's; a typed note, a used or a gone handoff starts nothing", async () => {
  const s = await bootServer();
  try {
    const { data: p } = await s.call('/api/projects', { name: 'Delve' }); // any scheme but Citadel's
    // A second member picks, so the new minion's login is shown to be the picker's, not the card owner's person's.
    const made = (await s.call('/api/people', { name: 'Josh' })).data;
    const res = await fetch(`${s.base}/api/invite/${made.token}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'a-long-password' }) });
    const josh = { id: made.person.id as number, cookie: res.headers.get('set-cookie')!.split(';')[0] };
    assert.equal((await s.call(`/api/projects/${p.id}/members`, { person: josh.id })).status, 200);
    const asJosh = (path: string, body: object) => fetch(`${s.base}${path}`, { method: 'POST', headers: { Cookie: josh.cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.status);

    const { data: owner } = await s.call(`/api/projects/${p.id}/tickets`, { title: 'Ideas', message: 'Find ideas.', model: 'claude-sonnet-5-5', effort: 'medium' });
    await mintedAgentToken(s.data, owner.id); // its first turn (it ends at once: there is no Claude here)
    // A wake starts a turn, which mints a new token: post once that turn is over, with the token it left.
    const asOwner = async (path: string, body: object) => {
      await until(`#${owner.number} idle`, async () => (await s.call(`/api/tickets/${owner.id}`)).data.ticket.status !== 'running');
      const r = await fetch(`${s.base}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${agentToken(s.data, owner.id)}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      return { status: r.status, data: await json<{ id: string; error?: string }>(r) };
    };
    const handoffs = join(s.data, 'projects', String(p.id), 'shared', 'project', 'handoffs');
    mkdirSync(handoffs, { recursive: true });
    for (const n of ['a', 'b', 'c', 'd', 'my e']) writeFileSync(join(handoffs, `${n}.md`), `# Handoff ${n}\n\n## Goal\nDo ${n}.\n`);
    const card = (opts: object[], extra: object = {}) => asOwner(`/api/tickets/${owner.id}/questions`, { questions: [{ question: 'Which to start?', multiSelect: true, options: opts }], not_duplicate: true, ...extra });
    const opt = (n: string, start: object, recommended = false) => ({ label: `Start ${n}`, ...(recommended ? { recommended: true } : {}), start: { handoff: join(handoffs, `${n}.md`), title: `Do ${n}`, type: 'feature', ...start } });
    const none = { label: 'None of these' };
    const posted = async (opts: object[]) => {
      const r = await card(opts);
      assert.equal(r.status, 201, JSON.stringify(r.data));
      return r.data.id;
    };

    // Refused when posted: a missing handoff, a model or a tier off the table, a start on a ship card, a file outside the
    // shared folder, and a path with a space (the brief's readers end a path there).
    assert.equal((await card([{ ...opt('a', {}, true), start: { handoff: join(handoffs, 'gone.md'), title: 'x', type: 'feature' } }, none])).status, 400);
    assert.equal((await card([opt('a', { model: 'gpt-9' }, true), none])).status, 400);
    const tier = await card([opt('a', { model: 'claude-fable-5-2', effort: 'max' }, true), none]);
    assert.equal(tier.status, 400);
    assert.match(String(tier.data.error), /isn't a tier of the model table/);
    assert.equal((await card([opt('a', {}, true), none], { kind: 'ship' })).status, 400);
    assert.equal((await card([opt('a', { handoff: '/etc/passwd' }, true), none])).status, 400, 'only a file in the shared folder');
    assert.equal((await card([opt('my e', {}, true), none])).status, 400, 'no spaces in the path');

    // A plain pick, by Josh: both picked options start; the owner and the Taskmaster hear it as held mail. Its state try
    // (a person trying something) keeps it open (#2175).
    assert.equal((await s.call(`/api/tickets/${owner.id}`, { state: 'try' }, 'PATCH')).status, 200);
    const ok = await posted([opt('a', { model: 'claude-sonnet-5-5', effort: 'medium' }, true), opt('b', { handoff: 'handoffs/b.md' }), none]);
    assert.equal(await asJosh(`/api/tickets/${owner.id}/answer`, { questionId: ok, answers: [{ selected: ['Start a', 'Start b'] }] }), 202);
    const db = new DatabaseSync(join(s.data, 'coordinator.db'), { readOnly: true, timeout: 30_000 });
    try {
      const minion = (title: string) => db.prepare('SELECT * FROM tickets WHERE title = ? AND project_id = ?').get(title, p.id) as unknown as Row | undefined;
      const a = minion('Do a')!;
      const b = minion('Do b')!;
      assert.ok(a && b, 'both started');
      assert.equal(a.parent, owner.number, "the card's owner is its parent");
      assert.notEqual(minion('Ideas')!.person_id, josh.id, "the card's owner is someone else's");
      assert.equal(a.person_id, josh.id, 'it runs on the login of the person who picked');
      assert.deepEqual([a.model, a.effort], ['claude-sonnet-5-5', 'medium'], "the card's model");
      assert.deepEqual([b.model, b.effort], ['claude-opus-5-5', 'high'], "left out: the table's pick for a feature");
      const brief = JSON.parse(((await s.call(`/api/tickets/${a.id}/events?after=0`)).data as Ev[]).find((e) => e.kind === 'user_message')!.data);
      assert.equal(brief.text, `Start from the handoff ${join(handoffs, 'a.md')}`);
      assert.equal(brief.author, 'Josh', 'its first turn is asked by the picker');
      const held = async (id: number) => ((await s.call(`/api/tickets/${id}`)).data.ticket.held_mail as Held)?.items ?? [];
      assert.ok(
        (await held(owner.id)).some((m) => m.text.includes(`Citadel started #${a.number} Do a`)),
        'the owner hears it as held mail',
      );
      assert.notEqual((await s.call(`/api/tickets/${owner.id}`)).data.ticket.status, 'closed', 'state try keeps it open');
      const events = (await s.call(`/api/tickets/${owner.id}/events?after=0`)).data as Ev[];
      assert.ok(
        events.some((e) => e.kind === 'note' && JSON.parse(e.data).text.includes(`#${a.number} Do a`)),
        'a note in its chat says what started',
      );
      const tm = (await s.call(`/api/projects/${p.id}`)).data.coordinator;
      assert.ok(
        (await held(tm.id)).some((m) => m.text.includes(`#${a.number} Do a`)),
        "the Taskmaster's held mail names what started",
      );

      // The same handoff again, on a new card: refused, and the owner is woken with why.
      const again = await posted([opt('a', {}, true), none]);
      assert.equal(await asJosh(`/api/tickets/${owner.id}/answer`, { questionId: again, answers: [{ selected: ['Start a'] }] }), 202);
      assert.equal((db.prepare("SELECT count(*) AS n FROM tickets WHERE title = 'Do a'").get() as { n: number }).n, 1, 'no second minion from one handoff');
      assert.match(answerTo((await s.call(`/api/tickets/${owner.id}/events?after=0`)).data, again), /Not started: Do a: .*already started from .*ask your Taskmaster to start it/);

      // A handoff deleted after its card was posted: refused at the pick.
      const gone = await posted([opt('d', {}, true), none]);
      rmSync(join(handoffs, 'd.md'));
      assert.equal(await asJosh(`/api/tickets/${owner.id}/answer`, { questionId: gone, answers: [{ selected: ['Start d'] }] }), 202);
      assert.equal(minion('Do d'), undefined);
      assert.match(answerTo((await s.call(`/api/tickets/${owner.id}/events?after=0`)).data, gone), /Not started: Do d: .*does not exist/);

      // A typed note with the pick: nothing starts, the owner is woken as before.
      const noted = await posted([opt('c', {}, true), none]);
      assert.equal(await asJosh(`/api/tickets/${owner.id}/answer`, { questionId: noted, answers: [{ selected: ['Start c'], other: 'but only the first half' }] }), 202);
      assert.equal(minion('Do c'), undefined, 'a note may change the brief: nothing started');
      assert.match(answerTo((await s.call(`/api/tickets/${owner.id}/events?after=0`)).data, noted), /started nothing by itself/);
    } finally {
      db.close();
    }
  } finally {
    await s.stop();
  }
});

test('an all-started pick dismisses its owner when nothing is left for people, and not while another card waits (#2175)', async () => {
  const s = await bootServer();
  try {
    const { data: p } = await s.call('/api/projects', { name: 'Delve' });
    const { data: owner } = await s.call(`/api/projects/${p.id}/tickets`, { title: 'Ideas', message: 'Find ideas.', model: 'claude-sonnet-5-5', effort: 'medium' });
    await mintedAgentToken(s.data, owner.id);
    const asOwner = async (path: string, body: object) => {
      await until(`#${owner.number} idle`, async () => (await s.call(`/api/tickets/${owner.id}`)).data.ticket.status !== 'running');
      const r = await fetch(`${s.base}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${agentToken(s.data, owner.id)}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      return json<{ id: string }>(r);
    };
    const handoffs = join(s.data, 'projects', String(p.id), 'shared', 'project', 'handoffs');
    mkdirSync(handoffs, { recursive: true });
    for (const n of ['a', 'b']) writeFileSync(join(handoffs, `${n}.md`), `# Handoff ${n}\n\n## Goal\nDo ${n}.\n`);
    const card = async (n: string) => (await asOwner(`/api/tickets/${owner.id}/questions`, { questions: [{ question: `Start ${n}?`, options: [{ label: `Start ${n}`, recommended: true, start: { handoff: join(handoffs, `${n}.md`), title: `Do ${n}`, type: 'feature' } }, { label: 'No' }] }], not_duplicate: true })).id;
    const pick = (q: string, label: string) => s.call(`/api/tickets/${owner.id}/answer`, { questionId: q, answers: [{ selected: [label] }] });
    const view = async () => (await s.call(`/api/tickets/${owner.id}`)).data.ticket as { status: string; held_mail: Held };
    const notes = async () => ((await s.call(`/api/tickets/${owner.id}/events?after=0`)).data as Ev[]).filter((e) => e.kind === 'note').map((e) => String(JSON.parse(e.data).text));

    const first = await card('a');
    const second = await card('b');
    // Its own turn ran on /bin/false and failed, so it waits for its one retry (#2258), and an owed turn rightly keeps
    // a minion open: stop that, as a person would, so only the cards decide here.
    const errors = async () => ((await s.call(`/api/tickets/${owner.id}/events?after=0`)).data as Ev[]).filter((e) => e.kind === 'error').map((e) => String(JSON.parse(e.data).text));
    await until('the failed turn waits for its retry', async () => (await errors()).some((t) => t.includes('retries it by itself once')));
    assert.equal((await s.call(`/api/tickets/${owner.id}/stop`, {})).status, 200);
    assert.equal((await s.call(`/api/tickets/${owner.id}`, { state: 'ready', note: 'pick one' }, 'PATCH')).status, 200);
    // Another card still waits: kept open, with today's held mail.
    assert.equal((await pick(first, 'Start a')).status, 202);
    assert.notEqual((await view()).status, 'closed', 'another card still waits on people');
    assert.ok(
      (await view()).held_mail?.items.some((m) => m.text.includes('Citadel started #')),
      'held mail as before',
    );
    // The last card's pick starts everything, and nothing else is left: dismissed, with a note naming what started.
    assert.equal((await pick(second, 'Start b')).status, 202);
    await until('the owner dismissed', async () => (await view()).status === 'closed');
    const db = new DatabaseSync(join(s.data, 'coordinator.db'), { readOnly: true, timeout: 30_000 });
    const b = db.prepare('SELECT number FROM tickets WHERE title = ? AND project_id = ?').get('Do b', p.id) as { number: number };
    db.close();
    const closing = (await notes()).find((t) => t.includes('so the server dismissed this minion'));
    assert.match(closing ?? '', /^Every pick on its card started, so the server dismissed this minion: #\d+ Do b \(/);
    assert.ok(closing?.includes(`#${b.number} Do b`), 'it names what started');
  } finally {
    await s.stop();
  }
});

test('leftForPeople keeps an owner open for its state, a turn, a card, a lead, and work on its branch not on main (#2175)', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'left-'));
  try {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
    git('init', '-q', '-b', 'main');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'base');
    git('worktree', 'add', '-q', '-b', 'ticket/1', join(repo, 'wt'));
    const wt = join(repo, 'wt');
    const base = { id: 1, kind: 'ticket', status: 'idle', state: 'ready', project_id: 1, build: null, branch: 'ticket/1', cwd: wt, created_at: Date.now() - 60_000 } as Ticket;
    let t: Ticket = { ...base };
    const seen = { running: false, kept: null as string | null, cabal: false, owner: null as number | null };
    const app: Parameters<typeof leftForPeople>[0] = {
      store: { getTicket: () => t, getProject: () => ({ repo_dir: repo }) as Project, getCabal: () => (seen.cabal ? ({} as CabalRow) : undefined), getSetting: <T>() => seen.owner as T | null },
      runner: { busy: () => seen.running, keptOpen: () => seen.kept },
    };
    assert.equal(await leftForPeople(app, 1), null, 'ready, idle, no card, a branch with nothing of its own: nothing left');
    for (const state of ['try', 'pending-deploy', 'parked', 'outside']) {
      t = { ...base, state: state as Ticket['state'] };
      assert.match((await leftForPeople(app, 1)) ?? '', new RegExp(`state is ${state}`), state);
    }
    t = { ...base, state: null };
    assert.equal(await leftForPeople(app, 1), null, 'no state is fine too');
    seen.running = true;
    assert.ok(await leftForPeople(app, 1), 'a turn running or owed');
    seen.running = false;
    seen.kept = 'a question card is still waiting on people';
    assert.equal(await leftForPeople(app, 1), seen.kept, 'another card');
    seen.kept = null;
    seen.cabal = true;
    assert.match((await leftForPeople(app, 1)) ?? '', /leads/, 'a cabal lead');
    seen.cabal = false;
    t = { ...base, build: 7 };
    seen.owner = 1;
    assert.match((await leftForPeople(app, 1)) ?? '', /leads/, "a build's own minion");
    seen.owner = null;
    // A Plot member that isn't its lead is mid-job (#2314): a feeder closes itself on merge, so one still here has work owed.
    assert.match((await leftForPeople(app, 1)) ?? '', /Plot member/, 'a Plot member');
    t = { ...base };
    writeFileSync(join(wt, 'x.txt'), 'x');
    execFileSync('git', ['add', 'x.txt'], { cwd: wt });
    assert.match((await leftForPeople(app, 1)) ?? '', /not committed/, 'uncommitted work');
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'work'], { cwd: wt });
    assert.match((await leftForPeople(app, 1)) ?? '', /commits main lacks/, 'commits not on main');
    git('merge', '-q', '--ff-only', 'ticket/1');
    assert.equal(await leftForPeople(app, 1), null, 'once main has them, nothing is left');
    // A git that can't answer keeps it open (fail closed): a branch whose ref git can't read, a worktree gone.
    t = { ...base, cwd: join(repo, 'gone') };
    assert.match((await leftForPeople(app, 1)) ?? '', /couldn't read its worktree/);
    const store = app.store;
    app.store = { ...store, getProject: () => ({ repo_dir: join(repo, 'not-a-repo') }) as Project };
    assert.match((await leftForPeople(app, 1)) ?? '', /couldn't read its branch/);
    app.store = store;
    t = { ...base, branch: 'ticket/never-made' };
    assert.equal(await leftForPeople(app, 1), null, 'a branch never made has nothing of its own');
  } finally {
    rmSync(repo, { recursive: true, force: true }); // timing-ok: own temp dir
  }
});
