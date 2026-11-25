// One SVG feeds every icon (#840): which file serves each role (a scheme's own override, else the source),
// and the generator's output set, with an override, for a sample SVG.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test, type TestContext } from 'node:test';
import { checkIcons, generateIcons, resolveIcons } from '../kit/skills/android-app/scripts/gen-icons.mjs';

const root = mkdtempSync(join(tmpdir(), 'icon-gen-'));
after(() => rmSync(root, { recursive: true, force: true }));
const SRC = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" fill="#0a6b6b"/><path d="M96 380 L256 120 L416 380 Z" fill="#fff" stroke="#fc0" stroke-width="12"/><path d="M180 380 H332" fill="none" stroke="#fff" stroke-width="14"/></svg>';
const SMALL = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" fill="#0a6b6b"/><path d="M96 400 L256 100 L416 400 Z" fill="#fff"/></svg>';
const MANIFEST = 'android/app/src/main/AndroidManifest.xml';
function repo(name: string, manifest: object | null, files: Record<string, string> = {}) {
  const dir = join(root, name);
  for (const [f, s] of Object.entries({ 'web/public/icon.svg': SRC, ...files })) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), s);
  }
  if (manifest) writeFileSync(join(dir, 'citadel-app.json'), JSON.stringify(manifest));
  return dir;
}
const hasRsvg = (() => {
  try {
    execFileSync('rsvg-convert', ['--version']);
    return true;
  } catch {
    return false;
  }
})();

/** rsvg-convert stood in for by `cat` (the "PNG" is the SVG handed to it), so a test of the vectors runs where it isn't installed. */
function fakeRsvg(t: TestContext) {
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'rsvg-convert'), '#!/bin/sh\nexec cat\n', { mode: 0o755 });
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  t.after(() => {
    process.env.PATH = path;
  });
}

test('with no config the source is web/public/icon.svg and every role uses it', () => {
  const r = resolveIcons(repo('plain', null));
  assert.equal(r.source, 'web/public/icon.svg');
  for (const role of ['scheme', 'small', 'foreground', 'monochrome', 'legacy', 'round', 'splash']) assert.equal(r.roles[role], 'web/public/icon.svg', role);
});

test('citadel-app.json names the source and overrides single roles; the rest stay on the source', () => {
  const r = resolveIcons(repo('over', { icon: { source: 'art/logo.svg', overrides: { small: 'art/small.svg', monochrome: 'art/mono.svg' } } }, { 'art/logo.svg': SRC, 'art/small.svg': SMALL, 'art/mono.svg': SMALL }));
  assert.equal(r.source, 'art/logo.svg');
  assert.equal(r.roles.small, 'art/small.svg');
  assert.equal(r.roles.monochrome, 'art/mono.svg');
  assert.equal(r.roles.foreground, 'art/logo.svg');
  assert.equal(r.roles.scheme, 'art/logo.svg');
});

test('a bad config is refused by name: unknown role, a path out of the repo, a missing file', () => {
  assert.throws(() => resolveIcons(repo('b1', { icon: { overrides: { tiny: 'x.svg' } } })), /unknown icon role "tiny"/);
  assert.throws(() => resolveIcons(repo('b2', { icon: { source: '../evil.svg' } })), /inside the repo/);
  assert.throws(() => resolveIcons(repo('b3', { icon: { overrides: { small: 'nope.svg' } } })), /nope\.svg/);
  assert.throws(() => resolveIcons(repo('b4', { icon: { background: 'red"/><x' } })), /background must be a #rgb/);
  assert.throws(() => resolveIcons(repo('b5', { icon: { webDir: '../out' } })), /webDir must be a folder inside the repo/);
  assert.throws(() => resolveIcons(repo('b6', { icon: { androidRes: '../out' } })), /androidRes must be a folder inside the repo/);
  const linked = repo('b7', { icon: { webDir: 'web/out/icons' } });
  mkdirSync(join(root, 'elsewhere'));
  symlinkSync(join(root, 'elsewhere'), join(linked, 'web/out'));
  assert.throws(() => resolveIcons(linked), /webDir web\/out\/icons points outside the repo/);
});

test('generates the web and Android set, an override changing only its own output', () => {
  if (!hasRsvg) return; // rsvg-convert is the PNG renderer; CI without it can't run this
  const dir = repo('gen', { icon: { overrides: { small: 'art/small.svg' } } }, { 'art/small.svg': SMALL, 'android/app/src/main/res/values/x.xml': '<resources/>', [MANIFEST]: '<manifest/>' });
  const out = generateIcons(dir);
  const res = join(dir, 'android/app/src/main/res');
  for (const f of ['drawable/ic_launcher_foreground.xml', 'drawable/ic_launcher_monochrome.xml', 'values/ic_launcher_background.xml', 'mipmap-anydpi-v26/ic_launcher.xml', 'mipmap-anydpi-v26/ic_launcher_round.xml', 'mipmap-xxxhdpi/ic_launcher.png', 'mipmap-mdpi/ic_launcher_round.png', 'drawable/splash.png'])
    assert.ok(existsSync(join(res, f)), f);
  for (const f of ['favicon-32.png', 'icon-192.png', 'icon-512.png']) assert.ok(existsSync(join(dir, 'web/public', f)), f);
  assert.match(readFileSync(join(res, 'values/ic_launcher_background.xml'), 'utf8'), /#0a6b6b/);
  assert.ok(out.length > 10);
  // the foreground comes from the source (apex at y=120), the 32 px favicon from the small glyph
  assert.match(readFileSync(join(res, 'drawable/ic_launcher_foreground.xml'), 'utf8'), /M96 380/);
  assert.equal(execFileSync('identify', ['-format', '%w', join(dir, 'web/public/favicon-32.png')]).toString(), '32');
  assert.deepEqual(checkIcons(dir), []);
  writeFileSync(join(dir, 'art/small.svg'), SMALL.replace('M96 400', 'M90 400'));
  assert.match(checkIcons(dir).join(' '), /out of date/);
});

test('refuses what Android layers or the config would get wrong, instead of writing a broken icon', () => {
  if (!hasRsvg) return;
  const circle = SRC.replace('</svg>', '<circle cx="256" cy="256" r="10" fill="#fff"/></svg>');
  assert.throws(() => generateIcons(repo('c1', null, { 'web/public/icon.svg': circle, [MANIFEST]: '' })), /<path> elements only.*<circle>/);
  assert.throws(() => generateIcons(repo('c2', null, { 'web/public/icon.svg': SRC.replace('#fff"', 'white"'), [MANIFEST]: '' })), /must be #rgb/);
  assert.throws(() => resolveIcons(repo('c3', { icon: { background: 'red"/><x' } })), /background/);
  assert.throws(() => resolveIcons(repo('c4', { icon: { webDir: '../out' } })), /inside the repo/);
});

test('the web icons keep the whole art (no crop) and a small first rect is art, not the background', () => {
  if (!hasRsvg) return;
  const edge = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect x="0" y="0" width="10" height="10" fill="#f00"/><rect width="100" height="100" fill="#00f"/></svg>';
  const dir = repo('e', null, { 'web/public/icon.svg': edge });
  generateIcons(dir);
  const px = (x: number, y: number) => execFileSync('magick', [join(dir, 'web/public/icon-192.png'), '-format', `%[hex:p{${x},${y}}]`, 'info:']).toString();
  assert.equal(px(2, 2).slice(0, 6), 'FF0000'); // the corner square is drawn at the very edge, not cropped
  assert.equal(px(150, 150).slice(0, 6), '0000FF');
});

test('the Android icons go to the project that builds, or are refused (#1941)', () => {
  // citadel-app.json names the project (Voice's shape): its res folder, not android/app.
  const named = repo('p1', { capacitor: { root: 'android', android: 'android/native' } }, { 'android/native/app/src/main/AndroidManifest.xml': '' });
  assert.equal(resolveIcons(named).androidRes, 'android/native/app/src/main/res');
  const rooted = repo('p2', { capacitor: { root: 'mobile' } }, { 'mobile/android/app/src/main/AndroidManifest.xml': '' });
  assert.equal(resolveIcons(rooted).androidRes, 'mobile/android/app/src/main/res');
  // Nothing names it and android/ isn't the project: refused, not written where nothing builds (and --check says so too).
  const lost = repo('p3', null, { 'android/native/app/src/main/AndroidManifest.xml': '', '.citadel-icons.sha256': 'x\n' });
  assert.throws(() => resolveIcons(lost), /no AndroidManifest\.xml beside it/);
  assert.match(checkIcons(lost).join(' '), /no AndroidManifest\.xml beside it/);
  assert.throws(() => resolveIcons(repo('p4', { icon: { androidRes: 'android/app/src/main/res' } })), /no AndroidManifest\.xml/);
  assert.throws(() => resolveIcons(repo('p5', { capacitor: { android: '../elsewhere' } })), /inside the repo/);
  // A repo with no Android app has web icons alone.
  assert.equal(resolveIcons(repo('p6', null)).androidRes, null);
});

test('an SVG Android would draw differently is refused; what changes nothing is not (#1941)', (t) => {
  fakeRsvg(t);
  let n = 0;
  const make = (svg: string, bg?: string) => {
    const dir = repo(`s${n++}`, bg ? { icon: { background: bg } } : null, { 'web/public/icon.svg': svg, [MANIFEST]: '' });
    generateIcons(dir);
    return readFileSync(join(dir, 'android/app/src/main/res/drawable/ic_launcher_foreground.xml'), 'utf8');
  };
  const path = (more: string, svg = '') => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"${svg}><path d="M1 1 L9 9" fill="#fff" ${more}/></svg>`;
  for (const a of ['transform="translate(0 -12)"', 'opacity=".5"', 'fill-rule="evenodd"', 'stroke-linejoin="round"', "style='fill:red'", 'fill-opacity="0.5"']) {
    assert.throws(() => make(path(a)), new RegExp(`can't draw ${a.split('=')[0]} on <path>`), a);
  }
  assert.throws(() => make(path('', ' fill="none"')), /can't draw fill on <svg>/);
  assert.throws(() => make(path('').replace('<path', '<style>path{fill:red}</style><path')), /<style>/);
  assert.throws(() => make(path('').replace('#fff', '#ffffff80')), /must be #rgb or #rrggbb/);
  assert.throws(() => resolveIcons(repo('bg8', { icon: { background: '#0a6b6b80' } })), /background/);
  assert.throws(() => make('<svg viewBox="0 0 8 8"><rect width="8" height="8" fill="#0a6b6b80"/><path d="M1 1"/></svg>'), /background "#0a6b6b80" must be/);
  // Harmless: names, accessibility, editors' own attributes, a stroke turned off.
  const ok = make(path('id="a" class="b" aria-hidden="true" inkscape:label="x" stroke="none"', ' id="r" width="512" height="512" role="img" version="1.1"'));
  assert.match(ok, /android:fillColor="#fff"/);
  assert.doesNotMatch(ok, /strokeColor/);
  // A line's ends are the SVG's: butt unless it says round.
  assert.match(make(path('stroke="#000"')), /strokeLineCap="butt"/);
  assert.match(make(path('stroke="#000" stroke-linecap="round"')), /strokeLineCap="round"/);
  // Single quotes are attributes too.
  assert.match(make(path("stroke='#f00'")), /strokeColor="#f00"/);
  // A viewBox that starts elsewhere is moved to the middle: k = 30/(256*.8), and its centre (356) lands on 54.
  const moved = make(path('').replace('0 0 512 512', '100 0 512 512'));
  const k = 30 / (256 * 0.8);
  assert.ok(moved.includes(`translateX="${(54 - 356 * k).toFixed(3)}"`), moved);
  assert.match(readFileSync(join(root, `s${n - 1}`, 'web/public/icon-192.png'), 'utf8'), /translate\(-356 -256\)/, 'the web icons too');
});

test('--check depends on the inputs alone, and on every icon being there (#1941)', (t) => {
  fakeRsvg(t);
  const dir = repo('chk', null, { [MANIFEST]: '', 'android/app/src/main/res/drawable-v24/ic_launcher_foreground.xml': 'old', 'android/app/src/main/res/drawable-v24/app_own.xml': 'own' });
  generateIcons(dir);
  assert.ok(existsSync(join(dir, 'android/app/src/main/res/drawable-v24/app_own.xml')), "the app's own drawable stays");
  assert.ok(!existsSync(join(dir, 'android/app/src/main/res/drawable-v24/ic_launcher_foreground.xml')));
  assert.deepEqual(checkIcons(dir), []);
  // The same generator reformatted (one more comment) reads the same icons as current.
  const copy = join(root, 'gen-copy.mjs');
  writeFileSync(copy, readFileSync(new URL('../kit/skills/android-app/scripts/gen-icons.mjs', import.meta.url), 'utf8') + '\n// reformatted\n');
  execFileSync(process.execPath, [copy, '--check', dir]);
  rmSync(join(dir, 'web/public/icon-192.png'));
  assert.match(checkIcons(dir).join(' '), /icon-192\.png is missing/);
});
