import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { bootServer, mintedAgentToken } from './helpers.ts';
import { json } from './typed.ts';

// A pick on a card starts the minion (#2050; Josh, 2026-11-25, picked "Start" on #2031's page; docs/adr/0038): an option's
// `start` makes the minion when a person picks it plainly, with no Taskmaster turn, as that person's, child of the card's owner.

type Ev = { id: number; kind: string; data: string };
type Row = { id: number; number: number; title: string; parent: number | null; person_id: number | null; model: string; effort: string; project_id: number };

test("a plain pick of a start option starts that minion as the picker's; a typed note or a used handoff starts nothing", async () => {
  const s = await bootServer();
  try {
    const { data: p } = await s.call('/api/projects', { name: 'Delve' }); // any scheme but Citadel's
    const { data: owner } = await s.call(`/api/projects/${p.id}/tickets`, { title: 'Ideas', message: 'Find ideas.', model: 'claude-sonnet-5-5', effort: 'medium' });
    // The token its first turn minted (that turn ends at once: there is no Claude here).
    const token = await mintedAgentToken(s.data, owner.id);
    const asOwner = (path: string, body: object) => fetch(`${s.base}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, data: await json<{ id: string; error?: string }>(r) }));
    const handoffs = join(s.data, 'projects', String(p.id), 'shared', 'project', 'handoffs');
    mkdirSync(handoffs, { recursive: true });
    for (const n of ['a', 'b', 'c']) writeFileSync(join(handoffs, `${n}.md`), `# Handoff ${n}\n\n## Goal\nDo ${n}.\n`);
    const card = (opts: object[], extra: object = {}) => asOwner(`/api/tickets/${owner.id}/questions`, { questions: [{ question: 'Which to start?', multiSelect: true, options: opts }], not_duplicate: true, ...extra });
    const opt = (n: string, start: object, recommended = false) => ({ label: `Start ${n}`, ...(recommended ? { recommended: true } : {}), start: { handoff: join(handoffs, `${n}.md`), title: `Do ${n}`, type: 'feature', ...start } });
    const none = { label: 'None of these' };

    // Refused when posted: a missing handoff, a model off the table, a start on a ship card.
    assert.equal((await card([{ ...opt('a', {}, true), start: { handoff: join(handoffs, 'gone.md'), title: 'x', type: 'feature' } }, none])).status, 400);
    assert.equal((await card([opt('a', { model: 'gpt-9' }, true), none])).status, 400);
    assert.equal((await card([opt('a', {}, true), none], { kind: 'ship' })).status, 400);
    assert.equal((await card([opt('a', { handoff: '/etc/passwd' }, true), none])).status, 400, 'only a file in the shared folder');

    // A plain pick: both picked options start, the owner hears it as held mail, the Taskmaster too.
    const ok = await card([opt('a', { model: 'claude-sonnet-5-5', effort: 'medium' }, true), opt('b', { handoff: 'handoffs/b.md' }), none]);
    assert.equal(ok.status, 201, JSON.stringify(ok.data));
    const pick = await s.call(`/api/tickets/${owner.id}/answer`, { questionId: ok.data.id, answers: [{ selected: ['Start a', 'Start b'] }] });
    assert.equal(pick.status, 202, JSON.stringify(pick.data));
    const db = new DatabaseSync(join(s.data, 'coordinator.db'), { readOnly: true });
    try {
      const made = (title: string) => db.prepare('SELECT * FROM tickets WHERE title = ? AND project_id = ?').get(title, p.id) as unknown as Row | undefined;
      const me = (db.prepare('SELECT id FROM users LIMIT 1').get() as { id: number }).id;
      const a = made('Do a')!;
      const b = made('Do b')!;
      assert.ok(a && b, 'both started');
      assert.equal(a.parent, owner.number, "the card's owner is its parent");
      assert.equal(a.person_id, me, 'it runs on the login of the person who picked');
      assert.deepEqual([a.model, a.effort], ['claude-sonnet-5-5', 'medium'], "the card's model");
      assert.deepEqual([b.model, b.effort], ['claude-opus-5-5', 'high'], "left out: the table's pick for a feature");
      const aEvents = (await s.call(`/api/tickets/${a.id}/events?after=0`)).data as Ev[];
      const brief = JSON.parse(aEvents.find((e) => e.kind === 'user_message')!.data);
      assert.equal(brief.text, `Start from the handoff ${join(handoffs, 'a.md')}`);
      assert.equal(brief.author, (db.prepare('SELECT name FROM users WHERE id = ?').get(me) as { name: string }).name, 'its first turn is asked by the picker');
      const view = (await s.call(`/api/tickets/${owner.id}`)).data.ticket;
      assert.ok(
        (view.held_mail?.items as { text: string }[] | undefined)?.some((m) => m.text.includes(`Citadel started #${a.number} Do a`)),
        'the owner hears it as held mail',
      );
      const events = (await s.call(`/api/tickets/${owner.id}/events?after=0`)).data as Ev[];
      assert.ok(
        events.some((e) => e.kind === 'note' && JSON.parse(e.data).text.includes(`#${a.number} Do a`)),
        'a note in its chat says what started',
      );
      const tm = (await s.call(`/api/projects/${p.id}`)).data.coordinator;
      const tmEvents = (await s.call(`/api/tickets/${tm.id}/events?after=0`)).data as Ev[];
      assert.ok(
        tmEvents.some((e) => e.data.includes(`#${a.number} Do a`)),
        'the Taskmaster gets mail naming what started',
      );

      // The same handoff again, on a new card: refused, and the owner is woken with why.
      const again = await card([opt('a', {}, true), none]);
      const twice = await s.call(`/api/tickets/${owner.id}/answer`, { questionId: again.data.id, answers: [{ selected: ['Start a'] }] });
      assert.equal(twice.status, 202);
      assert.equal((db.prepare("SELECT count(*) AS n FROM tickets WHERE title = 'Do a'").get() as { n: number }).n, 1, 'no second minion from one handoff');
      const woke = (await s.call(`/api/tickets/${owner.id}/events?after=0`)).data as Ev[];
      assert.match(woke.filter((e) => e.kind === 'user_message').at(-1)!.data, /Not started: Do a: .*already started from/);

      // A typed note with the pick: nothing starts, the owner is woken as before.
      const noted = await card([opt('c', {}, true), none]);
      await s.call(`/api/tickets/${owner.id}/answer`, { questionId: noted.data.id, answers: [{ selected: ['Start c'], other: 'but only the first half' }] });
      assert.equal(made('Do c'), undefined, 'a note may change the brief: nothing started');
      const last = (await s.call(`/api/tickets/${owner.id}/events?after=0`)).data as Ev[];
      assert.match(last.filter((e) => e.kind === 'user_message').at(-1)!.data, /started nothing by itself/);
    } finally {
      db.close();
    }
  } finally {
    await s.stop();
  }
});
