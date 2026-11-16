import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { check } from '../src/link-check.ts';
import { linkCheckHooks } from '../src/turn-launch.ts';
import { testPins } from './helpers.ts';

const { LINK_CHECK } = testPins();

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
  // The one file of that name the chat can show is named, so the rewrite gets it right (#281).
  assert.ok(v.reason.includes(`Did you mean ${join(mine, 'people-desktop.png')}?`), v.reason);
});

test('with no file of that name, or several, the send-back names no guess (#281)', async () => {
  assert.doesNotMatch((await reply('![x](gone/nothing.png)'))?.reason ?? '', /Did you mean/);
  writeFileSync(join(work, 'docs/handoff.md'), 'x');
  try {
    const v = await reply('[h](../handoff.md)');
    assert.equal(v?.decision, 'block');
    assert.doesNotMatch(v.reason, /Did you mean/);
  } finally {
    rmSync(join(work, 'docs/handoff.md'));
  }
});

test('absolute links and correct relative ones pass', async () => {
  assert.equal(await reply(`![desktop](${mine}/people-desktop.png) [plan](docs/plan.md) [handoff](${scheme}/handoff.md)`), null);
  assert.equal(await reply('![desktop](../../shared/268/people-desktop.png) [plan](./docs/plan.md#goals)'), null);
});

test('a file outside the folders the chat can show blocks too', async () => {
  const v = await reply(`[x](${root}/outside/x.png)`);
  assert.match(v?.reason ?? '', /outside the folders the chat can show/);
});

test('the hidden status line (#711) is not checked, the reply above it is', async () => {
  const status = `<!-- status: {"state":"ready","note":"see [x](${root}/outside/x.png)"} -->`;
  assert.equal(await reply(`Shipped.\n${status}`), null);
  assert.equal(await reply(status), null);
  assert.equal((await reply(`[x](${root}/outside/x.png)\n${status}`))?.decision, 'block');
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

test('one nudge per prompt, counted by its own marker, not by another hook\'s stop_hook_active (#243)', async () => {
  const nudged = join(root, 'turn-243', 'link-check-nudged');
  mkdirSync(join(root, 'turn-243'));
  const once = { ...cfg, nudged };
  const bad = { last_assistant_message: '![x](../shared/project/handoff.md)', prompt_id: 'p1' };
  // Good links leave no marker, so a later bad reply in the same turn still gets its nudge.
  assert.equal(await check({ last_assistant_message: `[h](${scheme}/handoff.md)`, prompt_id: 'p1' }, once), null);
  assert.equal(existsSync(nudged), false);
  // The job check blocked earlier this turn, so stop_hook_active is already true: still nudged.
  assert.equal((await check({ ...bad, stop_hook_active: true }, once))?.decision, 'block');
  assert.equal(existsSync(nudged), true);
  // The rewrite that's still broken ends the turn rather than looping.
  assert.equal(await check({ ...bad, stop_hook_active: true }, once), null);
  assert.equal(await check(bad, once), null);
  // A message steered into the same turn is a new prompt, with its own nudge.
  assert.equal((await check({ ...bad, prompt_id: 'p2' }, once))?.decision, 'block');
  assert.equal(await check({ ...bad, prompt_id: 'p2', stop_hook_active: true }, once), null);
  // Without a prompt id, one nudge for the turn.
  rmSync(nudged);
  assert.equal((await check({ last_assistant_message: bad.last_assistant_message }, once))?.decision, 'block');
  assert.equal(await check({ last_assistant_message: bad.last_assistant_message }, once), null);
});

test('the hook script prints a block decision, or nothing', () => {
  const [node, script, config] = linkCheckHooks(cfg.roots).Stop[0].hooks[0].command.split(' ').map((s: string) => s.slice(1, -1));
  assert.equal(script, LINK_CHECK);
  assert.deepEqual(JSON.parse(config), cfg);
  const run = (input: object | string, c = config) => spawnSync(node, [script, c], { input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8' });
  // As the runner wires it, with the turn's marker: the second stop of the prompt ends.
  const nudged = join(root, 'script-nudged');
  const withMarker = linkCheckHooks(cfg.roots, LINK_CHECK, nudged).Stop[0].hooks[0].command.split(' ')[2].slice(1, -1);
  const again = { hook_event_name: 'Stop', stop_hook_active: true, prompt_id: 'p', last_assistant_message: '![x](../shared/268/people-desktop.png)' };
  assert.equal(JSON.parse(run(again, withMarker).stdout).decision, 'block');
  assert.deepEqual([existsSync(nudged), run(again, withMarker).stdout], [true, '']);
  const blocked = run({ hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: '![x](../shared/268/people-desktop.png)' });
  assert.equal(blocked.status, 0);
  assert.equal(JSON.parse(blocked.stdout).decision, 'block');
  const ok = run({ hook_event_name: 'Stop', last_assistant_message: '![x](../../shared/268/people-desktop.png)' });
  assert.deepEqual([ok.status, ok.stdout], [0, '']);
  // A check that can't run never holds up the turn.
  assert.deepEqual([run('{bad').status, run('{bad').stdout], [0, '']);
  assert.deepEqual([run({ last_assistant_message: '![x](a.png)' }, '{bad').stdout], ['']);
});

test('a linked page with its own clipboard or send button is sent back; a kit page passes (#417)', async () => {
  const kit = '<link rel="stylesheet" href="mockkit.css"><script src="mockkit.js"></script><script>mock.picks({ collection: "picks" });</script>';
  writeFileSync(join(mine, 'kit.html'), kit);
  // The kit's own script sends and copies; that's the one way to.
  writeFileSync(join(mine, 'mockkit.js'), 'await window.citadel.send(body); document.execCommand("copy")');
  assert.equal(await reply(`[takes](${mine}/kit.html)`), null);
  // A button of its own in a script beside the page counts.
  writeFileSync(join(mine, 'answers.js'), 'navigator.clipboard.writeText(t)');
  writeFileSync(join(mine, 'split.html'), '<script src="answers.js"></script>');
  assert.equal((await reply(`[takes](${mine}/split.html)`))?.decision, 'block');
  for (const [name, js] of [['clip', 'navigator.clipboard.writeText(t)'], ['exec', "document.execCommand('copy')"], ['send', 'await window.citadel.send(picksText())']]) {
    writeFileSync(join(mine, `${name}.html`), `<button id="send">Send</button><script>${js}</script>`);
    const v = await reply(`[takes](${mine}/${name}.html) and [plan](docs/plan.md)`);
    assert.equal(v?.decision, 'block', name);
    assert.ok(v.reason.includes(`- ${join(mine, `${name}.html`)}`), v.reason);
    assert.match(v.reason, /mock kit's Send dock/);
    assert.doesNotMatch(v.reason, /won't open/, 'the other link is fine');
  }
  // A page named in code is no link.
  assert.equal(await reply(`\`${mine}/clip.html\``), null);
});

test('a linked choices page with no card that opens it is sent back; its card, open or settled, lets it through (#804)', async () => {
  writeFileSync(join(mine, 'takes.html'), '<title>Takes</title><script src="mockkit.js"></script><script>mock.boards([]);</script>');
  writeFileSync(join(mine, 'plain.html'), '<p>no picks</p>');
  const refsFile = join(root, 'refs-804.json');
  const withCards = (cards: object[], settled: object[] = []) => {
    writeFileSync(refsFile, JSON.stringify({ scheme: 'Citadel', others: [], minions: {}, self: 268, cards, settled }));
    return check({ last_assistant_message: `Pick in [the takes](${mine}/takes.html), or read [this](${mine}/plain.html).` }, { ...cfg, refs: refsFile });
  };
  const v = await withCards([]);
  assert.equal(v?.decision, 'block');
  assert.ok(v.reason.includes(`- ${join(mine, 'takes.html')}`), v.reason);
  assert.match(v.reason, /ask_question with doc set to the page's path/);
  assert.ok(!v.reason.includes('plain.html'), 'a page with no pick bars needs no card');
  const card = { minion: 268, kind: 'question', label: 'picks on “Takes”', href: '#/p/2/t/268?e=5', doc: join(mine, 'takes.html') };
  assert.equal(await withCards([card]), null);
  assert.equal(await withCards([], [{ ...card, how: 'picks sent by Cara at 2:31am' }]), null);
  // Another page's card doesn't count.
  assert.equal((await withCards([{ ...card, doc: join(mine, 'other.html') }]))?.decision, 'block');
});

test('a reply that asks a choice in prose with no card this turn is sent back; a card, a button, a quote or code lets it through', async () => {
  const line = (o: object) => JSON.stringify(o);
  const user = line({ type: 'user', message: { role: 'user', content: 'hi' } });
  const tool = (name: string) => line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name, input: {} }] } });
  const result = line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } });
  let n = 0;
  const ask = (text: string, ...transcript: string[]) => {
    const transcript_path = join(root, `t-${n++}.jsonl`);
    writeFileSync(transcript_path, [user, ...transcript].join('\n'));
    return check({ last_assistant_message: text, transcript_path }, cfg);
  };
  const v = await ask('Done.\n\nWant a small minion to close that, or leave it until it actually bites?');
  assert.equal(v?.decision, 'block');
  assert.match(v.reason, /Want a small minion to close that/);
  assert.match(v.reason, /ask_question card/);
  assert.equal((await ask('Should a follow-up retry it once Claude is back?'))?.decision, 'block');
  assert.equal((await ask('Fixed.\n\nIf you want it, say the word.'))?.decision, 'block');
  // A card posted this turn, even before the last tool result, covers the question.
  assert.equal(await ask('Should I merge it?', tool('mcp__thread__ask_question'), result), null);
  assert.equal(await ask('Should I merge it?', tool('mcp__thread__propose_plan'), result), null);
  const meta = line({ type: 'user', isMeta: true, message: { role: 'user', content: 'Base directory for this skill' } });
  assert.equal(await ask('Should I merge it?', tool('mcp__thread__ask_question'), meta), null, 'a skill\'s meta entry is no new prompt');
  // A card from an earlier turn does not.
  const earlier = [tool('mcp__thread__ask_question'), result, user];
  assert.equal((await ask('Should I merge it?', ...earlier))?.decision, 'block');
  assert.equal(await ask('Should I merge it?\n\nSee [the card below](#/p/2/t/9?e=4).'), null);
  assert.equal(await ask('Should I merge it?\n<!-- status: {"state":"ready","note":"x","replies":["Merge it"]} -->'), null);
  assert.equal(await ask('Picked Ctrl+`; nothing needed from you.'), null);
  assert.equal(await ask('Cara asked "should I merge it?" and I did.'), null);
  assert.equal(await ask('Notes:\n\n```\nshould I merge it?\n```'), null);
  // Only the last two paragraphs are read.
  assert.equal(await ask('Should I merge it?\n\nOne.\n\nTwo.\n\nThree.'), null);
  // KEEP and the once-per-prompt marker work as for the other findings.
  const marker = join(root, 'nudged-card');
  const p = join(root, 'tp.jsonl');
  writeFileSync(p, user);
  const input = { last_assistant_message: 'Should I merge it?', transcript_path: p, prompt_id: 'a' };
  assert.equal((await check(input, { ...cfg, nudged: marker }))?.decision, 'block');
  assert.equal(await check(input, { ...cfg, nudged: marker }), null);
  // No readable transcript: say nothing rather than guess.
  assert.equal(await check({ last_assistant_message: 'Should I merge it?' }, cfg), null);
});
