// One SVG feeds every icon (#840): which file serves each role (a scheme's own override, else the source),
// and the generator's output set, with an override, for a sample SVG.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { checkIcons, generateIcons, resolveIcons } from '../kit/skills/android-app/scripts/gen-icons.mjs';

const root = mkdtempSync(join(tmpdir(), 'icon-gen-'));
after(() => rmSync(root, { recursive: true, force: true }));
const SRC = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" fill="#0a6b6b"/><path d="M96 380 L256 120 L416 380 Z" fill="#fff" stroke="#fc0" stroke-width="12"/><path d="M180 380 H332" fill="none" stroke="#fff" stroke-width="14"/></svg>';
const SMALL = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" fill="#0a6b6b"/><path d="M96 400 L256 100 L416 400 Z" fill="#fff"/></svg>';
function repo(name: string, manifest: object | null, files: Record<string, string> = {}) {
  const dir = join(root, name);
  for (const [f, s] of Object.entries({ 'web/public/icon.svg': SRC, ...files })) { mkdirSync(dirname(join(dir, f)), { recursive: true }); writeFileSync(join(dir, f), s); }
  if (manifest) writeFileSync(join(dir, 'citadel-app.json'), JSON.stringify(manifest));
  return dir;
}
const hasRsvg = (() => { try { execFileSync('rsvg-convert', ['--version']); return true; } catch { return false; } })();

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
});

test('generates the web and Android set, an override changing only its own output', () => {
  if (!hasRsvg) return; // rsvg-convert is the PNG renderer; CI without it can't run this
  const dir = repo('gen', { icon: { overrides: { small: 'art/small.svg' } } }, { 'art/small.svg': SMALL, 'android/app/src/main/res/values/x.xml': '<resources/>' });
  const out = generateIcons(dir);
  const res = join(dir, 'android/app/src/main/res');
  for (const f of ['drawable/ic_launcher_foreground.xml', 'drawable/ic_launcher_monochrome.xml', 'values/ic_launcher_background.xml', 'mipmap-anydpi-v26/ic_launcher.xml', 'mipmap-anydpi-v26/ic_launcher_round.xml', 'mipmap-xxxhdpi/ic_launcher.png', 'mipmap-mdpi/ic_launcher_round.png', 'drawable/splash.png']) assert.ok(existsSync(join(res, f)), f);
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
