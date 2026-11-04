// Citadel UI's contract (#283): apps import public/ui/ live from /apps/_citadel/ui/, so a Citadel deploy
// that changes what a module exports, what its .d.ts promises, the classes its styles define, the
// --citadel-* names theme.css serves, or the HTML fixed markdown renders to would change every app at
// once. Each is held in test/ui-contract.json; a change fails here until that file changes in the same
// commit, which self-review rates medium risk at least. Additive only: a rename or removal ships as a
// new file beside the old one (ui/chat2.js) until the apps move.
//
// To accept an intended change: UPDATE_UI_CONTRACT=1 node --test test/ui-contract.test.ts, then read
// the diff of test/ui-contract.json before committing it.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { themeCss } from '../src/theme.ts';

const ui = join(import.meta.dirname, '..', 'public', 'ui');
const contractFile = join(import.meta.dirname, 'ui-contract.json');
const files = readdirSync(ui).sort();
const modules = files.filter((f) => f.endsWith('.js'));
const read = (f: string) => readFileSync(join(ui, f), 'utf8');
// The app rail and phone drawers live in public/ (Citadel's own pages import them), served to apps as
// /apps/_citadel/rail.js and drawers.js with their .d.ts beside them (#286): their exports are contract too.
const pub = join(import.meta.dirname, '..', 'public');
const SCRIPTS = ['drawers.js', 'rail.js'];

/** The names a .d.ts exports as values (functions, consts, classes), not its types. */
const declared = (dts: string) => [...dts.matchAll(/^export\s+(?:declare\s+)?(?:function|const|let|class)\s+([\w$]+)/gm)].map((m) => m[1]).sort();
/** The CSS a module brings: a .css file's text, or a .js module's constructed sheet (its `const CSS = `...``). */
const cssOf = (f: string) => (f.endsWith('.css') ? read(f) : /\bconst CSS = `([\s\S]*?)`;/.exec(read(f))?.[1] ?? '');
/** A selector list split at its top-level commas (not those inside :where(), :is() or :not()). */
function splitTop(sel: string) {
  const parts: string[] = [];
  let depth = 0, start = 0;
  for (let i = 0; i < sel.length; i++) {
    if (sel[i] === '(') depth++;
    else if (sel[i] === ')') depth--;
    else if (sel[i] === ',' && depth === 0) { parts.push(sel.slice(start, i)); start = i + 1; }
  }
  return [...parts, sel.slice(start)];
}
/** What's left of a selector after its leading :where(...) groups: '' when it weighs nothing. */
function outsideWhere(sel: string) {
  while (sel.startsWith(':where(')) {
    let depth = 0, i = ':where'.length;
    for (; i < sel.length; i++) if (sel[i] === '(') depth++; else if (sel[i] === ')' && --depth === 0) break;
    sel = sel.slice(i + 1);
  }
  return sel;
}
/** The cui-* classes a stylesheet defines. */
const classes = (css: string) => [...new Set([...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/\.(cui-[\w-]+)/g)].map((m) => m[1]))].sort();

// Fixed inputs; their HTML is part of the contract. Each covers something an app relies on.
const { renderMarkdown, markdownLine } = await import('../public/ui/markdown.js');
const SAMPLES: [string, string, object?][] = [
  ['paragraphs and emphasis', 'One **bold**, one *em*, one `code`, one ~~gone~~.\nSame paragraph.\n\nNext.'],
  ['chat keeps line breaks', 'one\ntwo', { breaks: true }],
  ['escaped html', '<script>alert(1)</script> & <b>x</b><br>y'],
  ['headings: a reply\'s # is an h3', '# Top\n## Next\n###### Deep'],
  ['headings: a document passes headingBase 1', '# Top\n## Top', { headingBase: 1 }],
  ['lists, nested and numbered', '1. one\n2. two\n   - a\n   - b\n3. three\n\n5. five\n6. six'],
  ['task list', '- [ ] todo\n- [x] done'],
  ['table with alignment', '| a | b | c |\n|:--|:-:|--:|\n| 1 | 2 | 3 |'],
  ['code fence', '```js\nconst a = "<b>";\n```'],
  ['quote and rule', '> quoted\n> more\n\n---\n\nafter'],
  ['links: http, mailto, relative, bare', '[web](https://example.com/a?b=1&c=2) [mail](mailto:a@b.c) [file](notes.md) https://example.com/x.'],
  ['image without a hook', '![a chart](chart.png)'],
  ['streaming: half table held back', 'Pieces:\n\n| Piece | Gives |\n|---|---|\n| Wa', { streaming: true }],
  ['streaming: header waits for its separator', 'Pieces:\n\n| Piece | Gives |', { streaming: true }],
  ['streaming: half bold, code and link', '**9:59 then `item and [the form](https://exa', { streaming: true }],
  ['streaming: a bare list marker waits', '- one\n-', { streaming: true }],
];
const LINES: [string, string, object?][] = [
  ['a reply as a line', '# Done\nMoved **Tue** to [Thu](https://x.y).\n\n- one\n- two'],
  ['a streaming line', 'Working on **it', { streaming: true }],
];

// A recorded turn, as an app's chat draws it: text, a run of calls with a failed one, a Grunt with two steps, then an
// error; once folded and once with its run open, and the same turn mid-flight.
const { chatModel, renderChat } = await import('../public/ui/chat.js');
const at = (s: number) => Date.UTC(2026, 10, 2, 12, 0, s);
const ev = (type: string, data: object, s?: number) => ({ type, data, at: s === undefined ? undefined : at(s) });
const RECORDED = [
  ev('text', { delta: 'Let me **check** Thursday.', parent: null, message: 'm1' }),
  ev('tool', { id: 'a', name: 'mcp__mandate__list_todos', input: {}, parent: null }, 1), ev('tool_result', { id: 'a', ok: true, parent: null }, 2),
  ev('tool', { id: 'b', name: 'mcp__mandate__move_todo', input: { title: 'Dry cleaning' }, parent: null }, 2), ev('tool_result', { id: 'b', ok: false, parent: null }, 3),
  ev('tool', { id: 'g', name: 'Agent', input: { description: 'Check the calendar' }, parent: null }, 3),
  ev('tool', { id: 'g1', name: 'mcp__mandate__calendar', input: {}, parent: 'g' }, 4), ev('tool_result', { id: 'g1', ok: true, parent: 'g' }, 5),
  ev('tool', { id: 'g2', name: 'mcp__mandate__search', input: {}, parent: 'g' }, 5), ev('tool_result', { id: 'g2', ok: true, parent: 'g' }, 9),
  ev('tool_result', { id: 'g', ok: true, parent: null }, 44),
  ev('text', { delta: 'Thursday is free.', parent: null, message: 'm2' }),
  ev('error', { code: 'limit', message: 'You\'ve reached your usage limit.' }),
];
const stepLabel = (name: string, input: { title?: string }) => (name === 'mcp__mandate__move_todo' ? `Moving “${input.title}”` : undefined);
const CHATS: [string, object[], object][] = [
  ['a recorded turn, folded', [{ ask: 'Move my errands', events: RECORDED }], { stepLabel, now: at(50) }],
  ['a recorded turn, its run open', [{ ask: 'Move my errands', events: RECORDED }], { stepLabel, now: at(50), open: ['0.1'] }],
  ['the same turn mid-flight', [{ ask: 'Move my errands', events: RECORDED.slice(0, 9) }], { stepLabel, now: at(7) }],
  // An app's markdown hooks (#286): Peek Auras draws key combos as <kbd>; its link hook replaces the kit's; breaks stay.
  ['a reply with the app\'s markdown hooks', [{ ask: 'Which keys?', events: [ev('text', { delta: 'Press Ctrl+Alt+P\nthen [the notes](notes.md)', parent: null, message: 'm1' }), ev('end', {})] }],
    { markdown: { text: (html: string) => html.replace(/\b(?:Ctrl|Alt|Shift)\+[\w+]+/g, (k) => `<kbd>${k}</kbd>`), link: (href: string, html: string) => `<a class="doc" href="#${href}">${html}</a>` }, now: at(0) }],
];

function current() {
  const exports: Record<string, string[]> = {};
  const css: Record<string, string[]> = {};
  return Promise.all(modules.map(async (f) => {
    exports[f] = Object.keys(await import(join(ui, f))).sort();
  }).concat(SCRIPTS.map(async (f) => {
    exports[f] = Object.keys(await import(join(pub, f))).sort();
  }))).then(() => {
    for (const f of files.filter((f) => /\.(js|css)$/.test(f))) {
      const c = classes(cssOf(f));
      if (c.length) css[f] = c;
    }
    // The events a module or script fires (#287): apps listen for them by name.
    const events: Record<string, string[]> = {};
    for (const [f, src] of [...modules.map((f) => [f, read(f)]), ...SCRIPTS.map((f) => [f, readFileSync(join(pub, f), 'utf8')])]) {
      // An event's name is written out where it is fired: new CustomEvent('name') or drawers.js's announce('name').
      const names = [...new Set([...src.matchAll(/(?:new CustomEvent|announce)\(\s*['"`]([\w-]+)['"`]/g)].map((m) => m[1]))].sort();
      if (names.length) events[f] = names;
    }
    const theme = [...new Set([...themeCss(readFileSync(join(import.meta.dirname, '..', 'public', 'style.css'), 'utf8')).matchAll(/(--citadel-[\w-]+):/g)].map((m) => m[1]))].sort();
    return {
      exports,
      css,
      theme,
      events,
      markdown: Object.fromEntries(SAMPLES.map(([name, src, opts]) => [name, renderMarkdown(src, opts)])),
      markdownLine: Object.fromEntries(LINES.map(([name, src, opts]) => [name, markdownLine(src, opts)])),
      chat: Object.fromEntries(CHATS.map(([name, turns, opts]) => [name, renderChat(turns, opts)])),
      // What mountChat's block(name, input, result) gets as `result` (#287): the tool_result's data, an app's own fields included.
      blockResult: chatModel([{ events: [ev('tool', { id: 'v', name: 'viability', input: {}, parent: null }), ev('tool_result', { id: 'v', ok: true, parent: null, output: { odds: 0.4 } })] }], { card: () => true }).items[0].blocks[0].result,
    };
  });
}

const now = await current();
if (process.env.UPDATE_UI_CONTRACT) writeFileSync(contractFile, `${JSON.stringify(now, null, 2)}\n`);
const stored = JSON.parse(readFileSync(contractFile, 'utf8'));
const why = 'Citadel UI\'s contract changed. If on purpose: UPDATE_UI_CONTRACT=1 node --test test/ui-contract.test.ts, commit test/ui-contract.json with it, and self-review rates it medium (additive only; a break ships as a new file)';

test('each ui module\'s exports match its .d.ts', async () => {
  for (const f of modules) {
    const dts = f.replace(/\.js$/, '.d.ts');
    assert.ok(files.includes(dts), `public/ui/${f} has types beside it (${dts})`);
    assert.deepEqual(now.exports[f], declared(read(dts)), `public/ui/${f}'s exports and ${dts}`);
  }
  for (const f of files.filter((f) => f.endsWith('.d.ts'))) assert.ok(modules.includes(f.replace(/\.d\.ts$/, '.js')), `${f} types a module that exists`);
  for (const f of SCRIPTS) assert.deepEqual(now.exports[f], declared(readFileSync(join(pub, f.replace(/\.js$/, '.d.ts')), 'utf8')), `public/${f}'s exports and its .d.ts`);
  // Every event a file fires is typed in its .d.ts too.
  for (const [f, names] of Object.entries(now.events)) {
    const dts = readFileSync(join(SCRIPTS.includes(f) ? pub : ui, f.replace(/\.js$/, '.d.ts')), 'utf8');
    for (const n of names) assert.match(dts, new RegExp(`['"]${n}['"]\\s*:`), `${f} fires ${n}; its .d.ts types it`);
  }
});

test('exports, classes and theme names are the stored contract', () => {
  assert.deepEqual(now.exports, stored.exports, why);
  assert.deepEqual(now.css, stored.css, why);
  assert.deepEqual(now.theme, stored.theme, why);
  assert.deepEqual(now.events, stored.events, why);
});

test('fixed markdown samples render to the stored HTML', () => {
  assert.deepEqual(now.markdown, stored.markdown, why);
  assert.deepEqual(now.markdownLine, stored.markdownLine, why);
});

test('a recorded chat turn renders to the stored HTML', () => {
  assert.deepEqual(now.chat, stored.chat, why);
  assert.deepEqual(now.blockResult, stored.blockResult, why);
});

test('every ui file keeps the rules: standalone, no inline styles, cui-* classes inside :where()', () => {
  for (const f of files) {
    const src = read(f);
    assert.match(src.slice(0, 1500), /standalone/i, `${f} says the public/ui/ rule in its header`);
    if (f.endsWith('.js')) {
      for (const m of src.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s+['"]([^'"]+)['"]/gm)) {
        assert.match(m[1], /^\.\/[\w-]+\.js$/, `${f} imports only from ui/ (${m[1]})`);
      }
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      // What CSP's default-src 'self' refuses: style="" in markup, <style>, setAttribute('style'). A CSSOM
      // write (el.style.height = …) is not refused; only the composer's autogrow (and its caret measure) and
      // the tooltip's placement (left, top, max-height) need one.
      assert.doesNotMatch(code, /\bstyle\s*=\s*["'`]|<style\b|\.setAttribute\(\s*['"]style/, `${f} writes no inline style`);
      if (f !== 'composer.js' && f !== 'tip.js') assert.doesNotMatch(code, /\.style\./, `${f} writes no CSSOM style either`);
    }
    const css = cssOf(f).replace(/\/\*[\s\S]*?\*\//g, '');
    // Each selector (outside @media and @keyframes) is wholly inside :where() groups, so it weighs nothing and an
    // app's own selectors always win; only a pseudo-element (::placeholder) may follow, as :where() can't hold one.
    for (const m of css.matchAll(/(?:^|[}{])\s*([^{}@]+?)\s*\{/g)) {
      const sel = m[1].trim();
      if (!sel || /^(from|to|\d+%)$/.test(sel)) continue;
      for (const part of splitTop(sel)) assert.match(outsideWhere(part.trim()), /^(::[\w-]+)?$/, `${f}: "${part.trim()}" sits wholly in :where()`);
    }
    for (const c of css.matchAll(/\.([a-z][\w-]*)/g)) assert.match(c[1], /^cui-/, `${f}: class .${c[1]} is cui-*`);
  }
});

// A page's reset (* { box-sizing: border-box }) weighs the same as :where() and often comes later, so it
// can win: a part sized in content-box then squashed (the switch's touch padding ate its track, ToC #33).
// Every rule whose size depends on box-sizing (a width or height with padding or a border) declares
// border-box, the value such a reset sets anyway, itself or on a base class of the same element (.cui-btn under .cui-btn.cui-small).
test('every ui part keeps its size under a box-sizing reset: sized in border-box, never content-box', () => {
  const rules = files.flatMap((f) => [...cssOf(f).replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}@]+?)\{([^{}]*)\}/g)].map((m) => {
    const decl = new Map(m[2].split(';').map((d) => d.split(/:(.*)/s).map((x) => x?.trim() ?? '')).filter((d) => d[0]) as [string, string][]);
    return { f, sel: m[1].trim(), decl };
  }));
  const borderBox = new Set(rules.filter((r) => r.decl.get('box-sizing') === 'border-box').map((r) => r.sel));
  for (const { f, sel, decl } of rules) {
    assert.notEqual(decl.get('box-sizing'), 'content-box', `${f}: "${sel}" sizes in content-box, which a page's reset overturns`);
    const sized = [...decl].some(([k, v]) => /^(min-|max-)?(width|height|inline-size|block-size)$/.test(k) && !/^(auto|none|0)$/.test(v));
    const boxed = [...decl].some(([k, v]) => /^(padding|border)(-(top|right|bottom|left|block|inline)(-(start|end))?)?(-width)?$/.test(k) && !/^(0(px)?( 0(px)?)*|none)$/.test(v));
    if (!sized || !boxed) continue;
    const bases = [...(sel.split(/[\s>+~]+/).pop() ?? '').matchAll(/\.(cui-[\w-]+)/g)].map((c) => `:where(.${c[1]})`);
    assert.ok(decl.get('box-sizing') === 'border-box' || bases.some((b) => borderBox.has(b)), `${f}: "${sel}" has a size and padding or a border, so it declares box-sizing: border-box`);
  }
});
