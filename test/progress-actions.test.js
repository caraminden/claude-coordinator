// public/progress.js: how each tool call reads in the chat's work readout (actionLabel,
// describeAction, activityLabel), which phase of the work it belongs to (actionPhase, workPhases),
// a step's roll-up line (summarizeActions), the step counts (stepInfo) and which calls count as
// work at all (isWorkTool).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  actionLabel, actionPhase, activityLabel, createProgress, describeAction, isWorkTool, stepInfo, summarizeActions, workPhases,
} from '../public/progress.js';

const bash = (command, description) => ({ name: 'Bash', input: description ? { command, description } : { command } });
const read = (file_path) => ({ name: 'Read', input: { file_path } });
const edit = (file_path) => ({ name: 'Edit', input: { file_path, old_string: 'a', new_string: 'b' } });
// An action as the readout holds it: the tool call and its result (null while it runs).
const act = (block, result = { is_error: false }) => ({ block, result });
const failed = (block) => act(block, { is_error: true });

test('only real work counts as an action, not plan bookkeeping or tool loading', () => {
  const cases = [
    ['TaskCreate', false], ['TaskUpdate', false], ['TaskList', false], ['TaskGet', false], // the task list itself
    ['TodoWrite', false], // the older task list
    ['ToolSearch', false], // loading other tools' schemas
    ['Bash', true], ['Edit', true], ['Read', true], ['Agent', true],
    ['mcp__thread__set_thread_status', true], // an MCP tool is work like any other
  ];
  for (const [name, work] of cases) assert.equal(isWorkTool(name), work, name);
});

test('each kind of tool call reads as a plain sentence naming what it touched', () => {
  const cases = [
    // Files are named by their basename, never the full path.
    [read('/home/x/repo/src/runner.ts'), 'Read runner.ts'],
    [edit('/home/x/repo/public/app.js'), 'Edited app.js'],
    [{ name: 'MultiEdit', input: { file_path: 'src/db.ts' } }, 'Edited db.ts'],
    // A notebook edit names its notebook_path.
    [{ name: 'NotebookEdit', input: { notebook_path: '/n/analysis.ipynb' } }, 'Edited analysis.ipynb'],
    // A whole-file write says so, rather than "Edited".
    [{ name: 'Write', input: { file_path: '/tmp/notes.md' } }, 'Wrote notes.md'],
    [{ name: 'Grep', input: { pattern: 'stepInfo', path: '/repo/public' } }, 'Searched for “stepInfo” in public'],
    // No path: no "in …".
    [{ name: 'Grep', input: { pattern: 'TODO' } }, 'Searched for “TODO”'],
    [{ name: 'Glob', input: { pattern: '**/*.test.js' } }, 'Looked for files matching **/*.test.js'],
    // A web page is named by its host only.
    [{ name: 'WebFetch', input: { url: 'https://nodejs.org/api/test.html#describe' } }, 'Read a page on nodejs.org'],
    // A URL that won't parse is shown as given.
    [{ name: 'WebFetch', input: { url: 'not a url' } }, 'Read a page on not a url'],
    [{ name: 'WebSearch', input: { query: 'node test runner' } }, 'Searched the web for “node test runner”'],
    // A Grunt's job continues the sentence, so its first letter drops to lower case.
    [{ name: 'Agent', input: { description: 'Review the diff', prompt: 'long brief' } }, 'Asked a grunt to review the diff'],
    // The older Task tool, and no description: the prompt stands in.
    [{ name: 'Task', input: { prompt: 'Find the flaky test' } }, 'Asked a grunt to find the flaky test'],
    [{ name: 'Skill', input: { skill: 'citadel:test-quality' } }, 'Used the citadel:test-quality skill'],
    [{ name: 'Workflow', input: { script: 'x' } }, 'Ran a multi-agent workflow'],
    // The Taskmaster's own tools: the tool name as a verb, then the minion and the title or text.
    [{ name: 'mcp__coordinator__message_ticket', input: { ticket_id: 12, text: 'Your fix is live' } }, 'Message ticket #12: Your fix is live'],
    [{ name: 'mcp__coordinator__create_ticket', input: { title: 'Fix the login page' } }, 'Create ticket Fix the login page'],
    [{ name: 'mcp__coordinator__list_tickets', input: {} }, 'List tickets'],
    // Any other MCP tool names its tool and its server, underscores as spaces.
    [{ name: 'mcp__thread__set_thread_status', input: { status: 'x' } }, 'Used set thread status (thread)'],
    [{ name: 'mcp__claude_ai_Gmail__search_threads', input: {} }, 'Used search threads (claude ai Gmail)'],
    // A tool this module has never heard of.
    [{ name: 'LSP', input: {} }, 'Used LSP'],
  ];
  for (const [block, text] of cases) {
    assert.equal(actionLabel(block), text, block.name);
    assert.equal(describeAction(block).text, text, block.name);
  }
});

test('a tool call that touches a file carries that file, so a phase can list what changed', () => {
  const cases = [
    [edit('/r/public/app.js'), 'edit', 'app.js'],
    [{ name: 'Write', input: { file_path: '/r/notes.md' } }, 'edit', 'notes.md'],
    [read('/r/src/db.ts'), 'read', 'db.ts'],
    // Shell commands and searches touch no single file.
    [bash('sed -i s/a/b/ x', 'Rename a to b'), 'run', undefined],
    [{ name: 'Grep', input: { pattern: 'x' } }, 'search', undefined],
  ];
  for (const [block, kind, object] of cases) {
    const d = describeAction(block);
    assert.equal(d.kind, kind, block.name);
    assert.equal(d.object, object, block.name);
  }
});

test("a shell command reads as Claude's own description, capitalised and kept to one line", () => {
  assert.equal(actionLabel(bash('npm test', 'run the test suite')), 'Run the test suite');
  assert.equal(actionLabel(bash('npm test', 'Run the tests\nthen look at the output')), 'Run the tests');
  // Clipped to 90 characters, the last an ellipsis.
  assert.equal(actionLabel(bash('x', `Check ${'a'.repeat(120)}`)), `Check ${'a'.repeat(83)}…`);
});

test('a shell command with no description is put into words from the command itself', () => {
  const cases = [
    ['npm test', 'Ran the tests'],
    // Env assignments in front don't hide what ran.
    ['CI=1 npm test', 'Ran the tests'],
    ['cd repo && node --test test/', 'Ran the tests'],
    // Only the first program of a pipeline counts.
    ['git log --oneline | head -5', 'Looked at commit history'],
    ['npm ls | grep react', 'Ran npm ls'],
    ['git status && git diff', 'Checked what changed, looked at code changes'],
    // A git subcommand with no wording of its own.
    ['git frobnicate', 'Ran git frobnicate'],
    // Files looked at in a row are listed together.
    ['cat a.ts; cat b.ts', 'Looked at a.ts and b.ts'],
    ['cat a.ts; cat b.ts; head c.ts', 'Looked at a.ts, b.ts and c.ts'],
    // Filler (listing, echo, sleep) drops out when the command did something else too...
    ['ls; cat app.js; echo done', 'Looked at app.js'],
    // ...but stays when it is all the command did.
    ['ls; echo done', 'Listed files, printed some text'],
    // At most two things are named.
    ['git add -A && git commit -m x && git push', 'Staged changes, committed changes and more'],
    // A heredoc's body is not more commands.
    ["node - <<'EOF'\nrm -rf build\nEOF", 'Ran a Node script'],
    ['python3 tools/report.py --all', 'Ran report.py'],
    ['node --check public/app.js', 'Checked JavaScript syntax'],
    ['npm install', 'Installed dependencies'],
    ['gh pr create --fill', 'Used GitHub (pr create)'],
    ['curl -s https://example.com/api/x', 'Made a web request to example.com'],
    ['sleep 5', 'Waited'],
    // sed's and perl's script is not the file they work on.
    ["sed -i 's/foo/bar/' app.js", 'Edited app.js'],
    ["sed -n '/start/,/end/p' app.js", 'Looked at app.js'],
    ["perl -pi -e 's/a/b/' lib/f.js", 'Edited f.js'],
    // Printing into a file is writing it.
    ["cat > notes.md <<'EOF'\nhello\nEOF", 'Wrote notes.md'],
    ['echo hi > out.txt', 'Wrote out.txt'],
    ['printf x >> log.txt; echo y > b.txt', 'Wrote log.txt and b.txt'],
    // Wrappers in a row all come off.
    ['sudo timeout 5 npm test', 'Ran the tests'],
    ['FOO=1 nice npm test', 'Ran the tests'],
    // A quoted folder with spaces is still git's -C value.
    ['git -C "/path with space" commit -m x', 'Committed changes'],
    // Nothing fits: the command itself, quoted.
    ['jj st', 'Ran `jj st`'],
  ];
  for (const [command, text] of cases) assert.equal(actionLabel(bash(command)), text, command);
});

test('every tool call belongs to one phase of the work', () => {
  const cases = [
    [read('/r/a.js'), 'explore'],
    [{ name: 'Grep', input: { pattern: 'x' } }, 'explore'],
    [{ name: 'Glob', input: { pattern: '*' } }, 'explore'],
    [edit('/r/a.js'), 'change'],
    [{ name: 'Write', input: { file_path: '/r/a.js' } }, 'change'],
    [{ name: 'WebFetch', input: { url: 'https://x.org' } }, 'research'],
    [{ name: 'WebSearch', input: { query: 'x' } }, 'research'],
    [{ name: 'Agent', input: { description: 'x' } }, 'delegate'],
    [{ name: 'Task', input: { description: 'x' } }, 'delegate'],
    [{ name: 'mcp__coordinator__message_ticket', input: {} }, 'coordinate'],
    // Only the Taskmaster's server counts as coordinating; other MCP tools and unknown tools are "other".
    [{ name: 'mcp__thread__set_thread_status', input: {} }, 'other'],
    [{ name: 'Skill', input: { skill: 'x' } }, 'other'],
  ];
  for (const [block, phase] of cases) assert.equal(actionPhase(block), phase, block.name);
});

test("a shell command's phase comes from the command first, then from its description", () => {
  const cases = [
    ['git push', '', 'save'],
    ['gh pr create --fill', '', 'save'],
    // Saving beats the change that comes before it.
    ['git add -A && git commit -m x', '', 'save'],
    ['sed -i s/a/b/ app.js', '', 'change'],
    ['echo hi > notes.txt', '', 'change'],
    ['npm install', '', 'change'],
    ['rm -rf build', '', 'change'],
    // Sending errors to a file is not changing the code.
    ['make 2> err.log', '', 'other'],
    ['npm test', '', 'verify'],
    ['node --test test/', '', 'verify'],
    ['node --check public/app.js', '', 'verify'],
    ['curl -s http://127.0.0.1:8573/', '', 'verify'],
    ['node server.ts', '', 'verify'],
    // Inline code isn't trying out a script.
    ['node -e "console.log(1)"', '', 'other'],
    ['git status', '', 'explore'],
    ['cd repo && git log --oneline', '', 'explore'],
    ['sed -n 1,20p app.js', '', 'explore'],
    // git run on another folder (-C) or with a setting (-c) is still the same git subcommand.
    ['git -C /home/x/repo log --oneline -5', '', 'explore'],
    ['git -C /repo log -5', 'Show recent commits', 'explore'],
    ['git -C /repo commit -m x', '', 'save'],
    ['git -c user.name=x commit -m x', '', 'save'],
    ['git -C /repo add -A', '', 'change'],
    ['git -C "/path with space" commit -m x', '', 'save'],
    ["git -C '/a b' log -5", '', 'explore'],
    ["perl -pi -e 's/a/b/' f.js", '', 'change'],
    ["cat > notes.md <<'EOF'\nhi\nEOF", '', 'change'],
    ['grep -rn foo src | head', '', 'explore'],
    // The command says nothing; the description decides.
    ['jj st', 'Deploy the app', 'save'],
    ['jj st', 'Run the build', 'verify'],
    ['jj st', 'Edit the config', 'change'],
    ['jj st', 'List the bookmarks', 'explore'],
    ['jj st', 'Wait for it', 'other'],
    ['jj st', '', 'other'],
  ];
  for (const [command, description, phase] of cases) assert.equal(actionPhase(bash(command, description)), phase, `${command} / ${description}`);
});

test('the activity line says what the work underway is, naming the file being changed', () => {
  const cases = [
    [edit('/r/public/app.js'), 'Changing app.js'],
    // A shell edit names no file.
    [bash('sed -i s/a/b/ app.js'), 'Making changes'],
    [read('/r/a.js'), 'Looking through the code'],
    [bash('npm test'), 'Trying it out'],
    [bash('git push'), 'Saving the work in git'],
    [{ name: 'WebSearch', input: { query: 'x' } }, 'Looking things up online'],
    [{ name: 'Agent', input: { description: 'x' } }, 'Working with grunts'],
    [{ name: 'mcp__coordinator__message_ticket', input: { ticket_id: 3 } }, 'Updating other minions'],
    [{ name: 'Skill', input: { skill: 'x' } }, 'Running commands'],
  ];
  for (const [block, text] of cases) assert.equal(activityLabel(block), text, block.name);
});

// A session in four phases: look, change two files (one twice), test (once failing), commit.
const session = [
  act(read('/r/src/a.js')),
  act({ name: 'Grep', input: { pattern: 'x' } }),
  act(edit('/r/src/a.js')),
  act(edit('/r/src/b.js')),
  act(edit('/r/src/a.js')),
  failed(bash('npm test')),
  act(bash('npm test')),
  act(bash('git commit -m "x"')),
];

test('back-to-back calls of the same kind merge into one phase, told as done', () => {
  const phases = workPhases(session);
  assert.deepEqual(phases.map((ph) => [ph.phase, ph.text, ph.count, ph.failed, ph.ongoing]), [
    ['explore', 'Looked through the code', 2, 0, false],
    // Each changed file once, in the order first touched.
    ['change', 'Changed a.js, b.js', 3, 0, false],
    ['verify', 'Tried it out and checked it works', 2, 1, false],
    ['save', 'Saved the work in git', 1, 0, false],
  ]);
  assert.equal(phases[2].actions[0], session[5]);
});

test('while the turn runs, only the last phase reads as ongoing', () => {
  const phases = workPhases(session, true);
  assert.deepEqual(phases.map((ph) => [ph.text, ph.ongoing]), [
    ['Looked through the code', false],
    ['Changed a.js, b.js', false],
    ['Tried it out and checked it works', false],
    ['Saving the work in git', true],
  ]);
  // An ongoing change names its files too.
  assert.deepEqual(workPhases(session.slice(0, 4), true).map((ph) => ph.text), ['Looked through the code', 'Changing a.js, b.js']);
});

test('the same kind of work after something else is a new phase', () => {
  const phases = workPhases([act(read('/r/a.js')), act(edit('/r/a.js')), act(read('/r/b.js'))]);
  assert.deepEqual(phases.map((ph) => [ph.phase, ph.count]), [['explore', 1], ['change', 1], ['explore', 1]]);
});

test('a change phase names three files at most, then counts the rest', () => {
  const files = ['a.js', 'b.js', 'c.js', 'd.js', 'e.js'].map((f) => act(edit(`/r/${f}`)));
  assert.equal(workPhases(files)[0].text, 'Changed a.js, b.js, c.js and 2 more');
  assert.equal(workPhases(files.slice(0, 3))[0].text, 'Changed a.js, b.js, c.js');
  // A change by shell command names no file.
  assert.equal(workPhases([act(bash('sed -i s/a/b/ x.js'))])[0].text, 'Made changes');
});

test('no actions, no phases', () => {
  assert.deepEqual(workPhases([]), []);
  assert.deepEqual(workPhases([], true), []);
});

test("a step's tool calls roll up into one line by kind", () => {
  const cases = [
    // Nothing done: no line.
    [[], ''],
    // Changed files listed once each.
    [[act(edit('/r/a.js')), act(edit('/r/b.js')), act(edit('/r/a.js'))], 'Changed a.js, b.js'],
    [[act(bash('ls')), act(bash('ls')), act(bash('ls'))], 'Ran 3 commands'],
    [[act(bash('ls'))], 'Ran 1 command'],
    // Files read are counted once each.
    [[act(read('/r/a.js')), act(read('/r/a.js')), act(read('/r/b.js'))], 'Read 2 files'],
    [[act({ name: 'Grep', input: { pattern: 'x' } })], 'Searched the code once'],
    [[act({ name: 'Grep', input: { pattern: 'x' } }), act({ name: 'Glob', input: { pattern: '*' } })], 'Searched the code 2 times'],
    [[act({ name: 'WebFetch', input: { url: 'https://a.org' } }), act({ name: 'WebSearch', input: { query: 'q' } })], 'Checked 2 web sources'],
    [[act({ name: 'Agent', input: { description: 'x' } })], 'Used 1 grunt'],
    [[act({ name: 'mcp__coordinator__message_ticket', input: {} }), act({ name: 'mcp__coordinator__list_tickets', input: {} })], '2 minion actions'],
    [[act({ name: 'Skill', input: { skill: 'x' } })], '1 other step'],
    // Parts come in a fixed order (changes, commands, reads), whatever order the calls ran in.
    [[act(read('/r/a.js')), act(bash('ls')), act(edit('/r/b.js'))], 'Changed b.js · ran 1 command · read 1 file'],
    // Failures are counted; a call still running (no result yet) has not failed.
    [[failed(bash('npm test')), act(bash('npm test')), act(bash('ls'), null)], 'Ran 3 commands (1 failed)'],
  ];
  for (const [actions, line] of cases) assert.equal(summarizeActions(actions), line, line);
});

test('step counts: how many steps, how many done, and which one is underway', () => {
  // A plan with the given statuses: c(ompleted), i(n progress), p(ending).
  const plan = (statuses) => ({
    ...createProgress(),
    tasks: [...statuses].map((s, n) => ({ id: String(n + 1), subject: `Step ${n + 1}`, status: { c: 'completed', i: 'in_progress', p: 'pending' }[s] })),
  });
  const cases = [
    // No plan.
    ['', { total: 0, done: 0, current: null, step: 0 }],
    // The step underway is numbered from 1.
    ['ippp', { total: 4, done: 0, current: 'Step 1', step: 1 }],
    ['ccip', { total: 4, done: 2, current: 'Step 3', step: 3 }],
    // Between steps, the step is the last one done.
    ['ccpp', { total: 4, done: 2, current: null, step: 2 }],
    ['cccc', { total: 4, done: 4, current: null, step: 4 }],
    // Steps done out of order still count; the step underway is numbered by its place.
    ['cppi', { total: 4, done: 1, current: 'Step 4', step: 4 }],
  ];
  for (const [statuses, want] of cases) {
    const info = stepInfo(plan(statuses));
    assert.deepEqual({ ...info, current: info.current?.subject ?? null }, want, statuses);
  }
});
