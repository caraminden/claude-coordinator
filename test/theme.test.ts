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
  assert.deepEqual([...new Set(all)].filter((n) => !(n in THEME_NAMES)), []);
  assert.equal(new Set(Object.values(THEME_NAMES)).size, Object.keys(THEME_NAMES).length, 'no two variables share a name');
});

test('theme.css carries the tokens, the phone control height and reduced motion, with Citadel\'s names renamed', () => {
  const css = themeCss(style);
  assert.match(css, /--citadel-on-accent: #fff;/);
  assert.match(css, /prefers-color-scheme: dark[\s\S]*--citadel-on-accent: #1d1c1a;/);
  assert.match(css, /^:root \{[^}]*--citadel-space-3: 12px;[^}]*--citadel-control-h: 32px;/m);
  assert.match(css, /@media \(max-width: 800px\) \{\s*:root \{\s*--citadel-control-h: 40px;/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*:root \{\s*--citadel-motion: 0s;/);
  // A token built from Citadel's colours points at the served names, never Citadel's own (apps don't have --accent).
  assert.match(css, /--citadel-focus-ring: 2px solid var\(--citadel-accent\);/);
  assert.doesNotMatch(css, /var\(--(?!citadel-)/);
  // The focus alias goes in the colour blocks only.
  assert.equal(css.match(/--citadel-focus:/g)!.length, 2);
});

test('theme.css carries style.css\'s exact values for light and dark, and its color-scheme', () => {
  const css = themeCss(style);
  const [lightCss, rest] = css.split('@media (prefers-color-scheme: dark)');
  const darkCss = rest.split(/^\}$/m)[0];
  const { light, dark } = citadelPalette(style);
  for (const [block, out] of [[light, vars(lightCss)], [dark, vars(darkCss)]] as const) {
    for (const [name, value] of block.vars) assert.equal(out[`citadel-${THEME_NAMES[name]}`], value, `--citadel-${THEME_NAMES[name]}`);
    assert.equal(out['citadel-focus'], 'var(--citadel-accent)');
  }
  // Spot-check against the file itself, not just the parser.
  assert.match(style, /--bg: #f6f5f2;/);
  assert.equal(vars(lightCss)['citadel-bg'], '#f6f5f2');
  assert.match(lightCss, /color-scheme: light;/);
  assert.match(darkCss, /color-scheme: dark;/);
});

test('a style.css without its :root blocks is refused, not served as an empty theme', () => {
  assert.throws(() => themeCss('body { color: red; }'), /no :root block/);
});
