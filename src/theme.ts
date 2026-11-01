// Citadel's colours for contraptions' pages: /apps/_citadel/theme.css (#269). Built from
// public/style.css's own :root blocks each time the front end loads, so the two can't drift: change
// a colour there and every contraption that links theme.css follows on the next deploy.

/** Citadel's variable (in style.css) → the name contraptions see, after `--citadel-`. A role name
 * where the colour has one outside Citadel; Citadel's own name otherwise. A variable missing here is
 * still served, as `--citadel-<its name>`, but test/theme.test.ts fails until it gets a chosen name. */
export const THEME_NAMES: Record<string, string> = {
  bg: 'bg',
  panel: 'surface',
  ink: 'text',
  muted: 'muted',
  line: 'border',
  accent: 'accent',
  error: 'danger',
  done: 'ok',
  waiting: 'warn',
  'waiting-tint': 'warn-tint',
  running: 'info',
  closed: 'neutral',
  held: 'violet',
  'code-bg': 'code-bg',
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

function render(block: Block, indent: string) {
  const lines = block.vars.map(([name, value]) => `${indent}--citadel-${THEME_NAMES[name] ?? name}: ${value};`);
  for (const [alias, of] of Object.entries(ALIASES)) lines.push(`${indent}--citadel-${alias}: var(--citadel-${of});`);
  if (block.colorScheme) lines.push(`${indent}color-scheme: ${block.colorScheme};`);
  return lines.join('\n');
}

/** theme.css, from style.css's text. */
export function themeCss(styleCss: string): string {
  const { light, dark } = citadelPalette(styleCss);
  return [
    "/* Citadel's colours, from its own style.css. Variable names: specs/contraptions/app-rail.md, \"Citadel's colours\". */",
    `:root {\n${render(light, '  ')}\n}`,
    `@media (prefers-color-scheme: dark) {\n  :root {\n${render(dark, '    ')}\n  }\n}`,
    '',
  ].join('\n');
}
