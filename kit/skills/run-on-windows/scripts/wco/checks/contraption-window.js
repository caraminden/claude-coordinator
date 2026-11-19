// #988: an app's own window (the contraption's page at top level, no Citadel around it). With the switch on, a link
// to the same app stays in the window and an outside link goes to Firefox (citadel-firefox:, whose prompt we accept);
// nothing opens in Edge. What proves it: the 'same stays' PASS and the 'window link' shot (Firefox's tab at /window-link).
// This rig has no apps domain, so the switch is read from Citadel's own localStorage on the same origin: the cookie a
// framed visit leaves on a real app host (rail.js mirrorFirefox) is covered by test/frame-protocol-browser.test.ts only.
await ev(`localStorage.setItem('citadel-open-in-firefox','1'); location.assign('/apps/wco-fixture/extlinks.html'); return 1`);
for (let i = 0; i < 60 && !(await ev(`return !!(document.readyState === 'complete' && location.pathname === '/apps/wco-fixture/extlinks.html' && document.getElementById('top-out') && document.querySelector('.citadel-rail'))`).catch(() => false)); i++) await sleep(250);
await sleep(1500);
expect('top-level, not framed', await ev(`return window.parent === window`), true);
await click('#same');
expect('same app stays in the window', await ev(`return location.pathname + location.hash`), '/apps/wco-fixture/extlinks.html#same');
await click('#top-out');
await snap('prompt');
await mouse('uia-click ^Always allow');
note(await mouse('uia-click ^Open$'));
await sleep(2500);
expect('window still on the app', await ev(`return location.pathname`), '/apps/wco-fixture/extlinks.html');
await snap('window link');
const origin = await ev('return location.origin');
note('pages opened elsewhere', (await send('Target.getTargets')).targetInfos.filter((t) => t.type === 'page' && !t.url.startsWith(origin)).map((t) => t.url));
await ev(`localStorage.removeItem('citadel-open-in-firefox'); location.assign('/c/'); return 1`);
