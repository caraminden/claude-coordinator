import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { tripwire, type TripwireConfig } from '../src/tripwire.ts';
import { coordinatorAccess, credentialDenies } from '../src/turn-launch.ts';

const root = mkdtempSync(join(tmpdir(), 'coordinator-access-'));
after(() => rmSync(root, { recursive: true, force: true }));

const repo = join(root, 'repo');
const tickets = join(root, 'tickets');
mkdirSync(join(tickets, '7'), { recursive: true });

test('adds the repo and the tickets folder, and denies edits in both', () => {
  const { addDirs, settings } = coordinatorAccess(repo, tickets) as any;
  assert.deepEqual(addDirs, [repo, tickets]);
  assert.ok(settings.permissions.deny.includes(`Edit(/${repo}/**)`));
  assert.ok(settings.permissions.deny.includes(`Edit(/${tickets}/**)`));
});

test('allows read-only git -C with the exact folder as prefix', () => {
  const { allow } = (coordinatorAccess(repo, tickets).settings as any).permissions;
  assert.ok(allow.includes(`Bash(git -C ${repo} log:*)`));
  assert.ok(allow.includes(`Bash(git -C ${join(tickets, '7')} status:*)`));
  assert.ok(allow.includes(`Bash(git -C ${repo} branch -a)`));
  for (const rule of allow.filter((r: string) => r.startsWith('Bash(git '))) {
    assert.ok(!rule.includes('*)') || rule.endsWith(':*)'), `no mid-rule wildcard: ${rule}`);
    assert.doesNotMatch(rule, / (commit|checkout|switch|reset|push|merge|rebase)(?![\w-])/);
  }
});

test('without a repo, only the tickets folder is added and no git is allowed', () => {
  const { addDirs, settings } = coordinatorAccess(null, tickets) as any;
  assert.deepEqual(addDirs, [tickets]);
  assert.ok(settings.permissions.allow.includes('WebSearch') && settings.permissions.allow.includes('Bash(grep:*)'));
  assert.ok(!settings.permissions.allow.some((r: string) => r.startsWith('Bash(git')));
});

test('a live checkout is added read-only, with read-only git, and only when given', () => {
  const live = join(root, 'live');
  const { addDirs, settings } = coordinatorAccess(repo, tickets, null, null, live) as any;
  assert.deepEqual(addDirs, [repo, tickets, live]);
  assert.ok(settings.permissions.deny.includes(`Edit(/${live}/**)`));
  assert.ok(settings.permissions.allow.includes(`Bash(git -C ${live} log:*)`));
  assert.ok(!settings.permissions.allow.some((r: string) => r.includes(live) && !r.startsWith(`Bash(git -C ${live} `)));
  assert.ok(!JSON.stringify(coordinatorAccess(repo, tickets)).includes(live));
});

test('given the open minions, git rules cover only their worktrees, so closed ones never grow the settings file', () => {
  mkdirSync(join(tickets, '8'), { recursive: true });
  const { addDirs, settings } = coordinatorAccess(repo, tickets, null, null, null, [], null, [join(tickets, '8')]) as any;
  assert.deepEqual(addDirs, [repo, tickets]);
  assert.ok(settings.permissions.allow.includes(`Bash(git -C ${join(tickets, '8')} status:*)`));
  assert.ok(settings.permissions.allow.includes(`Bash(git -C ${repo} log:*)`));
  assert.ok(!settings.permissions.allow.some((r: string) => r.includes(`${join(tickets, '7')} `)));
});

test('a project with no tickets folder yet still works', () => {
  const { addDirs } = coordinatorAccess(repo, join(root, 'missing'));
  assert.equal(addDirs.length, 2);
});

// ---------- #483: the Taskmaster's read-only shell, replayed against the calls it was denied ----------

const data = join(root, 'data');
mkdirSync(join(data, 'projects/2/tickets/141'), { recursive: true });
const mise = join(root, 'mise');
const live = join(root, 'live');
const tm = coordinatorAccess(`${data}/projects/2/repo`, `${data}/projects/2/tickets`, `${data}/projects/2/shared/project`, null, live, [data, mise]);
const { allow: tmAllow, deny: tmDeny } = tm.settings.permissions;

/** A Bash rule as a regex, the way Claude Code reads it (checked in real runs, #483): `x:*` is x alone or x and more; `*` elsewhere is any text. */
function ruleRe(rule: string): RegExp {
  const body = rule.slice('Bash('.length, -1);
  const esc = (s: string) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  return body.endsWith(':*') ? new RegExp(`^${esc(body.slice(0, -2))}( .*)?$`, 's') : new RegExp(`^${body.split('*').map(esc).join('.*')}$`, 's');
}
const allowRes = tmAllow.filter((r) => r.startsWith('Bash(')).map(ruleRe);
const denyRes = tmDeny.filter((r) => r.startsWith('Bash(')).map(ruleRe);

/** A command's parts split at |, ||, &&, ; and newlines outside quotes, or null for what Claude Code won't match by rule: a redirect that writes, $(…), backticks, unclosed quotes. */
function parts(command: string): string[] | null {
  const cmd = command.replace(/ 2>&1| 2>\/dev\/null| >\s?\/dev\/null/g, '');
  const out: string[] = [];
  let cur = '';
  let q = '';
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (q) {
      if (c === '\\' && q === '"') { cur += c + (cmd[++i] ?? ''); continue; }
      if (c === q) q = '';
      cur += c;
      continue;
    }
    if (c === '\\') { cur += c + (cmd[++i] ?? ''); continue; }
    if (c === "'" || c === '"') q = c;
    if (c === '`' || (c === '$' && cmd[i + 1] === '(') || c === '>' || c === '<') return null;
    if (c === ';' || c === '|' || c === '&' || c === '\n') {
      if (c === '&' && cmd[i + 1] !== '&') return null;
      if ((c === '|' || c === '&') && cmd[i + 1] === c) i++;
      out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += c;
  }
  if (q) return null;
  out.push(cur.trim());
  return out.filter(Boolean);
}
/** Whether Claude Code would run this Bash call with no prompt: every part allowed, none denied. Paths are Claude Code's own check, tried in real runs. */
const bashAllowed = (command: string) => !!parts(command)?.every((p) => allowRes.some((r) => r.test(p)) && !denyRes.some((r) => r.test(p)));

test('the rule matcher reads rules the way Claude Code did in real runs', () => {
  assert.ok(bashAllowed('ps -eo pid,pcpu --sort=-pcpu | head -5'));
  assert.ok(bashAllowed('curl -s -m 5 http://127.0.0.1:8573/api/health | head -c 50'));
  assert.ok(bashAllowed('sort /tmp/a | uniq -c | sort -rn'));
  assert.ok(!bashAllowed("curl -s http://127.0.0.1:8573/api/health -w '%output{/tmp/x}'"), 'curl only as the exact health check');
  assert.ok(bashAllowed(`git -C ${live} merge-base --is-ancestor HEAD HEAD && echo LIVE || echo NOT-LIVE`));
  for (const c of ['curl -X POST http://127.0.0.1:1/', 'curl -s -X POST http://127.0.0.1:1/', 'gh api -f x=1 rate_limit', 'sort -o /tmp/s /tmp/a', 'find -delete', 'journalctl --user --rotate', 'echo hi > /tmp/x', 'ss -ltn | awk \'{print $4}\'']) assert.ok(!bashAllowed(c), c);
});

// The calls, with the box's paths moved under this test's folders; calls cut at 500 characters are left out.
const fixture = readFileSync(new URL('taskmaster-denied-calls.txt', import.meta.url), 'utf8').split('\n').filter((l) => l.includes('\t') && !/…\[\+\d+ chars\]$/.test(l))
  .map((l) => l.split('\t')[1].replaceAll('/home/cara/.local/share/claude-coordinator', data).replaceAll('/home/cara/claude-coordinator', live).replaceAll('/home/cara/.local/share/mise/installs', mise));
/** Whether a Taskmaster turn now makes this fixture call without a prompt. */
function nowAllowed(call: string): boolean {
  const [tool, arg] = [call.slice(0, call.indexOf(':')), call.slice(call.indexOf(':') + 2)];
  if (tool === 'Bash') return bashAllowed(arg);
  if (tool === 'Read') return tmAllow.some((r) => r.startsWith('Read(') && arg.startsWith(r.slice('Read(/'.length, -'**)'.length)));
  return tmAllow.includes(tool);
}

// Why each call that stays denied does: the first of these it contains.
const STILL_DENIED: [RegExp, string][] = [
  [/^Bash: cd /, 'a cd first: run one command with absolute paths'],
  [/^Bash: (cp|python3) /, 'writes'],
  [/^Bash: (for|[A-Za-z]+=)/, 'a loop or a path in a variable, which Claude Code cannot match by rule'],
  [/\b(sed|awk|xargs|tr|last|tailscale) /, 'not on the list: awk and xargs can write or run anything; sed and file write with a flag bundled in anywhere (`-nsi`, `-bC`), which no rule can list (#621 review)'],
  [/sqlite3 -readonly (?!-safe)/, 'sqlite3 without -safe, which could run .shell or write with .output'],
  [/git -C \S+\/projects\/[^2]\/repo /, "another scheme's repo: git is allowed per folder of this scheme"],
  [/ branch --contains /, 'branch takes -D after a filter, so only listing forms are allowed'],
  [/^Bash: curl /, 'curl only as the exact health check `curl -s http://127.0.0.1:8573/api/health`: it has too many ways to write or reach elsewhere'],
];

test("most of the Taskmaster's denied calls now run; the rest write, cd, or are shell Claude Code can't match by rule", () => {
  const passed = fixture.filter(nowAllowed);
  for (const c of fixture.filter((c) => !nowAllowed(c))) assert.ok(STILL_DENIED.some(([re]) => re.test(c)), `still denied, unexpectedly: ${c.slice(0, 200)}`);
  assert.equal(`${passed.length} of ${fixture.length}`, '54 of 82');
  for (const c of [
    'Bash: systemctl --user status claude-coordinator --no-pager -n 20',
    'Bash: ps -eo pid,user,pcpu,pmem,rss,etime,comm --sort=-pcpu | head -25',
    'Bash: cat /proc/pressure/cpu /proc/pressure/memory /proc/pressure/io',
    'Bash: gh run list -R caraminden/peek-auras --limit 8',
    `Bash: git -C ${data}/projects/2/repo rev-list --count origin/main..main`,
    `Bash: git -C ${data}/projects/2/tickets/141 branch --show-current`,
    `Bash: ls ${mise}`,
    `Read: ${data}/projects/2/shared/191/scheme-instructions.diff`,
  ]) assert.ok(passed.includes(c), c);
});

test('writes stay denied: cp, sed -i, python, curl -X POST, gh api -X, sqlite3 without -readonly -safe, git push, rm, find -exec', () => {
  for (const c of [
    `cp /etc/hostname ${data}/x`, `sed -i s/a/b/ ${data}/x`, `python3 -c "open('/tmp/x','w').write('x')"`,
    'curl -s -X POST http://127.0.0.1:8573/api/x', 'curl -d x=1 http://127.0.0.1:8573/api/x', 'curl --json {} http://127.0.0.1:8573/api/x',
    'gh api -X DELETE repos/a/b', 'gh api repos/a/b/issues -f title=x', `sqlite3 ${data}/coordinator.db "delete from tickets"`,
    `sqlite3 -readonly ${data}/coordinator.db ".shell rm -rf /tmp/x"`, `git -C ${data}/projects/2/repo push`, `git -C ${data}/projects/2/repo -c core.pager=x log`,
    `rm ${data}/x`, `find ${data} -name x -delete`, `find ${data} -exec rm {} ;`, `find ${data} -fprint /tmp/x`, `grep -c a ${data}/x > /tmp/y`,
    `cd ${data}/projects/2/repo && git log -1`, 'journalctl --user --vacuum-time=1s', 'journalctl --user --vac=1s', 'journalctl --user --cursor-file=/tmp/c',
    'sort -o /tmp/a /tmp/b', 'sort --o=/tmp/a /tmp/b', 'sort --compress-program=sh -S 1K /tmp/a', 'sort --co=sh -S 1K /tmp/a', 'uniq /tmp/a /tmp/b',
    // Review findings: -nonce turns -safe off; curl writes, reads files, POSTs and reaches other hosts; ss -D writes.
    `sqlite3 -readonly -safe -nonce x ${data}/c.db '.nonce x' '.shell rm -rf /tmp/x'`, `sqlite3 -readonly -safe -unsafe-testing ${data}/c.db '.shell x'`,
    'curl -s http://127.0.0.1:8573/ -o /tmp/x', 'curl -s -o /dev/null http://127.0.0.1:8573/', 'curl -sSo /tmp/x http://127.0.0.1:8573/', 'curl -s -D /tmp/h http://127.0.0.1:8573/',
    'curl -s file:///home/u/.ssh/id_ed25519', 'curl -s http://127.0.0.1:8573/ FILE:///etc/passwd', 'curl -s http://127.0.0.1:8573/ file:/etc/passwd', 'curl -s http://127.0.0.1:8573/ -w @/home/u/.ssh/id_ed25519',
    'curl -s http://127.0.0.1:8573@example.com/', 'curl -s https://example.com/', 'curl -s --unix-socket /run/user/1/podman/podman.sock http://127.0.0.1:1/x',
    'curl -s http://127.0.0.1:8573/ --connect-to 127.0.0.1:8573:example.com:80', 'curl -s http://127.0.0.1:8573/api/health --expand-output /tmp/x',
    'curl -s http://127.0.0.1:8573/api/health https://example.com/', "curl -s http://127.0.0.1:8573/api/health -w '%output{/tmp/x}x'", 'curl -s http://127.0.0.1:8573/api/health -so /tmp/x', `ss -ltn -D ${data}/coordinator.db`, `ss -ltn --diag=${data}/x`,
  ]) assert.ok(!bashAllowed(c), c);
});

test('#621: file, sandboxed sed, more gh reads and plain fetches in the repo run; their writing forms stay denied', () => {
  const repo = `${data}/projects/2/repo`;
  const wt = `${data}/projects/2/tickets/141`;
  for (const c of ['gh repo view caraminden/peek-auras --json visibility',
    'gh release list -R a/b', 'gh workflow view tests.yml -R a/b', `git -C ${repo} fetch`, `git -C ${repo} fetch origin`, `git -C ${repo} fetch --prune`, `git -C ${wt} log -1`]) assert.ok(bashAllowed(c), c);
  for (const c of [`sed -n 1,20p ${data}/x`, `sed --sandbox -i s/a/b/ ${data}/x`, `sed --sandbox -ni s/a/b/p ${data}/x`, `sed --sandbox --in-place s/a/b/ ${data}/x`,
    `sed --sandbox -n 1,20p ${data}/x`, `sed --sandbox -nsi s/a/b/p ${data}/x`, `file ${data}/x`, `file -bC -m ${data}/magic`, `file -C -m ${data}/magic`, `git -C ${repo} fetch origin main:main`, `git -C ${repo} fetch --upload-pack=sh origin`, `git -C ${repo} fetch origin +main:main`,
    `git -C ${live} fetch`, 'gh repo view a/b --web', 'gh release download v1 -R a/b',
    // A worktree shares the repo's refs, so the repo's fetch is its fetch; per-worktree fetch rules filled the 2 MiB settings cap (#661).
    `git -C ${wt} fetch`, `git -C ${wt} fetch origin`]) assert.ok(!bashAllowed(c), c);
});

test("the data folder and mise's installs are readable, not added: acceptEdits can't write there", () => {
  assert.ok(!tm.addDirs.includes(data) && !tm.addDirs.includes(mise));
  assert.ok(tmAllow.includes(`Read(/${data}/**)`) && tmAllow.includes(`Read(/${mise}/**)`) && tmAllow.includes('Read(//proc/loadavg)'));
  assert.ok(!tmAllow.some((r) => /^(Edit|Write)\(/.test(r)));
});

test("the tripwire still refuses secrets, environments, the credentials table and writable state.db on calls the rules now allow", () => {
  const box = '/home/u/.local/share/claude-coordinator';
  const cfg: TripwireConfig = { home: '/home/u', data: box, checkout: '/home/u/claude-coordinator', project: 2, claudeConfig: '/home/u/.claude', ask: false, deployScript: false, env: { PATH: '/usr/bin:/bin' } };
  const cwd = `${box}/projects/2/coordinator`;
  for (const command of [
    'grep -r token /home/u/.config/gh', 'cat /home/u/.ssh/id_ed25519', 'grep -rl x /home/u', 'cat /home/u/.config/claude-coordinator/env',
    'cat /proc/1/environ', 'ps eww -p 1', `sqlite3 -readonly -safe ${box}/coordinator.db "select * from credentials"`,
    `sqlite3 -readonly -safe ${box}/coordinator.db ".dump"`, 'cat /home/u/.claude/.credentials.json',
  ]) {
    assert.ok(bashAllowed(command), `the rules let it through, so the tripwire is what stops it: ${command}`);
    const v = tripwire({ tool_name: 'Bash', tool_input: { command }, cwd }, cfg);
    assert.ok(v && !v.ask, `tripwire refuses: ${command}`);
  }
  assert.ok(tripwire({ tool_name: 'Bash', tool_input: { command: `sqlite3 ${box}/state.db "select 1"` }, cwd }, cfg));
  assert.ok(tripwire({ tool_name: 'Grep', tool_input: { pattern: 'x', path: '/home/u/.config' }, cwd }, cfg));
  // The push key isn't the tripwire's: Claude Code's Read deny keeps it from the Read tool and from cat (tried in real runs).
  assert.ok(credentialDenies('/home/u', '/home/u/.claude', box).includes(`Read(/${box}/vapid.json)`));
  assert.equal(tripwire({ tool_name: 'Bash', tool_input: { command: `sqlite3 -readonly -safe ${box}/coordinator.db "select id from tickets"` }, cwd }, cfg), null);
});

// ---------- #661: the largest launch, the Citadel Taskmaster's on a member's ask, against Claude Code's 2 MiB settings cap ----------

test("#661: the Citadel Taskmaster's every-scheme settings.json stays under 1 MiB at 3x today's open minions, and past 2 MiB fails with why", async () => {
  const { launchPlan, SETTINGS_CAP } = await import('../src/turn-launch.ts');
  const { GLOBAL_OWNER } = await import('../src/properties.ts');
  const { testPins } = await import('./helpers.ts');
  const pins = testPins();
  // Live-length paths: rules grow with each folder's path (2026-11-13: 10 open here, 77 in other schemes, 237 KB).
  const base = '/home/cara/.local/share/claude-coordinator/projects';
  const launch = (own: number, schemes: number, perScheme: number) => {
    const turnDir = join(root, `launch-${own}-${schemes}-${perScheme}`);
    mkdirSync(turnDir, { recursive: true });
    return launchPlan({
      project: { id: GLOBAL_OWNER, repo_dir: `${base}/2/repo`, approval_rules: '', plugin_dirs: '', optional_plugin_dirs: '' } as any,
      ticket: { id: 1, kind: 'coordinator', permission_mode: 'default', cwd: `${base}/2/repo`, plugin_dirs: '' } as any,
      dir: turnDir, pins, place: { host: true }, machines: [], model: null, effort: null, codex: null, codexReview: null, deploys: false, memory: false, typer: null, homeContraptions: [], claudeBin: 'claude', unit: null,
      env: { server: { HOME: '/home/cara', PATH: '/usr/bin' }, coordinator: {}, heavy: {}, github: null },
      folders: { files: null, shared: `${base}/2/shared/project`, memory: null, tmp: null, tickets: `${base}/2/tickets`, data: '/home/cara/.local/share/claude-coordinator',
        openTickets: Array.from({ length: own }, (_, i) => `${base}/2/tickets/${1500 + i}`) },
      everyScheme: {
        gitDirs: Array.from({ length: schemes }, (_, s) => [`${base}/${s + 10}/repo`, ...Array.from({ length: perScheme }, (_, i) => `${base}/${s + 10}/tickets/${1500 + i}`)]).flat(),
        apps: Array.from({ length: 10 }, (_, i) => `/home/cara/apps/contraption-${i}`), data: '/home/cara/.local/share/claude-coordinator', keysDir: '/home/cara/.local/share/claude-coordinator/contraptions',
      },
    });
  };
  // 3x today's 87 open minions: 30 here, 25 in each of 10 other schemes, and 10 contraptions. The boot check holds the same 1 MiB line on the live data.
  const grown = launch(30, 10, 25);
  const settings = grown.files.find((f) => f.name === 'settings.json')!.text;
  assert.ok(Buffer.byteLength(settings) < 1024 * 1024, `settings.json at 3x is ${Buffer.byteLength(settings)} bytes`);
  assert.ok(JSON.parse(settings).permissions.allow.includes(`Bash(git -C ${base}/19/tickets/1524 log:*)`), "the every-scheme rules are in it");
  for (const f of grown.files) assert.ok(Buffer.byteLength(f.text) < 1024 * 1024, `${f.name} is ${Buffer.byteLength(f.text)} bytes`);
  // 200 open in each of 11 schemes is far past the cap: the launch says why, not Claude Code's bare "Settings file exceeds the 2MiB limit".
  assert.throws(() => launch(200, 10, 200), (err: Error) => {
    assert.match(err.message, /^This turn's settings\.json would be \d+\.\d MiB, over Claude Code's 2 MiB cap, so it can't start: [\d,]+ allow rules, [\d,]+ of them read-only git rules for 2,222 folders \(200 open minions' worktrees in this scheme, 2,010 folders in other schemes and 10 contraptions' \(every-scheme reads\)\)\. /);
    return true;
  });
  assert.equal(SETTINGS_CAP, 2 * 1024 * 1024);
});
