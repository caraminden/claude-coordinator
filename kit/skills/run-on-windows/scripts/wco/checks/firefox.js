// #988: "Open links in Firefox". In the installed app, with the switch on, a real click on an external link (in
// Citadel's own page, and in a framed contraption) asks the browser to open citadel-firefox:, whose "Open this
// app?" prompt we accept; with the switch off the prompt never comes. Firefox's command lines are read after, on
// the box afterwards, since the driver can't list processes: expect -url https://example.org/top-link-on and
// /frame-link there, and no /top-link-off. (The prompt's "Open" button can't be told from other buttons named open.)
const ANCHOR = `const a = document.createElement('a'); a.id = 'ff-test'; a.href = 'https://example.org/top-link-' + (localStorage.getItem('citadel-open-in-firefox') ? 'on' : 'off'); a.target = '_blank'; a.textContent = 'External link in Citadel'; a.style.cssText = 'position:fixed;left:200px;top:200px;z-index:99999;font-size:28px;background:#fff'; document.body.append(a); return 1`;
// A link that opens in Edge (switch off) lands in a browser window that then covers the app: close those tabs.
const tidy = async () => {
  for (const t of (await send('Target.getTargets')).targetInfos) if (t.type === 'page' && !t.url.startsWith(location_origin)) await send('Target.closeTarget', { targetId: t.targetId });
  await home();
};
const location_origin = await ev('return location.origin');
const prompt = async () => {
  for (let i = 0; i < 8; i++) {
    const r = await mouse('uia-list .');
    if (/Open|Always allow/i.test(r)) return r;
    await sleep(500);
  }
  return '';
};
const accept = async () => { await snap('prompt'); note('prompt', (await prompt()).slice(0, 0)); await mouse('uia-click ^Always allow'); note(await mouse('uia-click ^Open$')); await sleep(2500); };
await home();
await go('#/p/99999');
await tidy();
for (const on of [false, true]) {
  await ev(`${on ? "localStorage.setItem('citadel-open-in-firefox','1')" : "localStorage.removeItem('citadel-open-in-firefox')"}; return 1`);
  await ev(`document.getElementById('ff-test')?.remove(); ${ANCHOR}`);
  await click('#ff-test');
  if (on) await accept();
  else { await sleep(2500); await tidy(); }
  await home();
}
await openFixture('extlinks.html');
await ev(`localStorage.setItem('citadel-open-in-firefox','1'); return 1`);
await ev(`${FRAME} return f.contentWindow.location.reload(), 1`);
await sleep(2500);
await tidy();
await click('#ext', true);
await accept();
await snap('firefox links');
await ev(`localStorage.removeItem('citadel-open-in-firefox'); return 1`);
