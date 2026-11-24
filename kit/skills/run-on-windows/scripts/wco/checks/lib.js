// What every check gets: rig.ts runs this file, then the check, then `return report()`, as one async function body in
// the box's driver.mjs (whose helpers send, mouse, session, evIn, screenPt, shot, sleep and log are in scope).
// ROUTES (the pages to test under the frame) and MINION (a minion's route) come from rig.ts.
// Points are CSS px in Citadel's page; frame: true means a selector inside the fixture's frame.
const APP = await session('/c/');
const ev = (js) => evIn(APP.s, js);
const { windowId: WINDOW } = await send('Browser.getWindowForTarget', { targetId: APP.targetId });
const lines = [];
/** A PASS or FAIL line: `got` matches `want` when their JSON is the same, or when `want` is a function returning true. */
const expect = (what, got, want) => {
  const ok = typeof want === 'function' ? !!want(got) : JSON.stringify(got) === JSON.stringify(want);
  lines.push(`${ok ? 'PASS' : 'FAIL'} ${what}: ${JSON.stringify(got)}${ok || typeof want === 'function' ? '' : ` (want ${JSON.stringify(want)})`}`);
  return ok;
};
const note = (...a) => lines.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
const report = () => lines.join('\n');
/** Puts the app window back where checks expect it, at the front. */
const home = async () => {
  await send('Browser.setWindowBounds', { windowId: WINDOW, bounds: { left: 20, top: 10, width: 1300, height: 800 } });
  await send('Page.bringToFront', {}, APP.s);
  await sleep(800);
};
const windowAt = async () => {
  const { bounds: b } = await send('Browser.getWindowBounds', { windowId: WINDOW });
  return [b.left, b.top];
};
/** The visible frame in Citadel's page: `${FRAME} ... d.querySelector(...)` (f: the iframe, fr: its rect, d: its document, w: its window). */
const FRAME = `const f = document.querySelector('#frames iframe:not([hidden])'); const fr = f?.getBoundingClientRect(); const d = f?.contentDocument; const w = d?.defaultView;`;
/** Goes to a route and waits for it: a framed app with its .cui-topbar up, or an unframed page. */
const go = async (hash) => {
  await ev(`location.hash = ${JSON.stringify(hash)}; return 1`);
  const ready = hash.startsWith('#/apps/') ? `${FRAME} return !!(document.documentElement.classList.contains('frame-topbar') && d?.querySelector('.cui-topbar'))` : `return !document.documentElement.classList.contains('framed')`;
  for (let i = 0; i < 60 && !(await ev(ready)); i++) await sleep(150);
  await sleep(1000);
  return ev('return location.hash');
};
/** Opens the fixture contraption, on fixture/<page> when given (a file in fixture/), else its index, and clears its click log. */
const openFixture = async (page = '') => {
  await go('#/apps/wco-fixture');
  const path = `/apps/wco-fixture/${page}`;
  if (!(await ev(`${FRAME} return d?.location.pathname === '${path}'`))) {
    await ev(`${FRAME} f.contentWindow.location.replace('${path}'); return 1`);
    for (let i = 0; i < 60 && !(await ev(`${FRAME} return !!(d?.readyState === 'complete' && d.location.pathname === '${path}' && d.querySelector('.cui-topbar'))`)); i++) await sleep(150);
    await sleep(800);
  }
  await ev(`${FRAME} w.clicks.length = 0; return 1`);
};
/** The centre of `sel`, in Citadel's page. */
const centre = (sel, frame = false) => ev(`${FRAME} const b = ${frame ? 'd' : 'document'}.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return [${frame ? 'fr.left + ' : ''}b.left + b.width / 2, ${frame ? 'fr.top + ' : ''}b.top + b.height / 2];`);
/** A real mouse click on a selector (or an [x, y] point). */
const click = async (sel, frame = false) => {
  const [x, y] = Array.isArray(sel) ? sel : await centre(sel, frame);
  await mouse(`click ${(await screenPt(APP.s, x, y)).join(' ')}`);
  await sleep(700);
};
/** A real drag from a selector (or point) by 80, 50 screen px; returns how far the window moved, in DIPs. */
const drag = async (sel, frame = false) => {
  const [x, y] = Array.isArray(sel) ? sel : await centre(sel, frame);
  const [sx, sy] = await screenPt(APP.s, x, y);
  const before = await windowAt();
  await mouse(`drag ${sx} ${sy} ${sx + 80} ${sy + 50}`);
  await sleep(700);
  const after = await windowAt();
  return [after[0] - before[0], after[1] - before[1]];
};
/** The ids of the fixture's buttons clicked since openFixture. */
const frameClicks = () => ev(`${FRAME} return w.clicks.slice()`);
/** A screenshot of the app window, saved on perigee as <name>.png (rig.ts prints the folder). */
const snap = async (name) => {
  await sleep(400);
  return shot(name, APP.targetId);
};

await home();
expect('title bar overlay on', await ev(`return !!navigator.windowControlsOverlay?.visible`), true);
