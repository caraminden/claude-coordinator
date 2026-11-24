// The README's Layout table is how a minion finds where something lives (#1645). It only works if it is complete, so
// every module in src/, src/routes/, src/db/, public/ and tools/ needs a row: its own path, a glob (`src/ci-*.ts`) or a
// folder (`public/ui/`). The test checks presence, not wording; a row naming a path that is gone fails too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const ROOTS = ['src', 'src/routes', 'src/db', 'public', 'tools'];
const ASSET = /\.(png|svg|webmanifest|css|json|txt|gradle|attributes|d\.ts)$/;

export function layoutTokens(readme: string): string[] {
  const start = readme.indexOf('\n## Layout');
  assert.ok(start >= 0, 'README.md has no "## Layout" section');
  const rest = readme.slice(start + 1);
  const end = rest.indexOf('\n## ', 3);
  const section = end < 0 ? rest : rest.slice(0, end);
  const out: string[] = [];
  for (const line of section.split('\n')) {
    if (!line.startsWith('|')) continue;
    const firstCell = line.split('|')[1] ?? '';
    for (const m of firstCell.matchAll(/`([^`]+)`/g)) out.push(m[1]!);
  }
  return out;
}

function toRegex(glob: string): RegExp {
  return new RegExp('^' + glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*') + '$');
}

export function covers(token: string, path: string): boolean {
  if (ROOTS.includes(token.replace(/\/$/, ''))) return false; // a bare root row covers nothing under it
  if (token.endsWith('/')) return path.startsWith(token);
  return token.includes('*') ? toRegex(token).test(path) : token === path;
}

export function modules(dir = root): string[] {
  const found: string[] = [];
  for (const r of ROOTS) {
    for (const e of readdirSync(join(dir, r), { withFileTypes: true })) {
      if (e.isDirectory() && ROOTS.includes(`${r}/${e.name}`)) continue; // src/routes and src/db have their own pass
      if (e.isFile() && ASSET.test(e.name)) continue;
      found.push(`${r}/${e.name}${e.isDirectory() ? '/' : ''}`);
    }
  }
  return found;
}

test('every module under src, src/routes, src/db, public and tools has a row in the README Layout table', () => {
  const tokens = layoutTokens(readFileSync(join(root, 'README.md'), 'utf8'));
  const missing = modules().filter((m) => !tokens.some((t) => covers(t, m)));
  assert.deepEqual(missing, [], 'add each to the README "## Layout" table (a path, a glob like `src/ci-*.ts`, or a folder)');
});

test('a Layout row names no path that is gone', () => {
  const tokens = layoutTokens(readFileSync(join(root, 'README.md'), 'utf8'));
  const all = modules();
  const stale = tokens.filter((t) => /^(server\.ts|src|public|tools|kit|deploy)\//.test(t) || t === 'server.ts').filter((t) => (t.includes('*') ? !all.some((m) => covers(t, m)) : !existsSync(join(root, t))));
  assert.deepEqual(stale, []);
});

test('the check fails on a table with a gap and passes with the row', () => {
  const table = '\n## Layout\n\n| Path | What |\n| --- | --- |\n| `src/a.ts` | a |\n\n## Next\n';
  assert.ok(!layoutTokens(table).some((t) => covers(t, 'src/b.ts')));
  assert.ok(layoutTokens(table.replace('`src/a.ts`', '`src/a.ts`, `src/b*.ts`')).some((t) => covers(t, 'src/b.ts')));
  assert.ok(!covers('public/', 'public/app.js'), 'a bare root row covers nothing');
  assert.ok(covers('public/ui/', 'public/ui/chat.js'));
});
