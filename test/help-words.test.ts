// Plain-words help (#1131): the glossary's one file, every label that uses it, and the page's pictures.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const PUBLIC = join(import.meta.dirname, '..', 'public');
const { WORDS } = await import(join(PUBLIC, 'help-words.js'));
const sources = readdirSync(PUBLIC).filter((f) => f.endsWith('.js') && f !== 'help-words.js').map((f) => [f, readFileSync(join(PUBLIC, f), 'utf8')] as const);

test('the nine starting words are defined, each in a sentence or two', () => {
  assert.deepEqual(Object.keys(WORDS).sort(), ['card', 'contraption', 'grunt', 'minion', 'parked', 'scheme', 'ship', 'taskmaster', 'turn']);
  for (const [k, w] of Object.entries<{ word: string; def: string }>(WORDS)) {
    assert.ok(w.word && w.def.length < 220, `${k}: one short definition`);
    assert.ok((w.def.match(/[.!?](\s|$)/g) ?? []).length <= 2, `${k}: two sentences at most`);
  }
});

test('every label that asks for a word asks for one that is defined', () => {
  const used = new Set<string>();
  for (const [f, src] of sources) for (const m of src.matchAll(/\bgloss\('([a-z]+)'|'data-gloss': '([a-z]+)'/g)) used.add(m[1] ?? m[2]);
  assert.deepEqual([...used].filter((k) => !(k in WORDS)), [], 'a gloss names a word help-words.js lacks');
  assert.deepEqual(Object.keys(WORDS).filter((k) => !used.has(k)), [], 'a defined word no label explains');
});

test('the page reads the same file and its pictures exist', () => {
  const page = readFileSync(join(PUBLIC, 'help.js'), 'utf8');
  assert.match(page, /from '\.\/help-words\.js'/);
  for (const m of page.matchAll(/\[\s*'([a-z]+)',\s*'[^']+'\]/g)) assert.ok(existsSync(join(PUBLIC, `help-${m[1]}.png`)), `help-${m[1]}.png`);
});

test('chat text is never glossed', () => {
  for (const f of ['bubbles.js', 'chattext.js', 'replies.js', 'narration.js']) assert.ok(!/gloss/.test(readFileSync(join(PUBLIC, f), 'utf8')), f);
});
