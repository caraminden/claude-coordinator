// The Stop hook a verifier case runs under (#1740): node verifier-stay.mjs <case folder>. The first trial's verifier
// read the diff, ran a curl or two and stopped after 2 minutes of the 20 it was asked for. This refuses its final
// answer until it has driven the dev copy enough times, for long enough, and shows commands with their output, saying
// what is still short. It gives way after MAX_BLOCKS refusals, so a stuck run still ends with a report.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const NEED = { drives: 8, minutes: 15, blocks: 3 };
export const MAX_BLOCKS = 5;
// A call that drives the running copy: its API or pages, its restart or people, or the fake claude's script.
const DRIVES = /\$\{?DEV_(URL|COOKIE|PORT)|127\.0\.0\.1:\d{4,5}|localhost:\d{4,5}|ui-shot|ui-measure|boot\.mjs\s+(start|restart|person)|fake\/turns\.jsonl|sqlite3\b[^|;&]*data\/coordinator\.db/;

/** What the run did so far, from its stream-json lines. */
export function tally(lines, startedAt, now = Date.now()) {
  let drives = 0,
    last = '';
  for (const l of lines) {
    let ev;
    try {
      ev = JSON.parse(l);
    } catch {
      continue;
    }
    if (ev.type !== 'assistant') continue;
    for (const b of ev.message?.content ?? []) {
      if (b.type === 'tool_use' && b.name === 'Bash' && DRIVES.test(String(b.input?.command ?? ''))) drives++;
      if (b.type === 'text' && b.text) last = b.text;
    }
  }
  return { drives, minutes: (now - startedAt) / 60_000, last };
}

/** Why it can't stop yet, or '' once it has done enough. `final` is its closing message when the hook was given it. */
export function shortfall(t, final = t.last) {
  const short = [];
  if (t.drives < NEED.drives) short.push(`you have driven the running copy ${t.drives} times (curl to $DEV_URL, ui-shot, boot.mjs restart/person, a scripted fake turn); do at least ${NEED.drives}`);
  if (t.minutes < NEED.minutes) short.push(`you have worked ${Math.floor(t.minutes)} minutes of the ${NEED.minutes} or more this asks for`);
  const blocks = (String(final ?? '').match(/```/g) ?? []).length / 2;
  if (blocks < NEED.blocks) short.push(`your report shows ${Math.floor(blocks)} commands with their output in code blocks; show at least ${NEED.blocks}, one per flow you drove`);
  if (!short.length) return '';
  return `Not done yet: ${short.join('; ')}. Keep going: pick a state from "Make the state the bug needs" in your brief that you haven't tried (a second person, a usage-limit or failed turn, a restart mid-turn, the clock at midnight, seeded minions), set it up, drive the change through it, and look at what comes back. Then write the report again in full.`;
}

if (import.meta.main ?? process.argv[1]?.endsWith('verifier-stay.mjs')) {
  const dir = process.argv[2];
  try {
    const input = JSON.parse(readFileSync(0, 'utf8') || '{}');
    const countFile = join(dir, 'stay-blocks');
    const n = existsSync(countFile) ? Number(readFileSync(countFile, 'utf8')) || 0 : 0;
    const started = Number(readFileSync(join(dir, 'started-at'), 'utf8'));
    const stream = existsSync(join(dir, 'stream.jsonl')) ? readFileSync(join(dir, 'stream.jsonl'), 'utf8').split('\n') : [];
    const why = n >= MAX_BLOCKS ? '' : shortfall(tally(stream, started), input.last_assistant_message);
    if (why) {
      writeFileSync(countFile, String(n + 1));
      console.log(JSON.stringify({ decision: 'block', reason: why }));
    }
  } catch {
    /* can't read its state: let it stop rather than hold it forever */
  }
}
