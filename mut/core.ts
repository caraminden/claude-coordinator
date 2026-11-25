// #1778: mutation runner for the core. node mut/core.ts <spec.ts> [--check] [--shard i/n] [--ids a,b]
// Spec default export: { file, tests: string[], mutants: [{ id, find, replace, why, nth?, tests? }] }.
// --check: only validate finds (safe anywhere). Otherwise CI only: each mutant in its own repo copy, LANES at once.
// A kill is re-run once: if its red files go green again with the mutant in, it was a flake and the mutant goes on as alive.
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import { join } from 'node:path';

type Mutant = { id: string; find: string; replace: string; why: string; nth?: number; tests?: string[] };
type Spec = { file: string; tests: string[]; mutants: Mutant[] };
const args = process.argv.slice(2);
const opt = (n: string) => { const i = args.indexOf(n); return i < 0 ? null : args.splice(i, 2)[1]; };
const flag = (n: string) => { const i = args.indexOf(n); if (i < 0) return false; args.splice(i, 1); return true; };
const shard = opt('--shard'), ids = opt('--ids')?.split(','), check = flag('--check');
const spec: Spec = (await import(new URL(args[0], `file://${process.cwd()}/`).href)).default;
const orig = readFileSync(spec.file, 'utf8');
function apply(m: Mutant): string | null {
  let at = -1;
  for (let i = 0; i < (m.nth ?? 1); i++) { at = orig.indexOf(m.find, at + 1); if (at < 0) return null; }
  if (m.nth === undefined && orig.indexOf(m.find, at + 1) >= 0) return null;
  return orig.slice(0, at) + m.replace + orig.slice(at + m.find.length);
}
const line = (m: Mutant) => { let at = -1; for (let i = 0; i < (m.nth ?? 1); i++) at = orig.indexOf(m.find, at + 1); return orig.slice(0, at).split('\n').length; };
let list = spec.mutants.filter((m) => !ids || ids.includes(m.id));
if (check) {
  let bad = 0; const seen = new Set<string>();
  for (const m of list) {
    const src = apply(m);
    const why = src === null ? 'find missing or ambiguous (use nth)' : seen.has(m.id) ? 'duplicate id' : src === orig ? 'no change' : null;
    seen.add(m.id);
    if (why) { bad++; console.log(`BAD ${m.id}: ${why}`); continue; }
    if (spec.file.endsWith('.ts')) {
      const f = join(mkdtempSync(join(tmpdir(), 'mc-')), 'm.ts'); writeFileSync(join(f, '..', 'package.json'), '{"type":"module"}'); writeFileSync(f, src!);
      const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
      rmSync(join(f, '..'), { recursive: true }); if (r.status) { bad++; console.log(`BAD ${m.id}: syntax ${r.stderr.split('\n').slice(0, 3).join(' | ')}`); continue; }
    } else {
      const r = spawnSync('bash', ['-n'], { input: src!, encoding: 'utf8' });
      if (r.status) { bad++; console.log(`BAD ${m.id}: ${r.stderr.slice(0, 120)}`); continue; }
    }
    console.log(`ok ${m.id} line ${line(m)}`);
  }
  for (const t of new Set([...spec.tests, ...list.flatMap((m) => m.tests ?? [])])) try { readFileSync(t); } catch { bad++; console.log(`BAD test ${t} missing`); }
  console.log(`${list.length} mutants, ${bad} bad`); process.exit(bad ? 1 : 0);
}
if (process.env.GITHUB_ACTIONS !== 'true') { console.error('CI only: run through citadel-heavy --heavy'); process.exit(3); }
if (shard) { const [i, n] = shard.split('/').map(Number); list = list.filter((_, k) => k % n === i - 1); }
const LANES = Number(process.env.LANES) || Math.max(1, Math.floor(cpus().length / 4));
const t0 = Date.now(); const el = () => `${Math.round((Date.now() - t0) / 1000)}s`;
const home = process.cwd(); const base = mkdtempSync(join(tmpdir(), 'mut-'));
const copies = Array.from({ length: LANES }, (_, i) => { const d = join(base, `c${i}`); cpSync(home, d, { recursive: true, verbatimSymlinks: true, filter: (s) => !s.endsWith('/node_modules') }); return d; });
function run(cwd: string, files: string[], secs = 600, bail = false): Promise<{ ok: boolean; red: string[]; names: string[] }> {
  return new Promise((done) => {
    const p = spawn(process.execPath, ['--test', '--test-reporter=tap', '--test-timeout=90000', '--test-concurrency=3', ...files], { cwd, stdio: ['ignore', 'pipe', 'ignore'] });
    let out = ''; p.stdout.on('data', (d) => { if (out.length < 64e6) out += d; if (bail && /not ok \d+ - [\s\S]*location: '.*:\d+:\d+'/.test(out.slice(-200000))) p.kill('SIGKILL'); });
    const kill = setTimeout(() => p.kill('SIGKILL'), secs * 1000);
    p.on('close', (code) => {
      clearTimeout(kill);
      const names: string[] = [], red = new Set<string>(); let name = '';
      for (const l of out.split('\n')) {
        const m = /^\s*not ok \d+ - (.*)$/.exec(l); if (m) { name = m[1]; names.push(name); }
        const loc = /^\s*location: '(.*?):\d+:\d+'/.exec(l);
        if (loc && name) { red.add(loc[1].replace(cwd + '/', '')); name = ''; }
      }
      done({ ok: code === 0, red: [...red].filter((f) => /^test\/.*\.test\.ts$/.test(f)), names: names.filter((n) => !/^test\//.test(n)).slice(0, 3) });
    });
  });
}
const all = [...new Set([...spec.tests, ...list.flatMap((m) => m.tests ?? [])])];
console.log(`## ${spec.file}: ${list.length} mutants${shard ? ` (shard ${shard})` : ''}, ${LANES} lanes, tests: ${all.join(' ')}`);
const redBase: string[] = []; const took: Record<string, number> = {}; const todo = [...all];
await Promise.all(Array.from({ length: LANES * 2 }, async () => {
  for (let f = todo.shift(); f; f = todo.shift()) {
    const s = Date.now(); const r = await run(home, [f], 240); took[f] = Math.round((Date.now() - s) / 1000);
    if (!r.ok && !(await run(home, [f], 240)).ok) redBase.push(f);
  }
}));
console.log(`baseline secs: ${Object.entries(took).sort((a, b) => b[1] - a[1]).slice(0, 8).map((x) => x.join(' ')).join(', ')}`);
if (redBase.length) console.log(`baseline red, dropped: ${redBase.join(' ')}`);
console.log(`baseline ${el()}`);
const rows: any[] = []; let next = 0;
await Promise.all(copies.map(async (cwd) => {
  for (;;) {
    const m = list[next++]; if (!m) return;
    const src = apply(m); const row: any = { id: m.id, why: m.why };
    if (src === null) { row.result = 'BAD-FIND'; rows.push(row); console.log(JSON.stringify(row)); continue; }
    row.line = line(m); writeFileSync(join(cwd, spec.file), src);
    try {
      const files = (m.tests ?? spec.tests).filter((f) => !redBase.includes(f)); const s = Date.now();
      files.sort((a, b) => took[a] - took[b]);
      const limit = Math.max(150, 2 * files.reduce((n, f) => n + took[f], 0));
      const r = await run(cwd, files, limit, true);
      if (r.ok) row.result = 'survived';
      else {
        const again = await run(cwd, r.red.length ? r.red : files, limit);
        if (again.ok) { row.result = 'survived'; row.flaked = r.names; } else { row.result = 'killed'; row.by = again.names; row.red = again.red; }
      }
      row.secs = Math.round((Date.now() - s) / 1000);
    } finally { writeFileSync(join(cwd, spec.file), orig); }
    rows.push(row); console.log(JSON.stringify(row));
  }
}));
const n = (r: string) => rows.filter((x) => x.result === r).length;
console.log(`SUMMARY ${spec.file}: ${rows.length} run, ${n('killed')} killed, ${n('survived')} survived, ${n('BAD-FIND')} bad; ${el()}`);
rmSync(base, { recursive: true, force: true });
