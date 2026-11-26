import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { sameCode } from '../src/types-only.ts';

const same = (a: string, b: string, path = 'x.ts') => sameCode(a, b, path).same;

test('types-only TypeScript edits are the same code', () => {
  assert.ok(same('function f(a) { return a; }', 'function f(a: number): number { return a; }'), 'annotation');
  assert.ok(same('const x = y.z;', 'const x = (y as Foo).z;'), 'as cast with its parentheses');
  assert.ok(same('const c = { a: 1 };', 'const c = { a: 1 } satisfies Conf;'), 'satisfies');
  assert.ok(same('const v = m.get(k).n;', 'const v = m.get(k)!.n;'), 'non-null !');
  assert.ok(same('import { b } from "./b.ts";', 'import { type A, b } from "./b.ts";\ntype T = A;'), 'type import and alias');
  assert.ok(same('f(a)', 'f(a) // why\n/* more */'), 'comments are dropped');
  assert.ok(same('function f(a) {\n  return a;\n}', 'function f(\n  a: {\n    x: number;\n  },\n): Promise<\n  number\n> {\n  return a;\n}'), 'multi-line types');
});

test('code changes are refused', () => {
  assert.ok(!same('const s = "a  b";', 'const s = "a b";'), 'whitespace inside a string');
  assert.ok(!same('const s = `a  ${x}`;', 'const s = `a ${x}`;'), 'whitespace inside a template');
  assert.ok(!same('const r = /a  b/;', 'const r = /a b/;'), 'whitespace inside a regex');
  assert.ok(!same('x = a + b;', 'x = a - b;'), 'operator');
  assert.ok(!same('x = a.b;', 'x = a.b as number + 1;'), 'real change on a typed line');
  assert.ok(!same('f(a, b);', 'f((a, b) as T);'), 'comma inside parentheses');
  assert.ok(!same('x = a || b.c;', 'x = (a || b as T).c;'), 'parentheses that change precedence');
  assert.ok(!same('x = a?.b.c;', 'x = (a?.b as T).c;'), 'parentheses that break an optional chain');
  assert.ok(!same('x\na.b = 1', 'x\n(a as T).b = 1'), 'a cast at a line start after an expression is a call');
  assert.ok(!same('x = new a.b();', 'x = new (a.b() as T)();'), 'new');
  assert.ok(!same('enum E { A }', 'enum E { A, B }'), 'enum fails to strip');
  assert.ok(!sameCode('a', 'a', 'x.sh').same, 'not a code file');
});

test('line breaks count only where semicolon insertion reads them', () => {
  assert.ok(same('() => { return a; }', '() => { return a as T; }'));
  assert.ok(!same('function f() { return a; }', 'function f() { return (\n a as T); }'.replace('(\n', '\n(')), 'return then a break');
  assert.ok(!same('a\n++b', 'a++\nb'), 'postfix');
  assert.ok(same('x = a\n  .b', 'x = a.b'), 'a break inside a chain');
  assert.ok(!same('const f = (a) => a;', 'const f = (a): \n T => a;'), 'a break before =>');
});

test('JSDoc-only front-end edits are the same code', () => {
  const js = (a: string, b: string) => sameCode(a, b, 'public/x.js').same;
  assert.ok(js('function f(a) {}', '/** @param {string} a */\nfunction f(a) {}'), '@param');
  assert.ok(js('const el = q("#x");\nel.value = 1;', 'const el = /** @type {HTMLInputElement} */ (q("#x"));\nel.value = 1;'), 'cast with parentheses');
  assert.ok(!js('const el = q("#x");', 'const el = /** @type {HTMLInputElement} */ (q("#y"));'), 'code change on the cast line');
  assert.ok(!js('t.textContent = "a  b";', '/** @type {X} */ (t).textContent = "a b";'), 'string change');
  assert.ok(js('x = a / b / c;', 'x = a / b / c; // y'), 'division');
  assert.ok(js('if (x) /a b/.test(y);', 'if (x) /a b/.test(y); // y'), 'regex after if ( )');
  assert.ok(!js('function f() {}\n/a  b/;', 'function f() {}\n/a b/;'), 'regex after a block');
  assert.ok(sameCode('declare const a: number;', 'declare const a: string;', 'public/x.d.ts').same, 'a declaration file');
});

const repo = mkdtempSync(join(tmpdir(), 'types-only-'));
after(() => rmSync(repo, { recursive: true, force: true })); // timing-ok: own temp dir

test('the CLI exits 0 only when every changed file is the same code', () => {
  const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  writeFileSync(join(repo, 'a.ts'), 'export function f(a) { return a; }\n');
  writeFileSync(join(repo, 'b.ts'), 'export const b = 1;\n');
  git('add', '.');
  git('commit', '-qm', 'base');
  git('checkout', '-qb', 'work');
  writeFileSync(join(repo, 'a.ts'), 'export function f(a: number): number { return a; }\n');
  git('commit', '-qam', 'types');
  const cli = join(import.meta.dirname, '..', 'tools', 'types-only.ts');
  const run = () => {
    try {
      return { code: 0, out: execFileSync(process.execPath, [cli, 'main'], { cwd: repo, encoding: 'utf8' }) };
    } catch (e) {
      const err = e as { status: number; stdout: string };
      return { code: err.status, out: err.stdout };
    }
  };
  let r = run();
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^same\ta\.ts$/m);
  writeFileSync(join(repo, 'b.ts'), 'export const b = 2;\n');
  git('commit', '-qam', 'code');
  r = run();
  assert.equal(r.code, 1);
  assert.match(r.out, /^differs\tb\.ts\t/m);
});
