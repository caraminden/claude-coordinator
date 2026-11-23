// The one table of Settings and Orders pages (public/settings-pages.js, #1308) names every page module, and every row names a real one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { PAGES, ORDERS_GROUPS, SETTINGS_GROUPS, isOrdersPage, plainKinds } from '../public/settings-pages.js';
import { schemeSwitchHash } from '../public/scheme-switch.js';

const dir = new URL('../public/', import.meta.url);
const src = (f) => readFileSync(new URL(f, dir), 'utf8');
// Page-shaped exports that are not Settings or Orders pages: they have their own routes.
const NOT_SETTINGS_PAGES = new Set(['releasesPage', 'setReleasesPage', 'chainsPage']);

test('every row names a module that exports its page', () => {
  for (const r of PAGES) {
    const text = src(r.module);
    assert.match(text, new RegExp(`export (async )?(function|const) ${r.page}\\b`), `${r.kind}: ${r.module} has no export ${r.page}`);
  }
});

test('a page module the table does not name fails', () => {
  const named = new Set(PAGES.map((r) => r.page));
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.js'))) {
    for (const m of src(f).matchAll(/^export (?:async )?(?:function|const) (\w*(?:Page|Editor))\b/gm)) {
      if (m[1] === 'isOrdersPage') continue;
      assert.ok(named.has(m[1]) || NOT_SETTINGS_PAGES.has(m[1]), `${f} exports ${m[1]}, which settings-pages.js doesn't name (add a row, or list it as not a Settings page)`);
    }
  }
});

test('kinds are unique and project.js can reach every named module', () => {
  assert.equal(new Set(PAGES.map((r) => r.kind)).size, PAGES.length);
  const project = src('project.js');
  for (const r of PAGES.filter((p) => !p.own)) assert.ok(project.includes(`'${r.module}':`), `project.js's PAGE_MODULES lacks ${r.module}`);
});

test('the table keeps its 22 pages, Orders and Settings apart', () => {
  assert.equal(PAGES.length, 22);
  assert.equal(ORDERS_GROUPS.flatMap(([, , r]) => r).length, 9);
  assert.equal(SETTINGS_GROUPS.flatMap(([, , r]) => r).length, 13);
  assert.ok(isOrdersPage('memory') && !isOrdersPage('members') && !isOrdersPage('orders'));
  assert.ok(!plainKinds().includes('schedules') && !plainKinds().includes('orders') && plainKinds().includes('machines'));
});

test('scheme switch is derived from the table: every page is kept, admin rows are gated', () => {
  for (const r of PAGES) {
    assert.equal(schemeSwitchHash(`#/p/3/${r.kind}`, 5, true), `#/p/5/${r.kind}`, r.kind);
    assert.equal(schemeSwitchHash(`#/p/3/${r.kind}`, 5, false), r.admin ? '#/p/5/instructions' : `#/p/5/${r.kind}`, r.kind);
    if (r.item) assert.equal(schemeSwitchHash(`#/p/3/${r.kind}/x.md`, 5), `#/p/5/${r.kind}`, r.kind);
  }
});
