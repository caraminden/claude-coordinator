// #2287: in the installed app, Citadel's own modal dialogs (the "Attached image" viewer is the kit's lightbox) dim the
// window controls with their backdrop, and closing puts the colour back. Cara, 2026-11-28: the page dimmed, the controls stayed bright.
const tint = () => ev(`return document.querySelector('meta[name=theme-color][media*=window-controls-overlay]')?.content ?? null`);
await home();
await go(MINION);
await sleep(1500);
const plain = await tint();
await snap('citadel modal before');
// The image viewer itself, as a click on a chat picture opens it; a stand-in picture when this chat has none.
await ev(`const m = await import(new URL('ui/media.js', document.baseURI).href);
  const png = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200"><rect width="300" height="200" fill="#c63"/></svg>');
  m.lightbox([{ src: png, alt: 'Attached image' }]);
  return 1`);
await sleep(800);
expect('the viewer is open', await ev(`return !!document.querySelector('dialog.cui-lightbox[open]')`), true);
const dim = await tint();
await snap('citadel modal open');
expect('the window controls dim with the backdrop', dim, (t) => t && t !== plain);
await ev(`document.querySelector('dialog.cui-lightbox').close(); return 1`);
await sleep(800);
expect('closing puts the colour back', await tint(), plain);
await snap('citadel modal after');
