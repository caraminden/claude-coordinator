// #890 (home too, #2276): the top-right corner of a scheme page or the overview in the installed app. No control in the page sits under the window's
// caption buttons (the strip's right end, from getTitlebarAreaRect), at a few window widths, and the strip's colour
// (the window-controls-overlay theme colour) is the page's, not the title bar's white.
const measure = `
  const t = navigator.windowControlsOverlay.getTitlebarAreaRect();
  const capLeft = t.x + t.width, out = [];
  for (const el of document.querySelectorAll('a, button, input, select, textarea, summary, [tabindex]')) {
    const r = el.getBoundingClientRect(), s = getComputedStyle(el);
    if (!r.width || !r.height || s.visibility === 'hidden' || r.top >= t.height || r.bottom <= 0 || r.right <= capLeft) continue;
    out.push((el.getAttribute('aria-label') || el.title || el.textContent.trim().slice(0, 16) || el.tagName) + ' ' + Math.round(r.left) + '..' + Math.round(r.right) + ' x ' + Math.round(r.top) + '..' + Math.round(r.bottom));
  }
  const meta = [...document.querySelectorAll('meta[name=theme-color]')].filter((m) => matchMedia(m.media || 'all').matches).map((m) => m.content)[0];
  return { area: [t.x, t.y, t.width, t.height], inner: innerWidth, client: document.documentElement.clientWidth, under: out, meta };`;
const pages = [...ROUTES.filter((r) => r.startsWith('#/p/') && !r.includes('99999')), '#/home']; // the overview too (#2276)
expect('a scheme page to check', pages.length, (n) => n > 0);
for (const route of pages) {
  for (const width of [1300, 1000, 820]) {
    await send('Browser.setWindowBounds', { windowId: WINDOW, bounds: { left: 20, top: 10, width, height: 800 } });
    await go(route);
    await sleep(600);
    const got = await ev(measure);
    note(route, width, got);
    expect(`${route} at ${width}: no control under the caption buttons`, got.under, []);
    expect(`${route} at ${width}: strip in page colour`, got.meta, (m) => m && m !== '#ffffff');
    await snap(`corner-${width}`);
  }
}
await home();
