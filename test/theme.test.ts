// theme.css (#269): contraptions' copy of Citadel's colours, built from public/style.css.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { citadelPalette, rootBlocks, THEME_NAMES, themeCss } from '../src/theme.ts';

const style = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');

/** The `--name: value` pairs in a CSS block's text. */
const vars = (css: string) => Object.fromEntries([...css.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));

test('every colour and token in style.css has a chosen --citadel-* name, in light and dark alike', () => {
  const { light, dark } = citadelPalette(style);
  const names = (b: typeof light) => b.vars.map(([n]) => n).sort();
  assert.ok(light.vars.length >= 10, 'found the light :root block');
  const all = rootBlocks(style).flatMap((r) => r.block.vars.map(([n]) => n));
  // Counted without the parser: every declaration in a `:root {` block.
  const declared = [...style.matchAll(/:root\s*\{([^}]*)\}/g)].flatMap((m) => m[1].match(/--[\w-]+\s*:/g) ?? []).length;
  assert.equal(all.length, declared, 'the parser found every variable style.css declares on :root');
  assert.deepEqual(names(dark), names(light), 'dark mode sets the same colours as light');
  // A new token in style.css fails here until THEME_NAMES gives it a name (and contraption-ui lists it).
  assert.deepEqual(
    [...new Set(all)].filter((n) => !(n in THEME_NAMES)),
    [],
  );
  assert.equal(new Set(Object.values(THEME_NAMES)).size, Object.keys(THEME_NAMES).length, 'no two variables share a name');
});

test("theme.css carries the tokens, the phone control height and reduced motion, with Citadel's names renamed", () => {
  const css = themeCss(style);
  assert.match(css, /@media \(max-width: 800px\) \{\s*:root \{\s*--citadel-control-h: /);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*:root \{\s*--citadel-motion: 0s;/);
  // A token built from Citadel's colours points at the served names, never Citadel's own (apps don't have --accent).
  assert.match(css, /--citadel-focus-ring: 2px solid var\(--citadel-accent\);/);
  assert.doesNotMatch(css, /var\(--(?!citadel-)/);
  // The focus alias goes in the colour blocks only.
  assert.equal(css.match(/--citadel-focus:/g)!.length, 2);
});

test("theme.css carries style.css's exact values for light and dark, and its color-scheme", () => {
  const css = themeCss(style);
  const [lightCss, rest] = css.split('@media (prefers-color-scheme: dark)');
  const darkCss = rest.split(/^\}$/m)[0];
  const { light, dark } = citadelPalette(style);
  for (const [block, out] of [
    [light, vars(lightCss)],
    [dark, vars(darkCss)],
  ] as const) {
    for (const [name, value] of block.vars) assert.equal(out[`citadel-${THEME_NAMES[name]}`], value, `--citadel-${THEME_NAMES[name]}`);
    assert.equal(out['citadel-focus'], 'var(--citadel-accent)');
  }
  // Spot-check against the file itself, not just the parser.
  assert.match(lightCss, /color-scheme: light;/);
  assert.match(darkCss, /color-scheme: dark;/);
});

test('a style.css without its :root blocks is refused, not served as an empty theme', () => {
  assert.throws(() => themeCss('body { color: red; }'), /no :root block/);
});

test('the colour roles for apps (#683) can be text: 4.5:1 or better on the page and on a card, in both modes', () => {
  const lum = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a: string, b: string) => {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  };
  const roles = ['accent-2', 'cat-1', 'cat-2', 'cat-3', 'cat-4', 'cat-5', 'cat-6'];
  for (const block of Object.values(citadelPalette(style))) {
    const v = Object.fromEntries(block.vars);
    for (const role of roles) {
      assert.match(v[role] ?? '', /^#[0-9a-f]{6}$/i, `--${role} is a plain hex in ${block.colorScheme}`);
      for (const under of ['panel', 'bg']) assert.ok(ratio(v[role], v[under]) >= 4.5, `--${role} on --${under} in ${block.colorScheme}: ${ratio(v[role], v[under]).toFixed(2)}:1`);
    }
  }
});
