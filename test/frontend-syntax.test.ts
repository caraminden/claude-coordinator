import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { Script } from 'node:vm';

// Every public/**/*.js must parse the way the browser loads it (the 9deeda36 fix: a stray apostrophe in
// public/reviews.js broke a page and nothing in the suite noticed). package.json says "type": "module",
// so `node --check` parses as a module; a file an HTML page loads with a plain <script> is a classic script.
const publicDir = resolve(import.meta.dirname, '..', 'public');

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

/** Files some page loads as a classic script: <script src> without type="module", plus the service worker. */
function classicScripts(): Set<string> {
  const classic = new Set<string>([join(publicDir, 'sw.js')]);
  for (const html of walk0(publicDir)) {
    const src = readFileSync(html, 'utf8');
    for (const m of src.matchAll(/<script\b([^>]*)>/g)) {
      const attrs = m[1];
      const s = /\bsrc="([^"]+)"/.exec(attrs);
      if (!s || /\btype="module"/.test(attrs) || /^https?:/.test(s[1])) continue;
      classic.add(resolve(dirname(html), s[1].split('?')[0]));
    }
  }
  return classic;
}
function walk0(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk0(p, out);
    else if (e.name.endsWith('.html')) out.push(p);
  }
  return out;
}

function parseError(file: string, classic: boolean): string | null {
  if (classic) {
    try {
      new Script(readFileSync(file, 'utf8'), { filename: file });
      return null;
    } catch (e) {
      return String((e as Error).message);
    }
  }
  const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  return r.status === 0 ? null : r.stderr.split('\n').slice(0, 6).join('\n');
}

test('every public/**/*.js parses the way the browser loads it', () => {
  const files = walk(publicDir);
  assert.ok(files.length > 50, 'found the front-end files');
  const classic = classicScripts();
  const bad: string[] = [];
  for (const f of files) {
    const err = parseError(f, classic.has(f));
    if (err) bad.push(`${relative(publicDir, f)} (${classic.has(f) ? 'classic script' : 'module'}): ${err}`);
  }
  assert.deepEqual(bad, [], 'syntax errors in the front end');
});
