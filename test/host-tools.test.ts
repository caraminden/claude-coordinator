import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { installCommand, installing, installTool, manifestProblems, manifestText, miseSpec, parseHostTool, readManifest, withTool, type ListedTool } from '../src/host-tools.ts';

// Host tools (#1147): what a proposal may name, the exact command it runs, and the list in deploy/host-tools.json.
const root = mkdtempSync(join(tmpdir(), 'host-tools-'));
after(() => rmSync(root, { recursive: true, force: true }));

const ok = { source: 'npm', package: 'pyright', version: '1.1.414', why: 'type-check Python' };
const line = (t: Partial<ListedTool>): ListedTool => ({ ...ok, approved_by: 'Josh', approved_on: '2026-11-19', asked_by: 'Delve #3', ...t }) as ListedTool;

test('a proposal names one source, a plain package name, one exact version and why; anything else is refused', () => {
  assert.deepEqual(parseHostTool({ ...ok, package: ' pyright ', why: ' type-check Python ' }), ok);
  assert.equal(parseHostTool({ ...ok, source: 'github', package: 'BurntSushi/ripgrep', version: 'v14.1.1' }).package, 'BurntSushi/ripgrep');
  assert.equal(parseHostTool({ ...ok, package: '@biomejs/biome' }).package, '@biomejs/biome');
  for (const [body, msg] of [
    [{ ...ok, source: 'pipx' }, /source must be one of mise, npm, pypi, cargo, github, pacman/],
    [{ ...ok, package: 'pyright; rm -rf ~' }, /isn't a npm name/],
    [{ ...ok, package: '--registry=evil' }, /isn't a npm name/],
    [{ ...ok, source: 'github', package: 'ripgrep' }, /owner\/repo/],
    [{ ...ok, version: 'latest' }, /one exact version/],
    [{ ...ok, version: '^1.2' }, /one exact version/],
    [{ ...ok, version: '' }, /one exact version/],
    [{ ...ok, why: '  ' }, /why is required/],
    [{ ...ok, why: 'x'.repeat(501) }, /at most 500/],
  ] as const)
    assert.throws(() => parseHostTool(body as any), msg, JSON.stringify(body));
});

test('the command is mise use for every source but Arch packages, which a person runs with sudo', () => {
  assert.equal(miseSpec({ source: 'mise', package: 'jq', version: '1.7.1' }), 'jq@1.7.1');
  assert.equal(installCommand({ source: 'cargo', package: 'ripgrep', version: '14.1.1' }), 'mise use -g --pin cargo:ripgrep@14.1.1');
  assert.equal(installCommand({ source: 'pypi', package: 'ruff', version: '0.8.0' }), 'mise use -g --pin pypi:ruff@0.8.0');
  assert.equal(miseSpec({ source: 'pacman', package: 'ffmpeg', version: '7.1' }), null);
  assert.equal(installCommand({ source: 'pacman', package: 'ffmpeg', version: '7.1' }), 'sudo pacman -S --needed ffmpeg');
});

test('the list is one sorted line per tool, a newer version replaces the older, and it reads back the same', () => {
  let list = withTool([], line({ source: 'pypi', package: 'ruff', version: '0.8.0' }));
  list = withTool(list, line({}));
  list = withTool(list, line({ version: '1.1.415' }));
  const text = manifestText(list);
  assert.deepEqual(
    text.split('\n').map((l) => l.slice(0, 40)),
    ['[', '{"source":"npm","package":"pyright","ver', '{"source":"pypi","package":"ruff","versi', ']', ''],
  );
  assert.match(text, /"version":"1\.1\.415"/);
  const file = join(root, 'list.json');
  writeFileSync(file, text);
  assert.deepEqual(readManifest(file), JSON.parse(text));
  assert.deepEqual(readManifest(join(root, 'missing.json')), []);
  assert.equal(manifestText([]), '[]\n');
});

test('check names each listed tool the box lacks, or has but not active', () => {
  const list = [
    line({}),
    line({ source: 'mise', package: 'jq', version: '1.7.1' }),
    line({ source: 'cargo', package: 'ripgrep', version: '14.1.1' }),
    line({ source: 'pacman', package: 'ffmpeg', version: '7.1' }),
    line({ source: 'pacman', package: 'git', version: '2.47.1' }),
    line({ source: 'pacman', package: 'curl', version: '8.10.0' }),
  ];
  const problems = manifestProblems(
    list,
    {
      'npm:pyright': [{ version: '1.1.414', installed: true, active: true }],
      jq: [{ version: '1.7.1', installed: true, active: false }],
      'cargo:ripgrep': [{ version: '13.0.0', installed: true, active: true }],
    },
    (pkg) => (({ git: '2.47.1-1', curl: '8.11.0-2' }) as Record<string, string>)[pkg] ?? null,
  );
  assert.deepEqual(problems, [
    "mise:jq@1.7.1: installed but not active in mise's global config; run `mise use -g --pin jq@1.7.1`",
    'cargo:ripgrep@14.1.1: not installed; run `mise use -g --pin cargo:ripgrep@14.1.1`',
    'pacman:ffmpeg@7.1: not installed; a person runs `sudo pacman -S --needed ffmpeg`',
    'pacman:curl@8.10.0: pacman has 8.11.0-2 installed; list the version the box has, or install 8.10.0',
  ]);
});

test('install runs mise use with the spec as one argument, and reports its failure output', async () => {
  const fake = join(root, 'mise');
  const log = join(root, 'mise.log');
  writeFileSync(fake, `#!/bin/sh\nprintf '%s|' "$@" >> ${log}; echo >> ${log}\n[ "$5" = "npm:broken@1.0.0" ] && { echo 'no such package' >&2; exit 1; }\nexit 0\n`);
  chmodSync(fake, 0o755);
  process.env.CITADEL_MISE = fake;
  try {
    const first = installTool({ source: 'npm', package: 'typescript', version: '5.6.3' }, root);
    assert.equal(installing(), 1, 'a restart waits for a running install');
    await first;
    assert.equal(installing(), 0);
    assert.deepEqual(await installTool({ source: 'npm', package: 'pyright', version: '1.1.414' }, root), { ok: true, output: '' });
    const bad = await installTool({ source: 'npm', package: 'broken', version: '1.0.0' }, root);
    assert.equal(bad.ok, false);
    assert.match(bad.output, /no such package/);
    assert.equal((await installTool({ source: 'pacman', package: 'ffmpeg', version: '7.1' }, root)).ok, false);
    assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'), ['use|-g|--pin|--yes|npm:typescript@5.6.3|', 'use|-g|--pin|--yes|npm:pyright@1.1.414|', 'use|-g|--pin|--yes|npm:broken@1.0.0|']);
  } finally {
    delete process.env.CITADEL_MISE;
  }
});
