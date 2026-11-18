// The side question's read-only guard (#932): the fork keeps the minion's tools, so this hook is what stops it writing.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';
import { bashWrites, sideGuard } from '../src/side-guard.ts';

const bash = (command: string) => sideGuard({ tool_name: 'Bash', tool_input: { command } });

test('refuses the tools that change things: Write, Edit, Agent, cards and machines', () => {
  for (const tool_name of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Agent', 'Task', 'TodoWrite', 'mcp__thread__ask_question', 'mcp__thread__message_minion',
    'mcp__thread__set_thread_status', 'mcp__thread__hand_off_land', 'mcp__thread__close_self', 'mcp__citadel-test-box-ws__run_task', 'mcp__coordinator__create_ticket']) {
    assert.match(sideGuard({ tool_name, tool_input: { file_path: '/tmp/x', content: 'x' } }) ?? '', /read-only/, tool_name);
  }
});

test('lets the reads through: files, searches and the read-only Citadel tools', () => {
  for (const tool_name of ['Read', 'Grep', 'Glob', 'ToolSearch', 'Skill', 'mcp__thread__read_minion', 'mcp__thread__list_tickets', 'mcp__thread__search_memory', 'mcp__coordinator__read_ticket']) {
    assert.equal(sideGuard({ tool_name, tool_input: {} }), null, tool_name);
  }
  // artifact_data reads a page's saved picks, but given entries it sets them.
  assert.match(sideGuard({ tool_name: 'mcp__thread__artifact_data', tool_input: { path: 'a.html', entries: { k: 1 } } }) ?? '', /read-only/);
});

test('lets an investigation run: git, gh, logs, processes and the database read-only', () => {
  for (const c of [
    'git log --oneline -5', 'git -C /x status --short', 'git diff main...HEAD -- src/a.ts | head -50', 'git branch --show-current', 'git worktree list',
    'gh pr view 12 --json state', 'gh run list -L 3', 'gh api repos/o/r/pulls', 'ps aux | grep claude', 'ss -ltnp 2>/dev/null', 'tail -n 50 /tmp/x.log 2>&1',
    'journalctl --user -u citadel -n 20', "sqlite3 -readonly db.sqlite 'SELECT count(*) FROM turns'", 'systemctl --user status citadel', "sed -n '10,20p' a.ts",
    "sed -n '/start/,/end/p' a.ts", "find . -name '*.ts' -newer x", 'ls -la && wc -l a.ts; date', 'cat <<EOF\nhi\nEOF', 'curl -s http://127.0.0.1:1234/health',
    'curl -fsSL -H "Accept: application/json" -m 5 http://x', "sqlite3 -readonly -json db 'SELECT 1'", 'journalctl --user -u x -n 20 --no-pager', 'sort -u a', 'date -d yesterday',
  ]) assert.equal(bashWrites(c), null, c);
});

test('refuses shell writes: redirects, removers, git and gh that change things, substitutions', () => {
  for (const c of [
    'echo hi > out.txt', 'echo hi >> out.txt', 'cat a | tee b', 'rm -rf x', 'mv a b', 'touch x', 'mkdir d', 'git commit -m x', 'git checkout main', 'git push',
    'git branch -D x', 'git stash', 'git -c core.pager=sh log', 'gh pr merge 1', 'gh pr create', 'gh api -X POST repos/o/r/issues', "sed -i 's/a/b/' f",
    "sed -n 'w out' f", "sed 's/a/b/e' f", 'find . -delete', 'find . -exec rm {} ;', 'sort -o x y', 'node -e 1', 'python3 x.py', "awk '{system(\"rm x\")}'",
    'sqlite3 db "DELETE FROM x"', "sqlite3 -readonly db '.shell rm x'", 'echo $(rm x)', 'echo `rm x`', 'ls &', '(rm x)', 'X=1 ls', 'xargs rm', 'eval rm x',
    'systemctl --user restart citadel', 'curl -X POST http://x', 'curl -o f http://x', 'kill 1', 'uniq a b', '$CMD x',
    // Found in review: flags inside a cluster or cut short, SQL that writes, a verb hidden behind a flag's value.
    "sqlite3 -readonly db \"select writefile('/tmp/x','y')\"", "sqlite3 -readonly db \"VACUUM INTO '/tmp/x'\"", 'echo .shell id | sqlite3 -readonly db',
    'sqlite3 -readonly -cmd .shell db x', 'systemctl --user -p status restart foo', 'curl -D /tmp/x http://a', 'curl -c /tmp/j http://a', 'curl --json {} http://a',
    'curl -sw %output{/tmp/x} http://a', 'sort -uo /tmp/x f', 'sort --out=/tmp/x f', 'git diff --outp=file', 'git grep -O"sh -c id" x', 'rg --hostname-bin=x y',
    'echo hi > 1', 'tree -o x .', 'file -C -m x', 'ss -K dst 1.2.3.4', 'date --se=now',
  ]) assert.notEqual(bashWrites(c), null, c);
});

test('a Bash write comes back with the read-only reason, and a background run is refused', () => {
  assert.match(bash('echo hi > out.txt') ?? '', /side question: a read-only copy.*would write a file/);
  assert.match(sideGuard({ tool_name: 'Bash', tool_input: { command: 'ls', run_in_background: true } }) ?? '', /background/);
});

test('as a hook it blocks with exit 2 and the reason on stderr, and lets a read through with exit 0', () => {
  const script = join(import.meta.dirname, '..', 'src', 'side-guard.ts');
  const run = (input: unknown) => spawnSync(process.execPath, [script], { input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8' });
  const write = run({ tool_name: 'Write', tool_input: { file_path: '/tmp/x', content: 'x' } });
  assert.equal(write.status, 2);
  assert.match(write.stderr, /\[side question\].*read-only/);
  assert.equal(run({ tool_name: 'Read', tool_input: { file_path: '/tmp/x' } }).status, 0);
  // Fails closed: input it can't read is refused.
  assert.equal(run('not json').status, 2);
});
