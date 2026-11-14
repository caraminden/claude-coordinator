// #667: in the installed app, over each page in ROUTES, every button in a framed contraption's .cui-topbar clicks
// (a late-shown one too), the bar's empty space drags the window, and Citadel's ‹ › × still work.
for (const under of ROUTES) {
  note(`--- under ${under}`);
  await home();
  await go(under);
  await openFixture();
  for (const late of [false, true]) {
    await ev(`${FRAME} d.getElementById('late').hidden = ${!late}; w.clicks.length = 0; return 1`);
    await sleep(400);
    const ids = await ev(`${FRAME} return [...d.querySelectorAll('.cui-topbar button')].filter((b) => !b.hidden).map((b) => b.id)`);
    for (const id of ids) await click(`#${id}`, true);
    await click('#body', true);
    expect(late ? 'bar buttons click, late Restart shown' : 'bar buttons click', await frameClicks(), [...ids, 'body']);
  }
  await ev(`${FRAME} d.getElementById('late').hidden = true; w.clicks.length = 0; return 1`);
  await snap(`topbar ${under.replace(/[#/]+/g, ' ').trim()}`);
  // The bar's empty middle, between Left and Icons.
  const gap = await ev(`${FRAME} const a = d.getElementById('b1').getBoundingClientRect(), b = d.getElementById('b2').getBoundingClientRect(); return [fr.left + (a.right + b.left) / 2, fr.top + (a.top + a.bottom) / 2];`);
  expect('empty bar drags the window', await drag(gap), ([dx, dy]) => dx > 40 && dy > 25);
  expect('the drag clicked nothing', await frameClicks(), []);
  await home();
  await click('.frame-nav .nav-back');
  expect('‹ goes back to the page under the frame', await ev('return location.hash'), under);
  await go('#/apps/wco-fixture');
  await go(MINION);
  await ev('history.back(); return 1');
  await sleep(1500);
  await click('.frame-nav .nav-forward');
  expect('› goes forward', await ev('return location.hash'), MINION);
  await go(under);
  await go('#/apps/wco-fixture');
  await click('.frame-nav .close-view');
  expect('× leaves the app', await ev('return document.documentElement.classList.contains("framed")'), false);
}
