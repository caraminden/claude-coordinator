import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Store, type Project } from '../src/db.ts';
import { onboardingPrompt } from '../src/prompts.ts';

// The pass on Minion rules after setup (#1046): onboarding done opens it, "Looks right" closes it, and the Taskmaster's
// step 3 ends with a card linking the page.

test('rules_review: off by default, opened when onboarding turns done, cleared by hand, not reopened by other saves', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rules-review-'));
  try {
    const store = new Store(join(dir, 'c.db'));
    const p = store.createProject('Lanternfall', null);
    assert.equal(store.getProject(p.id)!.rules_review, 0);
    store.setProjectSettings(p.id, { onboarding: 'setting-up' });
    assert.equal(store.getProject(p.id)!.rules_review, 0);
    store.setProjectSettings(p.id, { onboarding: 'done' });
    assert.equal(store.getProject(p.id)!.rules_review, 1);
    store.setProjectSettings(p.id, { rules_review: 0 });
    store.setProjectSettings(p.id, { onboarding: 'done', default_effort: 'medium' });
    assert.equal(store.getProject(p.id)!.rules_review, 0, 'done again is not a new setup');
    store.setProjectSettings(p.id, { onboarding: 'interview', onboarding_mode: 'tune-up' });
    store.setProjectSettings(p.id, { onboarding: 'done' });
    assert.equal(store.getProject(p.id)!.rules_review, 1, 'a tune-up opens the pass again');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('onboarding step 3 ends with a card linking the scheme\'s rules page, in setup and in a tune-up', () => {
  for (const mode of ['first-run', 'tune-up'] as const) {
    const text = onboardingPrompt({ id: 7, name: 'Lanternfall', onboarding: 'interview', onboarding_mode: mode } as Project, '/shared');
    assert.match(text, /end with one `ask_question` card to the scheme's members/, mode);
    assert.match(text, /`#\/p\/7\/approvals`/, mode);
  }
});
