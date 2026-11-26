// The server notices a stall (#1139, G5 from #1092; Josh picked it 2026-11-19). Three signals, counted per minion from what
// its turns stream: the same test red three times, the same file edited after four failed checks in a row, two failed ships (not counting
// the refusals in NOT_THE_MODELS).
// On a signal the minion's Taskmaster gets one message with the evidence and the step-up the model table names
// (nextStep in public/model-table.js). It suggests; it changes nothing. One suggestion per minion per tier.
// The parsing half (testCommand, checkCommand, failingTests, editedFiles) is pure and shared: the third-fix flag (B4) reads
// the same signals across minions.
import type { Store, Ticket } from './db.ts';
import { nextStep, tierLabel } from '../public/model-table.js';
import { classifyLandFailure, NO_CODE } from './land.ts';
import type { ClaudeEvent, ContentBlock } from './claude-events.ts';

/** Thresholds, from the handoff (starting values: the two-week read says whether they hold). */
export const RED_TIMES = 3;
export const CHURN_ROUNDS = 4;
export const SHIP_FAILS = 2;
/** Refusals the minion couldn't help, so they say nothing about its model and don't count (#2047, Josh, 2026-11-25). */
const NOT_THE_MODELS = new Set(['conflict', 'passed-alone', 'boot-copy', 'cut-off', 'ci', 'no-answer']);

/**
 * A failed ship's kind: classifyLandFailure's, or `no-answer` for exit 75 (CI gave no verdict), or `cut-off` for a run that
 * ended with no exit code, whatever it printed first (as the ship trail reads it).
 */
export function refusalKind(output: string, code: number | null = null): string | null {
  if (code === 75) return 'no-answer';
  return output.trimEnd().endsWith(NO_CODE.trim()) ? 'cut-off' : (classifyLandFailure(output)?.kind ?? null);
}

// A tool name only counts as the command a segment runs (at the start, or after ;, &, |, a bracket or a newline), past any
// VAR=value, cd, timeout or wrapper (citadel-heavy, npx), and as a whole word: `cat $TMPDIR/citadel-test.log` and
// `grep -rn pytest pyproject.toml` are no test runs.
const PREFIX = String.raw`(?:(?:\w+=\S*|citadel-heavy(?:\s+--(?:here|heavy))*|citadel-job(?:\s+--minutes\s+\S+)?|npx|env|time|nice|timeout\s+\S+|(?:pnpm|yarn)\s+exec)\s+)*`;
const words = (alts: string) => new RegExp(`(?:^|[;&|(\`\n]|\\$\\()\\s*${PREFIX}(?:${alts})(?=$|[\\s;&|)\`])`, 'i');
const TESTS = words(String.raw`citadel-test|node\s+--test|(?:npm|pnpm|yarn)\s+(?:run\s+)?test|cargo\s+(?:test|nextest)|pytest|vitest|jest|go\s+test|\S*run-tests(?:\.sh)?|\S*gradlew\s+\S*[tT]est\w*|deno\s+test|bun\s+test|dotnet\s+test`);
const CHECKS = words(String.raw`cargo\s+(?:build|check|clippy)|tsc|(?:npm|pnpm|yarn)\s+run\s+(?:build|lint|check|typecheck)|eslint|\S*gradlew\s+\S*(?:build|assemble)\w*|dotnet\s+build|go\s+(?:build|vet)`);
const LAND = /(?:^|[\s;&|(])\S*tools\/land\.sh(?=$|\s)/;
const SHIP = 'ship';
/** A shell command that runs tests, in any scheme's stack. */
export const testCommand = (cmd: string) => TESTS.test(cmd);
/** A shell command that checks the code: a test run, a build, type check or lint. */
export const checkCommand = (cmd: string) => testCommand(cmd) || CHECKS.test(cmd);

// One pattern per runner's way of naming a failed test; group 1 (and 2) the name kept. citadel-test's line is
// `✖ test/x.test.ts:91 › name`: the file and name are kept, the line number moves as the test is edited.
const FAILED: RegExp[] = [
  /^\s*✖ (test\/[^\s:]+)(?::\d+)?(?: (› .+?))?\s*$/gm, // citadel-test
  /^\s*not ok \d+ - (.+?)\s*(?:#.*)?$/gm, // node --test (TAP)
  /^test (\S+) \.\.\. FAILED$/gm, // cargo
  /^FAILED (\S+)/gm, // pytest
  /^\s*--- FAIL: (\S+)/gm, // go
  /^\s*FAIL (\S+\.\w+)/gm, // jest, vitest
];

/** The failed tests a test run's output names, deduped, at most 20. */
export function failingTests(output: string): string[] {
  const names = new Set<string>();
  for (const re of FAILED) for (const m of output.matchAll(re)) names.add((m[2] ? `${m[1]} ${m[2]}` : m[1]).trim().slice(0, 200));
  return [...names].slice(0, 20);
}

/** The files an edit tool call writes (Claude's edit tools, or a Codex turn's apply_patch: `files: ['update <path>']`). */
export function editedFiles(block: ContentBlock): string[] {
  if (block?.type !== 'tool_use') return [];
  if (block.name === 'apply_patch') return (Array.isArray(block.input?.files) ? block.input.files : []).map((f: unknown) => String(f).replace(/^\S+ /, '')).filter(Boolean);
  if (!['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(block.name ?? '')) return [];
  const p = block.input?.file_path ?? block.input?.notebook_path;
  return typeof p === 'string' && p ? [p] : [];
}

export type SignalKind = 'red-test' | 'file-churn' | 'failed-ships';
export interface Signal {
  kind: SignalKind;
  what: string;
  evidence: string[];
}

/** One minion's counts, kept in settings between events (stallKey). shortcut: kept after the minion closes (under 1 KB each); sweep them if settings grow. */
export interface StallState {
  /** Test name → times red, since the last suggestion sent. shortcut: not reset by a later green (a run doesn't say which tests it ran); fine while thresholds are this low. */
  reds: Record<string, number>;
  /** Bash tool_use id → its command, while it waits for its result. */
  pending: Record<string, string>;
  /** Since the last green test run: whether a check has failed, and file → rounds (failed checks it was edited after). */
  failing: boolean;
  rounds: Record<string, number>;
  /** Files edited since the newest failed check. */
  touched: string[];
  /** The failed ships' kinds since the last suggestion sent, oldest first. */
  ships: string[];
  /** Tiers (`model effort`) already suggested a step-up from. */
  sent: string[];
}

export const emptyState = (): StallState => ({ reds: {}, pending: {}, failing: false, rounds: {}, touched: [], ships: [], sent: [] });

const short = (s: string, n = 120) => (s.length > n ? `${s.slice(0, n)}…` : s);
const base = (p: string) => p.split('/').slice(-2).join('/');

/**
 * Feed one stream event (slimmed, as the runner stores it) into a minion's counts. Returns the signals this event pushed
 * over a threshold (each fires once, on the event that reaches it). `changed` tells the caller whether to save the state.
 */
export function observe(s: StallState, ev: ClaudeEvent): { signals: Signal[]; changed: boolean } {
  const signals: Signal[] = [];
  let changed = false;
  if (ev?.parent_tool_use_id || !Array.isArray(ev?.message?.content)) return { signals, changed };
  for (const b of ev.message.content) {
    if (ev.type === 'assistant' && b?.type === 'tool_use') {
      // A ship the minion runs itself (the land tool, or land.sh in a build's own turn) counts like a handed-off one.
      const ship = b.name === 'mcp__thread__land' || (b.name === 'Bash' && LAND.test((b.input?.command as string | undefined) ?? ''));
      if (ship || (b.name === 'Bash' && typeof b.input?.command === 'string' && checkCommand(b.input.command))) {
        s.pending[b.id!] = ship ? SHIP : short(b.input!.command as string, 200);
        changed = true;
        continue;
      }
      for (const file of s.failing ? editedFiles(b) : []) {
        if (s.touched.includes(file)) continue;
        s.touched.push(file);
        s.rounds[file] = (s.rounds[file] ?? 0) + 1;
        changed = true;
        if (s.rounds[file] === CHURN_ROUNDS) signals.push({ kind: 'file-churn', what: `${base(file)} edited after ${CHURN_ROUNDS} failed checks in a row`, evidence: [file] });
      }
    } else if (ev.type === 'user' && b?.type === 'tool_result' && b.tool_use_id! in s.pending) {
      const cmd = s.pending[b.tool_use_id!];
      delete s.pending[b.tool_use_id!];
      changed = true;
      const out = typeof b.content === 'string' ? b.content : '';
      if (cmd === SHIP) {
        if (b.is_error || /^tools\/land\.sh exited [1-9]/.test(out)) signals.push(...shipFailed(s, refusalKind(out) ?? 'land.sh run by the minion'));
        continue;
      }
      const names = testCommand(cmd) ? failingTests(out) : [];
      if (!b.is_error && !names.length) {
        // Green: a test run ends the stretch; a passing build or lint says nothing about the tests.
        if (testCommand(cmd)) Object.assign(s, { failing: false, rounds: {}, touched: [] });
        continue;
      }
      s.failing = true;
      s.touched = [];
      if (!testCommand(cmd)) continue;
      for (const name of names.length ? names : [`exit: ${short(cmd, 80)}`]) {
        s.reds[name] = (s.reds[name] ?? 0) + 1;
        if (s.reds[name] === RED_TIMES) signals.push({ kind: 'red-test', what: `${short(name, 100)} red ${RED_TIMES} times`, evidence: [`last run: ${short(cmd)}`] });
      }
    }
  }
  // A turn that ended (or crashed) leaves its calls without results: drop them so the state stays small.
  if (ev.type === 'user' && Object.keys(s.pending).length > 20) s.pending = Object.fromEntries(Object.entries(s.pending).slice(-20));
  return { signals, changed };
}

/** A failed ship (src/land.ts settle, a land.sh run in the minion's own turn, or red CI on a PR scheme's PR); `kind` is classifyLandFailure's, or what failed. */
export function shipFailed(s: StallState, kind: string): Signal[] {
  if (NOT_THE_MODELS.has(kind)) return [];
  // Filtered again: a count saved before #2047 can hold kinds that no longer count.
  s.ships = [...s.ships.filter((k) => !NOT_THE_MODELS.has(k)), kind];
  return s.ships.length === SHIP_FAILS ? [{ kind: 'failed-ships', what: `${SHIP_FAILS} failed ships`, evidence: [`kinds: ${s.ships.join(', ')}`] }] : [];
}

export const stallKey = (ticketId: number) => `stall:${ticketId}`;
/** Every suggestion sent, newest last, for the two-week read (was it taken, did it help). */
export const SUGGESTIONS_KEY = 'stall-suggestions';
export interface Suggestion {
  ticket: number;
  project: number;
  number: number | null;
  at: number;
  kind: SignalKind;
  what: string;
  from: string;
  to: string | null;
}

export interface StallDeps {
  store: Store;
  /** Message the minion's Taskmaster (runner.relay to ownerCoordinator; a held relay still counts as told); false when it has none. */
  tell: (ticket: Ticket, text: string) => boolean;
  /** A note in the minion's own chat, so people see what the server suggested. */
  note: (ticketId: number, text: string) => void;
  now?: () => number;
}

/** The live half: loads and saves each minion's counts, and sends the one suggestion per tier. */
export class StallWatch {
  private d: StallDeps;
  constructor(d: StallDeps) {
    this.d = d;
  }

  observe(ticketId: number, ev: ClaudeEvent) {
    if (ev?.type !== 'assistant' && ev?.type !== 'user') return;
    const s = this.d.store.getSetting<StallState>(stallKey(ticketId)) ?? emptyState();
    const { signals, changed } = observe(s, ev);
    if (changed) this.d.store.setSetting(stallKey(ticketId), s);
    if (signals.length) this.suggest(ticketId, s, signals);
  }

  shipFailed(ticketId: number, kind: string | null) {
    const s = this.d.store.getSetting<StallState>(stallKey(ticketId)) ?? emptyState();
    const signals = shipFailed(s, kind ?? 'unclassified');
    this.d.store.setSetting(stallKey(ticketId), s);
    if (signals.length) this.suggest(ticketId, s, signals);
  }

  private suggest(ticketId: number, s: StallState, signals: Signal[]) {
    const t = this.d.store.getTicket(ticketId);
    if (!t || t.kind === 'coordinator' || t.status === 'closed') return;
    const [model, effort] = [t.model ?? t.last_model, t.effort ?? t.last_effort];
    const tier = `${model ?? 'none'} ${effort ?? 'none'}`;
    // Counted afresh once told (here or below), so the same stall going on at the next tier reaches its threshold again (2R2).
    const afresh = () => Object.assign(s, { reds: {}, rounds: {}, ships: [] });
    // Its Taskmaster already has this tier's suggestion: these counts are covered by it.
    if (s.sent.includes(tier)) return void this.d.store.setSetting(stallKey(ticketId), afresh());
    const fable = this.d.store.getProject(t.project_id)?.fable_ok !== 'off';
    const next = nextStep(model, effort, fable);
    const now = tierLabel(model, effort);
    const step = next
      ? `The model table's next step from ${now} is ${tierLabel(next.model, next.effort)}: update_ticket with model ${next.model}, effort ${next.effort}.`
      : !model
        ? `It runs with no model set, so the table names no step: set one by its kind of work.`
        : /opus|fable/.test(model)
          ? `It already runs on ${now}, the top of the model table${fable ? '' : ' with Fable off'}: a step-up isn't there; diagnosis (citadel:diagnosing-bugs) or a person is.`
          : `The model table names no step from ${now}: pick one by hand, or try diagnosis (citadel:diagnosing-bugs).`;
    const lines = signals.map((g) => `- ${g.what} (${g.evidence.join('; ')})`);
    const text = `Stall signal on #${t.number} ${t.title}:\n${lines.join('\n')}\n${step} A suggestion only: nothing was changed. Skip it when the cause isn't the model (a flake, CI or a runner, a merge conflict, a person's answer it waits on), and say which you did in one line.`;
    // No Taskmaster to tell (a scheme without one yet): nothing is recorded, so the minion's next tier isn't spent.
    if (!this.d.tell(t, text)) return;
    afresh();
    s.sent.push(tier);
    this.d.store.setSetting(stallKey(ticketId), s);
    this.d.note(ticketId, `Stall signal: ${signals.map((g) => g.what).join('; ')}. Suggested ${next ? tierLabel(next.model, next.effort) : 'a look'} to the Taskmaster; nothing changed.`);
    const list = this.d.store.getSetting<Suggestion[]>(SUGGESTIONS_KEY) ?? [];
    for (const g of signals) list.push({ ticket: t.id, project: t.project_id, number: t.number, at: (this.d.now ?? Date.now)(), kind: g.kind, what: g.what, from: tier, to: next ? `${next.model} ${next.effort}` : null });
    this.d.store.setSetting(SUGGESTIONS_KEY, list.slice(-500));
  }
}
