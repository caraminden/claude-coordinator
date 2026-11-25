// Drills 2 and 7 (#1326): a turn's processes killed under a live server (the OOM killer on Nov 20), and a turn that
// died while no server watched it, with text in its stream no server had read.
import assert from 'node:assert/strict';
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { until } from '../helpers.ts';
import { Drill, gap, timedOut } from './harness.ts';

const d = new Drill('turn-kill');
after(() => d.cleanup());
const kill = (pid: number) => {
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Already gone.
  }
};
// A1 (fixed in #1364): a turn whose process was killed while the server ran resumes once by itself.
// A1: a turn whose process was killed while the server ran is written off (status error), never resumed.
test('a turn whose wrapper is SIGKILLed is resumed and finishes', async () => {
  await d.boot();
  const p = await d.project();
  const id = await d.minion(p.id);
  const dir = await until('the turn started', () => d.turnDir(id));
  kill(d.pids(dir).wrapper);
  await until('the server saw the turn end', () => d.status(id) !== 'running');
  const ended = d.status(id);
  d.fake.setRelease('ok');
  // A resumed turn's fake answers at once; the killed turn's orphaned claude writes to a stream no one reads.
  await until('a reply', () => d.stream(id, 'result').length > 0, 20_000).catch((e) => {
    if (!timedOut(e)) throw e;
    assert.equal(ended, 'error', `the killed turn was neither resumed nor written off (status ${ended})`);
    assert.fail(`A1: the killed turn was written off (status ${ended}), not resumed`);
  });
});

// C8: at boot, a turn with no process and no exit.json is cleared without reading its stream.
test('a turn that died while the server was down keeps the text it wrote meanwhile', async () => {
  d.fake.setRelease(null);
  if (!d.srv) await d.boot();
  const p = await d.project('Vanished');
  const id = await d.minion(p.id);
  const dir = await until('the turn started', () => d.turnDir(id));
  await d.crash();
  // While no server reads it, claude writes a reply, then the turn is killed before it ends (no result, no exit.json).
  const words = 'Words written while the server was down.';
  appendFileSync(join(dir, 'stream.jsonl'), `${JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: words }] } })}\n`);
  const { wrapper, claude } = d.pids(dir);
  kill(wrapper);
  kill(-claude);
  await until('the turn gone', () => {
    try {
      return !readFileSync(`/proc/${wrapper}/cmdline`, 'utf8').includes(dir);
    } catch {
      return true;
    }
  });
  await d.boot();
  // Recovery's note on the cut-off turn (resumed, or why not) comes after anything it read from the stream.
  await until('the boot took the turn up', () => d.notes(id).some((n) => /restart/.test(n)));
  const said = d.stream(id, 'assistant').flatMap((m) => m.message!.content.map((c) => c.text));
  assert.ok(said.includes(words), `C8: the turn's last text was dropped; its chat ends: ${JSON.stringify(d.notes(id).at(-1))}`);
});
