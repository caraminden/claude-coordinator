// An app's own window (the contraption's page at top level, no Citadel around it): a link to the same app stays in the window.
await ev(`location.assign('/apps/wco-fixture/extlinks.html'); return 1`);
for (let i = 0; i < 60 && !(await ev(`return !!(document.readyState === 'complete' && location.pathname === '/apps/wco-fixture/extlinks.html' && document.getElementById('top-out') && document.querySelector('.citadel-rail'))`).catch(() => false)); i++) await sleep(250);
await sleep(1500);
expect('top-level, not framed', await ev(`return window.parent === window`), true);
await click('#same');
expect('same app stays in the window', await ev(`return location.pathname + location.hash`), '/apps/wco-fixture/extlinks.html#same');
await ev(`location.assign('/c/'); return 1`);
