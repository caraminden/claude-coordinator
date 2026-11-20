// The fake Citadel MCP server a replay runs with (#1117): the version under test's real tool list, but every call is
// answered from the case's facts or a stock reply, so nothing reaches the live app. stdio JSON-RPC, one message a line.
// env: STUB_TOOLS (a JSON file of the tool list), STUB_FACTS (a JSON file of the case's facts), STUB_ROLE (thread|coordinator).
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

export type Fact = { tool: string; match?: string; result: string; why?: string };

const bare = (name: string) => name.replace(/^mcp__[a-z-]+__/, '');
export const nameMatches = (pattern: string, name: string) => new RegExp(`^(?:${pattern})$`, 'i').test(bare(name));

/** The first fact whose tool and match fit the call, else a stock reply. */
export function answer(facts: Fact[], tool: string, input: unknown): string {
  const json = JSON.stringify(input ?? {});
  const hit = facts.find((f) => nameMatches(f.tool, tool) && (!f.match || new RegExp(f.match, 'i').test(json)));
  if (hit) return hit.result;
  const t = bare(tool);
  if (/^(ask_question|propose_plan)$/.test(t)) return 'Your card is in the chat: [the card](#/p/2/t/900000?e=1). End your turn now with a short reply that links it.';
  if (/^(hand_off_land|land)$/.test(t)) return 'Handed off: the server runs tools/land.sh and wakes you if it fails. End your turn now with a short reply.';
  if (t === 'close_self') return 'The minion closes when this turn ends.';
  if (/^(host_check|search_decisions|search_memory|list_tickets|read_minion|read_ticket|ci_runners|ci_files|list_artifacts|artifact_data|contraption_read)$/.test(t)) return '(no rows)';
  if (/^(set_thread_status|set_properties|strike_text|settle_question|mark_image|pin_artifact|unpin_artifact)$/.test(t)) return 'Done.';
  if (/^(message_coordinator|message_minion|message_taskmaster|relay_when_live|wake_when_live|wake_at)$/.test(t)) return 'Sent.';
  return 'ok';
}

if (import.meta.main) {
  const tools = JSON.parse(readFileSync(process.env.STUB_TOOLS!, 'utf8'));
  const facts: Fact[] = JSON.parse(readFileSync(process.env.STUB_FACTS!, 'utf8'));
  const send = (m: object) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
  createInterface({ input: process.stdin }).on('line', (line) => {
    let m: any;
    try { m = JSON.parse(line); } catch { return; }
    if (m.id === undefined) return;
    if (m.method === 'initialize') {
      return send({ id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: process.env.STUB_ROLE ?? 'thread', version: '0' } } });
    }
    if (m.method === 'tools/list') return send({ id: m.id, result: { tools } });
    if (m.method === 'tools/call') return send({ id: m.id, result: { content: [{ type: 'text', text: answer(facts, m.params?.name ?? '', m.params?.arguments) }] } });
    send({ id: m.id, result: {} });
  });
}
