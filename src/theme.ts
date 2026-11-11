// Citadel's colours for contraptions' pages: /apps/_citadel/theme.css (#269). Built from
// public/style.css's own :root blocks each time the front end loads, so the two can't drift: change
// a colour there and every contraption that links theme.css follows on the next deploy.

/** Citadel's variable (in style.css) → the name contraptions see, after `--citadel-`. A role name
 * where the colour has one outside Citadel; Citadel's own name otherwise. A variable missing here is
 * still served, as `--citadel-<its name>`, but test/theme.test.ts fails until it gets a chosen name.
 * Names are an API apps depend on: add, never rename. */
export const THEME_NAMES: Record<string, string> = {
  bg: 'bg',
  panel: 'surface',
  ink: 'text',
  muted: 'muted',
  line: 'border',
  'control-line': 'control-border',
  accent: 'accent',
  error: 'danger',
  done: 'ok',
  waiting: 'warn',
  'waiting-tint': 'warn-tint',
  running: 'info',
  closed: 'neutral',
  held: 'violet',
  'code-bg': 'code-bg',
  'on-accent': 'on-accent',
  // The same in both modes (#283): type, spacing, radii, controls, focus, motion, the notice.
  font: 'font',
  mono: 'mono',
  'size-body': 'size-body',
  'size-small': 'size-small',
  'size-meta': 'size-meta',
  'size-h1': 'size-h1',
  'size-h2': 'size-h2',
  'size-h3': 'size-h3',
  'space-1': 'space-1',
  'space-2': 'space-2',
  'space-3': 'space-3',
  'space-4': 'space-4',
  'space-5': 'space-5',
  'space-6': 'space-6',
  'radius-sm': 'radius-sm',
  radius: 'radius',
  'radius-lg': 'radius-lg',
  'radius-pill': 'radius-pill',
  'control-h': 'control-h',
  'focus-ring': 'focus-ring',
  'focus-offset': 'focus-offset',
  motion: 'motion',
  'motion-slow': 'motion-slow',
  'notice-bg': 'notice-bg',
  'notice-bar': 'notice-bar',
};

/** Names that stand for another colour rather than one of their own. */
const ALIASES: Record<string, string> = { focus: 'accent' };

type Block = { vars: [string, string][]; colorScheme?: string };

/** The custom properties and color-scheme in one `:root { … }` body. */
function parseBlock(body: string): Block {
  const block: Block = { vars: [] };
  for (const m of body.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(--[\w-]+|color-scheme)\s*:\s*([^;]+);/g)) {
    if (m[1] === 'color-scheme') block.colorScheme = m[2].trim();
    else block.vars.push([m[1].slice(2), m[2].trim()]);
  }
  return block;
}

/** style.css's light `:root` block (its first) and the one inside `@media (prefers-color-scheme: dark)`. */
export function citadelPalette(styleCss: string): { light: Block; dark: Block } {
  const light = /^:root\s*\{([^}]*)\}/m.exec(styleCss);
  const dark = /@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*:root\s*\{([^}]*)\}/.exec(styleCss);
  if (!light || !dark) throw new Error('public/style.css has no :root block and dark :root block for theme.css');
  return { light: parseBlock(light[1]), dark: parseBlock(dark[1]) };
}

/**
 * Every `:root { … }` in style.css, in order: at the top level, or alone inside an `@media` (the dark
 * colours, the phone control height, reduced motion). A `:root` beside other rules in a media block
 * isn't one of these.
 */
export function rootBlocks(styleCss: string): { media: string | null; block: Block }[] {
  const re = /^:root\s*\{([^}]*)\}|^@media\s*([^{]+?)\s*\{\s*:root\s*\{([^}]*)\}\s*\}/gm;
  return [...styleCss.matchAll(re)].map((m) => ({ media: m[2] ?? null, block: parseBlock(m[1] ?? m[3]) }));
}

/** A value with Citadel's own variables renamed to the ones theme.css serves. */
const rename = (value: string) => value.replace(/var\(--([\w-]+)/g, (_, n) => `var(--citadel-${THEME_NAMES[n] ?? n}`);

function render(block: Block, indent: string, aliases: boolean) {
  const lines = block.vars.map(([name, value]) => `${indent}--citadel-${THEME_NAMES[name] ?? name}: ${rename(value)};`);
  if (aliases) for (const [alias, of] of Object.entries(ALIASES)) lines.push(`${indent}--citadel-${alias}: var(--citadel-${of});`);
  if (block.colorScheme) lines.push(`${indent}color-scheme: ${block.colorScheme};`);
  return lines.join('\n');
}

/** theme.css, from style.css's text. */
export function themeCss(styleCss: string): string {
  citadelPalette(styleCss); // refuses a style.css without its colours
  const blocks = rootBlocks(styleCss).map(({ media, block }, i) => (media
    ? `@media ${media} {\n  :root {\n${render(block, '    ', /prefers-color-scheme/.test(media))}\n  }\n}`
    : `:root {\n${render(block, '  ', i === 0)}\n}`));
  return [
    "/* Citadel's colours and design tokens, from its own style.css. What each is for: kit/skills/contraption-ui/SKILL.md and docs/design-system/. */",
    ...blocks,
    '',
  ].join('\n');
}
