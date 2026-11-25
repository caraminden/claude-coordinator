#!/usr/bin/env node
// Ships' CI runs before and after a moment (#1906: is one Citadel job at a time enough?): the last 20 land/ runs that ended
// before it and the first 20 started after it, as gh reads them (read-only).
//   node tools/ship-runs.ts --at 2026-11-25T20:00:00Z [--n 20]
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { repoSlug } from '../src/prlinks.ts';

export interface ShipRun {
  id: number;
  head_branch: string | null;
  conclusion: string | null;
  run_started_at: string;
  updated_at: string;
}

/** Green, red and no-verdict runs, and the median minutes of the green and red ones. */
export function summary(runs: ShipRun[]) {
  const ms = runs.filter((r) => r.conclusion === 'success' || r.conclusion === 'failure').map((r) => Date.parse(r.updated_at) - Date.parse(r.run_started_at));
  ms.sort((a, b) => a - b);
  const green = runs.filter((r) => r.conclusion === 'success').length;
  const red = runs.filter((r) => r.conclusion === 'failure').length;
  return { runs: runs.length, green, red, other: runs.length - green - red, rate: green + red ? Math.round((100 * green) / (green + red)) : null, minutes: ms.length ? Math.round(ms[ms.length >> 1] / 6000) / 10 : null };
}

/** Finished land/ runs either side of `at`: the last `n` before, the first `n` after. */
export function sides(runs: ShipRun[], at: number, n: number) {
  const done = runs.filter((r) => r.head_branch?.startsWith('land/') && r.conclusion).sort((a, b) => Date.parse(a.run_started_at) - Date.parse(b.run_started_at));
  return { before: done.filter((r) => Date.parse(r.updated_at) <= at).slice(-n), after: done.filter((r) => Date.parse(r.run_started_at) >= at).slice(0, n) };
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { at: { type: 'string' }, n: { type: 'string', default: '20' } } });
  const at = Date.parse(values.at ?? '');
  const n = Number(values.n);
  if (!Number.isFinite(at) || !(n > 0)) throw new Error('use: node tools/ship-runs.ts --at <when, ISO> [--n 20]');
  const slug = repoSlug(execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim());
  const runs: ShipRun[] = [];
  for (let page = 1; page <= 10; page++) {
    const got: ShipRun[] = JSON.parse(execFileSync('gh', ['api', `repos/${slug}/actions/workflows/tests.yml/runs?event=push&per_page=100&page=${page}`], { encoding: 'utf8', maxBuffer: 64 << 20 })).workflow_runs;
    runs.push(...got);
    const { before } = sides(runs, at, n);
    if (got.length < 100 || (before.length >= n && got.length)) break;
  }
  const { before, after } = sides(runs, at, n);
  for (const [name, list] of [
    ['before', before],
    ['after', after],
  ] as const) {
    const s = summary(list);
    console.log(`${name}: ${s.runs} ship runs, ${s.green} green, ${s.red} red, ${s.other} other (${s.rate ?? '-'}% green of those with a verdict), median ${s.minutes ?? '-'} min`);
  }
}
