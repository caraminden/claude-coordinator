import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { Approvals } from '../src/approvals.ts';
import { tripwire, type TripwireConfig } from '../src/tripwire.ts';
import { TRIPWIRE, tripwireHooks } from '../src/runner.ts';

const home = '/home/u';
const data = `${home}/.local/share/claude-coordinator`;
const cfg: TripwireConfig = { home, data, checkout: `${home}/claude-coordinator`, project: 2, claudeConfig: `${home}/.claude`, deployScript: false };
const worktree = `${data}/projects/2/tickets/9`;

const WHY = 'Delete the DB copies Cara approved in #54';
/** The reason, as a minion's turn sees it: a description that explains the call, and cards on. */
const verdict = (command: string, cwd = worktree, c = cfg) => tripwire({ tool_name: 'Bash', tool_input: { command, description: WHY }, cwd }, { ...c, ask: true });
const bash = (command: string, cwd = worktree, c = cfg) => verdict(command, cwd, c)?.reason ?? null;

// Hard blocks: no card, whoever asks.
const BLOCKED: [string, string?][] = [
  // the live database files themselves, data outside a card's reach
  ['rm "$HOME/.local/share/claude-coordinator/coordinator.db-wal"'],
  ['cp /tmp/old.db ${HOME}/.local/share/claude-coordinator/coordinator.db'],
  ['cd ~/.local/share/claude-coordinator && rm coordinator.db*'],
  ['rm ~/.local/share/claude-coordinator/[c]oordinator.db'],
  ['rm ~/.local/share/claude-coordinator/coordinator.db{,-wal}'],
  ['mv ~/.local/share/claude-coordinator/coordinator.db /tmp/'],
  ['sqlite3 ~/.local/share/claude-coordinator/coordinator.db < fix.sql'],
  ['sqlite3 ~/.local/share/claude-coordinator/coordinator.db ".read fix.sql"'],
  ['rm -rf ~/.local/share/claude-coordinator/*'],
  ['rm -rf ~/.local/share/claude-coordinator'],
  ['rm -rf ~/.local/share/claude-coordinator/projects'],
  // an ask in the same command as a hard block is a hard block
  ['rm ~/.local/share/claude-coordinator/x.bak; systemctl --user restart claude-coordinator'],
  ['systemctl --user enable x.timer && cat ~/.ssh/id_rsa'],
  ['rm -rf ~/.local/share'],
  ['rm -rf ~'],
  // the live checkout
  ['cd ~/claude-coordinator && git checkout -- .'],
  ['git -C ~/claude-coordinator reset --hard origin/main'],
  ['git -C /home/u/claude-coordinator pull'],
  ['find ~/claude-coordinator -name "*.orig" -delete'],
  ["sed -i -e 's/a/b/' ~/claude-coordinator/README.md"],
  ["perl -pi -e 's/a/b/' ../../../1/shared/project/x.md"],
  ['git -C ~/claude-coordinator merge ticket/6'],
  ['sed -i s/a/b/ ~/claude-coordinator/server.ts'],
  ['cp src/runner.ts ~/claude-coordinator/src/runner.ts'],
  ['cat > ~/claude-coordinator/x.txt <<EOF\nhello\nEOF'],
  ['echo hi | tee -a /home/u/claude-coordinator/README.md'],
  ['(cd ~/claude-coordinator; touch a)'],
  ['bash -c "cd ~/claude-coordinator && git stash"'],
  // the deploy-script era: the fast-forward exception ends
  ['git -C ~/claude-coordinator pull --ff-only /x main', 'deploy'],
  // config, units
  ['echo PORT=1 >> ~/.config/claude-coordinator/env'],
  ['cd ~/.config/systemd/user && rm claude-coordinator.service'],
  ['cp x.service ~/.config/systemd/user/perigee-godot.service'],
  ['rm -rf ~/.config/systemd/user'],
  ['systemctl --user edit cc-backup.timer'],
  // restarts
  ['systemctl --user restart claude-coordinator'],
  ['systemctl --user stop claude-coordinator.service'],
  ['systemctl --user kill perigee-godot'],
  ['systemctl --user restart perigee-godot-agent.service'],
  ['sleep 5; systemctl --user try-restart claude-coordinator'],
  ['systemd-run --user --unit=x systemctl --user restart claude-coordinator'],
  // secrets
  ['cat ~/.ssh/id_ed25519'],
  ['head -c 100 $HOME/.ssh/id_rsa'],
  ['cd ~ && cat .ssh/config'],
  ['grep token ~/.claude/.credentials.json'],
  ['base64 < ~/.claude/.credentials.json'],
  ['echo $(cat ~/.ssh/id_rsa)'],
  // the service's env file, any process's environment, the GitHub login (#115)
  ['cat ~/.config/claude-coordinator/env'],
  ['grep SECRET /home/u/.config/claude-coordinator/env'],
  ['source ~/.config/claude-coordinator/env && echo $SESSION_SECRET'],
  ['. ~/.config/claude-coordinator/env'],
  ['cat /proc/1234/environ'],
  ['cat /proc/1/task/1/environ'],
  ['tr "\\0" "\\n" < /proc/*/environ'],
  ['cat /proc/$(pgrep -f server.ts)/environ'],
  ['xargs -0 -n1 < "/proc/$PID/environ"'],
  ['cd /proc/1234 && strings environ'],
  ['ps eww 1234'],
  ['ps auxe | grep SESSION'],
  ['cat ~/.config/gh/hosts.yml'],
  ['gh auth token'],
  ['gh auth status --show-token'],
  // other schemes
  ['touch ~/.local/share/claude-coordinator/projects/1/shared/project/note.md'],
  ['cd ../../../1/tickets/4 && git commit -am wip'],
  ['git -C /home/u/.local/share/claude-coordinator/projects/1/repo merge ticket/5'],
  // server.ts against live data
  ['node server.ts'],
  ['cd ~/claude-coordinator && node server.ts'],
  ['PORT=9000 node server.ts'],
  [`node -e "import('./server.ts')"`],
  ['DATA_DIR=/tmp/x timeout 10 node server.ts'],
  [`node --experimental-strip-types -e "import('./server.ts').catch(e => console.error(e))"`],
  ['node ~/claude-coordinator/server.ts'],
];

const ALLOWED = [
  // normal work in the worktree
  'git status && git diff --stat',
  'git add -A && git commit -m "Tripwire: block writes to ~/.ssh and ~/claude-coordinator"',
  'git commit -F - <<EOF\nBlocks cat ~/.ssh/id_rsa and rm -rf ~/claude-coordinator\nEOF',
  'git commit -m "$(cat <<\'EOF\'\nTwo fixes:\n1) cat ~/.ssh/id_rsa is blocked\n2) so is rm -rf ~/claude-coordinator\nEOF\n)" && git log -1',
  'node --test test/',
  'node --check server.ts',
  'DATA_DIR=$(mktemp -d) PORT=8123 node server.ts',
  'export DATA_DIR=/tmp/d PORT=8124; node server.ts &',
  'env DATA_DIR=/tmp/d PORT=8125 node server.ts',
  'npm test',
  'podman build -t x . && podman run --rm -p 127.0.0.1:8001:80 x',
  'dotnet build Delve.sln',
  'rm -rf node_modules /tmp/scratch',
  'echo hi > /dev/null 2>&1',
  'ls ~ && cd ~ && ls',
  'mkdir -p ~/.local/share/claude-coordinator/projects/2/shared/123 && cp x.png ~/.local/share/claude-coordinator/projects/2/shared/123/',
  'echo note > ~/.local/share/claude-coordinator/projects/2/shared/project/handoff.md',
  // reading live state
  'sqlite3 -readonly ~/.local/share/claude-coordinator/coordinator.db "select count(*) from tickets"',
  'sqlite3 "file:/home/u/.local/share/claude-coordinator/coordinator.db?mode=ro" .tables',
  'ls -la ~/.local/share/claude-coordinator/',
  'du -sh ~/.local/share/claude-coordinator/*',
  'cat ~/.config/systemd/user/claude-coordinator.service',
  'grep -rn foo ~/claude-coordinator/src | head',
  'find ~/claude-coordinator -name "*.ts" -exec grep -l Runner {} \\;',
  'for f in ~/claude-coordinator/src/*.ts; do wc -l $f; done',
  'git -C ~/claude-coordinator log --oneline -5',
  'cd ~/claude-coordinator && git status && git rev-parse HEAD',
  'git -C ~/claude-coordinator fetch',
  'git -C ~/.local/share/claude-coordinator/projects/1/repo log -3',
  'cat ~/.local/share/claude-coordinator/projects/1/shared/project/plan.md',
  'diff ~/claude-coordinator/server.ts server.ts',
  'cp ~/claude-coordinator/README.md /tmp/',
  'systemctl --user status claude-coordinator',
  'journalctl --user -u claude-coordinator -n 50',
  // the deploy routine
  'git -C ~/claude-coordinator pull --ff-only /home/u/.local/share/claude-coordinator/projects/2/repo main',
  'cd ~/claude-coordinator && git pull --ff-only ~/.local/share/claude-coordinator/projects/2/repo main',
  'systemd-run --user --collect --unit=cc-restart-when-idle --description="Restart when idle" /tmp/cc-restart-when-idle.sh',
  '~/claude-coordinator/tools/deploy.sh',
  'tools/deploy.sh',
  'git fetch -q && git rebase main && tools/deploy.sh 2>&1 | tail -20',
  'cd ~/claude-coordinator && ./tools/deploy.sh',
  'systemd-run --user --unit=cc-restart-when-idle bash /home/u/claude-coordinator/tools/deploy.sh',
  // the scheme's own main checkout
  'git -C ~/.local/share/claude-coordinator/projects/2/repo merge --ff-only ticket/55',
  // ssh and git use keys on their own
  'ssh -i ~/.ssh/id_ed25519 host uptime',
  'git push origin HEAD',
  // paths that only look protected
  'echo "~/.ssh is off limits"',
  "cat '$HOME/.ssh/x'",
  'cat $SOMEDIR/coordinator.db > out.txt',
  'gh pr create --body "see ~/claude-coordinator/README.md"',
  // reads the replay of past turns turned up
  `node -e "const {DatabaseSync}=require('node:sqlite');new DatabaseSync(process.argv[1],{readOnly:true})" ~/.local/share/claude-coordinator/coordinator.db`,
  'sqlite3 ~/.local/share/claude-coordinator/coordinator.db "select project_id, number from tickets where status=\'running\'"',
  'cd ~/.local/share/claude-coordinator && sqlite3 "file:coordinator.db?mode=ro" ".backup coordinator.db.bak-x"',
  'git clone -q ~/.local/share/claude-coordinator/projects/1/repo /tmp/delve',
  'ls -la ~/.claude/.credentials.json ~/.ssh',
  // normal process and env inspection next to the #115 blocks
  'ps aux | grep node',
  'ps -ef | grep claude',
  'ps -eo pid,etime,cmd --sort=etime',
  'ps -p 1234 -o pid,comm,etime',
  'cat /proc/1234/status && cat /proc/meminfo',
  'ls -la /proc/1234/',
  'ls -la ~/.config/claude-coordinator/',
  'env | grep PORT && printenv HOME',
  'grep -n environ src/tripwire.ts',
  'gh auth status && gh pr view 3',
  'cat ~/.config/gh/config.yml',
  'cd ~/claude-coordinator && git pull --ff-only /home/u/.local/share/claude-coordinator/projects/2/repo main && systemd-run --user --collect --unit=cc-restart-when-idle /tmp/cc-restart-when-idle.sh',
  'cd ~/claude-coordinator && curl -s localhost:8573/api/version && gh pr list',
  'chmod 600 ~/.local/share/claude-coordinator/coordinator.db*',
  'env $E PORT=8617 DATA_DIR=/tmp/d node server.ts',
  `node -e "for (const c of ['node server.ts', 'ls']) console.log(label(c))"`,
  'git -C ~/claude-coordinator archive HEAD | tar -t | head',
  'cd ~/claude-coordinator && git status && R=/x/repo; git -C $R merge --ff-only ticket/6',
  'sqlite3 ~/.local/share/claude-coordinator/coordinator.db ".backup $D/coordinator.db"',
  "cd ~/.local/share/claude-coordinator/projects/2/tickets/9 && perl -pi -e 's/a\\/b/c/g' src/x.ts",
  "sed -i 's#/home/u/claude-coordinator#~/app#' README.md",
];

// Things a person may reasonably allow once: a card for that exact call.
const ASKS = [
  // a deploy that cuts off running turns
  'tools/deploy.sh --now',
  'git rebase main && ./tools/deploy.sh --now 2>&1 | tail -20',
  // data-dir files other than the live database
  'rm ~/.local/share/claude-coordinator/coordinator.db.bak-machines ~/.local/share/claude-coordinator/coordinator.db.bak-x',
  'cd ~/.local/share/claude-coordinator && rm coordinator.db.bak-*',
  'echo x > ~/.local/share/claude-coordinator/coordinator.db.bak-machines',
  'echo x>>~/.local/share/claude-coordinator/vapid.json',
  'mv ~/.local/share/claude-coordinator/old ~/.local/share/claude-coordinator/old-2',
  // SQL on the live database, when the card can show all of it
  `sqlite3 ${data}/coordinator.db "delete from tickets where id = 3"`,
  'sqlite3 ~/.local/share/claude-coordinator/coordinator.db "update tickets set state=null"',
  'cd ../../../.. && sqlite3 coordinator.db "vacuum"',
  'sqlite3 -json ~/.local/share/claude-coordinator/coordinator.db "select 1; delete from events"',
  // installing and enabling user units
  'cp deploy/backup.timer ~/.config/systemd/user/',
  'ln -s $PWD/x.container ~/.config/containers/systemd/x.container',
  'systemctl --user enable cc-backup.timer',
  'systemctl --user link ~/repo/deploy/cc-backup.service && systemctl --user daemon-reload',
];

for (const [command, mode] of BLOCKED) {
  test(`blocks: ${command}`, () => {
    const v = verdict(command, worktree, mode === 'deploy' ? { ...cfg, deployScript: true } : cfg);
    assert.ok(v, 'expected a block');
    assert.equal(v.ask, false, 'expected a hard block, not a card');
  });
}
for (const command of ASKS) {
  test(`asks: ${command}`, () => assert.equal(verdict(command)?.ask, true));
}
for (const command of ALLOWED) {
  test(`allows: ${command}`, () => assert.equal(bash(command), null));
}

test('once tools/deploy.sh exists, it is still allowed', () => {
  assert.equal(bash('~/claude-coordinator/tools/deploy.sh', worktree, { ...cfg, deployScript: true }), null);
});

test('a Taskmaster in its own scheme folder can work; one in another scheme cannot write', () => {
  assert.equal(bash('echo x > notes.md', `${data}/projects/2/coordinator`), null);
  assert.ok(bash('echo x > notes.md', `${data}/projects/1/coordinator`));
  assert.ok(tripwire({ tool_name: 'Bash', tool_input: { command: 'touch x' } , cwd: `${data}/projects/2/coordinator` }, { ...cfg, project: 1 }));
});

test('an ask is a hard block without an explanation, in a Taskmaster turn, or from a file tool', () => {
  const command = 'systemctl --user enable cc-backup.timer';
  for (const description of [undefined, '', 'Enable timer']) {
    const v = tripwire({ tool_name: 'Bash', tool_input: { command, description }, cwd: worktree }, { ...cfg, ask: true });
    assert.equal(v?.ask, false, String(description));
    assert.match(v!.reason, /only with an explanation/);
  }
  assert.equal(tripwire({ tool_name: 'Bash', tool_input: { command, description: WHY }, cwd: worktree }, cfg)?.ask, false);
  assert.equal(tripwire({ tool_name: 'Write', tool_input: { file_path: `${data}/coordinator.db.bak-x` }, cwd: worktree }, { ...cfg, ask: true })?.ask, false);
});

test('file tools: writes, edits and reads', () => {
  const t = (tool_name: string, tool_input: object) => tripwire({ tool_name, tool_input, cwd: worktree }, cfg)?.reason ?? null;
  assert.ok(t('Write', { file_path: `${home}/claude-coordinator/src/x.ts` }));
  assert.ok(t('Edit', { file_path: `${home}/.config/claude-coordinator/env` }));
  assert.ok(t('MultiEdit', { file_path: `${data}/projects/1/tickets/3/a.ts` }));
  assert.ok(t('NotebookEdit', { notebook_path: `${home}/.config/systemd/user/x.service` }));
  assert.ok(t('Write', { file_path: '../../../../coordinator.db' }));
  assert.ok(t('Read', { file_path: `${home}/.ssh/id_ed25519` }));
  assert.ok(t('Read', { file_path: '~/.claude/.credentials.json' }));
  assert.ok(t('Grep', { pattern: 'x', path: `${home}/.ssh` }));
  assert.ok(t('Read', { file_path: `${home}/.config/claude-coordinator/env` }));
  assert.ok(t('Grep', { pattern: 'SECRET', path: `${home}/.config/claude-coordinator` }));
  assert.ok(t('Read', { file_path: '/proc/1234/environ' }));
  assert.ok(t('Read', { file_path: '~/.config/gh/hosts.yml' }));
  assert.equal(t('Read', { file_path: '/proc/1234/status' }), null);
  assert.equal(t('Read', { file_path: `${home}/claude-coordinator/server.ts` }), null);
  assert.equal(t('Read', { file_path: `${data}/projects/1/shared/project/plan.md` }), null);
  assert.equal(t('Write', { file_path: `${worktree}/src/x.ts` }), null);
  assert.equal(t('Edit', { file_path: 'src/runner.ts' }), null);
  assert.equal(t('Write', { file_path: `${data}/projects/2/shared/project/handoff.md` }), null);
  // The scheme's repo memory, which the Taskmaster's prompt says it may write.
  assert.equal(t('Edit', { file_path: `${home}/.claude/projects/-home-u--local-share-claude-coordinator-projects-2-repo/memory/MEMORY.md` }), null);
  assert.equal(t('mcp__thread__set_thread_status', { title: 'x' }), null);
});

test('reasons say why and what to do instead', () => {
  assert.match(bash('systemctl --user restart claude-coordinator')!, /cc-restart-when-idle/);
  assert.match(bash('systemctl --user restart claude-coordinator', worktree, { ...cfg, deployScript: true })!, /tools\/deploy\.sh/);
  assert.match(bash('git -C ~/claude-coordinator pull --ff-only', worktree, { ...cfg, deployScript: true })!, /run it from your worktree/);
  assert.match(bash('node server.ts')!, /DATA_DIR=\$\(mktemp -d\)/);
  assert.match(bash('rm ~/.local/share/claude-coordinator/coordinator.db')!, /sqlite3 -readonly/);
});

test('the hook script blocks with exit 2, asks in a minion turn, and lets other calls through', () => {
  const hook = (ask: boolean) => tripwireHooks(2, `${home}/.claude`, ask).PreToolUse[0].hooks[0].command.split(' ').map((s: string) => s.slice(1, -1));
  const [node, script, config] = hook(true);
  assert.equal(script, TRIPWIRE);
  const run = (input: object, c = config) => spawnSync(node, [script, c], { input: JSON.stringify(input), encoding: 'utf8' });
  const blocked = run({ tool_name: 'Bash', tool_input: { command: 'cat ~/.ssh/id_rsa', description: WHY }, cwd: '/tmp' });
  assert.equal(blocked.status, 2);
  assert.match(blocked.stderr, /\[tripwire\].*SSH keys/);
  const enable = { tool_name: 'Bash', tool_input: { command: 'systemctl --user enable cc-backup.timer', description: WHY }, cwd: '/tmp' };
  const asked = run(enable);
  assert.equal(asked.status, 0);
  const out = JSON.parse(asked.stdout).hookSpecificOutput;
  assert.equal(out.permissionDecision, 'ask');
  assert.match(out.permissionDecisionReason, /systemctl enable/);
  // A Taskmaster's turn can't show cards, so the same call is a plain block there.
  assert.equal(run(enable, hook(false)[2]).status, 2);
  assert.equal(run({ tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: '/tmp' }).status, 0);
  assert.equal(spawnSync(node, [script, '{bad'], { input: '{}', encoding: 'utf8' }).status, 0);
});

// ---------- the card a tripwire ask turns into (Approvals.ask; the MCP round trip is in approvals.test.ts) ----------

test('cards: approve settles that exact call, deny blocks it, and one card at a time', async () => {
  const events: any[] = [];
  const a = new Approvals((ticketId, kind, data) => events.push({ ticketId, kind, data }));
  const input = { command: 'rm ~/.local/share/claude-coordinator/coordinator.db.bak-x', description: WHY };
  const first = a.ask(1, 'Bash', input, worktree, cfg, false);
  assert.ok('id' in first, JSON.stringify(first));
  const card = events.at(-1).data;
  assert.deepEqual(card.input, input, 'the card shows the call in full');
  assert.equal(card.tripwire.explanation, WHY);
  assert.match(card.tripwire.reason, /live data dir/);

  // While it waits, no second tripwire card, from this minion; another minion still can.
  const second = a.ask(1, 'Bash', { command: 'systemctl --user enable x.timer', description: WHY }, worktree, cfg, false);
  assert.match((second as any).refused, /already waiting/);
  assert.ok('id' in a.ask(2, 'Bash', input, worktree, cfg, false));

  const decided = a.wait(1, first.id, 10_000);
  assert.deepEqual(a.decide(1, first.id, true, 'Cara'), { state: 'allowed', by: 'Cara' });
  assert.deepEqual(await decided, { state: 'allowed', by: 'Cara' });

  // Once it's settled, the next call can ask; a deny ends tripwire cards for the rest of the turn.
  const next = a.ask(1, 'Bash', { command: 'systemctl --user enable x.timer', description: WHY }, worktree, cfg, false);
  assert.ok('id' in next);
  assert.deepEqual(a.decide(1, next.id, false, 'Cara'), { state: 'denied', by: 'Cara' });
  assert.match((a.ask(1, 'Bash', input, worktree, cfg, false) as any).refused, /denied a tripwire card earlier this turn/);
  a.endTurn(1, 'The turn ended while this waited.');
  assert.ok('id' in a.ask(1, 'Bash', input, worktree, cfg, false), 'a new turn starts afresh');
});

test('cards: refused for hard blocks, missing explanations, long calls, and other prompts without rules', () => {
  const a = new Approvals(() => {});
  const refused = (input: object, rules = false) => (a.ask(5, 'Bash', input, worktree, cfg, rules) as any).refused;
  assert.match(refused({ command: 'systemctl --user restart claude-coordinator', description: WHY }), /The tripwire blocks this/);
  assert.match(refused({ command: 'systemctl --user enable x.timer' }), /explanation/);
  assert.match(refused({ command: `rm ${data}/x.bak # ${'x'.repeat(20_000)}`, description: WHY }), /too long to show in full/);
  assert.match(refused({ command: 'gh pr merge 3' }), /Nobody can answer a permission prompt/);
  assert.equal(a.waiting(5), 0);
  // With approval rules, other prompts still get their card, as before.
  assert.equal(refused({ command: 'gh pr merge 3' }, true), undefined);
  assert.equal(a.waiting(5), 1);
});
