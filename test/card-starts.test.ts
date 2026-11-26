import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
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

    // A plain pick, by Josh: both picked options start; the owner and the Taskmaster hear it as held mail.
    const ok = await posted([opt('a', { model: 'claude-sonnet-5-5', effort: 'medium' }, true), opt('b', { handoff: 'handoffs/b.md' }), none]);
    assert.equal(await asJosh(`/api/tickets/${owner.id}/answer`, { questionId: ok, answers: [{ selected: ['Start a', 'Start b'] }] }), 202);
    const db = new DatabaseSync(join(s.data, 'coordinator.db'), { readOnly: true });
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
      assert.match(answerTo((await s.call(`/api/tickets/${owner.id}/events?after=0`)).data, again), /Not started: Do a: .*already started from/);

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
