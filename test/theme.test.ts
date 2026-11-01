// theme.css (#269): contraptions' copy of Citadel's colours, built from public/style.css.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { citadelPalette, THEME_NAMES, themeCss } from '../src/theme.ts';

const style = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');

/** The `--name: value` pairs in a CSS block's text. */
const vars = (css: string) => Object.fromEntries([...css.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));

test('every colour in style.css has a chosen --citadel-* name, in light and dark alike', () => {
  const { light, dark } = citadelPalette(style);
  const names = (b: typeof light) => b.vars.map(([n]) => n).sort();
  assert.ok(light.vars.length >= 10, 'found the light :root block');
  // Counted without the parser: the declarations up to the second column-0 `}` (the end of the dark :root's @media).
  const declared = style.split(/^\}$/m).slice(0, 2).join('').match(/^\s*--[\w-]+\s*:/gm)!.length;
  assert.equal(light.vars.length + dark.vars.length, declared, 'the parser found every variable style.css declares');
  assert.deepEqual(names(dark), names(light), 'dark mode sets the same variables as light');
  // A new colour in style.css fails here until THEME_NAMES gives it a name (and app-rail.md lists it).
  assert.deepEqual(names(light).filter((n) => !(n in THEME_NAMES)), []);
  assert.equal(new Set(Object.values(THEME_NAMES)).size, Object.keys(THEME_NAMES).length, 'no two colours share a name');
});

test('theme.css carries style.css\'s exact values for light and dark, and its color-scheme', () => {
  const css = themeCss(style);
  const [lightCss, darkCss] = css.split('@media (prefers-color-scheme: dark)');
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
