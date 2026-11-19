// #988: "Open links in Firefox". In the installed app, with the switch on, a real click on an external link (in
// Citadel's own page, and in a framed contraption) asks the browser to open citadel-firefox:, whose "Open this
// app?" prompt we accept; with the switch off the link opens in Edge as before. It asserts nothing itself: what
// proves it is the 'firefox links' shot (Firefox's tabs: /top-link-on and /frame-link, no /top-link-off), or the
// box's handler logging its argument. Needs the one-time setup on the box (public/citadel-firefox-link.ps1).
const ANCHOR = `const a = document.createElement('a'); a.id = 'ff-test'; a.href = 'https://example.org/top-link-' + (localStorage.getItem('citadel-open-in-firefox') ? 'on' : 'off'); a.target = '_blank'; a.textContent = 'External link in Citadel'; a.style.cssText = 'position:fixed;left:200px;top:200px;z-index:99999;font-size:28px;background:#fff'; document.body.append(a); return 1`;
// A link that opens in Edge (switch off) lands in a browser window that then covers the app: close those tabs.
const tidy = async () => {
  for (const t of (await send('Target.getTargets')).targetInfos) if (t.type === 'page' && !t.url.startsWith(location_origin)) await send('Target.closeTarget', { targetId: t.targetId });
  await home();
};
const location_origin = await ev('return location.origin');
const accept = async () => { await snap('prompt'); await mouse('uia-click ^Always allow'); note(await mouse('uia-click ^Open$')); await sleep(2500); };
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
