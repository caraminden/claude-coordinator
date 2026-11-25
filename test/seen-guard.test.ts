// The seen guard (kit/hooks/seen.ts, #1920): the same unchanged lines are not printed twice, however they are read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterCompact, fileRuns, seenHook } from '../kit/hooks/seen.ts';
import { logPath } from '../kit/hooks/retro-log.ts';

const HOOKS = join(import.meta.dirname, '../kit/hooks');
const lineAt = (i: number) => (i % 50 === 1 ? `export function part${i}(value: number) {` : `  const result${i} = compute(${i}, 'some text to make the line long enough');`);
const body = (n: number) => Array.from({ length: n }, (_, i) => lineAt(i + 1));

/** A session at /w with files in memory. */
function setup(t: { after(f: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'seen-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true })); // timing-ok: own temp dir
  const disk = new Map<string, string[]>([
    ['/w/src/a.ts', body(400)],
    ['/w/src/b.ts', body(900).map((l) => l.replace('result', 'other'))],
  ]);
  const files = { read: (p: string) => disk.get(p)?.join('\n') ?? null, stateDir: dir, now: 1_000_000 };
  const call = (tool_name: string, tool_input: object, tool_response: object, over: object = {}) => {
    files.now += 60_000;
    const out = seenHook({ hook_event_name: 'PostToolUse', session_id: 's', cwd: '/w', tool_name, tool_input: { ...tool_input }, tool_response: { ...tool_response }, ...over }, files);
    return out ? JSON.parse(out).hookSpecificOutput : {};
  };
  /** What a Bash call that printed `out` hands the model. */
  const bash = (command: string, out: string[], over: object = {}) => {
    const o = call('Bash', { command }, { stdout: out.join('\n'), stderr: '', interrupted: false, isImage: false }, over);
    return { text: (o.updatedToolOutput?.stdout ?? out.join('\n')) as string, cut: !!o.updatedToolOutput, context: o.additionalContext as string | undefined, raw: o.updatedToolOutput };
  };
  const read = (from: number, to: number, input: object = {}) => {
    const content = disk
      .get('/w/src/a.ts')!
      .slice(from - 1, to)
      .join('\n');
    const o = call('Read', { file_path: '/w/src/a.ts', offset: from, ...input }, { type: 'text', file: { filePath: '/w/src/a.ts', content, startLine: from, numLines: to - from + 1, totalLines: 400 } });
    return { file: o.updatedToolOutput?.file as { content: string; startLine: number; numLines: number } | undefined, context: o.additionalContext as string | undefined };
  };
  const a = (from: number, to: number) => disk.get('/w/src/a.ts')!.slice(from - 1, to);
  const b = (from: number, to: number) => disk.get('/w/src/b.ts')!.slice(from - 1, to);
  const compact = () => afterCompact({ session_id: 's', cwd: '/w' }, files, dir);
  return { dir, disk, files, bash, read, a, b, compact };
}

test('lines already in context are not printed again, however they are read', (t) => {
  const { bash, read, a } = setup(t);
  assert.equal(bash("sed -n '1,120p' src/a.ts", a(1, 120)).cut, false, 'the first read prints');
  const forms: [string, string[]][] = [
    ["sed -n '1,120p' src/a.ts", a(1, 120)],
    ['cd /w/src && cat a.ts | head -100', a(1, 100)],
    ['cat -n src/a.ts | sed -n 20,60p', a(20, 60).map((l, i) => `    ${i + 20}\t${l}`)],
    ['for f in src/a.ts; do sed -n 30,90p $f | cut -c1-60; done', a(30, 90).map((l) => l.slice(0, 60))],
    ['git show HEAD:src/a.ts | sed -n 1,50p', a(1, 50)],
    ['D=src; awk "NR<60" $D/a.ts', a(1, 59)],
  ];
  for (const [command, out] of forms) {
    const r = bash(command, out);
    assert.match(r.text, /^\[seen\] lines \d+-\d+ of src\/a\.ts: unchanged since you printed them .* ago .*# allow_large/, command);
    assert.ok(r.text.length < 300, command);
  }
  const whole = read(1, 120);
  assert.match(whole.file!.content, /^\[seen\] lines 1-120 of src\/a\.ts/);
});

test('overlapping ranges print only their new lines, with the rest of the output untouched', (t) => {
  const { bash, read, a } = setup(t);
  bash('sed -n 1,120p src/a.ts', a(1, 120));
  const r = bash('git status; sed -n 60,160p src/a.ts; echo done', [' M src/a.ts', ...a(60, 160), 'done']);
  const out = r.text.split('\n');
  assert.equal(out[0], ' M src/a.ts');
  assert.match(out[1], /^\[seen\] lines 60-112 of/, 'a few lines before the new ones still print');
  assert.deepEqual(out.slice(2), [...a(113, 160), 'done']);
  assert.deepEqual(Object.keys(r.raw).sort(), ['interrupted', 'isImage', 'stderr', 'stdout'], "the tool's own result shape is kept");
  // Read numbers its lines, so a cut head moves its first line.
  const over = read(150, 200);
  assert.equal(over.file, undefined, '11 repeated lines are too few to cut');
  const head = read(170, 260);
  assert.equal(head.file!.startLine, 193);
  assert.equal(head.file!.content.split('\n')[0], a(193, 193)[0]);
  assert.match(head.context!, /lines 170-192 of src\/a\.ts/);
});

test('short repeats, changed lines, other output and unsaved reads go through', (t) => {
  const { bash, a, disk, files } = setup(t);
  bash('sed -n 1,200p src/a.ts', a(1, 200));
  assert.equal(bash('sed -n 10,20p src/a.ts', a(10, 20)).cut, false, 'a short range');
  assert.equal(
    bash(
      'npm test -- src/a.ts',
      Array.from({ length: 80 }, (_, i) => `ok ${i} - a test about src/a.ts`),
    ).cut,
    false,
    'output that is no file',
  );
  disk.get('/w/src/a.ts')![99] = '  const edited = true;';
  const after = bash('sed -n 92,107p src/a.ts', a(92, 107));
  assert.equal(after.cut, false, 'a look at an edit prints whole');
  assert.match(bash('sed -n 1,200p src/a.ts', a(1, 200)).text, /const edited = true|unchanged/);
  // An edit that moves lines leaves the moved ones seen.
  disk.get('/w/src/a.ts')!.unshift('// one', '// two');
  assert.match(bash('sed -n 120,180p src/a.ts', a(120, 180)).text, /^\[seen\] lines 120-180/);
  // A long output Claude Code saved to a file showed only its first lines.
  const saved = seenHook({ hook_event_name: 'PostToolUse', session_id: 'p', cwd: '/w', tool_name: 'Bash', tool_input: { command: 'cat src/b.ts' }, tool_response: { stdout: disk.get('/w/src/b.ts')!.join('\n'), persistedOutputPath: '/x' } }, files);
  assert.equal(saved, null);
  assert.equal(bash('sed -n 1,100p src/b.ts', disk.get('/w/src/b.ts')!.slice(0, 100), { session_id: 'p' }).cut, false);
});

test('each agent has its own memory, and an hour-old read counts as lost', (t) => {
  const { bash, a, files } = setup(t);
  bash('sed -n 1,100p src/a.ts', a(1, 100));
  assert.equal(bash('sed -n 1,100p src/a.ts', a(1, 100), { agent_id: 'grunt' }).cut, false);
  files.now += 61 * 60_000;
  assert.equal(bash('sed -n 1,100p src/a.ts', a(1, 100)).cut, false);
});

test('after a compaction a range to edit prints again, the wholesale second pass does not', (t) => {
  const { bash, a, b, compact } = setup(t);
  bash('sed -n 1,400p src/a.ts', a(1, 400));
  bash('sed -n 1,900p src/b.ts', b(1, 900));
  const told = compact();
  assert.match(told, /- src\/a\.ts 1-400: .*1 part1/);
  assert.match(told, /- src\/b\.ts 1-900/);
  assert.match(told, /notes\.md/);
  assert.doesNotMatch(told, /in 15 minutes/);
  assert.equal(bash('sed -n 1,100p src/a.ts', a(1, 100)).cut, false, 'the first 12k chars print again');
  const r = bash('sed -n 1,400p src/b.ts', b(1, 400));
  assert.match(r.text, /^\[seen\] lines 1-400 of src\/b\.ts: you read these .*before your context was compacted.*They hold: 1 part1,.*allow_large/);
  assert.ok(r.text.length < 800);
  assert.equal(bash('sed -n 300,324p src/b.ts', b(300, 324)).cut, false, 'the lines about to be edited');
  // Printed again in this window, so now they are in context.
  assert.match(bash('sed -n 1,100p src/a.ts', a(1, 100)).text, /unchanged since you printed them/);
  assert.equal(bash('sed -n 1,90p src/a.ts # allow_large', a(1, 90)).cut, false);
  const again = compact();
  assert.match(again, /This is compaction 2 in 15 minutes; you went back to: .*a\.ts.*Before anything else write what you know.*notes\.md/);
});

test('past the hour, or with the notes kept, the compaction message follows', (t) => {
  const { dir, disk, files, bash, a, compact } = setup(t);
  bash('sed -n 1,100p src/a.ts', a(1, 100));
  compact();
  files.now += 16 * 60_000;
  disk.set(join(dir, 'notes.md'), ['a.ts:12 is the bug']);
  const told = compact();
  assert.doesNotMatch(told, /in 15 minutes/);
  assert.match(told, /Your notes, .*notes\.md \(1 lines.*\na\.ts:12 is the bug/);
});

test('a gulp is told once at 100k chars of files, then every 60k', (t) => {
  const { disk, bash } = setup(t);
  const said: boolean[] = [];
  for (let k = 0; k < 10; k++) {
    const lines = body(330).map((l) => `${l} // ${k}`);
    disk.set(`/w/src/f${k}.ts`, lines);
    said.push(!!bash(`cat src/f${k}.ts`, lines).context);
  }
  const n = said.filter(Boolean).length;
  assert.ok(!said[0] && n >= 2 && n <= 4, `told ${n} times: ${said}`);
});

test('an escape is counted in the retro log', (t) => {
  const { dir, bash, a } = setup(t);
  const was = process.env.COORDINATOR_SHARED_DIR;
  process.env.COORDINATOR_SHARED_DIR = dir;
  t.after(() => (was === undefined ? delete process.env.COORDINATOR_SHARED_DIR : (process.env.COORDINATOR_SHARED_DIR = was)));
  bash('sed -n 1,100p src/a.ts', a(1, 100));
  bash('sed -n 1,100p src/a.ts # allow_large', a(1, 100));
  assert.match(readFileSync(logPath(dir, 's', new Date()), 'utf8'), /re-read · allow_large printed \d+ chars again .*src\/a\.ts/);
});

test('a run is three lines in a row, and a lone match is none', () => {
  const f = [{ path: '/x', lines: body(20) }];
  assert.deepEqual(fileRuns([lineAt(3), 'other', lineAt(4), lineAt(5)], f), []);
  assert.deepEqual(
    fileRuns(['x', lineAt(3), lineAt(4), lineAt(5), 'y'], f).map((r) => [r.at, r.len, r.from]),
    [[1, 3, 2]],
  );
});

test('the kit runs it: run.ts cuts a second print, after-compact.sh hands back what was read', (t) => {
  const { dir } = setup(t);
  writeFileSync(join(dir, 'real.ts'), `${body(80).join('\n')}\n`);
  const env = { ...process.env, TMPDIR: dir, CLAUDE_PROJECT_DIR: dir, COORDINATOR_SHARED_DIR: '' };
  const input = { hook_event_name: 'PostToolUse', session_id: 'kit', cwd: dir, tool_name: 'Bash', tool_input: { command: 'cat real.ts' }, tool_response: { stdout: body(80).join('\n'), stderr: '' } };
  const run = (bad?: string) => spawnSync(process.execPath, [join(HOOKS, 'run.ts')], { input: bad ?? JSON.stringify(input), env, encoding: 'utf8' });
  assert.equal(run().stdout, '');
  assert.match(JSON.parse(run().stdout).hookSpecificOutput.updatedToolOutput.stdout, /^\[seen\] lines 1-80 of real\.ts/);
  const compact = () => spawnSync('bash', [join(HOOKS, 'after-compact.sh')], { input: JSON.stringify({ session_id: 'kit', cwd: dir, source: 'compact' }), cwd: dir, env, encoding: 'utf8' });
  assert.match(compact().stdout, /\[after-compact\][\s\S]*- real\.ts 1-80: 1 part1/);
  assert.match(compact().stdout, /compaction 2 in 15 minutes/);
  // Fails open on a log it can't read.
  writeFileSync(join(dir, 'citadel-kit/seen-kit.jsonl'), '{not json\n');
  const broken = run();
  assert.doesNotMatch(broken.stdout, /updatedToolOutput/);
  assert.equal(broken.status, 0);
});
