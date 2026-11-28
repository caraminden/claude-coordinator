for (let i = 0; i < 40 && !(await ev("document.body.children.length > 2").catch(() => false)); i++) await sleep(500);
await sleep(3000);
const measure = () =>
  ev(`(() => {
  const R = (e) => { const r = e?.getBoundingClientRect(); return r && { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
  const cs = (e, p) => e && getComputedStyle(e)[p];
  const tb = navigator.windowControlsOverlay?.getTitlebarAreaRect();
  const first = document.querySelector('main > *') || document.querySelector('main');
  return { href: location.href, wco: matchMedia('(display-mode: window-controls-overlay)').matches, inset: getComputedStyle(document.documentElement).getPropertyValue('--top-inset'),
    strip: tb && { x: tb.x, y: tb.y, w: tb.width, h: tb.height }, w: innerWidth, h: innerHeight, dpr: devicePixelRatio,
    topbar: R(document.querySelector('.topbar')), topbarBg: cs(document.querySelector('.topbar'), 'backgroundColor'), main: R(document.querySelector('main')), mainPadTop: cs(document.querySelector('main'), 'paddingTop'),
    first: first && { tag: first.tagName + '.' + first.className, ...R(first) }, bodyBg: cs(document.body, 'backgroundColor'), htmlBg: cs(document.documentElement, 'backgroundColor'), scrollY };
})()`);
const dpr = await ev('devicePixelRatio');
const shoot = async (name) => {
  const b = await ev('({ left: screenX, top: screenY, width: outerWidth, height: outerHeight })');
  const f = path.join(process.env.TEMP, `electron-strip-${name}.png`);
  await mouse(`shot ${f} ${[b.left, b.top, b.width, b.height].map((v) => Math.round(v * dpr)).join(' ')}`);
  console.log('M', name, JSON.stringify(await measure()));
  console.log('shot', f);
};
await shoot('normal');
await ev('window.resizeTo(420, 700)');
await sleep(1500);
await shoot('narrow');
ps.stdin.end();
app.kill();
fwd.close();
ws.close();
process.exit(0);
