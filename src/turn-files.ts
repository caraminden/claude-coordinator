// What the server reads and writes in a running turn's folder for a steer and at the turn's end, off its own thread
// (#2137): on a busy disk each blocking call there held every request for as long as the disk took.
import { readFileSync } from 'node:fs';
import { appendFile, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Steer } from './minion-queue.ts';
import type { QueuedMessage } from './runner.ts';
import { track } from './settled.ts';

/** The part of a followed turn these use. */
export interface TurnFiles {
  dir: string;
  /** The steers still on their way into the file, in order. */
  steerTail?: Promise<void>;
}

/** A steer's `end` until its text is in the file: past any size steer.sent can name, so a turn that ends first gives it back. */
export const STEER_PENDING = Number.MAX_SAFE_INTEGER;

/**
 * Append `text` to the turn's steer file, after the steers before it. `written` gets the file's size once it is in:
 * the steer's end, which steer.sent is compared with. A write that fails is logged and `written` never runs, so the
 * steer keeps STEER_PENDING and the next turn gets it. So does one written to a file no wrapper reads (a turn from
 * before steering had none, which was once looked for first): nothing is passed on, and the turn's end gives it back.
 */
export function steerLater(live: TurnFiles, text: () => string | Promise<string>, written?: (end: number) => void): void {
  const file = join(live.dir, 'steer.jsonl');
  live.steerTail = track(
    'steers',
    (live.steerTail ?? Promise.resolve())
      .then(async () => {
        await appendFile(file, await text());
        written?.((await stat(file)).size);
      })
      .catch((err) => console.error(`${file}: a steer could not be written:`, err)),
  );
}

/** What a turn's end reads of its folder: null for a file that isn't there. */
export interface EndFiles {
  sent: string | null;
  stderr: string | null;
  codexLog: string | null;
}

/** Read them once every steer on its way is in the file. Never rejects. */
export async function endFiles(live: TurnFiles): Promise<EndFiles> {
  await live.steerTail;
  const text = (name: string) => readFile(join(live.dir, name), 'utf8').catch(() => null);
  const [sent, stderr, codexLog] = await Promise.all([text('steer.sent'), text('stderr.log'), text('codex-log.jsonl')]);
  return { sent, stderr, codexLog };
}

/** A turn's steers its wrapper never passed to claude (see src/turn-wrapper.mjs), from its steer.sent's text (null: none passed on). */
export function unsentSteers(turn: { steered?: Steer[]; dir?: string }, sentText: string | null): QueuedMessage[] {
  if (!turn.steered?.length || !turn.dir) return [];
  const text = sentText ?? '0';
  const sent = /^\d+$/.test(text) ? Number(text) : NaN;
  // Unreadable (an older wrapper killed mid-write): some were passed on, so resending risks doubles.
  if (Number.isNaN(sent)) {
    console.error(`${turn.dir}: steer.sent reads ${JSON.stringify(text)}, so its turn's steers are taken as sent.`);
    return [];
  }
  return turn.steered.filter((s) => s.end > sent).map((s) => s.msg);
}

/** A cut-off turn's steers its wrapper never passed on, read at boot before the server listens. */
export function unsentSteersAtBoot(turn: { steered?: Steer[]; dir?: string }): QueuedMessage[] {
  let text: string | null = null;
  try {
    if (turn.steered?.length && turn.dir) text = readFileSync(join(turn.dir, 'steer.sent'), 'utf8');
  } catch {
    // None passed on.
  }
  return unsentSteers(turn, text);
}
