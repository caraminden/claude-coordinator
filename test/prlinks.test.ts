import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { owners, prOwners, repoSlug } from '../src/prlinks.ts';
import { until } from './wait.ts';
import type { Project, Ticket } from '../src/db.ts';

test('repoSlug reads GitHub https and ssh URLs', () => {
  assert.equal(repoSlug('https://github.com/caraminden/claude-coordinator'), 'caraminden/claude-coordinator');
  assert.equal(repoSlug('https://github.com/CaraMinden/gamedevtest.git'), 'caraminden/gamedevtest');
  assert.equal(repoSlug('git@github.com:o/r.git'), 'o/r');
  for (const s of [null, '', 'https://gitlab.com/o/r', 'https://github.com/o']) assert.equal(repoSlug(s), null, String(s));
});

test('a PR belongs to the minion whose branch is its head', () => {
  const t = (id: number, number: number, branch: string | null, kind = 'ticket') => ({ id, number, branch, kind, title: `t${id}` }) as unknown as Ticket;
  const tickets = [t(162, 68, 'ticket/68-laptop'), t(1, 0, 'main', 'coordinator'), t(3, 4, null)];
  assert.deepEqual(
    owners(
      [
        { number: 186, headRefName: 'ticket/68-laptop' },
        { number: 9, headRefName: 'main' },
        { number: 2, headRefName: 'other' },
      ],
      tickets,
    ),
    { 186: { id: 162, number: 68, title: 't162' } },
  );
});

test('a PR from another ticket/<N>- branch belongs to minion N of the scheme', () => {
  const t = (id: number, number: number, branch: string | null) => ({ id, number, branch, kind: 'ticket', title: `t${id}` }) as unknown as Ticket;
  const tickets = [t(193, 93, 'ticket/93-s9-measured'), t(164, 64, 'ticket/64-port-the-mod')];
  assert.deepEqual(
    owners(
      [
        { number: 217, headRefName: 'ticket/93-s11-targets-doc' },
        { number: 195, headRefName: 'ticket/64-drop-fold-check' },
        { number: 3, headRefName: 'ticket/7-nobody' },
        { number: 4, headRefName: 'claude/project-thread-x' },
      ],
      tickets,
    ),
    { 217: { id: 193, number: 93, title: 't193' }, 195: { id: 164, number: 64, title: 't164' } },
  );
});

test('prOwners lists every PR and issue number, and a failed issue list leaves the PRs', async () => {
  // A stand-in gh: two PRs, and an issue list that fails (issues turned off).
  const bin = mkdtempSync(join(tmpdir(), 'prlinks-gh-'));
  writeFileSync(join(bin, 'gh'), `#!/bin/sh\n[ "$1" = pr ] && echo '[{"number":5,"headRefName":"ticket/3-x"},{"number":4,"headRefName":"claude/old"}]' && exit 0\nexit 1\n`);
  chmodSync(join(bin, 'gh'), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  try {
    const minion = { id: 30, number: 3, branch: 'ticket/3-x', kind: 'ticket', title: 'Three' } as unknown as Ticket;
    const [repo] = await prOwners([{ id: 9, name: 'S', repo_url: 'https://github.com/stub/prlinks-test' } as unknown as Project], () => [minion]);
    assert.deepEqual(repo, { projectId: 9, scheme: 'S', repo: 'stub/prlinks-test', prs: { 5: { id: 30, number: 3, title: 'Three' } }, pulls: [5, 4], issues: [] });
  } finally {
    process.env.PATH = path;
  }
});

test("merged and closed PRs of dismissed minions find their owner in each scheme's own repo", async () => {
  // A stand-in gh like GitHub's: without --state all it lists only open PRs. Each repo has its own PRs.
  const bin = mkdtempSync(join(tmpdir(), 'prlinks-gh-'));
  writeFileSync(
    join(bin, 'gh'),
    `#!/bin/sh
[ "$1" = pr ] || exit 1
case "$*" in *"--state all"*) all=1 ;; esac
case "$*" in
  *"--repo stub/mandate-like"*) [ -n "$all" ] && echo '[{"number":15,"headRefName":"ticket/24-colours"},{"number":12,"headRefName":"ticket/16-ics"}]' || echo '[]' ;;
  *"--repo stub/citadel-like"*) [ -n "$all" ] && echo '[{"number":15,"headRefName":"ticket/240-other"}]' || echo '[]' ;;
  *) exit 1 ;;
esac
`,
  );
  chmodSync(join(bin, 'gh'), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  try {
    // Mandate #24 merged PR 15 and was dismissed; #16's PR 12 was closed unmerged. Citadel's own PR 15 is #240's.
    const t = (id: number, number: number, branch: string) => ({ id, number, branch, kind: 'ticket', status: 'closed', title: `t${number}` }) as unknown as Ticket;
    const tickets: Record<number, Ticket[]> = { 5: [t(422, 24, 'ticket/24-colours'), t(380, 16, 'ticket/16-ics')], 2: [t(500, 240, 'ticket/240-other')] };
    const repos = await prOwners(
      [
        { id: 2, name: 'Citadel', repo_url: 'https://github.com/stub/citadel-like' },
        { id: 5, name: 'Mandate', repo_url: 'https://github.com/stub/mandate-like' },
      ] as unknown as Project[],
      (id) => tickets[id],
    );
    assert.deepEqual(
      repos.map((r) => [r.projectId, r.repo, r.prs]),
      [
        [2, 'stub/citadel-like', { 15: { id: 500, number: 240, title: 't240' } }],
        [5, 'stub/mandate-like', { 15: { id: 422, number: 24, title: 't24' }, 12: { id: 380, number: 16, title: 't16' } }],
      ],
    );
  } finally {
    process.env.PATH = path;
  }
});

/** A stand-in gh on PATH that runs `body` (sh) for each call; returns a restore function. */
function standInGh(bin: string, body: string): () => void {
  writeFileSync(join(bin, 'gh'), `#!/bin/sh\n${body}\n`);
  chmodSync(join(bin, 'gh'), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  return () => {
    process.env.PATH = path;
    rmSync(bin, { recursive: true }); // timing-ok: own temp dir
  };
}
const proj = (id: number, slug: string) => ({ id, name: `S${id}`, repo_url: `https://github.com/${slug}` }) as unknown as Project;

test('a copy older than 5 minutes answers at once while GitHub is asked behind it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'prlinks-gh-'));
  const restore = standInGh(dir, `echo "$@" >> ${dir}/calls\n[ "$1" = pr ] || { echo '[]'; exit 0; }\nif [ -e ${dir}/slow ]; then while [ ! -e ${dir}/go ]; do sleep 0.05; done; echo '[{"number":2,"headRefName":"x"}]'; else echo '[{"number":1,"headRefName":"x"}]'; fi`);
  try {
    let clock = 1_000_000;
    const p = [proj(1, 'stub/stale-a')];
    const first = await prOwners(
      p,
      () => [],
      () => clock,
    );
    assert.deepEqual(first[0].pulls, [1]);
    writeFileSync(join(dir, 'slow'), '');
    clock += 6 * 60_000;
    const stale = await prOwners(
      p,
      () => [],
      () => clock,
    ); // gh has not answered; must not wait for it
    assert.deepEqual(stale[0].pulls, [1]);
    await prOwners(
      p,
      () => [],
      () => clock,
    ); // a second page while it runs
    writeFileSync(join(dir, 'go'), '');
    await until(
      'the refresh landed',
      async () =>
        (
          await prOwners(
            p,
            () => [],
            () => clock,
          )
        )[0].pulls[0] === 2,
    );
    const prCalls = readFileSync(join(dir, 'calls'), 'utf8')
      .split('\n')
      .filter((l) => l.startsWith('pr '));
    assert.equal(prCalls.length, 2, 'one refresh in flight, not one per page');
  } finally {
    restore();
  }
});

test('a cold start asks every repo before the first has answered', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'prlinks-gh-'));
  // The first repo's PR list waits up to 3 s for the second repo to be asked, and notes whether it was.
  const restore = standInGh(dir, `[ "$1" = pr ] || { echo '[]'; exit 0; }\ntouch ${dir}/asked-$(echo $4 | tr / _)\nif [ "$4" = stub/cold-a ]; then i=0; while [ ! -e ${dir}/asked-stub_cold-b ] && [ $i -lt 60 ]; do sleep 0.05; i=$((i+1)); done; [ -e ${dir}/asked-stub_cold-b ] && touch ${dir}/saw-b; fi\necho '[]'`);
  try {
    await prOwners([proj(1, 'stub/cold-a'), proj(2, 'stub/cold-b')], () => []);
    assert.ok(existsSync(join(dir, 'saw-b')), 'the second repo was asked while the first was still waiting');
  } finally {
    restore();
  }
});

test('a failed refresh keeps the last good list', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'prlinks-gh-'));
  const restore = standInGh(dir, `echo "$1" >> ${dir}/calls\n[ -e ${dir}/fail ] && exit 1\n[ "$1" = pr ] && echo '[{"number":7,"headRefName":"x"}]' || echo '[{"number":8}]'`);
  try {
    let clock = 5_000_000;
    const p = [proj(1, 'stub/fail-a')];
    await prOwners(
      p,
      () => [],
      () => clock,
    );
    writeFileSync(join(dir, 'fail'), '');
    clock += 6 * 60_000;
    await prOwners(
      p,
      () => [],
      () => clock,
    ); // starts the failing refresh
    await until('the failing calls ran', () => readFileSync(join(dir, 'calls'), 'utf8').split('\n').filter(Boolean).length >= 4);
    await new Promise((r) => setTimeout(r, 200)); // timing-ok: gh exited, its answer is still being read
    clock += 6 * 60_000;
    const [r] = await prOwners(
      p,
      () => [],
      () => clock,
    );
    assert.deepEqual([r.pulls, r.issues], [[7], [8]]);
  } finally {
    restore();
  }
});
