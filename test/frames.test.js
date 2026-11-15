// #765: Citadel's icon on a phone opens Citadel, not the contraption that was framed in it when you left.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AWAY, opensOnCitadel } from '../public/frames.js';

const mandate = '#/apps/mandate';

test('an installed Citadel on a phone that reloads on a framed contraption opens on Citadel', () => {
  // After the phone closed it in the background, Chrome reloads the page it showed: no time away to go by.
  assert.equal(opensOnCitadel({ phoneApp: true, hash: mandate }), true);
});

test('coming back after a while away with a contraption framed opens on Citadel', () => {
  assert.equal(opensOnCitadel({ phoneApp: true, hash: mandate, away: AWAY }), true);
  assert.equal(opensOnCitadel({ phoneApp: true, hash: mandate, away: 10 * 60_000 }), true);
});

test('a short trip out (a photo picker, the share sheet, a quick switch) keeps the contraption', () => {
  assert.equal(opensOnCitadel({ phoneApp: true, hash: mandate, away: AWAY - 1 }), false);
  assert.equal(opensOnCitadel({ phoneApp: true, hash: mandate, away: 0 }), false);
});

test("Citadel's own views stay as they are", () => {
  for (const hash of ['', '#/', '#/t/12', '#/share?text=hi', '#/apps']) {
    assert.equal(opensOnCitadel({ phoneApp: true, hash }), false, hash);
    assert.equal(opensOnCitadel({ phoneApp: true, hash, away: AWAY }), false, hash);
  }
});

test('a browser tab or a desktop window keeps its contraption', () => {
  assert.equal(opensOnCitadel({ phoneApp: false, hash: mandate }), false);
  assert.equal(opensOnCitadel({ phoneApp: false, hash: mandate, away: 10 * 60_000 }), false);
});
