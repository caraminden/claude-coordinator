// Holding a warm session's prompt (#1276). Every turn rebuilds its system prompt (#618), and any changed byte in it
// makes the next call re-write the whole cached conversation. So while a session is warm (its last turn ended under an
// hour ago), it keeps the system prompt it last ran with, and what changed since reaches it as a short note in the turn
// message. It takes the new prompt whole when it is next cold, starts a new session, after HOLD_CAP_MS, or when the
// change is too long for a note (NOTE_MAX). The held texts are kept once per version, in files under the data dir.
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promptText, type PromptSections } from './prompts.ts';

/** A prompt cache entry lives an hour after its last read: past that, nothing is saved by holding. */
export const HOLD_WARM_MS = 60 * 60_000;
/** The longest a session keeps one held prompt; then it takes the new one and pays once. */
export const HOLD_CAP_MS = 8 * 60 * 60_000;
/** A change note longer than this is no longer "short": the session takes the new prompt instead. */
export const NOTE_MAX = 8000;

/** The settings key of a minion's or Taskmaster's hold. */
export const holdKey = (ticketId: number) => `prompt_hold:${ticketId}`;

export interface HoldRecord {
  /** The held system prompt's hash: its sections are in `<dir>/<hash>.json`. */
  hash: string;
  /** When the session took this prompt. */
  since: number;
  /** The session it was taken for; null until the first turn of a new session reports its id. */
  session: string | null;
  /** The hash of the newest prompt whose changes the session has read in a note (or the held one). */
  sent: string;
  /** The hash whose note the running turn carries: it becomes `sent` once that turn has run. */
  pending?: string;
}

export const promptHash = (sections: PromptSections): string => createHash('sha256').update(promptText(sections)).digest('hex').slice(0, 16);

export interface HoldDecision {
  /** The system prompt this turn runs with: the held one, or the current one. */
  system: PromptSections;
  /** The turn message's note of what changed, or null. */
  note: string | null;
  /** Whether `system` is an older prompt than the current one. */
  held: boolean;
  /** The record to save once the turn launches (Holds.save), or null to leave it as it is. */
  record: HoldRecord;
  /** Why it took the current prompt, for the log: null when it held or nothing changed. */
  reload: 'cold' | 'session' | 'cap' | 'too-long' | null;
}

/**
 * Which system prompt a turn runs with. `held` is the record's sections (null when its file is gone), `session` the
 * session the turn resumes (null for a new one), `lastEnd` when its last turn ended.
 */
export function decideHold(o: { record: HoldRecord | null; held: PromptSections | null; current: PromptSections; session: string | null; lastEnd: number | null; now: number }): HoldDecision {
  const { record, held, current, session, lastEnd, now } = o;
  const hash = promptHash(current);
  const take = (reload: HoldDecision['reload']): HoldDecision => ({ system: current, note: null, held: false, record: { hash, since: now, session, sent: hash }, reload });
  if (!record || !session) return take(null);
  if (record.session !== session) return take('session');
  if (!held) return take('cold');
  if (lastEnd === null || now - lastEnd >= HOLD_WARM_MS) return take(record.hash === hash ? null : 'cold');
  // Back to the held text: a session that read a note about a later version hears that it no longer applies.
  if (record.hash === hash) return { system: current, note: record.sent === hash ? null : BACK_NOTE, held: false, record: { ...record, pending: hash }, reload: null };
  if (now - record.since >= HOLD_CAP_MS) return take('cap');
  const note = changeNote(held, current);
  if (note.length > NOTE_MAX) return take('too-long');
  // The note goes once per change: a session that read it keeps it in its conversation (a compaction clears `sent`).
  return { system: held, note: record.sent === hash ? null : note, held: true, record: { ...record, pending: hash }, reload: null };
}

/** The note for a session whose instructions changed and then changed back to its system prompt's. */
export const BACK_NOTE = 'Your instructions are back to this conversation\'s system prompt as written: the last note about changed instructions no longer applies.';

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * What changed from the held prompt to the current one, line by line: each new or reworded line in full under its
 * heading, and the start of each line that no longer stands. Order and repeats are ignored: rules are lines.
 */
export function changeNote(held: PromptSections, current: PromptSections): string {
  const linesOf = (lines: string[] | undefined) => (lines ?? []).join('\n').split('\n');
  const added: string[] = [];
  const removed: string[] = [];
  for (const name of new Set([...Object.keys(current), ...Object.keys(held)])) {
    const was = linesOf(held[name]);
    const now = linesOf(current[name]);
    const wasSet = new Set(was);
    const nowSet = new Set(now);
    let heading = '';
    let shown = '';
    for (const line of now) {
      if (/^#{1,6} /.test(line)) heading = line;
      if (!line.trim() || wasSet.has(line)) continue;
      if (heading && heading !== shown && heading !== line) {
        added.push(`Under "${heading}":`);
        shown = heading;
      }
      added.push(line);
    }
    for (const line of was) if (line.trim() && !nowSet.has(line)) removed.push(`- "${clip(line, 120)}"`);
  }
  return [
    'Your instructions changed since this conversation\'s system prompt was written. It stays as it was until your next cold start, so your prompt cache stays warm; these lines are current and win over the old wording in it.',
    ...(added.length ? ['New or reworded:', ...added] : []),
    ...(removed.length ? ['No longer in force (the old lines that start):', ...removed] : []),
  ].join('\n');
}

type Settings = { getSetting<T>(key: string): T | null; setSetting(key: string, value: unknown): void };

/** The held prompts, one file per version, and each session's record in the settings. */
export class Holds {
  private dir: string;
  private settings: Settings;
  private swept = 0;
  constructor(dir: string, settings: Settings) {
    this.dir = dir;
    this.settings = settings;
  }

  private set(key: string, value: unknown) {
    this.settings.setSetting(key, value);
  }

  record(ticketId: number): HoldRecord | null {
    return this.settings.getSetting<HoldRecord>(holdKey(ticketId));
  }

  /** A version's sections, or null when its file is gone (swept, or never written). */
  sections(hash: string): PromptSections | null {
    try {
      return JSON.parse(readFileSync(join(this.dir, `${hash}.json`), 'utf8'));
    } catch {
      return null;
    }
  }

  /** Save a launched turn's record, and its prompt's file when it took a new one. */
  save(ticketId: number, d: HoldDecision, now = Date.now()) {
    if (!d.held) this.keep(d.record.hash, d.system, now);
    this.set(holdKey(ticketId), d.record);
  }

  /** The turn ran: the note it carried has been read, and a new session's id is known. */
  ran(ticketId: number, session: string | null) {
    const r = this.record(ticketId);
    if (!r) return;
    const { pending, ...rest } = r;
    this.set(holdKey(ticketId), { ...rest, sent: pending ?? r.sent, session: session ?? r.session });
  }

  /** A compaction summarised the conversation, notes and all: the next turn carries the note again. */
  compacted(ticketId: number) {
    const r = this.record(ticketId);
    if (!r) return;
    const { pending: _, ...rest } = r;
    this.set(holdKey(ticketId), { ...rest, sent: r.hash });
  }

  private keep(hash: string, sections: PromptSections, now: number) {
    const file = join(this.dir, `${hash}.json`);
    try {
      mkdirSync(this.dir, { recursive: true });
      // Touched on every take, so a file younger than the cap is never swept from under a hold.
      try {
        utimesSync(file, now / 1000, now / 1000);
      } catch {
        writeFileSync(file, JSON.stringify(sections));
      }
      if (now - this.swept > 10 * 60_000) this.sweep(now);
    } catch (err: any) {
      // No file: the next turn finds no held text and takes the current prompt, as before #1276.
      console.error(`[prompt-hold] could not keep ${file}: ${err.message}`);
    }
  }

  /** Files older than the cap (and an hour) belong to no hold that can still be used. */
  sweep(now = Date.now()) {
    this.swept = now;
    for (const name of readdirSync(this.dir)) {
      const file = join(this.dir, name);
      try {
        if (now - statSync(file).mtimeMs > HOLD_CAP_MS + HOLD_WARM_MS) rmSync(file, { force: true });
      } catch {
        // Gone already.
      }
    }
  }
}
