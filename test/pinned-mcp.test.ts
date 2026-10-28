import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { MACHINE_MCP_SERVER, MCP_SERVER } from '../src/runner.ts';

// Turns run copies of the MCP servers from the data dir; a local import that isn't copied
// with them makes every session's MCP server die on start (CONNECTION_CLOSED).

test('the pinned mcp.ts starts from its pinned dir and answers initialize', async () => {
  const child = spawn(process.execPath, [MCP_SERVER], {
    cwd: dirname(MCP_SERVER),
    env: { ...process.env, COORDINATOR_ROLE: 'thread', COORDINATOR_PROJECT: '1', COORDINATOR_TICKET: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d));
  const reply = new Promise<any>((resolve, reject) => {
    createInterface({ input: child.stdout }).once('line', (line) => resolve(JSON.parse(line)));
    child.once('exit', (code) => reject(new Error(`mcp.ts exited (${code}): ${stderr}`)));
  });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }) + '\n');
  try {
    const msg = await reply;
    assert.equal(msg.id, 1);
    assert.equal(msg.result.serverInfo.name, 'coordinator');
  } finally {
    child.kill();
  }
});

test('every local import of a pinned server is pinned beside it', () => {
  const pinned = new Set(readdirSync(dirname(MCP_SERVER)));
  for (const server of [MCP_SERVER, MACHINE_MCP_SERVER]) {
    for (const [, file] of readFileSync(server, 'utf8').matchAll(/from '\.\/([^']+)'/g)) {
      assert.ok(pinned.has(file), `${server} imports ./${file}, which runner.ts doesn't pin`);
    }
  }
});
