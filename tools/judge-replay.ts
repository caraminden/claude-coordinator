#!/usr/bin/env node
// judge-replay (#1503): run a registered judge (src/judges.ts) over recent real inputs and print what it would do now,
// beside what it really did. No model; the live database is opened read-only and the judge's own writes stay in memory.
//   node tools/judge-replay.ts <judge id> [--days N] [--scheme N] [--db path] [--record]
//   node tools/judge-replay.ts --list
// --record writes the replay to test/judge-replays.json with the judge's hash, which test/judges.test.ts checks: run it
// after changing a judge's pinned code, and read the hits first. Exit 0, or 2 on a bad argument.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { JUDGES, judge, type ReplayRecord } from '../src/judges.ts';
import { judgeHash } from './judge-replays/pins.ts';
import { pacific } from '../src/pacific.ts';
import { LIVE_DB } from './judge-replays/store.ts';
import type { Act, ReplayCtx, ReplayResult } from './judge-replays/types.ts';

const ROOT = join(import.meta.dirname, '..');
export const RECORDS = join(ROOT, 'test', 'judge-replays.json');

export function readRecords(): Record<string, ReplayRecord> {
  try {
    return JSON.parse(readFileSync(RECORDS, 'utf8'));
  } catch {
    return {};
  }
}

/** Hits next to real acts, paired by key: both, only the replay (it would act now and didn't), only real (it no longer would). */
export function pair(r: ReplayResult) {
  const realKeys = new Set(r.real.map((a) => a.key));
  const hitKeys = new Set(r.hits.map((a) => a.key));
  return {
    both: r.hits.filter((h) => realKeys.has(h.key)),
    replayOnly: r.hits.filter((h) => !realKeys.has(h.key)),
    realOnly: r.real.filter((a) => !hitKeys.has(a.key)),
  };
}

async function main(argv: string[]) {
  const flag = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv.splice(i, 2)[1] : undefined; };
  const days = Number(flag('--days') ?? 3);
  const scheme = flag('--scheme');
  const db = flag('--db') ?? LIVE_DB;
  const record = argv.includes('--record');
  const id = argv.find((a) => !a.startsWith('--'));
  const records = readRecords();
  if (argv.includes('--list') || !id) {
    for (const j of JUDGES) {
      const rec = records[j.id];
      const state = j.replay === true ? (rec ? (rec.hash === judgeHash(j, ROOT) ? `replayed ${rec.at}` : 'CHANGED since its replay') : 'never replayed') : `not yet: ${j.replay.notYet}`;
      console.log(`${j.id.padEnd(16)} ${j.mode.padEnd(8)} ${state}`);
    }
    return id || argv.includes('--list') ? 0 : 2;
  }
  const j = judge(id);
  if (!j) return console.error(`No judge ${id}: node tools/judge-replay.ts --list names them.`), 2;
  if (j.replay !== true) return console.error(`${id} has no replay yet: ${j.replay.notYet}`), 2;
  if (!(days > 0)) return console.error('--days takes a number of days.'), 2;
  const mod = (await import(`./judge-replays/${id}.ts`)) as { replay(ctx: ReplayCtx): Promise<ReplayResult> };
  const t0 = Date.now();
  const r = await mod.replay({ db, days, scheme: scheme ? Number(scheme) : null, now: Date.now(), repo: ROOT });
  const { both, replayOnly, realOnly } = pair(r);
  const line = (a: Act) => `  ${pacific(a.at)}  ${a.key}  ${a.text.slice(0, 220)}`;
  console.log(`${j.name}, the last ${days} day${days === 1 ? '' : 's'}: read ${r.inputs} in ${((Date.now() - t0) / 1000).toFixed(1)} s.`);
  console.log(`It would act ${r.hits.length} time${r.hits.length === 1 ? '' : 's'} now; it really acted ${r.real.length}.`);
  console.log(`\nBoth (${both.length}):`); both.forEach((a) => console.log(line(a)));
  console.log(`\nOnly the replay: new with today's code (${replayOnly.length}):`); replayOnly.forEach((a) => console.log(line(a)));
  console.log(`\nOnly real: today's code wouldn't (${realOnly.length}):`); realOnly.forEach((a) => console.log(line(a)));
  console.log(`\nWhat it can't see: ${r.limits.join('; ')}.`);
  if (record) {
    const rec: ReplayRecord = {
      hash: judgeHash(j, ROOT), at: new Date().toISOString().slice(0, 10), days, inputs: r.inputs, hits: r.hits.length, real: r.real.length,
      summary: `${both.length} as before, ${replayOnly.length} new, ${realOnly.length} gone`,
    };
    const all = readRecords();
    all[j.id] = rec;
    writeFileSync(RECORDS, `${JSON.stringify(Object.fromEntries(Object.entries(all).sort()), null, 2)}\n`);
    console.log(`Recorded in test/judge-replays.json: commit it with the change.`);
  }
  return 0;
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
