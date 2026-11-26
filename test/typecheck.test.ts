// The type check's ratchet (#1789): tsc over server.ts, src/, tools/, test/ and kit/ (tsconfig.json) and the front end
// (#2010: tsconfig.public.json, tsconfig.sw.json), plus a count of explicit `any` types and @ts-ignore-style comments in
// every tracked TypeScript file and front-end script. A file whose count goes above
// test/typecheck-baseline.json fails the ship; lower counts pass, and `node tools/typecheck.ts --update` records them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { holds } from './holds.ts';
import { PROJECTS, ROOT, SCRIPTS, compare, describe, escapes, lowered, measure, moved, parseTsc, readBaseline, scriptEscapes, tscErrors, tscFiles, tsFiles, upMessage } from '../tools/typecheck.ts';

test('no file has more type errors or escapes than its baseline', async () => {
  const { table, errors } = await measure();
  const { up, down } = compare(readBaseline(), table);
  if (down.length) console.log(`typecheck: ${down.length} count(s) went down; record them with \`node tools/typecheck.ts --update\`:\n  ${down.map(describe).join('\n  ')}`);
  assert.deepEqual(up.map(describe), [], upMessage(up, errors));
});

test('tools/typecheck.ts is the kit template outside its config block', () => {
  const body = (path: string) => readFileSync(path, 'utf8').split('// --- end of config ---')[1];
  assert.ok(body(join(ROOT, 'tools', 'typecheck.ts')));
  assert.equal(body(join(ROOT, 'tools', 'typecheck.ts')), body(join(ROOT, 'kit', 'skills', 'scheme-setup', 'templates', 'typecheck.ts')), 'a fix to tools/typecheck.ts goes into kit/skills/scheme-setup/templates/typecheck.ts too (other schemes copy it)');
});

test('an any in a type counts; an any that is a value, a property, a comment or text does not', () => {
  assert.equal(escapes('let a: any = 1;\nconst b = x as any;\nfunction f(c: any[]): Map<string, any> { return new Map(); }\n'), 4);
  assert.equal(escapes('const any = 1; const o = { any: 2 }; o.any; fc.anything(); // any here\nconst s = "any" + `any ${any}`;\n'), 0);
  assert.equal(escapes('type T = Record<string, unknown>;\nlet u: unknown;\n'), 0);
});

test('each `as unknown as` counts, in every way of counting; one in a comment or text, or a lone cast, does not (#2142)', () => {
  const casts = 'const a = x as unknown as T;\nconst b = (y as unknown\n  as string[]).length + (z as unknown as U<V>).n;\n';
  assert.equal(escapes(casts), 3);
  assert.equal(escapes(casts, 'x.tsx'), 3);
  assert.equal(escapes('const a = x as any as T;\n'), 1, 'the any counts, once');
  for (const file of ['x.ts', 'x.tsx']) assert.equal(escapes('// as unknown as T\n/* as unknown as T */\nconst s = "x as unknown as T" + `as unknown as`;\nconst u = x as unknown;\nconst v = y as T;\n', file), 0, file);
});

test('@ts-ignore, @ts-expect-error and @ts-nocheck count; a mention mid-line does not', () => {
  assert.equal(escapes('// @ts-nocheck\n  // @ts-ignore: why\nlet a = 1;\n/* @ts-expect-error */\nlet b = 2;\n'), 3);
  assert.equal(escapes('const s = "see // @ts-ignore";\n'), 0);
});

test('in a .tsx file, which Node cannot strip, an any in a type still counts and one in text does not', () => {
  const tsx = 'const a: any = 1;\nconst b = <div x={c as any} />;\nfunction f(m: Map<string, any>, l: any[]): Array<any> { return []; }\nconst any2 = "any"; // any\nconst t = `any ${any}`;\n';
  assert.equal(escapes(tsx, 'x.tsx'), 5);
  // The pattern also reads type aliases and arrow return types.
  assert.equal(escapes('type G = any;\ntype H<T> = any;\nlet f: () => any;\nconst g = (x: number): any => x;\n', 'y.tsx'), 4);
  assert.equal(escapes('const any = 1;\nlet b = any;\nconst h = () => any;\n', 'y.tsx'), 1, 'a value named any is not a type, except after => where the pattern cannot tell');
});

test('in a .d.ts every any outside a comment counts', () => {
  assert.equal(escapes('export const x: any;\n// any\n/** any */\nexport function f(a: any): void;\n', 'x.d.ts'), 2);
});

test('a count above its baseline is up, below is down, and a new file with errors is up', () => {
  const base = { 'a.ts': { errors: 2, escapes: 1 }, 'gone.ts': { errors: 1, escapes: 0 } };
  const now = { 'a.ts': { errors: 3, escapes: 0 }, 'new.ts': { errors: 0, escapes: 1 } };
  const { up, down } = compare(base, now);
  assert.deepEqual(up.map(describe), ['a.ts: errors 2 → 3', 'new.ts: escapes 0 → 1']);
  assert.deepEqual(down.map(describe), ['a.ts: escapes 1 → 0', 'gone.ts: errors 1 → 0']);
});

test('--update only ever lowers: a count above its baseline keeps the baseline, a new file is not added', () => {
  const base = { 'a.ts': { errors: 2, escapes: 1 }, 'gone.ts': { errors: 1, escapes: 0 } };
  const now = { 'a.ts': { errors: 5, escapes: 0 }, 'new.ts': { errors: 3, escapes: 3 } };
  assert.deepEqual(lowered(base, now), { 'a.ts': { errors: 2, escapes: 0 } });
});

test('--moved re-files counts after a split, but not when a total went up', () => {
  const base = { 'big.ts': { errors: 5, escapes: 2 } };
  assert.deepEqual(moved(base, { 'big.ts': { errors: 2, escapes: 0 }, 'part.ts': { errors: 3, escapes: 2 } }), { 'big.ts': { errors: 2, escapes: 0 }, 'part.ts': { errors: 3, escapes: 2 } });
  assert.equal(moved(base, { 'big.ts': { errors: 2, escapes: 0 }, 'part.ts': { errors: 3, escapes: 3 } }), null);
});

test('tsc runs and its errors are read per file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'typecheck-'));
  try {
    writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, types: [] }, include: ['*.ts'] }));
    writeFileSync(join(dir, 'ok.ts'), 'export const n: number = 1;\n');
    writeFileSync(join(dir, 'bad.ts'), 'export const n: number = "one";\nexport function f(a) { return a; }\n');
    const errors = await tscErrors(dir, ['tsconfig.json']);
    assert.deepEqual(
      errors.map((e) => `${e.file}:${e.line} ${e.code}`),
      ['bad.ts:1 TS2322', 'bad.ts:2 TS7006'],
    );
    // A listed tsconfig that isn't there is a mistake, not zero errors (#1789 review); a scheme with none lists none.
    await assert.rejects(tscErrors(dir, ['tsconfig.json', 'tsconfig.typo.json']), /tsconfig\.typo\.json/);
    assert.deepEqual(await tscErrors(dir, []), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('tsc output with follow-on lines folds them into the error before', () => {
  const out = 'src/a.ts(3,5): error TS2322: Type A is not B.\n  Property x is missing.\nerror TS5083: Cannot read file.\n';
  const errors = parseTsc(out, '/r');
  assert.deepEqual(
    errors.map((e) => [e.file, e.line, e.code]),
    [
      ['src/a.ts', 3, 'TS2322'],
      ['(global)', 0, 'TS5083'],
    ],
  );
  assert.match(errors[0]!.text, /Property x is missing/);
});

test('the word any in a comment or quoted text inside a type does not count; a real any beside it does (HK2)', () => {
  assert.equal(escapes("interface A {\n  x: string /** A link, if any. */;\n  // any\n  y: 1; // it's any\n}\n"), 0);
  assert.equal(escapes("type T = \"any\" | 'any' | `any ${string} any`;\nlet u: Exclude<T, 'any'>;\n"), 0);
  assert.equal(escapes('interface A {\n  // it\'s\n  x: any; /* any */ y: any[]; z: "//" | any;\n}\n'), 3);
  assert.equal(escapes('type T = `any${any}any${Foo<{ a: `}${any}` }>}any` | any;\n'), 3);
  assert.equal(escapes('const r = /[`\'"]/;\nlet a: any = 1;\nconst s = /`/;\nlet b = a as any;\n'), 2);
  assert.equal(escapes('const r = /\\/*/;\nlet a: any = "*/";\n'), 1);
  assert.equal(escapes('export type U = "any" | any;\nexport const v: "https://any" | any;\n', 'x.d.ts'), 2);
  assert.equal(escapes('// a comment ends here\u2028export type T = any;\n', 'x.d.ts'), 1, 'U+2028 ends a line too');
});

/** A scratch repo with its own copy of the check, for what only a run of it shows. */
function scratch(files: Record<string, string>): { dir: string; check: (...args: string[]) => { code: number | null; out: string }; done: () => void } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'typecheck-')));
  mkdirSync(join(dir, 'tools'));
  copyFileSync(join(ROOT, 'kit', 'skills', 'scheme-setup', 'templates', 'typecheck.ts'), join(dir, 'tools', 'typecheck.ts'));
  symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'));
  writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, types: [] }, include: ['*.ts'] }));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['add', ':(glob)*.ts'], { cwd: dir });
  const check = (...args: string[]) => {
    const r = spawnSync(process.execPath, [join(dir, 'tools', 'typecheck.ts'), ...args], { cwd: dir, encoding: 'utf8' });
    return { code: r.status, out: r.stdout + r.stderr };
  };
  return { dir, check, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test('a syntax error that makes tsc skip every type is refused, not read as errors fixed (HK10)', () => {
  const { dir, check, done } = scratch({ 'bad.ts': 'export const n: number = "one";\n', 'two.ts': 'export const a: number = "1";\nexport const b: number = "2";\n' });
  try {
    assert.equal(check('--init').code, 0);
    const baseline = readFileSync(join(dir, 'typecheck-baseline.json'), 'utf8');
    // One syntax error where two errors were allowed: every count is down, so only the skipped pass gives it away.
    writeFileSync(join(dir, 'two.ts'), 'export const a = ;\n');
    for (const args of [[], ['--update'], ['--update', '--moved']]) {
      const { code, out } = check(...args);
      assert.equal(code, 1, `typecheck ${args.join(' ')}: ${out}`);
      assert.match(out, /before it checked any types[\s\S]*two\.ts\(1,18\) TS1109/);
    }
    assert.equal(readFileSync(join(dir, 'typecheck-baseline.json'), 'utf8'), baseline);
    // A TS1xxx error the checker itself reports leaves the types checked: it counts like any other.
    writeFileSync(join(dir, 'two.ts'), 'export abstract abstract class Q {}\n');
    assert.match(check().out, /2 errors/);
    // An error in the config skips the types as well.
    writeFileSync(join(dir, 'two.ts'), 'export {};\n');
    writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, types: ['nope'] }, include: ['*.ts'] }));
    assert.match(check('--update', '--moved').out, /before it checked any types[\s\S]*TS2688/);
    // So does a config that matches no files, though tsc then prints a check time of 0.
    for (const [config, code] of [
      [{ include: ['nothing/*.ts'] }, /TS18003/],
      [{ files: [] }, /TS18002/],
    ] as const) {
      writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, types: [] }, ...config }));
      const { code: exit, out } = check('--update', '--moved');
      assert.equal(exit, 1, out);
      assert.match(out, code);
    }
    assert.equal(readFileSync(join(dir, 'typecheck-baseline.json'), 'utf8'), baseline);
  } finally {
    done();
  }
});

test('a file can be named by its absolute path, and one the check does not cover says so (HK11)', () => {
  const { dir, check, done } = scratch({ 'bad.ts': 'export const n: number = "one";\n' });
  try {
    for (const path of ['bad.ts', join(dir, 'bad.ts')]) assert.match(check(path).out, /^bad\.ts: errors 1 [\s\S]*TS2322/);
    const typo = check('bda.ts');
    assert.match(typo.out, /bda\.ts: not a file this check covers/);
    assert.equal(typo.code, 1);
    assert.match(check('tools/typecheck.ts').out, /not a file this check covers/);
    execFileSync('git', ['add', 'tools'], { cwd: dir });
    assert.match(check('tools/typecheck.ts').out, /its type errors are not checked/);
    // A .js file that checkJs has tsc check is covered: the gate names this command for it.
    writeFileSync(join(dir, 'j.js'), '/** @type {number} */\nexport const j = "x";\n');
    writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, types: [], allowJs: true, checkJs: true }, include: ['*.ts', '*.js'] }));
    assert.match(check('j.js').out, /errors 1 [\s\S]*TS2322/);
    writeFileSync(join(dir, 'j.js'), 'export const j = 1;\n');
    const clean = check('j.js');
    assert.match(clean.out, /errors 0 [\s\S]*only with checkJs/);
    assert.equal(clean.code, 0);
    writeFileSync(join(dir, 'new.ts'), 'export const x: number = "a";\n');
    assert.match(check('new.ts').out, /errors 1 [\s\S]*its escapes are not counted/);
  } finally {
    done();
  }
});

test('a string continued onto the next line with a backslash does not hide an any after it (#2007)', () => {
  for (const eol of ['\n', '\r\n']) {
    for (const q of ["'", '"', '`']) {
      const code = `type A = { a: ${q}x\\${eol}y${q}; b: any; c: ${q}z${q} };${eol}`;
      assert.equal(escapes(code), 1, `stripped: ${JSON.stringify(code)}`);
      assert.equal(escapes(code, 'x.d.ts'), 1, `d.ts: ${JSON.stringify(code)}`);
      assert.equal(escapes(code, 'x.tsx'), 1, `pattern: ${JSON.stringify(code)}`);
    }
  }
  // An unclosed template full of continued lines must not send the pattern into endless backtracking: this hangs if so.
  escapes(`const s = \`${'\\\r\n'.repeat(40)}`, 'x.tsx');
});

// #2033: type checks share the limit citadel-test's files wait on (tools/test-gate.ts), so several started together don't each take ~1 GB.
test('a type check waits while the shared limit is held, says so, and goes once it is freed', async () => {
  const { spawn } = await import('node:child_process');
  const { dir, done } = scratch({ 'a.ts': 'export const a: number = 1;\n' });
  const heavy = join(dir, 'heavy');
  mkdirSync(heavy);
  copyFileSync(join(ROOT, 'tools', 'test-gate.ts'), join(dir, 'tools', 'test-gate.ts'));
  // One place in all, and something else holds it.
  const env = { ...process.env, CITADEL_HEAVY_DIR: heavy, CITADEL_TEST_FILES: '1', CITADEL_TEST_FILES_MIN: '1', CITADEL_TEST_FILES_MAX: '1', CITADEL_HEAVY_PRESSURE: join(dir, 'none'), RUNNER_TEMP: '', GITHUB_ACTIONS: '', CITADEL_HEAVY_HELD: '' };
  const holder = spawn('sh', ['-c', 'exec 8>"$1" && flock -n 8 && echo held && exec sleep 600', 'sh', join(heavy, 'test-slot-0')], { stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    await new Promise((r) => holder.stdout.once('data', r));
    const child = spawn(process.execPath, [join(dir, 'tools', 'typecheck.ts'), '--init'], { cwd: dir, env });
    let out = '';
    child.stderr.on('data', (b) => (out += b));
    child.stdout.on('data', (b) => (out += b));
    const exited = new Promise<number | null>((r) => child.on('close', r));
    await holds('the check has not run', () => child.exitCode === null, { after: () => /typecheck: waiting for room/.test(out) });
    assert.match(out, /typecheck: waiting for room/, 'it says it is waiting');
    holder.kill();
    assert.equal(await exited, 0, `it goes once the place is free: ${out}`);
  } finally {
    holder.kill();
    done();
  }
});

test('a type check does not wait on CI, in a heavy job, with the limit off, or when the repo has no gate', async () => {
  const { spawn } = await import('node:child_process');
  const { dir, check, done } = scratch({ 'a.ts': 'export const a: number = 1;\n' });
  try {
    const heavy = join(dir, 'heavy');
    mkdirSync(heavy);
    // No tools/test-gate.ts in this copy: the other schemes' case.
    assert.equal(check('--init').code, 0);
    copyFileSync(join(ROOT, 'tools', 'test-gate.ts'), join(dir, 'tools', 'test-gate.ts'));
    // One place in all, held by something else: a run that waited would sit until CITADEL_TEST_ROOM_WAIT (60 s) and say so.
    const holder = spawn('sh', ['-c', 'exec 8>"$1" && flock -n 8 && echo held && exec sleep 600', 'sh', join(heavy, 'test-slot-0')], { stdio: ['ignore', 'pipe', 'ignore'] });
    try {
      await new Promise((r) => holder.stdout.once('data', r));
      const base = { ...process.env, CITADEL_HEAVY_DIR: heavy, CITADEL_TEST_FILES: '1', CITADEL_TEST_FILES_MIN: '1', CITADEL_TEST_FILES_MAX: '1', CITADEL_HEAVY_PRESSURE: join(dir, 'none'), CITADEL_TEST_ROOM_WAIT: '60', RUNNER_TEMP: '', GITHUB_ACTIONS: '', CITADEL_HEAVY_HELD: '' };
      for (const skip of [{ GITHUB_ACTIONS: 'true' }, { RUNNER_TEMP: '/tmp' }, { CITADEL_HEAVY_HELD: '1' }, { CITADEL_TEST_FILES: '0' }]) {
        const r = spawnSync(process.execPath, [join(dir, 'tools', 'typecheck.ts')], { cwd: dir, encoding: 'utf8', timeout: 40_000, env: { ...base, ...skip } });
        assert.equal(r.status, 0, JSON.stringify(skip) + r.stderr);
        assert.doesNotMatch(r.stderr, /waiting for room/, JSON.stringify(skip));
      }
    } finally {
      holder.kill();
    }
  } finally {
    done();
  }
});

test("every front-end script is in the front end's check, with the page's globals and none of the server (#2010)", async () => {
  for (const p of ['tsconfig.public.json', 'tsconfig.sw.json']) assert.ok(PROJECTS.includes(p), p);
  const scripts = execFileSync('git', ['ls-files', '--', 'public'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter((f) => /\.(?:[cm]?jsx?|tsx|[cm]ts|ts)$/.test(f) && !f.endsWith('.d.ts'));
  // The two agents are Node programs people download, not pages.
  const pages = scripts.filter((f) => !['public/machine-agent.mjs', 'public/runner-agent.mjs'].includes(f));
  const ours = (files: Iterable<string>) => [...files].filter((f) => !f.startsWith('node_modules/'));
  const page = ours(await tscFiles(ROOT, ['tsconfig.public.json']));
  const worker = ours(await tscFiles(ROOT, ['tsconfig.sw.json']));
  assert.deepEqual(
    pages.filter((f) => !page.includes(f) && !worker.includes(f)),
    [],
    'front-end scripts tsc does not check',
  );
  assert.deepEqual(
    [...page, ...worker].filter((f) => !f.startsWith('public/')),
    [],
    'a front-end file imports a type from outside public/: declare it in public/ (the server would be checked as a page, and its errors counted twice)',
  );
  const counted = await tsFiles();
  assert.deepEqual(
    pages.filter((f) => !counted.includes(f)),
    [],
    `front-end scripts whose escapes are not counted (SCRIPTS: ${SCRIPTS})`,
  );
});

test("a page's type errors are found with the real configs, a .d.ts beside it or not; a service worker has a worker's globals (#2010)", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'typecheck-')));
  try {
    mkdirSync(join(dir, 'public'));
    for (const f of ['tsconfig.json', 'tsconfig.public.json', 'tsconfig.sw.json']) copyFileSync(join(ROOT, f), join(dir, f));
    writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
    const put = (f: string, text: string) => writeFileSync(join(dir, 'public', f), text);
    // A wrong field, a missing argument, a Node global, another script's name with no import.
    put('page.js', "const o = { a: 1 };\no.b;\ndocument.getElementById();\nprocess.exit();\nelsewhere;\nimport { twin } from './twin.js';\ntwin(1);\n");
    put('script.js', 'const elsewhere = 1;\n');
    put('twin.js', "export const twin = () => 1;\nconst n = 'x'.nope;\n");
    put('twin.d.ts', 'export function twin(a: string): number;\n');
    put('sw.js', "self.importScripts('x.js');\ndocument.title;\n");
    const errors = await tscErrors(dir, ['tsconfig.public.json', 'tsconfig.sw.json']);
    assert.deepEqual(errors.map((e) => `${e.file}:${e.line} ${e.code}`).sort(), [
      'public/page.js:2 TS2339',
      'public/page.js:3 TS2554',
      'public/page.js:4 TS2591',
      'public/page.js:5 TS2304',
      'public/page.js:7 TS2345', // an importer sees the .d.ts ...
      'public/sw.js:2 TS2584',
      'public/twin.js:2 TS2339', // ... and the script beside it is checked all the same
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a script's JSDoc any and @ts- comments count, in every form tsc honours (#2010)", () => {
  const one = [
    '/** @type {any} */',
    '/** @type any */',
    '/** @this any */',
    '/** @type {*} */',
    '/*** @type {any} */',
    '/** @type\n * {any} */',
    '/** @param x {any} */',
    '/** @param {...any} x */',
    '/** @param {Object<string, any>} x the rest */',
    '/** @typedef {{ a: any }} T */',
    '/** @typedef {{\n *   a: { b: string },\n *   c: any,\n * }} T */',
    '/** @callback F @param {number} x @returns {any} */',
    '/** @template T, {any} U */',
    '/** @type Map<string, any> */',
    "/** @type {'}' | any} */",
    '/** @type {"{" | \'x\'} and @type {any} */',
    "/** It's @type {any} but doesn't */",
    '// @ts-nocheck',
    '//@ts-nocheck',
    '/// @ts-nocheck',
    '// @TS-NOCHECK',
    '#!/usr/bin/env node\n// @ts-nocheck',
    'let a = 1; // @ts-ignore',
    'let a = 1; /* @ts-ignore */',
    '/* hi\n * @ts-ignore */',
    '/** @ts-expect-error */',
    '//// @ts-ignore: why',
    "const s = '/**'; /** @type {any} */ let b = 1;",
    'const r = /[\'"`]/; /** @type {any} */ let b = 1;',
    '/** @type {"a\\"}" | any} */',
    "/** @type {'it\\'s }' | any} */",
    '/** @type {T extends string ? any : never} */',
    '/** @type {{ any: string, b: any }} */',
  ];
  for (const code of one) assert.equal(scriptEscapes(`${code}\nexport let x = 1;\n`), 1, code);
  assert.equal(scriptEscapes('/**\n * @param {any} a\n * @param {any} b\n * @returns {Promise<any>}\n */\nfunction f(a, b) {}\n'), 3);
  const none = ['/** any kind, {any} of them */', '/**\n * Any caller.\n * @param {string} x any of them * twice\n */', '/** @type {\'any\' | "any" | `any`} */', '/** @param {string} x see {@link any} */', '/* @type {any} */', '// any\nconst any = { any: 1 }; any.any;', '/** @type {unknown} */'];
  for (const code of none) assert.equal(scriptEscapes(`${code}\nexport let x = 1;\n`), 0, code);
});

test("a tracked script's escapes are in the table only when SCRIPTS names it, and take it past its baseline (#2010)", async () => {
  const { dir, done } = scratch({ 'ok.ts': 'export {};\n' });
  try {
    mkdirSync(join(dir, 'public'));
    writeFileSync(join(dir, 'public', 'a.js'), '// @ts-nocheck\nexport const a = 1;\n');
    execFileSync('git', ['add', 'public'], { cwd: dir });
    assert.deepEqual((await measure(dir, [], ['public/*.js'])).table, { 'public/a.js': { errors: 0, escapes: 1 } });
    assert.deepEqual((await measure(dir, [], [])).table, {});
    assert.deepEqual(compare({ 'public/a.js': { errors: 9, escapes: 0 } }, { 'public/a.js': { errors: 0, escapes: 1 } }).up.map(describe), ['public/a.js: escapes 0 → 1']);
  } finally {
    done();
  }
});
