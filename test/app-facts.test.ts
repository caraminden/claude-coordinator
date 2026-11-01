import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { systemPrompt } from '../src/runner.ts';
import { TRIPWIRE_BLOCKS } from '../src/tripwire-blocks.ts';

// How the app behaves (the chat, links, the tripwire) is the same in every scheme, so the built-in
// prompts say it; tools/deploy.sh, pending-deploy and previews only exist where the server runs the code.
const project = { id: 3, name: 'Delve', instructions: '', approval_rules: '' } as any;
const minion = { id: 5, number: 5, title: 'T', kind: 'ticket', branch: 'ticket/5-t' } as any;
const taskmaster = { ...minion, kind: 'coordinator' } as any;

test('minions and Taskmasters both hear the chat, link, strike and tripwire facts', () => {
  for (const t of [minion, taskmaster]) {
    const p = systemPrompt(project, t, null, null, '/tickets', null);
    assert.match(p, /write the answer last/, t.kind);
    assert.match(p, /pull requests as PR #N/, t.kind);
    assert.match(p, /Never paste GitHub URLs/, t.kind);
    assert.match(p, /write the wrong words as `~~…~~` with the fix right after/, t.kind);
    assert.ok(p.includes(TRIPWIRE_BLOCKS), t.kind);
  }
  assert.match(systemPrompt(project, minion, null, null, '/tickets', null), /one blocking command, up to 10 minutes per call/);
});

test('deploy lines show only when the server runs the scheme', () => {
  const served = systemPrompt(project, minion, null, null, '/tickets', null, [], true);
  assert.match(served, /After you deploy with tools\/deploy\.sh/);
  assert.match(served, /or pending-deploy \(deployed with tools\/deploy\.sh/);
  assert.match(served, /pending-deploy after tools\/deploy\.sh, close_self otherwise/);
  const elsewhere = systemPrompt(project, minion, null, null, '/tickets', null);
  assert.doesNotMatch(elsewhere, /deploy\.sh|pending-deploy/);
  assert.match(elsewhere, /Once your work is finished and nothing is left for a person to answer, try or read, end the minion in that same turn \(close_self\)/);
  assert.match(elsewhere, /outside \(work still running elsewhere\), or null when/);
});

/** The thread MCP server's tools, with or without COORDINATOR_DEPLOYS. */
async function threadTools(deploys: boolean): Promise<any[]> {
  const env: Record<string, string | undefined> = { ...process.env, MACHINES_URL: undefined, COORDINATOR_API: 'http://127.0.0.1:1', COORDINATOR_TOKEN: 'x', COORDINATOR_PROJECT: '3', COORDINATOR_ROLE: 'thread', COORDINATOR_TICKET: '5', COORDINATOR_DEPLOYS: deploys ? '1' : undefined };
  const mcp = spawn(process.execPath, [join(import.meta.dirname, '../src/mcp.ts')], { env, stdio: ['pipe', 'pipe', 'inherit'] });
  try {
    const reply = new Promise<any>((r) => createInterface({ input: mcp.stdout! }).once('line', (l) => r(JSON.parse(l))));
    mcp.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) + '\n');
    return (await reply).result.tools;
  } finally {
    mcp.kill();
  }
}

test("a minion's MCP tools mention deploys and offer previews only when the server runs the scheme", async () => {
  for (const deploys of [true, false]) {
    const tools = await threadTools(deploys);
    const tool = (name: string) => tools.find((t) => t.name === name);
    assert.equal(!!tool('start_preview'), deploys);
    assert.equal(/deploy\.sh/.test(tool('close_self').description), deploys);
    const state = tool('set_thread_status').inputSchema.properties.state;
    assert.equal(state.enum.includes('pending-deploy'), deploys);
    assert.equal(state.description.includes('pending-deploy'), deploys);
  }
});

test('a minion parked on start_after hears its brief is held and to stay parked', () => {
  const held = systemPrompt(project, minion, null, null, '/tickets', null, [], false, '', "#3 Leader's work is merged");
  assert.match(held, /You are parked: your brief is held until #3 Leader's work is merged/);
  assert.doesNotMatch(systemPrompt(project, minion, null, null, '/tickets', null), /You are parked/);
});
