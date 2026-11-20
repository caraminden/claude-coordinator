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

// #892: a contraption's page is on its own host (the frame's src redirects there), so its mic needs the delegation to name any origin.
test('a contraption frame may use the microphone, camera and fullscreen on whatever host it ends on', async () => {
  const { FRAME_ALLOW } = await import('../public/frames.js');
  for (const f of ['microphone', 'camera', 'fullscreen']) assert.match(FRAME_ALLOW, new RegExp(`(^|; )${f} \\*(;|$)`));
});

// #1086: Chrome lets a focused page write the clipboard with no click, which Windows Defender flags as a ClickFix attack.
test('only an app that asks for it gets clipboard writes, and no app gets clipboard reads', async () => {
  const { FRAME_ALLOW, frameAllow } = await import('../public/frames.js');
  const { ARTIFACT_ALLOW } = await import('../public/frames.js');
  // Said outright, as a frame on Citadel's own origin gets the clipboard by default.
  for (const allow of [FRAME_ALLOW, ARTIFACT_ALLOW]) for (const f of ['clipboard-read', 'clipboard-write']) assert.match(allow, new RegExp(`(^|; )${f} 'none'(;|$)`));
  assert.equal(frameAllow(false), FRAME_ALLOW);
  assert.match(frameAllow(true), /(^|; )clipboard-write \*(;|$)/);
  assert.match(frameAllow(true), /(^|; )clipboard-read 'none'(;|$)/);
  for (const f of ['microphone', 'camera', 'fullscreen']) assert.match(frameAllow(true), new RegExp(`(^|; )${f} \\*(;|$)`));
});
