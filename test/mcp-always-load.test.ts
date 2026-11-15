// The tools every turn uses are never deferred behind ToolSearch (#710): the MCP server marks exactly these
// `anthropic/alwaysLoad`. Each 1k tokens of prefix costs about $22 a week (#699), so growing the list is a decision.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

function marked(role: string) {
  const input = [{ jsonrpc: '2.0', id: 1, method: 'tools/list' }].map((m) => JSON.stringify(m)).join('\n') + '\n';
  const r = spawnSync(process.execPath, ['src/mcp.ts'], { input, encoding: 'utf8', env: { ...process.env, COORDINATOR_ROLE: role, COORDINATOR_PROJECT: '1', COORDINATOR_TICKET: '1', COORDINATOR_APP_INSTRUCTIONS: '' } });
  const tools = JSON.parse(r.stdout.split('\n')[0]).result.tools;
  return tools.filter((t: any) => t._meta?.['anthropic/alwaysLoad']).map((t: any) => t.name).sort();
}

test("a minion's always-loaded tools are these five", () => {
  assert.deepEqual(marked('thread'), ['ask_question', 'close_self', 'message_coordinator', 'set_properties', 'set_thread_status']);
});

test("a Taskmaster's always-loaded tools are these four", () => {
  assert.deepEqual(marked('coordinator'), ['create_ticket', 'list_tickets', 'message_ticket', 'read_ticket']);
});
