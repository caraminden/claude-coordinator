// Numbers a scheme's CI sends per run, kept per commit for months, charted, and flagged when a step up holds (#1369).
// Josh, 2026-11-19, on Peek Auras #636: "Build" on idea C3 (bench numbers kept for months, with a chart). Cara,
// 2026-11-20, on Peek Auras' rollout page: "Keep CI numbers per commit and flag a step up"; on #1369's card: the charts
// in a new tab on the CI page, and a flag once 3 runs in a row are over 5% above the 10 runs before and past their
// usual run-to-run wobble. A flag wakes the scheme's Taskmaster; it never blocks a ship.
//
// A job sends them with its GitHub run token, as a CI store upload does (src/ci-store.ts): the scheme, workflow, run,
// commit and ref come from the token, the job sends only names, values and units (kit/skills/ci-store/ci-numbers.sh).
import { median as statsMedian } from './stats.ts';
import type { CiNumber, CiNumberStep, Project, Store } from './db.ts';
import type { RunClaims } from './ci-store.ts';
import { HttpError } from './http.ts';
import { repoSlug } from './prlinks.ts';

const DAY = 24 * 60 * 60_000;

/** The step-up rule: `held` runs in a row each above the median of the `base` runs before by `pct` and by `noise` × their median wobble. */
export const STEP = { held: 3, base: 10, pct: 0.05, noise: 3 };

/** Small by rule: numbers, not reports. */
export const LIMITS = { perUpload: 50, series: 100, bodyBytes: 16_384, keepMs: 400 * DAY };

export const NUMBER_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,79}$/;
const UNIT = /^[\p{L}%/]{0,12}$/u;

export interface Sent {
  name: string;
  value: number;
  unit: string;
}

export const median = (xs: number[]): number => statsMedian(xs) ?? NaN;

/** A series' values, oldest first: the step up its last `held` runs make over the runs before, or null. */
export function stepUp(values: number[], rule = STEP): { baseline: number; level: number } | null {
  if (values.length < rule.held + rule.base) return null;
  const held = values.slice(-rule.held);
  const base = values.slice(-rule.held - rule.base, -rule.held);
  const baseline = median(base);
  const wobble = median(base.map((v) => Math.abs(v - baseline)));
  const bar = baseline + Math.max(rule.pct * Math.abs(baseline), rule.noise * wobble);
  return held.every((v) => v > bar) ? { baseline, level: median(held) } : null;
}

/** A request body's numbers, checked: `{ numbers: [{ name, value, unit? }] }`. */
export function parseNumbers(body: unknown): Sent[] {
  const list = (body as { numbers?: unknown } | null)?.numbers;
  if (!Array.isArray(list) || !list.length) throw new HttpError(400, 'Send { "numbers": [{ "name", "value", "unit" }] } with at least one');
  if (list.length > LIMITS.perUpload) throw new HttpError(413, `A run sends at most ${LIMITS.perUpload} numbers`);
  const seen = new Set<string>();
  return list.map((n: any) => {
    const name = n?.name, value = n?.value, unit = n?.unit ?? '';
    if (typeof name !== 'string' || !NUMBER_NAME.test(name)) throw new HttpError(400, `A number's name is letters, digits and . _ + -, at most 80: ${JSON.stringify(name)?.slice(0, 90)}`);
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new HttpError(400, `${name}'s value is not a number`);
    if (typeof unit !== 'string' || !UNIT.test(unit)) throw new HttpError(400, `${name}'s unit is letters, % and /, at most 12`);
    if (seen.has(name)) throw new HttpError(400, `${name} is in the upload twice`);
    seen.add(name);
    return { name, value, unit };
  });
}

const round = (v: number) => +v.toPrecision(4);

export class CiNumbers {
  private store: Store;
  private now: () => number;
  /** Told of each step up as it is flagged: server.ts wakes the scheme's Taskmaster with `words`. */
  onStep: (project: Project, step: CiNumberStep, words: string) => void = () => {};

  constructor(store: Store, now: () => number = Date.now) {
    this.store = store;
    this.now = now;
  }

  /** Keep a run's numbers, then flag any series of them whose step up has just held. */
  take(project: Project, claims: RunClaims, body: unknown): { stored: number; steps: CiNumberStep[] } {
    const sent = parseNumbers(body);
    const names = new Set(this.store.ciNumberNames(project.id));
    const fresh = sent.filter((n) => !names.has(n.name)).length;
    if (names.size + fresh > LIMITS.series) throw new HttpError(413, `${project.name} has ${names.size} series of CI numbers; a scheme keeps at most ${LIMITS.series}, so a new one is refused`);
    const at = this.now();
    // A ship's land/<branch> run is main's next commit (tools/land.sh pushes the commit it is about to land there), so it is main's line.
    const ref = claims.ref.startsWith('refs/heads/land/') ? 'refs/heads/main' : claims.ref;
    this.store.putCiNumbers(sent.map((n) => ({ project_id: project.id, ...n, workflow: claims.workflow, run_id: claims.runId, run_attempt: claims.runAttempt, sha: claims.sha, ref, created_at: at })));
    const steps = sent.flatMap((n) => this.check(project, n.name, ref) ?? []);
    return { stored: sent.length, steps };
  }

  /** The rule on one series' runs of one ref: a new step, recorded and told, or null (none, or that step is flagged already). */
  private check(project: Project, name: string, ref: string): CiNumberStep | null {
    // Each ref is its own line, so a branch's slow tries never count against main's; only the charted line is watched.
    if (this.store.ciNumberMainRef(project.id, name) !== ref) return null;
    const runs = this.store.ciNumberRuns(project.id, name, ref, STEP.held + STEP.base);
    const found = stepUp(runs.map((n) => n.value));
    if (!found) return null;
    // Flagged once: a step marked inside these runs is this one still holding, unless this level is a further step over it.
    const earlier = this.store.ciNumberStepsSince(project.id, name, ref, runs[0].created_at);
    if (earlier.some((s) => found.level <= s.level + STEP.pct * Math.abs(s.level))) return null;
    const first = runs[runs.length - STEP.held];
    const step: CiNumberStep = { id: 0, project_id: project.id, name, ref, run_id: first.run_id, sha: first.sha, created_at: first.created_at, baseline: found.baseline, level: found.level, flagged_at: this.now() };
    this.store.addCiNumberStep(step);
    this.onStep(project, step, this.words(project, step, first));
    return step;
  }

  private words(project: Project, s: CiNumberStep, first: CiNumber): string {
    const u = first.unit ? ` ${first.unit}` : '';
    const pct = s.baseline ? ` (+${Math.round(((s.level - s.baseline) / Math.abs(s.baseline)) * 100)}%)` : '';
    const slug = repoSlug(project.repo_url);
    const commit = slug ? `https://github.com/${slug}/commit/${s.sha}` : s.sha.slice(0, 10);
    return `CI numbers: ${s.name} in ${project.name} stepped up ${round(s.baseline)}${u} → ${round(s.level)}${u}${pct} and held for ${STEP.held} runs on ${s.ref.replace(/^refs\/heads\//, '')}, ` +
      `starting at ${first.workflow} run ${s.run_id}, commit ${commit}. The CI page's Numbers tab charts it. A flag, not a gate: check whether it's a real slowdown and which change made it.`;
  }

  /**
   * A scheme's series for the chart: each on the ref most of its runs are on (the default branch, in practice), with
   * every point's commit and run, and its steps.
   */
  view(projectId: number) {
    const all = this.store.ciNumbers(projectId);
    const steps = this.store.ciNumberSteps(projectId);
    const byName = Map.groupBy(all, (n) => n.name);
    const series = [...byName].map(([name, rows]) => {
      const refs = Map.groupBy(rows, (n) => n.ref);
      const [ref, onRef] = [...refs].sort((a, b) => b[1].length - a[1].length)[0];
      return {
        name, ref, unit: onRef.at(-1)!.unit,
        // shortcut: the chart gets a series' last 500 runs, not all 400 days of them; page through older runs if a scheme sends many a day.
        points: onRef.slice(-500).map((n) => ({ value: n.value, sha: n.sha, run_id: n.run_id, workflow: n.workflow, at: n.created_at })),
        steps: steps.filter((s) => s.name === name && s.ref === ref).map((s) => ({ run_id: s.run_id, sha: s.sha, at: s.created_at, baseline: s.baseline, level: s.level })),
      };
    }).sort((a, b) => a.name.localeCompare(b.name));
    const slug = repoSlug(this.store.getProject(projectId)?.repo_url ?? null);
    return { repo: slug ? `https://github.com/${slug}` : null, series, rules: { ...STEP, keepDays: LIMITS.keepMs / DAY } };
  }

  /** Drop what is past the keep; the count of numbers dropped. */
  sweep(): number {
    return this.store.pruneCiNumbers(this.now() - LIMITS.keepMs);
  }
}
