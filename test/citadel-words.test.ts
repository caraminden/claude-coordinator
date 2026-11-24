// Citadel's glossary (#1773): kit/skills/citadel-words/SKILL.md is the one list of Citadel's words. The help page's
// words (public/help-words.js) and the wording check's reserved words (src/wording.ts) are tied to it here, so either
// drifting from it is red.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { RESERVED } from '../src/wording.ts';

const ROOT = join(import.meta.dirname, '..');
const { WORDS } = await import(join(ROOT, 'public', 'help-words.js'));
const text = readFileSync(join(ROOT, 'kit', 'skills', 'citadel-words', 'SKILL.md'), 'utf8');
const [language, retiredPart = ''] = text.split(/^## Retired and restricted words$/m);

/** Each entry: its terms (one line of **bold** names ending in a colon) and its Code line's names. */
function entries(part: string) {
  const out: { terms: string[]; code: string[]; body: string }[] = [];
  for (const block of part.split(/\n(?=\*\*)/)) {
    const head = block.match(/^((?:\*\*[^*]+\*\*(?:,\s*)?)+)/);
    if (!head) continue;
    const terms = [...head[1].matchAll(/\*\*([^*]+)\*\*/g)].map((m) => m[1].toLowerCase());
    const code = [...(block.match(/^Code: (.*)$/m)?.[1] ?? '').matchAll(/`([^`]+)`|([a-z][\w-]*)/gi)].map((m) => (m[1] ?? m[2]).toLowerCase());
    out.push({ terms, code, body: block });
  }
  return out;
}
const words = entries(language);
const retired = entries(retiredPart);

test('the glossary has its terms and its retired words', () => {
  assert.ok(words.length >= 30 && retired.length >= 5, `${words.length} terms, ${retired.length} retired`);
  for (const r of retired) assert.match(r.body, /_\((?:retired|restricted)\)_:.*\b(?:say|is ship|only)\b/, `${r.terms}: name its replacement`);
});

test('every help-page word is a glossary term, under its own key or its code name', () => {
  for (const [key, w] of Object.entries<{ word: string }>(WORDS)) {
    const e = words.find((x) => x.terms.includes(w.word.toLowerCase()));
    assert.ok(e, `help-words.js defines "${w.word}", which the glossary (kit/skills/citadel-words/SKILL.md) lacks: add it there`);
    assert.ok(e.terms.includes(key) || e.code.includes(key), `help-words.js keys "${w.word}" as "${key}", neither its term nor a name on its Code line`);
    assert.ok(!retired.some((r) => r.terms.includes(w.word.toLowerCase())), `help-words.js shows "${w.word}", a retired word`);
  }
});

test('every word the wording check sends back is a retired or restricted word in the glossary', () => {
  for (const r of RESERVED) {
    assert.ok(
      retired.some((x) => x.terms.includes(r.term.toLowerCase())),
      `wording.ts sends back "${r.term}", which the glossary's retired words lack: add it there`,
    );
  }
});

test('every state a minion can be in is a glossary term, under its code name', async () => {
  const { TICKET_STATES } = await import('../src/db.ts');
  for (const st of TICKET_STATES)
    assert.ok(
      words.some((e) => e.code.includes(st)),
      `src/db.ts has the state "${st}", which no glossary entry names on its Code line`,
    );
});
