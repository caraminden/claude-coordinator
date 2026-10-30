import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { check } from '../src/link-check.ts';
import { LINK_CHECK, linkCheckHooks } from '../src/runner.ts';

// A scheme's folders as the runner lays them out: a minion's worktree, its shared folder and the scheme's.
const root = mkdtempSync(join(tmpdir(), 'link-check-'));
after(() => rmSync(root, { recursive: true, force: true }));
const work = join(root, 'projects/2/tickets/268');
const mine = join(root, 'projects/2/shared/268');
const scheme = join(root, 'projects/2/shared/project');
for (const dir of [join(work, 'docs'), mine, scheme, join(root, 'outside')]) mkdirSync(dir, { recursive: true });
for (const f of [join(work, 'docs/plan.md'), join(mine, 'people-desktop.png'), join(scheme, 'handoff.md'), join(root, 'outside/x.png')]) writeFileSync(f, 'x');
const cfg = { cwd: work, roots: [work, mine, scheme] };
const reply = (text: string, more = {}) => check({ last_assistant_message: text, ...more }, cfg);

test('a wrong-depth ../shared link blocks the stop, naming where it landed', async () => {
  const v = await reply('Done. ![desktop](../shared/268/people-desktop.png)');
  assert.equal(v?.decision, 'block');
  assert.ok(v.reason.includes(join(root, 'projects/2/tickets/shared/268/people-desktop.png')), v.reason);
  assert.match(v.reason, /no such file/);
  assert.ok(v.reason.includes(work), 'says what relative links resolve against');
});

test('absolute links and correct relative ones pass', async () => {
  assert.equal(await reply(`![desktop](${mine}/people-desktop.png) [plan](docs/plan.md) [handoff](${scheme}/handoff.md)`), null);
  assert.equal(await reply('![desktop](../../shared/268/people-desktop.png) [plan](./docs/plan.md#goals)'), null);
});

test('a file outside the folders the chat can show blocks too', async () => {
  const v = await reply(`[x](${root}/outside/x.png)`);
  assert.match(v?.reason ?? '', /outside the folders the chat can show/);
});

test('web links, in-app routes, code and non-file links are left alone', async () => {
  assert.equal(await reply('[a](https://x.dev/missing.png) [b](#/p/2/t/3) [src](src/runner.ts) [dir](docs/)'), null);
  assert.equal(await reply('Write `![caption](../shared/1/x.png)` like this:\n```md\n[t](nope/gone.html)\n```\nand stop.'), null);
  assert.equal(await reply('```md\n\nfirst\n[u](b.md)\n```\n~~~\n![i](a.png)\n~~~\nand an unclosed one:\n```\nx\n[v](c.md)'), null);
  // Only code is skipped: a link after a fence, or after an empty one, is still checked.
  assert.equal((await reply('```\n```\n```md\n[t](x.md)\n```\n![x](../shared/268/people-desktop.png)'))?.decision, 'block');
});

test('stop_hook_active lets the turn end, and so does a reply with no text', async () => {
  assert.equal(await reply('![x](../shared/268/people-desktop.png)', { stop_hook_active: true }), null);
  assert.equal(await check({}, cfg), null);
});

test('the hook script prints a block decision, or nothing', () => {
  const [node, script, config] = linkCheckHooks(cfg.roots).Stop[0].hooks[0].command.split(' ').map((s: string) => s.slice(1, -1));
  assert.equal(script, LINK_CHECK);
  assert.deepEqual(JSON.parse(config), cfg);
  const run = (input: object | string, c = config) => spawnSync(node, [script, c], { input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8' });
  const blocked = run({ hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: '![x](../shared/268/people-desktop.png)' });
  assert.equal(blocked.status, 0);
  assert.equal(JSON.parse(blocked.stdout).decision, 'block');
  const ok = run({ hook_event_name: 'Stop', last_assistant_message: '![x](../../shared/268/people-desktop.png)' });
  assert.deepEqual([ok.status, ok.stdout], [0, '']);
  // A check that can't run never holds up the turn.
  assert.deepEqual([run('{bad').status, run('{bad').stdout], [0, '']);
  assert.deepEqual([run({ last_assistant_message: '![x](a.png)' }, '{bad').stdout], ['']);
});
