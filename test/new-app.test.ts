// The kit's new-app generator (kit/skills/contraption-ui/new-app): a generated app passes its own tests,
// and the generator refuses what would break one.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { generateApp } from '../kit/skills/contraption-ui/new-app/new-app.ts';

const repo = mkdtempSync(join(tmpdir(), 'new-app-'));
after(() => rmSync(repo, { recursive: true, force: true }));

test('a generated app passes its own tests, with every placeholder filled', () => {
  const written = generateApp({ repo, name: 'trip-notes', title: "Trip notes: Josh's", idea: 'Notes for a trip.\nShared by the group.', runner: 'delve-ci' });
  assert.ok(written.includes('apps/trip-notes/citadel-app.json'));
  assert.ok(written.includes('apps/trip-notes/test/fake-citadel.ts'));
  assert.ok(written.includes('.github/workflows/app-trip-notes.yml'));
  for (const f of written) {
    if (f.endsWith('.png')) continue;
    assert.doesNotMatch(readFileSync(join(repo, f), 'utf8'), /\{\{\w+\}\}/, f);
  }
  const manifest = JSON.parse(readFileSync(join(repo, 'apps/trip-notes/public/manifest.webmanifest'), 'utf8'));
  assert.equal(manifest.scope, '/apps/trip-notes/');
  assert.equal(manifest.name, "Trip notes: Josh's");
  const app = JSON.parse(readFileSync(join(repo, 'apps/trip-notes/citadel-app.json'), 'utf8'));
  assert.equal(app.health, '/apps/trip-notes/healthz');
  assert.deepEqual(app.migrations, ['migrations']);
  assert.match(readFileSync(join(repo, '.github/workflows/app-trip-notes.yml'), 'utf8'), /"self-hosted", "delve-ci"/);
  // Without NODE_TEST_CONTEXT, or the inner run reports to this one's runner instead of printing.
  const { NODE_TEST_CONTEXT: _, ...env } = process.env;
  const run = spawnSync(process.execPath, ['--test', '--test-reporter=tap', 'test/'], { cwd: join(repo, 'apps/trip-notes'), env, encoding: 'utf8', timeout: 60_000 });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout, /# pass 10/);
});

test('no runner, no workflow', () => {
  const written = generateApp({ repo, name: 'bare', title: 'Bare', idea: 'x', runner: null });
  assert.ok(!written.some((f) => f.startsWith('.github')));
  assert.ok(!existsSync(join(repo, '.github/workflows/app-bare.yml')));
});

test('refuses a bad name, an unsafe title, an empty idea, a bad runner label or a folder that exists', () => {
  const ok = { repo, name: 'fine', title: 'Fine', idea: 'x', runner: null };
  for (const name of ['Fine', '-x', 'a/b', '../x', '']) assert.throws(() => generateApp({ ...ok, name }), /Not an app name/, name);
  for (const title of ['<script>', 'a"b', 'a\nb', '', 'x'.repeat(61), 'a\\b']) assert.throws(() => generateApp({ ...ok, title }), /title/, title);
  assert.throws(() => generateApp({ ...ok, idea: '  ' }), /idea/);
  assert.throws(() => generateApp({ ...ok, runner: 'evil"]' }), /runner label/);
  mkdirSync(join(repo, 'apps/taken'), { recursive: true });
  assert.throws(() => generateApp({ ...ok, name: 'taken' }), /already exists/);
  assert.deepEqual(readdirSync(join(repo, 'apps/taken')), []);
  assert.ok(!existsSync(join(repo, 'apps/fine')));
});
