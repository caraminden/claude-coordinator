// Cheap style updates (#1534): a `:has()` before a child or descendant that has nothing to filter on (`X:has(…) > *`,
// `X:has(…) *`, `X:has(…) > :not(.a)`) made every node added anywhere on the page cost about 20 ms of style, not 1.
// Four such rules in settings.css were 20 of the 21 ms one chat line cost; tools/has-cost.mjs measures it again.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';

const ROOT = join(import.meta.dirname, '..');
const PUBLIC = join(ROOT, 'public');

/** The selectors of every rule in a sheet, comments left out (an at-rule's own prelude is skipped, its rules kept). */
function selectors(css: string): string[] {
  const out: string[] = [];
  for (const m of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{};]+)\{/g)) {
    const prelude = m[1].trim();
    if (prelude && !prelude.startsWith('@')) out.push(...splitTop(prelude, ','));
  }
  return out.map((s) => s.trim()).filter(Boolean);
}

/** Splits at `sep` outside any brackets or parentheses. */
function splitTop(s: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0, from = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (c === sep && depth === 0) { parts.push(s.slice(from, i)); from = i + 1; }
  }
  parts.push(s.slice(from));
  return parts;
}

/** A complex selector as [compound, combinator, compound, …]; the combinator is ' ', '>', '+' or '~'. */
function compounds(sel: string): string[] {
  const out: string[] = [];
  let depth = 0, cur = '', comb = '';
  for (const c of sel.trim()) {
    if (c === '(' || c === '[') depth++;
    if (c === ')' || c === ']') depth--;
    if (depth === 0 && /[\s>+~]/.test(c)) {
      if (c !== ' ' && c !== '\n' && c !== '\t') comb = c;
      else if (!comb) comb = ' ';
      continue;
    }
    if (comb && cur) { out.push(cur, comb === ' ' || /\s/.test(comb) ? ' ' : comb); cur = ''; }
    comb = '';
    cur += c;
  }
  if (cur) out.push(cur);
  return out;
}

/** Drops the arguments of `:not()` and `:has()` (they never narrow which elements a compound is tried on). */
function withoutNegations(compound: string): string {
  let s = compound;
  for (;;) {
    const at = s.search(/:(not|has)\(/);
    if (at < 0) return s;
    let i = s.indexOf('(', at), depth = 0;
    for (; i < s.length; i++) { if (s[i] === '(') depth++; else if (s[i] === ')' && --depth === 0) break; }
    s = s.slice(0, at) + s.slice(i + 1);
  }
}

/** True when a compound names something to filter on: a type, class, id or attribute (an :is() or :where() of them counts). */
const narrows = (compound: string) => /^[a-zA-Z]|[.#[]/.test(withoutNegations(compound).replace(/::?[a-z-]+(?!\()/g, ''));

/** The costly shape: a `:has()` in an ancestor or parent compound, and a subject with nothing to filter on. */
function costlyHas(sel: string): boolean {
  const parts = compounds(sel);
  const subject = parts[parts.length - 1];
  if (narrows(subject)) return false;
  for (let i = 0; i < parts.length - 1; i += 2) {
    if (!parts[i].includes(':has(')) continue;
    // A sibling-only path (`X:has(…) ~ *`, `+ *`) measured as cheap as no rule; a child or descendant step is the cost.
    const combs = parts.slice(i + 1).filter((_, k) => k % 2 === 0);
    if (combs.some((c) => c === ' ' || c === '>')) return true;
  }
  return false;
}

const sheets = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? sheets(join(dir, e.name)) : e.name.endsWith('.css') ? [join(dir, e.name)] : []);

test('the checker flags the four rules that cost 20 ms, and passes their rewrites', () => {
  for (const bad of [
    '.shelf .account .foot:has(.get-app) > *',
    '.artifacts-main:has(> .ticket-head > .settings-tabs) > :not(.ticket-head)',
    '.artifacts-main:has(> .ticket-head > .settings-tabs) > *',
    '.ticket-head:has(> .settings-tabs) > *',
    '.zzz:has(.get-app) *',
    ':where(.foot:has(.get-app)) > *',
    'body:has(.split) *::before',
  ]) assert.ok(costlyHas(bad), `flags ${bad}`);
  for (const ok of [
    '.artifacts-main > .ticket-head:has(> .settings-tabs) ~ :not(.ticket-head)',
    '.artifacts-main > :has(~ .ticket-head > .settings-tabs)',
    '.ticket-head > .settings-tabs ~ *',
    '.shelf .account .foot > :is(.get-app, .get-app ~ *, :has(~ .get-app))',
    'body:has(.split) main',
    'body:has(.split) .topbar',
    '.panels:has(> details[open]) > details:not([open]) > summary::after',
    '.progress-line .text:has(.doing) > :is(.stepname, .arrow)',
    '.qcard.answered .tile:not(:has(.opt.picked))',
    '.foo:has(.x) + *',
  ]) assert.ok(!costlyHas(ok), `passes ${ok}`);
});

test('no stylesheet puts :has() before a child or descendant with nothing to filter on', () => {
  const found: string[] = [];
  for (const file of sheets(PUBLIC)) {
    for (const sel of selectors(readFileSync(file, 'utf8'))) if (costlyHas(sel)) found.push(`${relative(ROOT, file)}: ${sel}`);
  }
  assert.deepEqual(found, [], 'A :has() before `> *`, ` *` or `> :not(…)` makes every node added anywhere on the page cost ' +
    'about 20 ms of style (#1534). Give the child a class (`X:has(…) > .row`), use the siblings around the one that ' +
    'decides (`X > .tabs ~ *`, `X > :has(~ .tabs)`), or set a class from the code that knows. Found:\n' + found.join('\n'));
});
