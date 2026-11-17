#!/usr/bin/env node
// One SVG feeds every icon (#840). Dependency-free; needs rsvg-convert for the PNGs.
//   node gen-icons.mjs [repo-dir]          write the icons (web PNGs, and Android res when android/ exists)
//   node gen-icons.mjs --check [repo-dir]  exit 1 when the committed icons don't match their inputs (for an app's tests or build)
// Started from TWIReader's scripts/gen-android-icons.mjs. Config: the `icon` key of citadel-app.json:
//   "icon": { "source": "web/public/icon.svg", "background": "#0a6b6b", "webDir": "web/public", "androidRes": "android/app/src/main/res",
//             "overrides": { "small": "art/glyph.svg", "monochrome": "art/mono.svg" } }
// Everything is optional. A role with no override is made from the source. Roles (ROLES below): scheme (the icon
// Citadel shows for the scheme), small (the 32 px favicon), foreground and monochrome (Android adaptive layers),
// legacy and round (Android's pre-8 PNGs), splash. Citadel's server reads `source` and `overrides.scheme` too (src/scheme-icon.ts).
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

export const ROLES = ['scheme', 'small', 'foreground', 'monochrome', 'legacy', 'round', 'splash'];
export const DEFAULT_SOURCES = ['web/public/icon.svg', 'assets/icon/icon.svg', 'public/icon.svg', 'icon.svg'];
const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const LOCK = '.citadel-icons.sha256';

const inside = (root, p) => { const r = relative(root, resolve(root, p)); return !!r && !r.startsWith('..') && !isAbsolute(r); };

/** Which file feeds each role: { source, background, webDir, androidRes, roles: {role: repo-relative path} }. Throws with a reason for a bad config. */
export function resolveIcons(dir) {
  const root = realpathSync(dir);
  let cfg = {};
  if (existsSync(join(root, 'citadel-app.json'))) {
    try { cfg = JSON.parse(readFileSync(join(root, 'citadel-app.json'), 'utf8')).icon ?? {}; } catch (e) { throw new Error(`citadel-app.json: ${e.message}`); }
  }
  if (typeof cfg !== 'object' || Array.isArray(cfg)) throw new Error('citadel-app.json: icon must be an object');
  const file = (p, what) => {
    if (typeof p !== 'string' || !p) throw new Error(`icon ${what} must be a path`);
    if (!inside(root, p)) throw new Error(`icon ${what} ${p} must be inside the repo`);
    const abs = join(root, p);
    if (!existsSync(abs)) throw new Error(`icon ${what} ${p} doesn't exist`);
    if (!realpathSync(abs).startsWith(root + '/')) throw new Error(`icon ${what} ${p} points outside the repo`);
    return p.replace(/^\.\//, '');
  };
  const source = cfg.source !== undefined ? file(cfg.source, 'source') : DEFAULT_SOURCES.find((p) => existsSync(join(root, p)));
  if (!source) throw new Error(`no icon source: put an SVG at ${DEFAULT_SOURCES[0]} or name one in citadel-app.json's icon.source`);
  const roles = Object.fromEntries(ROLES.map((r) => [r, source]));
  for (const [role, p] of Object.entries(cfg.overrides ?? {})) {
    if (!ROLES.includes(role)) throw new Error(`unknown icon role "${role}" (roles: ${ROLES.join(', ')})`);
    roles[role] = file(p, `override ${role}`);
  }
  if (cfg.background !== undefined && !HEX.test(cfg.background)) throw new Error('icon background must be a #rgb or #rrggbb colour');
  const dirOf = (v, d, what) => {
    if (v === undefined) return d;
    if (typeof v !== 'string' || !inside(root, v)) throw new Error(`icon ${what} must be a folder inside the repo`);
    // a folder that exists must not be a link out of the repo (the generator writes and deletes in it)
    let up = join(root, v); while (!existsSync(up) && up !== root) up = dirname(up);
    if (!(realpathSync(up) + '/').startsWith(root + '/')) throw new Error(`icon ${what} ${v} points outside the repo`);
    return v;
  };
  return { source, roles, background: cfg.background, webDir: dirOf(cfg.webDir, dirname(source) === '.' ? '.' : dirname(source), 'webDir'), androidRes: dirOf(cfg.androidRes, 'android/app/src/main/res', 'androidRes') };
}

/** Marks and background of an SVG: its viewBox, the first full-size <rect>'s fill, and the rest of its content. */
function parseSvg(text) {
  const vb = (text.match(/viewBox="([^"]+)"/)?.[1] ?? '0 0 512 512').trim().split(/[\s,]+/).map(Number);
  const [, , w, h] = vb;
  let inner = text.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
  let bg;
  // The background is the first <rect> that covers the whole viewBox (100%, or the viewBox's own width and height).
  inner = inner.replace(/<rect\b([^>]*)\/>/g, (m, a) => {
    const f = a.match(/fill="(#[0-9a-fA-F]{3,8})"/), at = (n) => a.match(new RegExp(`\\b${n}="([^"]*)"`))?.[1];
    const covers = (v, full) => v === '100%' || Number(v) === full, zero = (v) => v === undefined || Number(v) === 0;
    if (f && !bg && covers(at('width'), w) && covers(at('height'), h) && zero(at('x')) && zero(at('y'))) { bg = f[1]; return ''; }
    return m;
  });
  const paths = [...inner.matchAll(/<path\s+([^>]*?)\/?>/g)].map((m) => Object.fromEntries([...m[1].matchAll(/([\w-]+)="([^"]*)"/g)].map((x) => [x[1], x[2]])));
  return { w, h, inner, bg, paths, other: [...new Set([...inner.matchAll(/<(circle|rect|ellipse|line|polygon|polyline|g|use|text|image)\b/g)].map((m) => m[1]))] };
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
/** The files to write, as { relative path: string | Buffer }; PNGs are rendered with rsvg-convert. */
export function buildIcons(dir) {
  const root = realpathSync(dir);
  const cfg = resolveIcons(root);
  const svgOf = (role) => parseSvg(readFileSync(join(root, cfg.roles[role]), 'utf8'));
  const src = svgOf('scheme');
  const BG = cfg.background ?? src.bg ?? '#ffffff';
  const out = {};
  const rsvg = (svg, w, h) => execFileSync('rsvg-convert', ['-w', String(w), '-h', String(h)], { input: svg, maxBuffer: 64 << 20 });
  const wrap = (w, h, body) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>`;
  // The art centred in a w×h canvas so its half-width (80% of the viewBox's short half-side) is `frac` of the canvas's.
  const place = (s, w, h, frac) => `<g transform="translate(${w / 2} ${h / 2}) scale(${(Math.min(w, h) / 2 * frac) / (Math.min(s.w, s.h) / 2 * 0.8)}) translate(${-s.w / 2} ${-s.h / 2})">${s.inner}</g>`;
  // A whole icon (its own background) at w×h, for the web set.
  const full = (role, px) => { const s = svgOf(role); return rsvg(wrap(px, px, `<rect width="${px}" height="${px}" fill="${s.bg ?? BG}"/>${place(s, px, px, 0.8)}`), px, px); };
  const webDir = cfg.webDir;
  out[`${webDir}/favicon-32.png`] = full('small', 32);
  out[`${webDir}/icon-192.png`] = full('scheme', 192);
  out[`${webDir}/icon-512.png`] = full('scheme', 512);

  if (existsSync(join(root, 'android'))) {
    const res = cfg.androidRes;
    const vector = (role, colorOf) => {
      const s = svgOf(role);
      if (!s.paths.length || s.other.length) throw new Error(`${cfg.roles[role]}: Android's ${role} layer is built from <path> elements only (after the background <rect>); found ${s.other.length ? '<' + s.other.join('>, <') + '>' : 'no paths'}. Convert shapes to paths.`);
      const k = 30 / (Math.min(s.w, s.h) / 2 * 0.8); // adaptive layers are 108dp; content stays in a 30dp radius
      const body = s.paths.map((p) => {
        for (const c of [p.fill, p.stroke]) if (c && c !== 'none' && !HEX.test(c)) throw new Error(`${cfg.roles[role]}: colour "${c}" must be #rgb or #rrggbb for Android`);
        const f = p.fill ?? (p.stroke ? 'none' : '#000000'); // SVG's default fill is black
        const fill = f !== 'none' ? `\n        android:fillColor="${colorOf(f)}"` : '';
        const stroke = p.stroke ? `\n        android:strokeColor="${colorOf(p.stroke)}"\n        android:strokeWidth="${p['stroke-width'] ?? 1}"\n        android:strokeLineCap="round"` : '';
        return `    <path${fill}${stroke}\n        android:pathData="${esc(p.d ?? '')}"/>`;
      }).join('\n');
      return `<?xml version="1.0" encoding="utf-8"?>\n<!-- Generated by citadel:android-app's gen-icons.mjs from ${cfg.roles[role]} -->\n<vector xmlns:android="http://schemas.android.com/apk/res/android"\n    android:width="108dp" android:height="108dp" android:viewportWidth="108" android:viewportHeight="108">\n  <group android:translateX="${(54 - s.w / 2 * k).toFixed(3)}" android:translateY="${(54 - s.h / 2 * k).toFixed(3)}"\n      android:scaleX="${k.toFixed(5)}" android:scaleY="${k.toFixed(5)}">\n${body}\n  </group>\n</vector>\n`;
    };
    out[`${res}/drawable/ic_launcher_foreground.xml`] = vector('foreground', (c) => c);
    out[`${res}/drawable/ic_launcher_monochrome.xml`] = vector('monochrome', () => '#000000');
    out[`${res}/values/ic_launcher_background.xml`] = `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">${BG}</color>\n</resources>\n`;
    const adaptive = `<?xml version="1.0" encoding="utf-8"?>\n<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n    <background android:drawable="@color/ic_launcher_background"/>\n    <foreground android:drawable="@drawable/ic_launcher_foreground"/>\n    <monochrome android:drawable="@drawable/ic_launcher_monochrome"/>\n</adaptive-icon>\n`;
    out[`${res}/mipmap-anydpi-v26/ic_launcher.xml`] = adaptive;
    out[`${res}/mipmap-anydpi-v26/ic_launcher_round.xml`] = adaptive;
    const leg = svgOf('legacy'), rnd = svgOf('round'), spl = svgOf('splash');
    for (const [d, px] of Object.entries({ mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 })) {
      out[`${res}/mipmap-${d}/ic_launcher.png`] = rsvg(wrap(px, px, `<rect width="${px}" height="${px}" rx="${px * 0.22}" fill="${leg.bg ?? BG}"/>${place(leg, px, px, 0.78)}`), px, px);
      out[`${res}/mipmap-${d}/ic_launcher_round.png`] = rsvg(wrap(px, px, `<circle cx="${px / 2}" cy="${px / 2}" r="${px / 2}" fill="${rnd.bg ?? BG}"/>${place(rnd, px, px, 0.7)}`), px, px);
    }
    // Splash: the mark at 40% of the short side, centred, on the background.
    const splash = (w, h) => rsvg(wrap(w, h, `<rect width="${w}" height="${h}" fill="${spl.bg ?? BG}"/>${place(spl, w, h, 0.4)}`), w, h);
    out[`${res}/drawable/splash.png`] = splash(480, 320);
    const sizes = { mdpi: [320, 480], hdpi: [480, 800], xhdpi: [720, 1280], xxhdpi: [960, 1600], xxxhdpi: [1280, 1920] };
    for (const [d, [a, b]] of Object.entries(sizes)) {
      for (const [kind, w, h] of [['port', a, b], ['land', b, a]]) if (existsSync(join(root, `${res}/drawable-${kind}-${d}`))) out[`${res}/drawable-${kind}-${d}/splash.png`] = splash(w, h);
    }
  }
  return out;
}

/** A hash of every input: the source and overrides, the config and this generator, so the check doesn't depend on rsvg's exact bytes. */
function inputsHash(root) {
  const cfg = resolveIcons(root);
  const h = createHash('sha256');
  for (const f of [...new Set(Object.values(cfg.roles))].sort()) h.update(f).update(readFileSync(join(root, f)));
  h.update(JSON.stringify([cfg.background, cfg.webDir, cfg.androidRes, existsSync(join(root, 'android'))]));
  h.update(readFileSync(new URL(import.meta.url)));
  return h.digest('hex');
}

/** Write the icons; returns the paths written. Old Capacitor foreground PNGs and drawable-v24 go when Android's set is written. */
export function generateIcons(dir) {
  const root = realpathSync(dir);
  const files = buildIcons(root);
  for (const [p, data] of Object.entries(files)) { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), data); }
  const cfg = resolveIcons(root);
  if (existsSync(join(root, 'android'))) {
    for (const d of ['mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi']) rmSync(join(root, cfg.androidRes, `mipmap-${d}/ic_launcher_foreground.png`), { force: true });
    rmSync(join(root, cfg.androidRes, 'drawable-v24'), { recursive: true, force: true });
  }
  writeFileSync(join(root, LOCK), inputsHash(root) + '\n');
  return Object.keys(files);
}

/** Problems with the committed icons: none when they match their inputs. Needs no rsvg-convert. */
export function checkIcons(dir) {
  const root = realpathSync(dir);
  const lock = join(root, LOCK);
  if (!existsSync(lock)) return [`${LOCK} is missing: run gen-icons.mjs and commit its output`];
  if (readFileSync(lock, 'utf8').trim() !== inputsHash(root)) return ['the icons are out of date with their SVG sources: run gen-icons.mjs and commit its output'];
  return [];
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const check = args.includes('--check');
  const dir = args.find((a) => !a.startsWith('--')) ?? '.';
  try {
    if (check) { const bad = checkIcons(dir); for (const b of bad) console.error(b); process.exit(bad.length ? 1 : 0); }
    const written = generateIcons(dir);
    console.log(`wrote ${written.length} icon files`);
  } catch (e) { console.error(e.message); process.exit(1); }
}
