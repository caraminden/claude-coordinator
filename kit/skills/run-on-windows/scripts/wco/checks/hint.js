// #890's title bar hint in the real app window. Edge's app window always has the title bar hidden (no ⌃ to show it,
// unlike Chrome's), so this proves the side Edge can: with the title bar hidden the note never shows, even on a profile
// that hasn't closed it, and is marked done for when the title bar comes back. The title-bar-showing side is test/app-browser.test.ts's, against a stand-in overlay.
await home();
await ev(`localStorage.removeItem('cc-wco-hint'); location.reload(); return 1`);
await sleep(4000);
const s = await ev(`const o = navigator.windowControlsOverlay;
  return { overlay: !!o, visible: o?.visible, standalone: matchMedia('(display-mode: standalone)').matches, hint: !!document.querySelector('.wco-hint'), saved: localStorage.getItem('cc-wco-hint'), module: !!(await import(new URL('wco-hint.js', document.baseURI).href)).wcoHint }`);
note('state', s);
expect('the hint module loads in the app window', s.module, true);
expect('the title bar is hidden', s.visible, true);
expect('so no hint shows', s.hint, false);
expect('and none later, if they show the title bar', s.saved, '1');
await snap('hint');
