// No hand-built dialog, toast or tooltip outside the kit (#872; Cara, 2026-11-17: "the biggest thing from that video
// that I want to make sure we are doing, is using reusable components"). Citadel's pages use the shared parts in
// public/ui/: openDialog or a cui-dialog (dialog.js), toast (status.js), data-tip (tip.js), lightbox (media.js).
// A new twin fails here; one that truly can't use the part goes in ALLOWED with the reason it stays.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';

const root = join(import.meta.dirname, '..');
const pub = join(root, 'public');

/** What a hand-built part looks like in a page's script, markup or styles. */
const PATTERNS: Record<string, RegExp> = {
  dialog: /\.showModal\(|\bh\(\s*['"]dialog['"]|createElement\(\s*['"]dialog['"]|<dialog\b|['"]role['"]\s*,\s*['"]dialog['"]|\brole\s*[:=]\s*['"]dialog['"]/,
  toast: /\bclass(?:Name)?\s*[:=]\s*['"`][^'"`]*\btoast\b|classList\.add\([^)]*['"]toast['"]|(^|[\s,}])\.toast\b/,
  // #1309: a loading line is loadingLine() in ui/state.js, a tablist is tabs() there.
  loading: /(?<!loadingLine\()['"`]Loading[^'"`]*…['"`]/,
  tabs: /\brole\s*[:=]\s*['"]tablist['"]|\brole\s*[:=]\s*['"]tab['"]/,
  tooltip: /['"]tooltip['"]|\btooltip\s*[:=]|(^|[\s,}])\.tooltip\b|\bpopover\s*[:=]|setAttribute\(\s*['"]popover['"]|\.showPopover\(/,
};

/** file → part → why it stays hand-built. Keep each reason to what the shared part can't do for it. */
const ALLOWED: Record<string, Record<string, string>> = {
  'artifacts.js': { dialog: "the file viewer fills the page with the file and its chat side by side on a grid, not a box with a head; its picture view already uses the kit's lightbox" },
  'settings.js': { loading: 'a status span beside a button that the save and load calls rewrite in place (textContent), not a block that gets replaced' },
  'thread.js': { loading: "the label of the Load earlier button while it loads: a button's own text, not a line" },
  'home.js': { loading: 'an emptyCard placeholder sized like the card that replaces it' },
  'drawers.js': { dialog: "it is itself a shared part (served to apps as /apps/_citadel/drawers.js): the phone's side panels as named modal drawers" },
};

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return p === join(pub, 'ui') ? [] : files(p);
    return /\.(js|html|css)$/.test(e.name) ? [p] : [];
  });
}

/** The parts each file hand-builds, ignoring comment lines. */
function found(text: string): string[] {
  // A toggletip's `role: 'dialog'` passed to the kit's mountTips is the part in use (contraption-ui component-checks.md), not a twin.
  const code = text
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\/?\*|<!--)/.test(l))
    .map((l) => l.replace(/\bmountTips\(.*$/, 'mountTips('))
    .join('\n');
  return Object.entries(PATTERNS)
    .filter(([, re]) => code.split('\n').some((l) => re.test(l)))
    .map(([part]) => part);
}

test('the patterns catch a hand-built dialog, toast and tooltip, and pass the kit parts in use', () => {
  assert.deepEqual(found(`const d = document.createElement('dialog');\nd.showModal();`), ['dialog']);
  assert.deepEqual(found(`h('dialog', { class: 'x' })`), ['dialog']);
  assert.deepEqual(found(`el.setAttribute('role', 'dialog');`), ['dialog']);
  assert.deepEqual(found(`tips = mountTips(document.body, { selector: '.x', role: 'dialog', tapOpens: true });`), [], 'a toggletip through the kit');
  assert.deepEqual(found(`h('div', { class: 'my-toast' })`), ['toast']);
  assert.deepEqual(found(`h('div', { class: 'toaster-row' })`), []);
  assert.deepEqual(found(`h('div', { class: 'toast warn' })`), ['toast']);
  assert.deepEqual(found(`.toast { position: fixed }`), ['toast']);
  assert.deepEqual(found(`h('span', { role: 'tooltip' })`), ['tooltip']);
  assert.deepEqual(found(`h('div', { class: 'tip', popover: 'auto' })`), ['tooltip']);
  assert.deepEqual(found(`openDialog({ title: 'Rename', body: form });\ntoast('Saved');\nh('button', { 'data-tip': 'Copy' })`), []);
  assert.deepEqual(found(`h('p', { class: 'muted' }, 'Loading its history…')`), ['loading']);
  assert.deepEqual(found(`h('div', { class: 'tabs', role: 'tablist' })`), ['tabs']);
  assert.deepEqual(found(`loadingLine('Loading…')`), [], 'the kit part is a call, so its words stay out of the page');
  assert.deepEqual(found(`// we used to call showModal() here`), [], 'comments are skipped');
});

test("Citadel's pages build no dialog, toast or tooltip of their own outside public/ui/ (or say why in ALLOWED)", () => {
  const seen = new Set<string>();
  const bad: string[] = [];
  for (const f of files(pub)) {
    const name = relative(pub, f);
    for (const part of found(readFileSync(f, 'utf8'))) {
      if (ALLOWED[name]?.[part]) seen.add(`${name}:${part}`);
      else bad.push(`${name}: a hand-built ${part}`);
    }
  }
  assert.deepEqual(bad, [], `use the kit part instead (loadingLine and tabs in ui/state.js, openDialog in ui/dialog.js, toast in ui/status.js, data-tip with ui/tip.js, lightbox in ui/media.js), or add the file to ALLOWED in this test with the reason it can't`);
  const stale = Object.entries(ALLOWED)
    .flatMap(([f, parts]) => Object.keys(parts).map((p) => `${f}:${p}`))
    .filter((k) => !seen.has(k));
  assert.deepEqual(stale, [], 'these no longer hand-build the part: take them out of ALLOWED');
});
