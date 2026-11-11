// A machine agent's task runs in a process group of its own off Windows (#468 S09-5), so the agent ends those
// groups as it exits. A task whose first process has ended can leave the rest of its group running (`sleep 600 &`):
// that group is still the agent's to end (#468 S09-5 review, Codex 1).
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { REPO, stopProcs, until } from './helpers.ts';

const root = mkdtempSync(join(tmpdir(), 'agent-task-groups-'));
const procs: ChildProcess[] = [];
const servers: ReturnType<typeof createServer>[] = [];
let leftover = 0;
after(async () => {
  if (leftover) try { process.kill(-leftover, 'SIGKILL'); } catch {}
  await stopProcs(procs);
  for (const s of servers) s.closeAllConnections(), s.close();
  rmSync(root, { recursive: true, force: true });
});

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test('a task that has ended but left its group running is ended with the agent', { skip: process.platform === 'win32' }, async () => {
  const ws = join(root, 'ws');
  mkdirSync(ws);
  const config = join(root, 'machine-agent.json');
  writeFileSync(config, JSON.stringify({ workspaces: { w: { path: ws, tasks: { launch: { run: ['sh', '-c', `sleep 47 & echo "child $!"`] } } } } }));
  // An app that lends the workspace, then asks for the task once; the agent's answers come back on /send.
  const replies: any[] = [];
  const srv = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    if (req.url!.startsWith('/api/machines/connect')) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ hello: 'box' })}\n\n`);
      res.write(`data: ${JSON.stringify({ lend: { server: null, workspaces: ['w'] } })}\n\n`);
      res.write(`data: ${JSON.stringify({ session: 's1', server: 'ws', who: '#1', message: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'run_task', arguments: { workspace: 'w', task: 'launch', wait: 5 } } } })}\n\n`);
      return;
    }
    req.on('end', () => {
      try {
        replies.push(JSON.parse(body));
      } catch {}
      res.writeHead(202).end('{}');
    });
  });
  servers.push(srv);
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const agent = spawn(process.execPath, [join(REPO, 'public/machine-agent.mjs'), base, 'ccm_1_x', '--config', config], { stdio: ['ignore', 'pipe', 'pipe'] });
  procs.push(agent);
  let out = '';
  agent.stdout!.on('data', (d) => (out += d));
  agent.stderr!.on('data', (d) => (out += d));
  const text = await until('the task has finished', () => replies.map((r) => r.message?.result?.content?.[0]?.text).find((t) => /child \d+/.test(t ?? '')), 20_000).catch((err) => assert.fail(`${err.message}\n${out}`));
  const pid = Number(/child (\d+)/.exec(text)![1]);
  leftover = Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' }).trim());
  assert.equal(alive(pid), true, 'the sleep outlives the shell that started it');
  agent.kill('SIGTERM');
  await new Promise((r) => agent.once('exit', r));
  await until('the sleep is gone', () => !alive(pid), 5_000).catch(() => assert.fail('the task\'s group outlived the agent'));
});
