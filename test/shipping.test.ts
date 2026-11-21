import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Store } from '../src/db.ts';
import { shippingLine } from '../src/prompts.ts';
import { MERGE_RULES, needsGo, shippingGate } from '../public/shipping.js';

// A scheme's Shipping settings (#1043): the one gate between them and the merge approval, the go threshold, the
// prompt line, and the one-off move of the schemes whose merges already waited for a person.

test('needsGo: a label at or above the threshold waits, and no threshold means high', () => {
  assert.deepEqual(['low', 'medium', 'high'].map((r) => needsGo('high', r)), [false, false, true]);
  assert.deepEqual(['low', 'medium', 'high'].map((r) => needsGo('medium', r)), [false, true, true]);
  assert.deepEqual(['low', 'medium', 'high'].map((r) => needsGo('all', r)), [true, true, true]);
  assert.deepEqual(['low', 'medium', 'high'].map((r) => needsGo('never', r)), [false, false, false]);
  assert.equal(needsGo(undefined, 'high'), true);
});

test('shippingGate: on a PR path the merge approval is on exactly when every change needs a go', () => {
  const merge = MERGE_RULES.join('\n');
  const on = shippingGate({ ship_path: 'pr-auto', go_from: 'all', approval_rules: 'Bash(tools/deploy.sh:*)' });
  assert.deepEqual(on, { go_from: 'all', approval_rules: `Bash(tools/deploy.sh:*)\n${merge}` });
  const off = shippingGate({ ship_path: 'pr-auto', go_from: 'high', approval_rules: `Bash(tools/deploy.sh:*)\n${merge}` });
  assert.deepEqual(off, { go_from: 'high', approval_rules: 'Bash(tools/deploy.sh:*)' });
  // pr-person means a person merges every change.
  assert.deepEqual(shippingGate({ ship_path: 'pr-person', go_from: 'medium', approval_rules: '' }), { go_from: 'all', approval_rules: merge });
  // Citadel's own path merges no PR, so the box is left as people ticked it.
  assert.deepEqual(shippingGate({ ship_path: 'citadel', go_from: 'high', approval_rules: merge }), { go_from: 'high', approval_rules: merge });
  // Rules that already agree come back as they were, spacing and all, so a save doesn't rewrite them.
  const agreed = `${merge}\n  Edit(CLAUDE.md)  `;
  assert.equal(shippingGate({ ship_path: 'pr-person', go_from: 'all', approval_rules: agreed }).approval_rules, agreed);
});

test('shippingLine: the path, the go threshold and try-first, with defaults for missing fields', () => {
  const citadel = shippingLine({ ship_path: 'citadel', go_from: 'high', try_first: 'never' }, true);
  assert.match(citadel, /hand it off with `hand_off_land`/);
  assert.match(citadel, /A high-risk change waits for a member's go: .*kind ship.*hand_off_land's `go` names who and when/);
  assert.doesNotMatch(citadel, /try first/);
  assert.match(citadel, /A bug fix proving itself .* needs no go: pass `fix_proof`; not for data or auth/, 'the fix exception (#1398)');
  const auto = shippingLine({ ship_path: 'pr-auto', go_from: 'medium', try_first: 'ui' }, false);
  assert.match(auto, /gh pr merge --auto --squash/);
  assert.match(auto, /A medium or high-risk change waits/);
  assert.doesNotMatch(auto, /hand_off_land/, 'a PR path never points at the land tool');
  assert.match(auto, /front-end paths in Project facts .* post screenshots/, 'no previews: screenshots, then wait');
  const person = shippingLine({ ship_path: 'pr-person', go_from: 'all', try_first: 'features' }, true);
  assert.match(person, /Every change waits.*Every feature \(type feature\) waits for a try first: start a preview/);
  assert.match(person, /the merge's own Approve is that go: .*no card first/, 'the merge approval is the go, so no second ask on a card');
  assert.doesNotMatch(person, /kind ship/);
  assert.doesNotMatch(person, /bug fix/, 'where a person merges every change, a fix waits too');
  assert.match(auto, /A bug fix proving itself .* needs no go; not for data or auth/);
  assert.doesNotMatch(auto, /fix_proof/);
  assert.doesNotMatch(shippingLine({ ship_path: 'citadel', go_from: 'high', try_first: 'never', skills_off: 'self-review' }, true), /proving itself/, 'the fix route needs the review, so not with self-review off');
  assert.doesNotMatch(shippingLine({ ship_path: 'citadel', go_from: 'all', try_first: 'never' }, true), /bug fix/);
  assert.match(shippingLine({ ship_path: 'citadel', go_from: 'never', try_first: 'never' }, true), /No change waits for a person's go/);
  assert.equal(shippingLine({} as any, true), shippingLine({ ship_path: 'citadel', go_from: 'high', try_first: 'never' }, true));
});

test('a scheme whose merges already waited for a person starts on pr-person once, and others keep the defaults', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shipping-'));
  try {
    const path = join(dir, 'coordinator.db');
    let store = new Store(path);
    const waits = store.createProject('Waits', null), half = store.createProject('Half', null), plain = store.createProject('Plain', null);
    store.setProjectSettings(waits.id, { approval_rules: `Edit(CLAUDE.md)\n${MERGE_RULES.join('\n')}` });
    store.setProjectSettings(half.id, { approval_rules: 'Bash(gh pr merge:*)' });
    store.setSetting('schema_version', 72);
    store.db.close();
    store = new Store(path);
    const got = (id: number) => { const p = store.getProject(id)!; return [p.ship_path, p.go_from, p.try_first]; };
    assert.deepEqual(got(waits.id), ['pr-person', 'all', 'never']);
    assert.deepEqual(got(half.id), ['citadel', 'high', 'never'], 'only both merge rules mean every merge waits');
    assert.deepEqual(got(plain.id), ['citadel', 'high', 'never']);
    // Once only: a scheme moved off it afterwards stays where people put it.
    store.setProjectSettings(waits.id, { ship_path: 'pr-auto', go_from: 'all' });
    store.db.close();
    store = new Store(path);
    assert.equal(store.getProject(waits.id)!.ship_path, 'pr-auto');
    store.db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
