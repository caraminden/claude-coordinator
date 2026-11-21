// Two agents with the same token (#468 S09-3): the app keeps the newer and tells the older why it was dropped. The older
// one must not reconnect at once, or the two drop each other once a second for as long as both run.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { REPO, tempRoot, until, holds } from './helpers.ts';

const tmp = tempRoot('agent-replaced-');
after(() => tmp.teardown());

/** An app whose first connect says hello and then that another agent took over; later connects just stay open. */
async function replacingApp() {
  const state = { connects: 0 };
  const srv = createServer((req, res) => {
    req.resume();
    if (req.url!.startsWith('/api/machines/connect')) {
      state.connects++;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ hello: 'box' })}\n\n`);
      if (state.connects === 1) res.end(`data: ${JSON.stringify({ replaced: true, by: 'other-pc' })}\n\n`);
      return;
    }
    res.writeHead(202).end('{}');
  });
  const port = await tmp.serve(srv);
  return { base: `http://127.0.0.1:${port}`, state };
}

async function run(args: string[]) {
  const app = await replacingApp();
  const proc = tmp.spawn(process.execPath, [args[0], app.base, ...args.slice(1)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  proc.stdout!.on('data', (d) => (out += d));
  proc.stderr!.on('data', (d) => (out += d));
  await until('it is told', () => /another agent/.test(out), 10_000);
  // Before, it reconnected after 1 s.
  await holds('it does not reconnect at once', () => app.state.connects === 1, { ms: 1600 });
  return { connects: app.state.connects, out };
}

test('a machine agent told another agent took over says so and does not reconnect at once', async () => {
  const { connects, out } = await run([join(REPO, 'public/machine-agent.mjs'), 'ccm_1_x', '--', process.execPath, '-e', '0']);
  assert.equal(connects, 1, out);
  assert.match(out, /another agent connected with this machine's token, from other-pc/);
});

test('a runner agent told another agent took over says so and does not reconnect at once', async () => {
  const tokenFile = tmp.path('token');
  writeFileSync(tokenFile, 'ccm_1_x\n');
  const { connects, out } = await run([join(REPO, 'public/runner-agent.mjs'), '--token-file', tokenFile]);
  assert.equal(connects, 1, out);
  assert.match(out, /another agent connected with this machine's token, from other-pc/);
});
