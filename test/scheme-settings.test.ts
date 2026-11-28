import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Session } from '../src/auth.ts';
import type { Project } from '../src/db.ts';
import { HttpError } from '../src/http.ts';
import { planSettings, settingsNotes } from '../src/scheme-settings.ts';

// The scheme settings PATCH's validation and notes, called with no server (#2324).
const project = { id: 1, name: 'Citadel', instructions: 'old', ship_path: 'land', go_from: 'high', land_mode: 'off', plugin_dirs: '', optional_plugin_dirs: '', approval_rules: '', repo_dir: null, repo_url: null } as unknown as Project;
const admin = { name: 'Cara', admin: true } as Session;
const member = { name: 'Josh', admin: false } as Session;
const store = { getProject: () => project, props: { listGroups: () => [] } } as never;

const plan = (body: Record<string, unknown>, who = admin) => planSettings(body, project, store, who, null);
const refused = async (body: Record<string, unknown>, status: number, text: RegExp, who = admin) => {
  await assert.rejects(plan(body, who), (e: unknown) => e instanceof HttpError && e.status === status && text.test(e.message));
};

test('refusals', async () => {
  await refused({ onboarding: 'nope' }, 400, /onboarding must be one of/);
  await refused({ land_mode: '' }, 400, /land_mode must be one of/);
  await refused({ shots_required: 'yes' }, 400, /true or false/);
  await refused({ rules_review: 1 }, 400, /true or false/);
  await refused({ instructions: 5 }, 400, /instructions must be text/);
  await refused({ instructions: 'x'.repeat(200_000) }, 400, /Instructions are/);
  await refused({ repo_url: 'ftp://x' }, 400, /Repo URL must be/);
  await refused({ repo_url: 'https://me@host/x' }, 400, /cannot hold spaces or a login/);
  await refused({ skills_off: ['no-such-skill'] }, 400, /skills_off must be/);
  await refused({ land_mode: 'fast' }, 409, /tools\/land\.sh is missing/);
  await refused({ plugin_dirs: '/some/where' }, 403, /Only an admin/, member);
});

test('accepted values', async () => {
  const ok = await plan({ name: ' New ', shots_required: true, rules_review: false, instructions: 'a\r\nb ' });
  assert.equal(ok.name, 'New');
  assert.equal(ok.settings.shots_required, 1);
  assert.equal(ok.settings.rules_review, 0);
  assert.equal(ok.instructions, 'a\nb');
  assert.equal(ok.repoUrl, null);
  assert.equal((await plan({ repo_url: 'https://github.com/a/b' })).repoUrl, 'https://github.com/a/b');
  assert.equal((await plan({ default_effort: '' })).settings.default_effort, '');
});

test('a pull-request-by-person scheme keeps every change waiting for a go', async () => {
  const pr = { ...project, ship_path: 'pr-person' } as Project;
  await assert.rejects(planSettings({ go_from: 'high' }, pr, store, admin, null), /every change waits/);
});

test('notes say who changed what, and only what changed', () => {
  assert.deepEqual(settingsNotes(project, {}, 'Cara'), []);
  assert.match(settingsNotes(project, { default_effort: 'high' }, 'Cara')[0]!, /^Cara set the scheme's default effort to high\./);
  assert.match(settingsNotes(project, { land_mode: 'fast' }, 'Cara')[0]!, /turned fast mode on/);
  assert.match(settingsNotes(project, { land_mode: 'off' }, 'Cara')[0]!, /turned fast mode off/);
  assert.match(settingsNotes(project, { ci_quiet: '' }, 'Cara')[0]!, /quiet CI workflows to: none\./);
  assert.match(settingsNotes(project, { onboarding: 'skipped' }, 'Cara')[0]!, /skipped the scheme's setup/);
  assert.equal(settingsNotes(project, { approval_rules: 'a', ci_watch: 'b' }, 'Cara').length, 2);
});
