// A deployed contraption's to-dos (#418) reach its home scheme's Taskmaster once per new list.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deployTodo } from '../src/routes/contraptions.ts';

test("a deploy's to-dos go to the home Taskmaster once per list, after a home scheme is set, and again after a clean deploy", async () => {
  const sent: { to: number; author: string; text: string; asker: unknown }[] = [];
  let fail = false;
  const app = {
    dataDir: '/nonexistent',
    store: { getProject: (id: number) => (id === 5 ? { id: 5, name: 'Transdata' } : undefined), getCoordinator: () => ({ id: 50 }) },
    runner: { send: (to: number, author: string, text: string, _i: unknown, extra: any) => { if (fail) throw new Error('down'); sent.push({ to, author, text, asker: extra.asker }); } },
  } as any;
  const c = (home: number | null) => ({ name: 'td', title: 'Transdata', home_scheme: home }) as any;
  const minion = { kind: 'ticket', project_id: 5 } as any;
  const todo = ['It has no rail icon', 'Its page has no <link rel="manifest">'];

  // No home scheme yet: nothing sent, and nothing remembered, so setting one later still sends.
  await deployTodo(app, c(null), minion, 7, todo);
  assert.equal(sent.length, 0);
  await deployTodo(app, c(5), minion, 7, todo);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 50);
  assert.equal(sent[0].asker, 7, 'runs as the person who deployed');
  assert.match(sent[0].text, /To do for Transdata \(td\).*\n- It has no rail icon\n- Its page has no <link rel="manifest">/);
  // The same list again wakes no one; a changed one does.
  await deployTodo(app, c(5), minion, 7, todo);
  assert.equal(sent.length, 1);
  await deployTodo(app, c(5), minion, 7, todo.slice(1));
  assert.equal(sent.length, 2);
  // Its own Taskmaster deployed it: its tool answer has them already.
  await deployTodo(app, c(5), { kind: 'coordinator', project_id: 5 } as any, 7, todo);
  assert.equal(sent.length, 2);
  // A failed send isn't remembered, so the next deploy tries again.
  fail = true;
  await assert.rejects(deployTodo(app, c(5), null, 7, todo), /down/);
  fail = false;
  await deployTodo(app, c(5), null, 7, todo);
  assert.equal(sent.length, 3);
  // All done, then the same problem back: sent again.
  await deployTodo(app, c(5), null, 7, []);
  await deployTodo(app, c(5), null, 7, todo);
  assert.equal(sent.length, 4);
});
