// Mutation runner for #1284 (R11): hand-written mutants of one guard file, run ON CI only.
//   node mut/run.ts mut/<spec>.ts [more specs...]
// A spec's default export: { file, related: [test files], mutants: [{ id, find, replace, why, nth? }] }.
// For each spec: a baseline run (tests already red there are dropped), then per mutant: the tests the affected map picks
// for the file (tier A, what citadel-test --affected runs before a ship), and if all green, the related tests (tier B).
// Mutants that survive both are applied together and the full suite runs once (tier C, what CI checks on a ship):
// green there means every one of them survives everything. Prints a markdown table and a JSON line per mutant.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';

if (process.env.GITHUB_ACTIONS !== 'true') {
  console.error('mut/run.ts runs on CI only (#1284: nothing on perigee). Run it through citadel-heavy.');
  process.exit(3);
}

type Mutant = { id: string; find: string; replace: string; why: string; nth?: number };
type Spec = { file: string; related: string[]; mutants: Mutant[]; full?: boolean };
const conc = String(Math.max(1, Math.floor((cpus().length + 1) / 2)));
const t0 = Date.now();

function tests(files: string[], limit = 900): { ok: boolean; failed: string[]; secs: number; timedOut: boolean } {
  const start = Date.now();
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', '--test-timeout=60000', `--test-concurrency=${conc}`,
    '--test-global-setup=test/leak-guard.ts', ...files], { encoding: 'utf8', timeout: limit * 1000, maxBuffer: 512 << 20, killSignal: 'SIGKILL' });
  const out = `${r.stdout ?? ''}`;
  // The innermost failing test names, with the file they ran in.
  const failed: string[] = [];
  let file = '';
  for (const line of out.split('\n')) {
    const m = /^(\s*)(not ok|ok) \d+ - (.*)$/.exec(line);
    if (!m) continue;
    if (m[1] === '') file = m[3];
    if (m[2] === 'not ok' && m[1] !== '') failed.push(`${m[3]}`);
    if (m[2] === 'not ok' && m[1] === '' && !failed.length) failed.push(m[3]);
  }
  const timedOut = !!r.error && (r.error as any).code === 'ETIMEDOUT';
  return { ok: r.status === 0 && !timedOut, failed: [...new Set(failed)].slice(0, 3), secs: Math.round((Date.now() - start) / 1000), timedOut };
}

function affected(file: string): string[] {
  const r = spawnSync(process.execPath, ['tools/affected.ts', '--paths', file], { encoding: 'utf8' });
  const picked = r.stdout.split('\n').filter((l) => l.startsWith('run\t')).map((l) => l.split('\t')[1]);
  const always = readFileSync('tools/always-tests.txt', 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  return [...new Set([...picked, ...always])];
}

function apply(src: string, m: Mutant): string | null {
  const n = m.nth ?? 1;
  let at = -1;
  for (let i = 0; i < n; i++) { at = src.indexOf(m.find, at + 1); if (at < 0) return null; }
  if (m.nth === undefined && src.indexOf(m.find, at + 1) >= 0) return null; // ambiguous: say which with nth
  return src.slice(0, at) + m.replace + src.slice(at + m.find.length);
}
const lineOf = (src: string, find: string, nth = 1) => { let at = -1; for (let i = 0; i < nth; i++) at = src.indexOf(find, at + 1); return src.slice(0, at).split('\n').length; };

// Args: <spec> [--ids a01-a12,a15] [--combine a05,a13 (apply these together, full suite only)] [--no-full]
const args = process.argv.slice(2);
const opt = (name: string) => { const i = args.indexOf(name); return i < 0 ? null : args.splice(i, 2)[1]; };
const idsArg = opt('--ids'); const combine = opt('--combine'); const noFull = args.includes('--no-full');
const pick = (list: string | null) => list === null ? null : new Set(list.split(',').flatMap((r) => {
  const [a, b] = r.split('-'); if (!b) return [a];
  const pre = a.replace(/\d+$/, ''); const w = a.length - pre.length; const out = [];
  for (let n = Number(a.slice(pre.length)); n <= Number(b.replace(/^\D+/, '')); n++) out.push(pre + String(n).padStart(w, '0'));
  return out;
}));
const results: any[] = [];
for (const path of args.filter((a) => !a.startsWith('--'))) {
  const spec: Spec = (await import(new URL(path, `file://${process.cwd()}/`).href)).default;
  const ids = pick(idsArg ?? combine);
  if (ids) spec.mutants = spec.mutants.filter((m) => ids.has(m.id));
  if (noFull) spec.full = false;
  const orig = readFileSync(spec.file, 'utf8');
  let A = combine ? [] : affected(spec.file);
  let B = combine ? [] : spec.related.filter((t) => !A.includes(t));
  console.log(`\n## ${spec.file}: ${spec.mutants.length} mutants\nTier A (affected map): ${A.join(' ')}\nTier B (related): ${B.join(' ')}`);
  // Baseline: a test file red without any mutant can't judge one.
  for (const [name, set] of [['A', A], ['B', B]] as const) {
    const bad: string[] = [];
    if (set.length && !tests(set).ok) for (const f of set) { const r = tests([f]); if (!r.ok) bad.push(f); }
    if (bad.length) console.log(`baseline red in tier ${name}, dropped: ${bad.join(' ')}`);
    if (name === 'A') A = A.filter((f) => !bad.includes(f)); else B = B.filter((f) => !bad.includes(f));
  }
  console.log(`baseline done at ${Math.round((Date.now() - t0) / 1000)} s`);
  const survivors: Mutant[] = [];
  try {
    if (combine) survivors.push(...spec.mutants);
    for (const m of combine ? [] : spec.mutants) {
      const mutated = apply(orig, m);
      const row: any = { file: spec.file, id: m.id, why: m.why };
      if (mutated === null) { row.result = 'BAD-FIND'; results.push(row); console.log(JSON.stringify(row)); continue; }
      row.line = lineOf(orig, m.find, m.nth ?? 1);
      writeFileSync(spec.file, mutated);
      try {
        const a = tests(A, 600);
        if (!a.ok) { Object.assign(row, { result: 'killed', tier: 'A', by: a.failed, secs: a.secs, timeout: a.timedOut || undefined }); }
        else if (B.length) {
          const b = tests(B, 900);
          if (!b.ok) Object.assign(row, { result: 'killed', tier: 'B', by: b.failed, secs: a.secs + b.secs, timeout: b.timedOut || undefined });
          else Object.assign(row, { result: 'survived', secs: a.secs + b.secs });
        } else Object.assign(row, { result: 'survived', secs: a.secs });
      } finally { writeFileSync(spec.file, orig); }
      if (row.result === 'survived') survivors.push(m);
      results.push(row);
      console.log(JSON.stringify(row));
    }
    // Tier C: every survivor at once under the full suite.
    if (survivors.length && spec.full !== false) {
      let src = orig; const applied: string[] = [];
      for (const m of survivors) { const next = apply(src, m); if (next !== null) { src = next; applied.push(m.id); } }
      writeFileSync(spec.file, src);
      const all = spawnSync('bash', ['-c', 'ls test/*.test.ts test/*.test.js 2>/dev/null'], { encoding: 'utf8' }).stdout.trim().split('\n');
      const c = tests(all, 1800);
      writeFileSync(spec.file, orig);
      console.log(`TIER-C ${spec.file}: ${applied.length} survivors applied together (${applied.join(' ')}); full suite ${c.ok ? 'GREEN: all survive' : `RED in ${c.secs} s, failing: ${c.failed.join(' | ')}`}`);
      if (!c.ok) {
        // Name which applied survivor each red file belongs to: rerun just the red files per mutant.
        const redFiles = [...new Set(c.failed.map((f) => f.split(' ')[0]).filter((f) => /^test\//.test(f)))];
        console.log(`TIER-C red files: ${redFiles.join(' ') || '(names above)'}`);
      }
    }
  } finally { writeFileSync(spec.file, orig); }
}

console.log(`\n| file | mutant | line | result | tier | caught by | s |\n|---|---|---|---|---|---|---|`);
for (const r of results) console.log(`| ${r.file} | ${r.id} | ${r.line ?? ''} | ${r.result} | ${r.tier ?? ''} | ${(r.by ?? []).join('; ').slice(0, 120)} | ${r.secs ?? ''} |`);
const by = (f: string) => results.filter((r) => r.file === f);
for (const f of [...new Set(results.map((r) => r.file))]) {
  const rs = by(f).filter((r) => r.result !== 'BAD-FIND');
  console.log(`SUMMARY ${f}: ${rs.length} run, ${rs.filter((r) => r.result === 'killed').length} killed, ${rs.filter((r) => r.result === 'survived').length} survived, ${by(f).length - rs.length} bad finds`);
}
console.log(`total ${Math.round((Date.now() - t0) / 1000)} s on ${cpus().length} CPUs`);
