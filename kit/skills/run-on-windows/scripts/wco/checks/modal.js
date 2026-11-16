// #772: in the installed app, a framed contraption's modal dialog (Citadel UI's .cui-dialog, wide and tall like Peek
// Auras' Library) opens below the title bar strip, clear of the window controls; its ✕ and title take clicks, not
// the window's drag; the strip above it still drags the window; and the window controls take the backdrop's tint.
const tint = () => ev(`return document.querySelector('meta[name=theme-color][media*=window-controls-overlay]')?.content ?? null`);
const strip = () => ev(`const r = navigator.windowControlsOverlay.getTitlebarAreaRect(); return [r.x, r.width, r.height]`);
const opened = () => ev(`${FRAME} return d.getElementById('lib').open`);
for (const under of ROUTES) {
  note(`--- under ${under}`);
  await home();
  await go(under);
  await openFixture('modal.html');
  const plain = await tint();
  await click('#open', true);
  expect('the Library opens', await opened(), true);
  await snap(`modal open ${under.replace(/[#/]+/g, ' ').trim()}`);
  const [, , h] = await strip();
  expect('the dialog starts below the title bar strip', await ev(`${FRAME} return fr.top + d.getElementById('lib').getBoundingClientRect().top`), (top) => top >= h);
  expect('the window controls take the backdrop', await tint(), (t) => t && t !== plain);
  // The strip first: right after a fresh load, a drag that moved nothing (the title's) left the next drag dead on the box.
  const [x, w] = await strip();
  expect('the strip above the dialog drags the window', await drag([x + w / 3, h / 2]), ([dx, dy]) => dx > 40 && dy > 25);
  await home();
  const title = await ev(`${FRAME} const b = d.getElementById('lib-head').getBoundingClientRect(); return [fr.left + b.left + 40, fr.top + b.top + b.height / 2]`);
  expect('the dialog title does not drag the window', await drag(title), [0, 0]);
  await home();
  expect('the Library is still open', await opened(), true);
  await ev(`${FRAME} w.clicks.length = 0; return 1`);
  await click('#x', true);
  expect('its ✕ clicks', await frameClicks(), ['x']);
  expect('its ✕ closes it', await opened(), false);
  expect('the window is not maximised', (await send('Browser.getWindowBounds', { windowId: WINDOW })).bounds.windowState, 'normal');
  expect('the tint comes back', await tint(), plain);
}
