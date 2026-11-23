// The live probe (#1741, rework fix 4): a ship of PROBE_LINES or more names one read-only check of itself, and the
// server runs it once the change is live, with no model turn. A pass is one line in the minion's chat; a fail keeps
// the minion open and wakes it with what the probe saw, so its builder fixes it with the context it still has.
// A probe that can't run (no answer, a timeout, a page that needs a login it couldn't get) says so and isn't a fail.
// Probes are data this file interprets, never commands: GET requests to this server, a SELECT through the masked
// read-only reader (src/db-view.ts), a timing bound, a page shot through tools/ui-shot.ts. The trial and its stop
// rule: docs/adr/0030-live-probe-trial.md.
import { execFile, spawn } from 'node:child_process';
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** A main ship of this many changed lines (added plus removed) or more carries a probe (the trial's line; 200 later). */
export const PROBE_LINES = 600;

/** Lines the branch in `cwd` changes against main (added plus removed, binary files left out); 0 when git can't say. */
// shortcut: a scheme whose trunk isn't named main counts 0 (no probe asked); read its default branch if one ships big changes.
export function changedLines(cwd: string): Promise<number> {
  return new Promise((done) => execFile('git', ['diff', '--numstat', 'main...HEAD'], { cwd, maxBuffer: 16 * 1024 * 1024 }, (err, out) => {
    if (err) return done(0);
    let n = 0;
    for (const line of out.split('\n')) {
      const [a, d] = line.split('\t');
      if (/^\d+$/.test(a) && /^\d+$/.test(d)) n += Number(a) + Number(d);
    }
    done(n);
  }));
}

export type Probe =
  | { kind: 'http'; path: string; status: number; text?: string }
  | { kind: 'timing'; path: string; ms: number }
  | { kind: 'sql'; query: string; min?: number; max?: number }
  | { kind: 'page'; route: string; wait?: string }
  | { kind: 'none'; reason: string };

export interface Outcome {
  result: 'pass' | 'fail' | 'cant';
  /** What it saw, one line. */
  saw: string;
}

/** The kinds, for a refusal that teaches them. */
export const PROBE_HELP = 'probe is one of: {kind:"http", path:"/api/...", status?:200, text?:"expected text"}, {kind:"timing", path:"/api/...", ms:800} (median of 3 GETs), {kind:"sql", query:"SELECT count(*) FROM ...", min?:1, max?:5} (read-only, secrets masked; first column of the first row), {kind:"page", route:"#/p/2/skills", wait?:"css selector"} (a 1440 px shot of the live page), or {kind:"none", reason:"why nothing live can show it"}. Paths are on this server, as the minion\'s own person sees them';

const str = (v: unknown, name: string, max: number, re?: RegExp): string => {
  if (typeof v !== 'string' || !v.trim()) throw new Error(`probe.${name} is required`);
  const s = v.trim();
  if (s.length > max) throw new Error(`probe.${name} is over ${max} characters`);
  if (re && !re.test(s)) throw new Error(`probe.${name} is not a valid ${name}`);
  return s;
};
const int = (v: unknown, name: string, lo: number, hi: number): number => {
  if (!Number.isInteger(v) || (v as number) < lo || (v as number) > hi) throw new Error(`probe.${name} must be a whole number from ${lo} to ${hi}`);
  return v as number;
};
const num = (v: unknown, name: string): number | undefined => {
  if (v === undefined) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`probe.${name} must be a number`);
  return v;
};
/** A path on this server: one leading slash (never another host), no spaces or control characters. */
const PATH = /^\/(?!\/)[^\s\\]*$/;

/** hand_off_land's probe, checked; throws with what's wrong. */
export function parseProbe(x: unknown): Probe {
  if (!x || typeof x !== 'object' || Array.isArray(x)) throw new Error('probe must be an object');
  const o = x as Record<string, unknown>;
  switch (o.kind) {
    case 'http': {
      const p: Probe = { kind: 'http', path: str(o.path, 'path', 300, PATH), status: o.status === undefined ? 200 : int(o.status, 'status', 100, 599) };
      if (o.text !== undefined) p.text = str(o.text, 'text', 200);
      return p;
    }
    case 'timing':
      return { kind: 'timing', path: str(o.path, 'path', 300, PATH), ms: int(o.ms, 'ms', 1, 30_000) };
    case 'sql': {
      const query = str(o.query, 'query', 2000).replace(/;\s*$/, '');
      if (!/^(select|with)\b/i.test(query) || query.includes(';')) throw new Error('probe.query must be one SELECT (or WITH ... SELECT) statement');
      const p: Probe = { kind: 'sql', query, min: num(o.min, 'min'), max: num(o.max, 'max') };
      if (p.min === undefined && p.max === undefined) throw new Error('probe.sql needs min, max or both (both the same for an exact count)');
      if (p.min !== undefined && p.max !== undefined && p.min > p.max) throw new Error('probe.min is over probe.max');
      if (p.min === undefined) delete p.min;
      if (p.max === undefined) delete p.max;
      return p;
    }
    case 'page': {
      const p: Probe = { kind: 'page', route: str(o.route, 'route', 300, /^[#/][^\s]*$/) };
      if (o.wait !== undefined) p.wait = str(o.wait, 'wait', 200, /^[^\n\r]+$/);
      return p;
    }
    case 'none':
      return { kind: 'none', reason: str(o.reason, 'reason', 300) };
    default:
      throw new Error('probe.kind must be http, timing, sql, page or none');
  }
}

/** One line for people: what it checks. */
export function describeProbe(p: Probe): string {
  switch (p.kind) {
    case 'http': return `GET ${p.path} answers ${p.status}${p.text ? ` with "${p.text}"` : ''}`;
    case 'timing': return `GET ${p.path} in ${p.ms} ms or less`;
    case 'sql': return `${p.query} is ${p.min === p.max ? p.min : p.max === undefined ? `at least ${p.min}` : p.min === undefined ? `at most ${p.max}` : `${p.min} to ${p.max}`}`;
    case 'page': return `the live page ${p.route} draws${p.wait ? ` with ${p.wait}` : ''}`;
    case 'none': return `none: ${p.reason}`;
  }
}

export interface ProbeEnv {
  /** This server, e.g. http://127.0.0.1:8573. */
  base: string;
  /** `cc_session=...` for the minion's person, or null (a page that needs a login then can't run). */
  cookie: string | null;
  /** The live database, for sql. */
  dbPath: string;
  /** Where a page probe's shot goes. */
  outDir: string;
  /** Per request; tests shorten it. */
  timeoutMs?: number;
}

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const clip = (s: string, n = 300) => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n)}…` : one;
};

async function get(env: ProbeEnv, path: string): Promise<{ status: number; body: string; ms: number }> {
  const t0 = performance.now();
  const res = await fetch(new URL(path, env.base), { headers: env.cookie ? { cookie: env.cookie } : {}, redirect: 'manual', signal: AbortSignal.timeout(env.timeoutMs ?? 30_000) });
  const body = await res.text();
  return { status: res.status, body, ms: Math.round(performance.now() - t0) };
}

const noAnswer = (err: any): Outcome => ({ result: 'cant', saw: err?.name === 'TimeoutError' ? 'no answer within the time limit' : `no answer: ${clip(String(err?.cause?.code ?? err?.message ?? err), 120)}` });
const login = (env: ProbeEnv): Outcome => ({ result: 'cant', saw: `401: the page needs a login${env.cookie ? ' the minion\'s person doesn\'t have' : ' and the minion has no person to sign in as'}` });

/** Run one probe against the live server. Never throws: a probe that can't run says so. */
export async function runProbe(p: Probe, env: ProbeEnv): Promise<Outcome> {
  try {
    switch (p.kind) {
      case 'none': return { result: 'pass', saw: 'none' };
      case 'http': {
        let r;
        try { r = await get(env, p.path); } catch (err) { return noAnswer(err); }
        if (r.status === 401 && p.status !== 401) return login(env);
        if (r.status !== p.status) return { result: 'fail', saw: `${r.status}, not ${p.status}: ${clip(r.body)}` };
        if (p.text && !r.body.includes(p.text)) return { result: 'fail', saw: `${r.status}, but the body has no "${p.text}": ${clip(r.body)}` };
        return { result: 'pass', saw: `${r.status}${p.text ? ` with "${p.text}"` : ''} in ${r.ms} ms` };
      }
      case 'timing': {
        const times: number[] = [];
        for (let i = 0; i < 3; i++) {
          let r;
          try { r = await get(env, p.path); } catch (err) { return noAnswer(err); }
          if (r.status === 401) return login(env);
          if (r.status < 200 || r.status > 299) return { result: 'fail', saw: `${r.status}: ${clip(r.body)}` };
          times.push(r.ms);
        }
        const median = [...times].sort((a, b) => a - b)[1];
        return { result: median <= p.ms ? 'pass' : 'fail', saw: `median ${median} ms of 3 (${times.join(', ')} ms), bound ${p.ms} ms` };
      }
      case 'sql': {
        const r = await child([join(ROOT, 'src', 'db-view.ts'), env.dbPath], p.query, env.timeoutMs ?? 30_000);
        if (r.timedOut) return { result: 'cant', saw: 'the query ran past the time limit' };
        if (r.code !== 0) return { result: 'fail', saw: `the query failed: ${clip(r.err, 200)}` };
        const lines = r.out.trim().split('\n');
        if (lines.length < 2) return { result: 'fail', saw: 'no rows' };
        const v = Number(lines[1].split('|')[0]);
        // Only a number is ever shown: whatever else the first column holds stays out of the chat.
        if (lines[1].split('|')[0] === '' || !Number.isFinite(v)) return { result: 'fail', saw: 'its first column is not a number' };
        const ok = (p.min === undefined || v >= p.min) && (p.max === undefined || v <= p.max);
        return { result: ok ? 'pass' : 'fail', saw: `${v}` };
      }
      case 'page': {
        const args = [join(ROOT, 'tools', 'ui-shot.ts'), p.route, '--widths', '1440', '--themes', 'light', '--timeout', '30', '--out', env.outDir, ...(p.wait ? ['--wait', p.wait] : [])];
        const r = await child(args, null, 150_000, { DEV_URL: env.base, DEV_COOKIE: env.cookie ?? '', TMPDIR: env.outDir });
        if (r.timedOut) return { result: 'cant', saw: 'the page shot ran past 150 s' };
        const said = `${r.out}\n${r.err}`;
        if (/no browser/.test(said)) return { result: 'cant', saw: 'no headless browser on this server' };
        if (r.code !== 0) return { result: 'fail', saw: clip(said.split('\n').filter((l) => /FAILED|hang|error/i.test(l)).join(' ') || said.slice(-400), 400) };
        return { result: 'pass', saw: `it drew (shots in ${env.outDir})` };
      }
    }
  } catch (err: any) {
    return { result: 'cant', saw: `the probe broke: ${clip(String(err?.message ?? err), 200)}` };
  }
}

/** Run node with `args`, off the event loop, with an optional stdin and a time limit. */
function child(args: string[], input: string | null, ms: number, env: Record<string, string> = {}): Promise<{ code: number | null; out: string; err: string; timedOut: boolean }> {
  return new Promise((done) => {
    const c = spawn(process.execPath, args, { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '', timedOut = false;
    const timer = setTimeout(() => { timedOut = true; c.kill('SIGKILL'); }, ms);
    c.stdout.on('data', (d) => { if (out.length < 64_000) out += d; });
    c.stderr.on('data', (d) => { if (err.length < 64_000) err += d; });
    c.on('error', (e) => { err += e.message; });
    c.on('close', (code) => { clearTimeout(timer); done({ code, out, err, timedOut }); });
    c.stdin.end(input ?? '');
  });
}

/** Where a probe waits between a restart's ship and its live (a setting, so it outlasts the restart). */
export const probeKey = (id: number) => `live-probe:${id}`;
/** The note while a restart's dismissal waits on its probe. */
export const HOLD_NOTE = 'live; running its live probe';
/** A stored probe whose ship never went live in this long is dropped. */
const STALE_MS = 2 * 24 * 3600_000;

interface Stored {
  probe: Probe;
  commit: string | null;
  at: number;
}

export interface ProbeDeps {
  store: {
    getSetting<T>(key: string): T | null;
    setSetting(key: string, value: unknown): void;
    deleteSetting(key: string): void;
    settingKeys(prefix: string): string[];
    getTicket(id: number): { state: string | null; note: string | null; status: string; number?: number; project_id: number } | null | undefined;
    updateTicket(id: number, fields: { state?: string | null; note?: string | null }): unknown;
  };
  runner: {
    emit(id: number, kind: string, data: unknown): unknown;
    send(id: number, author: string, text: string): unknown;
    close(id: number, text: string): Promise<void>;
    broadcastTicket(id: number): void;
    isRunning(id: number): boolean;
    queued(id: number): number;
  };
  from: string;
  /** Run one probe for this minion (runProbe, signed in as its person). */
  run(id: number, p: Probe): Promise<Outcome>;
  /** Whether this server runs `commit` now (a restart's ship). */
  isLive(id: number, commit: string | null): Promise<boolean>;
  /** One row per ship that carried a probe, for the trial's numbers. */
  log(row: Record<string, unknown>): Promise<void> | void;
}

/** The trial's numbers, one JSON line each: $DATA_DIR/live-probes.jsonl. */
export function probeLog(dataDir: string) {
  return (row: Record<string, unknown>) => appendFile(join(dataDir, 'live-probes.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), ...row })}\n`).catch((err) => console.error(`Logging a live probe failed: ${err?.message ?? err}`));
}

export class LiveProbes {
  private running = new Set<number>();
  private readonly d: ProbeDeps;

  constructor(d: ProbeDeps) {
    this.d = d;
  }

  /**
   * A ship with a probe went through (LandHandoffs.settle). `when`: live now runs it now; later (a restart) keeps it
   * for the live (hold, sweep), or runs it now if that already came; nowhere: nothing of the ship is served here.
   * True when it failed and woke the minion.
   */
  async shipped(id: number, probe: Probe, commit: string | null, when: 'live' | 'later' | 'nowhere'): Promise<boolean> {
    const t = this.d.store.getTicket(id);
    const row = { ticket: id, number: t?.number ?? null, scheme: t?.project_id ?? null, commit, kind: probe.kind };
    if (probe.kind === 'none') {
      await this.d.log({ ...row, result: 'none', saw: probe.reason });
      return false;
    }
    if (when === 'nowhere') {
      await this.d.log({ ...row, result: 'cant', saw: 'nothing served here' });
      this.d.runner.emit(id, 'note', { text: `Live probe couldn't run: nothing this ship changed is served by this server. Not counted as a fail.` });
      return false;
    }
    if (when === 'later') {
      this.d.store.setSetting(probeKey(id), { probe, commit, at: Date.now() } satisfies Stored);
      // Its restart may have gone live before land.sh's end was read: then no live will come for it.
      if (!(await this.d.isLive(id, commit).catch(() => false))) return false;
      this.d.store.deleteSetting(probeKey(id));
    }
    return (await this.once(id, probe, commit)) === 'fail';
  }

  /** A probe still waits for this minion's live (Runner.deployLive): hold its dismissal, run it now, and dismiss on a pass. */
  hold(id: number): boolean {
    if (!this.d.store.getSetting<Stored>(probeKey(id))) return false;
    this.d.store.updateTicket(id, { state: 'outside', note: HOLD_NOTE });
    this.d.runner.broadcastTicket(id);
    void this.stored(id, true);
    return true;
  }

  /** The server runs a new head: run each kept probe whose ship it has (a stay_open restart, a hold a restart cut off). */
  async sweep() {
    for (const key of this.d.store.settingKeys('live-probe:')) {
      const id = Number(key.slice('live-probe:'.length));
      const s = this.d.store.getSetting<Stored>(key);
      if (!s || this.running.has(id)) continue;
      if (Date.now() - s.at > STALE_MS) {
        this.d.store.deleteSetting(key);
        await this.d.log({ ticket: id, commit: s.commit, kind: s.probe.kind, result: 'cant', saw: 'never went live' });
        continue;
      }
      if (await this.d.isLive(id, s.commit).catch(() => false)) await this.stored(id, this.d.store.getTicket(id)?.note === HOLD_NOTE);
    }
  }

  private async stored(id: number, closeOnPass: boolean) {
    const s = this.d.store.getSetting<Stored>(probeKey(id));
    if (!s || this.running.has(id)) return;
    try {
      const result = await this.once(id, s.probe, s.commit);
      this.d.store.deleteSetting(probeKey(id));
      const t = this.d.store.getTicket(id);
      // Only a dismissal this held: a person who wrote, a turn or another state since then keeps it open.
      if (result !== 'fail' && closeOnPass && t && t.status !== 'closed' && t.state === 'outside' && t.note === HOLD_NOTE && !this.d.runner.isRunning(id) && !this.d.runner.queued(id)) {
        this.d.store.updateTicket(id, { state: null, note: null });
        await this.d.runner.close(id, `The deploy is live and its live probe ${result === 'pass' ? 'passed' : "couldn't run"}, so it dismissed this minion.`);
      }
    } catch (err: any) {
      console.error(`Minion ${id}'s live probe failed to report: ${err?.message ?? err}`);
    }
  }

  private async once(id: number, probe: Probe, commit: string | null): Promise<Outcome['result']> {
    this.running.add(id);
    try {
      const o = await this.d.run(id, probe).catch((err): Outcome => ({ result: 'cant', saw: `the probe broke: ${err?.message ?? err}` }));
      const t = this.d.store.getTicket(id);
      await this.d.log({ ticket: id, number: t?.number ?? null, scheme: t?.project_id ?? null, commit, kind: probe.kind, result: o.result, saw: o.saw });
      const what = describeProbe(probe);
      if (o.result === 'pass') this.d.runner.emit(id, 'note', { text: `Live probe passed: ${what} (${o.saw}).` });
      else if (o.result === 'cant') this.d.runner.emit(id, 'note', { text: `Live probe couldn't run: ${what} (${o.saw}). Not counted as a fail.` });
      else {
        this.d.store.updateTicket(id, { state: null, note: 'live probe failed' });
        this.d.runner.broadcastTicket(id);
        this.d.runner.send(id, this.d.from, `Your live probe failed once your ship${commit ? ` ${commit}` : ''} went live.\n\nProbe: ${what}\nIt saw: ${o.saw}\n\nThe change is live, so people may be hitting this now. If it's a real defect, fix it with what you know and hand the fix off with hand_off_land. If the probe was wrong and the change is fine, say so in one line and close_self: the trial counts wrong fails against real ones.`);
      }
      return o.result;
    } finally {
      this.running.delete(id);
    }
  }
}
