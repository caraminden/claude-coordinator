// The app-shots judge (src/shot-judge.ts, #1783) over the nights of contraption screenshots kept beside the database: each
// kept picture is compared again with today's code, and what it calls broken is set beside what that night called it.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pacificDay } from '../../src/pacific.ts';
import { problems, type Night } from '../../src/shot-judge.ts';
import { changed, readPng } from '../app-shots/picture.ts';
import type { Act, ReplayCtx, ReplayResult } from './types.ts';

export async function replay(ctx: ReplayCtx): Promise<ReplayResult> {
  const dir = join(dirname(ctx.db), 'app-shots');
  const from = pacificDay(ctx.now - ctx.days * 86_400_000);
  const picture = (file: string) => (existsSync(file) ? readPng(readFileSync(file)) : null);
  const hits: Act[] = [];
  const real: Act[] = [];
  let shots = 0;
  const days = (existsSync(dir) ? readdirSync(dir) : []).filter((d) => d >= from && existsSync(join(dir, d, 'night.json'))).sort();
  for (const day of days) {
    const night: Night = JSON.parse(readFileSync(join(dir, day, 'night.json'), 'utf8'));
    for (const a of night.apps) {
      if (ctx.scheme !== null && a.scheme !== ctx.scheme) continue;
      const act = (p: { key: string; text: string }): Act => ({ at: night.endedAt, key: `${day}|${p.key}`, text: `${a.title}: ${p.text}` });
      real.push(...a.called.map(act));
      for (const s of a.shots) {
        shots++;
        const [was, is] = [s.was && picture(join(dir, s.was)), s.file && picture(join(dir, day, a.app, s.file))];
        if (was && is) s.moved = changed(was, is);
      }
      hits.push(...problems(a).map(act));
    }
  }
  return {
    inputs: `${shots} shots of ${days.length} nights`,
    hits,
    real,
    limits: ['The blank measure is read as that night took it', 'What was said: a problem that stays open is told once, here it is a hit each night'],
  };
}
