/**
 * The answer check (Stop hook, Citadel turns): two rules from the built-in prompt that had no check
 * (history-mining report, patterns 11 and 12; #484).
 *  - Thin last message: a turn that made five or more tool calls ends on a short remark ("Now the
 *    tests.") or a lead-in ending in a colon, with the real answer further up or missing.
 *  - Proposal without a card: the final text proposes work (a heading or lead-in with "propos",
 *    "recommend", "next steps" or "follow-up") and the turn asked nobody anything: no ask_question,
 *    propose_plan, or message to the Taskmaster or a minion.
 * A trial: each hit writes one `would refuse` line to the retro log and refuses nothing. The weekly
 * process digest counts them and how many were false alarms; refusal turns on only for a check with
 * under one false alarm in five. A turn a person's message reached mid-turn (a steer) is skipped:
 * its short end may be the steer cutting it off, not a broken rule (#280).
 */
import { readFileSync } from 'node:fs';
import { note } from './retro-log.ts';

export const MIN_TOOL_CALLS = 5;
export const MIN_ANSWER_CHARS = 200;

/** Tools that turn a proposal into something people answer, or hand it on (MCP names end in `__<tool>`). */
const ACTIONS = ['ask_question', 'propose_plan', 'message_coordinator', 'message_taskmaster', 'message_ticket', 'create_ticket'];

/** What one turn did, read from its transcript. */
export type Turn = { toolCalls: string[]; finalText: string; steered: boolean };
// `steered` covers every turn cut short rather than ended: a steer, a stop, a usage-limit or API error.

const isNotification = (text: string) => /^\s*<task-notification>/.test(text);
const textOf = (content: unknown): string =>
  typeof content === 'string' ? content : Array.isArray(content) ? content.map((b: any) => (b?.type === 'text' ? String(b.text ?? '') : '')).join('\n') : '';

/**
 * The turn of `promptId` in a transcript (JSONL): its tool calls, its last text, and whether a
 * message other than a Grunt's finish notice reached it while it ran. Without a prompt id, the turn
 * starts at the last prompt a person or the Taskmaster sent.
 */
export function readTurn(transcript: string, promptId?: string): Turn {
  const entries: any[] = [];
  for (const raw of transcript.split('\n')) {
    if (!raw.trim()) continue;
    try {
      entries.push(JSON.parse(raw));
    } catch {
      // A line cut short mid-write.
    }
  }
  const isPrompt = (e: any) => e?.type === 'user' && !e.isMeta && !e.isSidechain && !e.isCompactSummary && !(Array.isArray(e.message?.content) && e.message.content.some((b: any) => b?.type === 'tool_result'));
  let start = promptId ? entries.findIndex((e) => e?.promptId === promptId) : -1;
  if (start < 0) start = entries.findLastIndex(isPrompt);
  const turn: Turn = { toolCalls: [], finalText: '', steered: false };
  let waiting = 0;
  for (const e of entries.slice(Math.max(start, 0) + 1)) {
    if (e?.isSidechain) continue;
    if (e?.type === 'assistant') {
      // A usage-limit or API error, written by Claude Code itself: the turn was cut short, not ended.
      if (e.isApiErrorMessage || e.message?.model === '<synthetic>') {
        turn.steered = true;
        continue;
      }
      for (const b of Array.isArray(e.message?.content) ? e.message.content : []) {
        if (b?.type === 'tool_use') turn.toolCalls.push(String(b.name ?? ''));
        else if (b?.type === 'text' && String(b.text ?? '').trim()) turn.finalText = String(b.text);
      }
    } else if (e?.type === 'attachment' && e.attachment?.type === 'queued_command') {
      // A message passed in mid-turn: a steer, unless it is a Grunt's or a job's finish notice.
      if (!isNotification(textOf(e.attachment.prompt))) turn.steered = true;
    } else if (e?.type === 'queue-operation' && !isNotification(String(e.content ?? ''))) {
      // A message that arrived after the last tool call waits in the queue for the next prompt.
      if (e.operation === 'enqueue') waiting++;
      else if (e.operation === 'dequeue' || e.operation === 'remove') waiting = Math.max(0, waiting - 1);
    } else if (isPrompt(e)) {
      const text = textOf(e.message?.content);
      if (/^\[Request interrupted/.test(text.trim()) || (promptId && e.promptId && e.promptId !== promptId)) turn.steered = true;
    }
  }
  if (waiting > 0) turn.steered = true;
  return turn;
}

/** A line of the final text that heads or leads in a proposal: a heading, a bold line or a lead-in before a colon. */
export function proposalLine(text: string): string | null {
  const word = /propos|recommend|next steps?\b|follow[- ]?ups?\b/i;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const heading = /^#{1,6}\s/.test(line) || /^\*\*[^*]+\*\*:?$/.test(line) || /^__[^_]+__:?$/.test(line);
    const leadIn = line.match(/^(?:[-*]\s+)?([^:]{1,80}):(?:\s|$)/)?.[1] ?? null;
    // A link to a proposal doc ([Proposal: X](path)) shares it rather than proposing work in prose.
    if (line.startsWith('[')) continue;
    if ((heading && word.test(line)) || (leadIn !== null && word.test(leadIn))) return line;
  }
  return null;
}

/** The checks a turn fails, as retro-log details (`thin last message · …`); empty when it passes. */
export function answerCheck(turn: Turn): string[] {
  if (turn.steered) return [];
  const text = turn.finalText.trim();
  const quote = `"${text.replace(/\s+/g, ' ').slice(0, 120)}"`;
  const hits: string[] = [];
  if (turn.toolCalls.length >= MIN_TOOL_CALLS && (text.length < MIN_ANSWER_CHARS || text.endsWith(':'))) {
    hits.push(`thin last message · ${turn.toolCalls.length} tool calls · ${quote}`);
  }
  // A link to a card (#/p/2/t/475?e=399793) means the proposal already has one, maybe from an earlier turn.
  const acted = /\]\(#\/p\/\d+\/t\/\d+\?e=\d+\)/.test(text) || turn.toolCalls.some((name) => ACTIONS.some((a) => name === a || name.endsWith(`__${a}`)));
  if (!acted && proposalLine(text)) hits.push(`proposal without a card · ${quote}`);
  return hits;
}

/**
 * Runs the checks for one Stop of a Citadel turn and logs each hit; returns the hits. Never refuses.
 * job-check.ts calls it, only for a stop it lets through: a refused stop isn't the turn's end.
 */
export function answerHook(input: any, env = process.env): string[] {
  const role = env.COORDINATOR_ROLE;
  if (role !== 'thread' && role !== 'coordinator') return [];
  let turn: Turn = { toolCalls: [], finalText: '', steered: false };
  if (input?.transcript_path) turn = readTurn(readFileSync(input.transcript_path, 'utf8'), input.prompt_id ?? undefined);
  // Claude Code's own copy of the last message beats the transcript, which may not be flushed yet.
  if (typeof input?.last_assistant_message === 'string' && input.last_assistant_message.trim()) turn.finalText = input.last_assistant_message;
  const hits = answerCheck(turn);
  for (const hit of hits) note(input, 'would refuse', hit, env);
  return hits;
}
