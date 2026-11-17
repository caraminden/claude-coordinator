// #890's title bar hint in the real app window. The window's own ⌃ (left of the caption buttons, at the same screen
// spot with the title bar shown or hidden) is clicked for real: with the title bar showing the note shows, and hiding
// the title bar takes it away for good.
const state = () => ev(`const o = navigator.windowControlsOverlay, r = o.getTitlebarAreaRect();
  return { visible: o.visible, x: r.x, w: r.width, h: r.height, hint: !!document.querySelector('.wco-hint'), saved: localStorage.getItem('cc-wco-hint') }`);
await home();
let s = await state();
note('start', s);
expect('the app opens with the title bar hidden (Edge, after an install)', s.visible, true);
const chevron = await screenPt(APP.s, s.x + s.w + 14, s.h / 2);
await mouse(`click ${chevron.join(' ')}`);
await sleep(1200);
s = await state();
note('after ⌃', s);
expect('⌃ shows the title bar', s.visible, false);
await ev(`localStorage.removeItem('cc-wco-hint'); location.reload(); return 1`);
await sleep(4000);
s = await state();
expect('with the title bar showing, the hint shows', s.hint, true);
await snap('hint-shown');
await mouse(`click ${chevron.join(' ')}`);
await sleep(1200);
s = await state();
note('after ⌃ again', s);
expect('⌃ hides the title bar again', s.visible, true);
expect('and the hint is gone for good', [s.hint, s.saved], [false, '1']);
await snap('hint-gone');
await home();
