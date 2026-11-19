// #988: "Open links in Firefox". In the installed app, with the switch on, a real click on an external link (in
// Citadel's own page, and in a framed contraption) asks the browser to open citadel-firefox:, whose "Open this
// app?" prompt we accept; with the switch off the prompt never comes. Firefox's command lines are read after, on
// the box (the rig's firefox-link PowerShell line in the skill), since the driver can't list processes.
const ANCHOR = `const a = document.createElement('a'); a.id = 'ff-test'; a.href = 'https://example.org/top-link'; a.target = '_blank'; a.textContent = 'External link in Citadel'; a.style.cssText = 'position:fixed;left:200px;top:200px;z-index:99999;font-size:28px;background:#fff'; document.body.append(a); return 1`;
const prompt = async () => {
  for (let i = 0; i < 8; i++) {
    const r = await mouse('uia-list .');
    if (/Open|Always allow/i.test(r)) return r;
    await sleep(500);
  }
  return '';
};
const accept = async () => { note('prompt', await prompt()); await mouse('uia-click ^Always allow'); note(await mouse('uia-click ^Open$')); await sleep(2500); };
await home();
await go('#/p/99999');
for (const on of [false, true]) {
  await ev(`${on ? "localStorage.setItem('citadel-open-in-firefox','1')" : "localStorage.removeItem('citadel-open-in-firefox')"}; return 1`);
  await ev(`document.getElementById('ff-test')?.remove(); ${ANCHOR}`);
  await click('#ff-test');
  const r = await prompt();
  expect(`switch ${on ? 'on' : 'off'}: top-level link ${on ? 'asks to open Firefox' : 'raises no prompt'}`, /^none$|^$/.test(r) ? false : true, on);
  if (on) await accept();
  else { await mouse('key {ESC}'); }
  await home();
}
await openFixture('links.html');
await ev(`localStorage.setItem('citadel-open-in-firefox','1'); return 1`);
await ev(`${FRAME} return f.contentWindow.location.reload(), 1`);
await sleep(2500);
await click('#ext', true);
expect('switch on: framed contraption link asks to open Firefox', !!(await prompt()), true);
await accept();
await snap('firefox links');
await ev(`localStorage.removeItem('citadel-open-in-firefox'); return 1`);
