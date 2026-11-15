// Two agents with the same token (#468 S09-3): the app keeps the newer and tells the older why it was dropped. The older
// one must not reconnect at once, or the two drop each other once a second for as long as both run.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { REPO, stopProcs, until } from './helpers.ts';

const root = mkdtempSync(join(tmpdir(), 'agent-replaced-'));
const procs: ChildProcess[] = [];
const servers: ReturnType<typeof createServer>[] = [];
after(async () => {
  await stopProcs(procs);
  for (const s of servers) s.closeAllConnections(), s.close();
  rmSync(root, { recursive: true, force: true });
});

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
  servers.push(srv);
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, state };
}

async function run(args: string[]) {
  const app = await replacingApp();
  const proc = spawn(process.execPath, [args[0], app.base, ...args.slice(1)], { stdio: ['ignore', 'pipe', 'pipe'] });
  procs.push(proc);
  let out = '';
  proc.stdout!.on('data', (d) => (out += d));
  proc.stderr!.on('data', (d) => (out += d));
  await until('it is told', () => /another agent/.test(out), 10_000);
  // Before, it reconnected after 1 s.
  await new Promise((r) => setTimeout(r, 1600));
  return { connects: app.state.connects, out };
}

test('a machine agent told another agent took over says so and does not reconnect at once', async () => {
  const { connects, out } = await run([join(REPO, 'public/machine-agent.mjs'), 'ccm_1_x', '--', process.execPath, '-e', '0']);
  assert.equal(connects, 1, out);
  assert.match(out, /another agent connected with this machine's token, from other-pc/);
});

test('a runner agent told another agent took over says so and does not reconnect at once', async () => {
  const tokenFile = join(root, 'token');
  writeFileSync(tokenFile, 'ccm_1_x\n');
  const { connects, out } = await run([join(REPO, 'public/runner-agent.mjs'), '--token-file', tokenFile]);
  assert.equal(connects, 1, out);
  assert.match(out, /another agent connected with this machine's token, from other-pc/);
});
