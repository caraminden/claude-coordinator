/**
 * The answer check (Stop hook, Citadel turns): two rules from the built-in prompt that had no check
 * (history-mining report, patterns 11 and 12; #484).
 *  - Thin last message: a turn that made five or more tool calls ends on a short remark ("Now the
 *    tests.") or a lead-in ending in a colon, with the real answer further up or missing.
 *  - Proposal without a card: the final text proposes work (a heading or lead-in with "propos",
 *    "recommend", "next steps" or "follow-up") and the turn asked nobody anything: no ask_question,
 *    propose_plan, or message to the Taskmaster or a minion.
 *  - Placeholder in a command: a fenced block tagged powershell, powershell-admin, wsl, fish, bash or
 *    cmd holds a `<like this>` placeholder. Values you can look up go in filled (Cara, 2026-11-17, #900).
 *  - Live-state claim without a read (#1113): the final text states another minion's, CI's or a deploy's
 *    state, or that something waits on a person, and the turn made no call that reads it (live_facts,
 *    read_ticket, list_tickets, host_check, gh, git…) nor got it in its prompt from Citadel or that minion.
 *  - The minion checks (#1154, mechanism first): three rules of the minion prompt, minions only. No status line
 *    (or one Citadel can't read) at the end of the final reply; the title still the opening words of the first
 *    message at the end of the first turn (CITADEL_MINION_TITLE, the title the turn started with); and a ship handed
 *    off (hand_off_land or land) with no self-review anywhere in the session.
 * Each hit writes one `would refuse` line to the retro log. The weekly process digest counts them and
 * how many were false alarms; refusal turns on only for a check with under one false alarm in five.
 * Refusing is on for one shape, the proposal without a card (Josh, 2026-11-19, "Go on C3", #1106): the
 * stop is sent back once per prompt, never twice, and logs a `refused stop` line instead. The other
 * shapes only count. (A choice asked in prose is refused by src/link-check.ts, a different hook.)
 * A `Process:` line in the final text (self-review's, not `none`) is also
 * logged, as a `process` line. A turn a person's message reached mid-turn (a steer) is skipped:
 * its short end may be the steer cutting it off, not a broken rule (#280).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { note } from './retro-log.ts';
import type { HookInput, TranscriptBlock, TranscriptEntry } from './hook-input.ts';

/** An ask_question call's question, as the transcript holds it. */
type AskedQuestion = { question?: unknown; options?: unknown };

export const MIN_TOOL_CALLS = 5;
export const MIN_ANSWER_CHARS = 200;

/** Tools that turn a proposal into something people answer, or hand it on (MCP names end in `__<tool>`). */
const ACTIONS = ['ask_question', 'propose_plan', 'message_coordinator', 'message_taskmaster', 'message_ticket', 'create_ticket'];

/** What one turn did, read from its transcript. */
export type Turn = { toolCalls: string[]; finalText: string; steered: boolean; cardText?: string; commands?: string[]; prompt?: string; titled?: boolean };
// `cardText`: the question and option description text of the turn's ask_question calls, where a command can sit too.
// `commands` and `prompt`: the turn's Bash commands and its prompt's text, for the live-claim check's reads.
// `titled`: the turn called set_thread_status with a title, for the title check.
// `steered` covers every turn cut short rather than ended: a steer, a stop, a usage-limit or API error.

const isNotification = (text: string) => /^\s*<task-notification>/.test(text);
const textOf = (content: unknown): string =>
  typeof content === 'string' ? content : Array.isArray(content) ? content.map((b: TranscriptBlock | null) => (b?.type === 'text' ? String(b.text ?? '') : '')).join('\n') : '';

/**
 * The turn of `promptId` in a transcript (JSONL): its tool calls, its last text, and whether a
 * message other than a Grunt's finish notice reached it while it ran. Without a prompt id, the turn
 * starts at the last prompt a person or the Taskmaster sent.
 */
export function readTurn(transcript: string, promptId?: string): Turn {
  const entries: (TranscriptEntry | null)[] = [];
  for (const raw of transcript.split('\n')) {
    if (!raw.trim()) continue;
    try {
      entries.push(JSON.parse(raw));
    } catch {
      // A line cut short mid-write.
    }
  }
  const isPrompt = (e: TranscriptEntry | null): e is TranscriptEntry => e?.type === 'user' && !e.isMeta && !e.isSidechain && !e.isCompactSummary && !(Array.isArray(e.message?.content) && e.message.content.some((b) => b?.type === 'tool_result'));
  let start = promptId ? entries.findIndex((e) => e?.promptId === promptId) : -1;
  if (start < 0) start = entries.findLastIndex(isPrompt);
  const turn: Turn = { toolCalls: [], finalText: '', steered: false };
  if (start >= 0) turn.prompt = textOf(entries[start]?.message?.content);
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
        if (b?.type === 'tool_use') {
          turn.toolCalls.push(String(b.name ?? ''));
          if (b.name === 'Bash' && typeof b.input?.command === 'string') (turn.commands ??= []).push(b.input.command);
          if (/(^|__)set_thread_status$/.test(String(b.name ?? '')) && typeof b.input?.title === 'string' && b.input.title.trim()) turn.titled = true;
          if (/(^|__)ask_question$/.test(String(b.name ?? ''))) {
            const qs = Array.isArray(b.input?.questions) ? b.input.questions : [];
            const parts = qs.flatMap((q: AskedQuestion | null) => [q?.question, ...(Array.isArray(q?.options) ? q.options.map((o: { description?: unknown } | null) => o?.description) : [])]).filter((t: unknown) => typeof t === 'string');
            if (parts.length) turn.cardText = `${turn.cardText ?? ''}\n${parts.join('\n')}`;
          }
        }
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
  const placeholder = placeholderInCommand(text) ?? (turn.cardText ? placeholderInCommand(turn.cardText) : null);
  if (placeholder) hits.push(`placeholder in a command · "${placeholder.slice(0, 120)}"`);
  return hits;
}

const SHELL_TAGS = new Set(['powershell', 'powershell-admin', 'wsl', 'fish', 'bash', 'cmd', 'sh', 'zsh', 'pwsh']);
// `<name ...>`: not a redirect (`<file >out`, `2>&1`, `<<EOF`): the `<` follows no `<` or word character, and the `>` follows no space or digit.
const PLACEHOLDER = /(?<![<\w])<[A-Za-z][^<>\n]*[^<>\s\d]>/;

/** The first `<placeholder>` in a fenced block tagged with a shell, as its line, or null. */
export function placeholderInCommand(text: string): string | null {
  const fence = /^[ \t]*```([\w-]+)[^\n]*\n([\s\S]*?)^[ \t]*```/gm;
  for (const m of text.matchAll(fence)) {
    if (!SHELL_TAGS.has(m[1].toLowerCase())) continue;
    for (const line of m[2].split('\n')) if (PLACEHOLDER.test(line)) return line.trim();
  }
  return null;
}

// The live-claim check (#1113): a sentence stating live state (a minion's, CI's, a deploy's, a person's turn)
// in a turn that read none of it. The shapes come from the replies struck in the week to 2026-11-19.
const LIVE_CLAIMS = [
  // Another minion's state: "#1002 has been live since 20:18", "#993 is sealed".
  /#\d{2,5}\b[^.?!\n]{0,40}?\b(?:is|was|are|has(?: been)?|have(?: been)?|'s|isn't|aren't|hasn't|haven't|never|already|still)\s+(?:now\s+|already\s+|still\s+|not\s+|been\s+)?(?:live|shipped|landed|deployed|merged|parked|sealed|running|idle|closed|done|blocked|stuck|waiting|ready|green|red|failed|failing)\b/i,
  // CI, runners, jobs and lands with a result: "the last four lands all failed", "the test job never got a runner".
  /\b(?:CI|runs?|runners?|jobs?|lands?|landings?|workflows?|queue|checks?)\b[^.?!\n]{0,50}?\b(?:failed|fails|failing|passed|passes|passing|green|red|queued|stuck|cancell?ed|never got|timed out|hung|hangs|finished|is busy|are busy|waits? its turn|still running|still in the queue)\b/i,
  /\b(?:flaky|broken|offline|busy)\s+(?:runner|machine|box|CI)\b/i,
  /\b(?:machine|box|runner)\b[^.?!\n]{0,60}?\b(?:isn't|is not|is|are|aren't)\s+(?:lent|online|offline|down|connected|free)\b/i,
  // Deploys and live-ness: "is live", "live since", "isn't actually taking effect".
  /\b(?:is|are|went|been|isn't|aren't|not|now)\s+live\b|\blive (?:since|now)\b|\btaking effect\b|(?:\b(?:was|were|got|is|are|been|now)\s+|'(?:re|s)\s+(?:now\s+)?)(?:deployed|restarted)\b/i,
  // Someone else's moves: "Josh's Taskmaster started that build", "the Taskmaster closed #12".
  /(?<!\b(?:the|a|an)\s)\b(?:started|closed|stopped|parked|unparked|sealed|unsealed)\s+(?:#\d+|(?:that|the|this) build|Build \d+)/i,
  // A person's turn: "waiting on you", "it needs your go".
  /\b(?:waits?|waiting|blocked)\s+on\s+(?:you\b|your\b|Cara\b|Josh\b)|\bneeds? (?:your|Cara's|Josh's) (?:go|answer|pick|OK)\b/i,
];
// Hedged, future or conditional sentences claim nothing now.
const HEDGE = /\b(?:I think|probably|likely|maybe|might|may|guess|not sure|I don't know|seems?|looks like|once|if|until|when|after|before|unless|will|would|could|expect)\b/i;
// Calls that read live state: the facts tool, a minion or the minions list, the database, CI, machines, a Grunt,
// and the turn's own starts and deploys ("#625 is running now" right after starting it).
const READS = /(?:^|__)(?:live_facts|read_ticket|read_minion|list_tickets|host_check|ci_runners|ci_files|ci_status|job_status|check_machine|list_machines|contraption_read|hand_off_land|land|create_ticket|deploy_contraption)$|^(?:Agent|Task)$/;
const READ_COMMANDS = /\b(?:git|gh|sqlite3|curl|journalctl|systemctl|ci-failures|citadel-[\w-]+|ss|ps|pgrep|uptime|free|df|nproc|land\.sh|deploy\.sh)\b/;

/** The sentences of `text` that state live state, outside code, quotes and comments; hedged ones and questions left out. */
export function liveClaims(text: string): string[] {
  const prose = text.replace(/^[ \t]*```[\s\S]*?^[ \t]*```/gm, '').replace(/<!--[\s\S]*?-->/g, '').replace(/`[^`\n]*`/g, '`…`')
    .split('\n').filter((l) => !/^\s*>/.test(l)).join('\n');
  const out: string[] = [];
  for (const raw of prose.split(/(?<=[.!?])\s+|\n+/)) {
    const s = raw.replace(/~~[^~]*~~/g, '').trim();
    // A question, a hedge, or the turn's own act ("I started #630") claims nothing about someone else's state.
    if (!s || s.endsWith('?') || HEDGE.test(s) || /^(?:[-*]\s+)?(?:I|I've|I'm|I'll|We|We've)\b/.test(s)) continue;
    if (LIVE_CLAIMS.some((re) => re.test(s))) out.push(s);
  }
  return out;
}

/** The parts of a prompt Citadel, GitHub, a Taskmaster or a minion wrote (`[Citadel]:`, `[#N title]:`, a quoted Taskmaster), not a person's words. */
function toldBy(prompt: string): string {
  return prompt.split(/^(?=\[[^\]\n]+\]:)/m).filter((b) => /^\[(?:System|Citadel|GitHub|Taskmaster|#\d)/.test(b) || b.includes('(Quoted from ')).join('\n');
}
const numbers = (s: string) => new Set(s.match(/#\d{2,5}\b/g) ?? []);

/** The live-claim check's hits for a turn that read no live state: count only, never sent back. */
export function liveClaimCheck(turn: Turn): string[] {
  if (turn.steered) return [];
  if (turn.toolCalls.some((n) => READS.test(n)) || (turn.commands ?? []).some((c) => READ_COMMANDS.test(c))) return [];
  // A claim the prompt's own notes or a minion's report state (#655 is live, CI passed) passes them on; a person's question doesn't.
  const told = toldBy(turn.prompt ?? '');
  const toldNumbers = numbers(told);
  const toldLive = LIVE_CLAIMS.some((re) => re.test(told));
  const passedOn = (s: string) => toldLive && [...numbers(s)].every((n) => toldNumbers.has(n));
  return liveClaims(turn.finalText).filter((s) => !passedOn(s)).slice(0, 3).map((s) => `live-state claim without a read · "${s.replace(/\s+/g, ' ').slice(0, 160)}"`);
}

// The minion checks (#1154). The trailer as src/status-trailer.ts reads it: only at the very end, its body can't cross a `-->`.
const STATUS_TRAILER = /<!--\s*status:\s*((?:(?!-->)[\s\S])*?)\s*-->`?\s*$/;
const SHIP = /(?:^|__)(?:hand_off_land|land)$/;

/** A final reply with no status line, or one src/status-trailer.ts would ignore. */
export function statusLineCheck(turn: Turn): string[] {
  const text = turn.finalText.trimEnd();
  // No closing text at all is the thin-message check's to count, not a missing line's.
  if (turn.steered || !text) return [];
  const m = STATUS_TRAILER.exec(text);
  if (!m) return [`no status line · "…${text.replace(/\s+/g, ' ').slice(-80)}"`];
  try {
    const v = JSON.parse(m[1]);
    if (v === null || (v && typeof v === 'object' && !Array.isArray(v) && ['state', 'note', 'replies'].some((k) => k in v))) return [];
  } catch {
    // Not JSON: unreadable.
  }
  return [`unreadable status line · "${m[1].replace(/\s+/g, ' ').slice(0, 80)}"`];
}

/** The turn's title (CITADEL_MINION_TITLE, as it started) is still the opening words of its prompt, and the turn set none. */
export function titleCheck(turn: Turn, title: string | undefined): string[] {
  if (turn.steered || turn.titled || !title) return [];
  // provisionalTitle (src/routes/projects.ts) cuts near 40 characters and adds `…`.
  const stem = title.replace(/…$/, '').replace(/\s+/g, ' ').trim();
  if (stem.length < 8) return [];
  const prompt = (turn.prompt ?? '').replace(/\s+/g, ' ').trim();
  // The first message opens the prompt, or follows its sender's tag ("[Josh]: "); a later turn's prompt doesn't, so only the first turn counts.
  return prompt.startsWith(stem) || prompt.includes(`]: ${stem}`) ? [`title still the opening words · "${title.slice(0, 80)}"`] : [];
}

/**
 * A turn that handed off a ship (hand_off_land or land) in a session with no self-review in it: no Skill call to
 * self-review and no reviewer Grunt, before or after the hand-off (a low-risk ship is reviewed while it ships).
 * shortcut: any review in the session counts, so a second ship after more edits passes; tighten if the digest shows it.
 */
export function shipReviewCheck(turn: Turn, transcript: string): string[] {
  if (turn.steered || !turn.toolCalls.some((n) => SHIP.test(n))) return [];
  for (const raw of transcript.split('\n')) {
    if (!raw.includes('"tool_use"')) continue;
    let e: TranscriptEntry | null;
    try {
      e = JSON.parse(raw);
    } catch {
      continue;
    }
    for (const b of Array.isArray(e?.message?.content) ? e.message.content : []) {
      if (b?.type !== 'tool_use') continue;
      if (b.name === 'Skill' && /(?:^|:)self-review$/.test(String(b.input?.skill ?? ''))) return [];
      if ((b.name === 'Agent' || b.name === 'Task') && /(?:^|:)reviewer$/.test(String(b.input?.subagent_type ?? ''))) return [];
    }
  }
  return ['ship with no self-review'];
}

/** The text of a `Process:` line (self-review's last line) at the start of a line, or null for none or no such line. */
export function processLine(text: string): string | null {
  const m = text.match(/^Process:[ \t]*(.*\S)[ \t]*$/m);
  return m && !/^none\b\.?$/i.test(m[1]) ? m[1] : null;
}

/** The shapes whose stop is sent back, once per prompt. */
const REFUSED = /^proposal without a card/;

/**
 * Runs the checks for one Stop of a Citadel turn and logs each hit; returns the hits.
 * job-check.ts calls it, only for a stop it lets through: a refused stop isn't the turn's end.
 * `refusal` (job-check.ts passes it) lets a REFUSED shape send the stop back, once per prompt.
 */
export function answerHook(input: HookInput, env = process.env, refusal?: { stateDir?: string; out: { block?: string } }): string[] {
  const role = env.COORDINATOR_ROLE;
  if (role !== 'thread' && role !== 'coordinator') return [];
  let turn: Turn = { toolCalls: [], finalText: '', steered: false };
  const transcript = input?.transcript_path ? readFileSync(input.transcript_path, 'utf8') : '';
  if (transcript) turn = readTurn(transcript, input.prompt_id ?? undefined);
  // Claude Code's own copy of the last message beats the transcript, which may not be flushed yet.
  if (typeof input?.last_assistant_message === 'string' && input.last_assistant_message.trim()) turn.finalText = input.last_assistant_message;
  const hits = [...answerCheck(turn), ...liveClaimCheck(turn)];
  if (role === 'thread') hits.push(...statusLineCheck(turn), ...titleCheck(turn, env.CITADEL_MINION_TITLE), ...shipReviewCheck(turn, transcript));
  const refuse = refusal ? refusalFor(input, hits, refusal.stateDir ?? join(tmpdir(), 'citadel-kit')) : null;
  for (const hit of hits) {
    if (refuse && REFUSED.test(hit)) {
      note(input, 'refused stop', hit, env);
      refusal!.out.block = refuse;
    } else if (!refuse) note(input, 'would refuse', hit, env); // a stop sent back is judged again when it ends
  }
  // self-review's Process: line goes to the log for the process digest, whatever the checks said.
  const process = turn.steered ? null : processLine(turn.finalText);
  if (process && !refusal?.out.block) note(input, 'process', process, env);
  return hits;
}

/** The reason to send this stop back for, the first time this prompt hits a REFUSED shape; else null. Without a prompt id, only a first stop. */
function refusalFor(input: HookInput, hits: string[], stateDir: string): string | null {
  if (!hits.some((h) => REFUSED.test(h))) return null;
  const prompt = input?.prompt_id ?? null;
  const file = join(stateDir, `answer-${String(input?.session_id ?? 'unknown').replace(/[^\w.-]/g, '_')}.json`);
  if (!prompt && input?.stop_hook_active) return null;
  try {
    if (prompt && JSON.parse(readFileSync(file, 'utf8')).prompt === prompt) return null;
  } catch {
    // Nothing refused yet this session.
  }
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(file, JSON.stringify({ prompt }));
  } catch {
    return null; // no marker to stop a second refusal: let the turn end
  }
  return '[citadel answer check] Your reply proposes work (a proposal, recommendation, next steps or follow-ups) and no card, plan or message to the Taskmaster went with it. '
    + 'Post the choice as an ask_question card (a plan as propose_plan; a handoff as a message to the Taskmaster), one option per proposal with your pick marked, then write the reply again with the card\'s link. '
    + 'If nobody has a choice to make (a report that only lists what was done), write the reply again without the proposal wording.';
}
