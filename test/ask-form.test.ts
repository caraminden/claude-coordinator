import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkAsk, formatAsk } from '../src/ask-form.ts';

const full = { saw: '401 on /api/x', checked: 'read my logs; same 401 from curl', wanted: 'look at your token check', by: 'today' };

test('an ask with no "what I checked" comes back with a one-line reason', () => {
  for (const checked of [undefined, '', '  ', 'nothing', 'Nothing.', 'none', 'n/a', 'no']) {
    const r = checkAsk({ ...full, checked });
    assert.ok('error' in r && /checked/.test(r.error) && !r.error.includes('\n'), String(checked));
  }
});

test('every part is required', () => {
  for (const k of ['saw', 'wanted', 'by']) assert.match((checkAsk({ ...full, [k]: '' }) as any).error, new RegExp(k));
});

test('a full ask lays out the same way every time, with free text after', () => {
  const r = checkAsk({ ...full, text: 'extra' });
  assert.ok('ask' in r);
  assert.equal(formatAsk(r.ask), `What I saw: 401 on /api/x\nWhat I checked on my side: read my logs; same 401 from curl\nWhat I need: look at your token check\nBy when: today\n\nextra`);
});
