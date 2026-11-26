// A machine's Minion turns on its row of the Machines page (Build 7 T5): the switch, the one command that makes that PC a
// worker, its caps, the owner's sign-ins there and the self-test. Citadel changes nothing on that PC: every change is a
// command its owner runs.
import { account, ago, api, h, pacificStamp, view } from './base.js';
import { statTiles, toneChip } from './look.js';
import { machineSetupWorkerLinux, machineSetupWorkerWindows, WORKER_CAPS, WORKER_CHECKS, workerCapsCommand, workerCommand, WORKER_LIMITS } from './machine-setup.js';
import { markdownElement } from './ui/markdown.js';
import { optimistic } from './ui/optimistic.js';
import { failedLine, loadingLine } from './ui/state.js';

/** What the page holds for a row between redraws, by machine id: its token and address, the picked OS, caps being typed, open blocks. */
const kept = new Map();
const keptFor = (id) => kept.get(id) ?? kept.set(id, { link: null, asking: false, error: null, os: null, caps: null, open: new Set(), folder: { name: '', path: '', write: false } }).get(id);

/** Its token was replaced: the command is made again with the new one. */
export function forgetWorkerLink(id) {
  const k = kept.get(id);
  if (k) k.link = k.error = null;
}

const windows = (m) => (m.worker.host ? m.worker.wsl : (keptFor(m.id).os ?? (/^linux/i.test(navigator.userAgentData?.platform ?? navigator.platform) && !/android/i.test(navigator.userAgent) ? 'linux' : 'windows')) === 'windows');
const mine = (m) => m.owner_id !== null && m.owner_id === account?.id;

/** How a worker stands, in a word or two and a line: the most pressing thing first. */
export function workerState(m) {
  const w = m.worker;
  if (!w.on) return { tone: 'neutral', word: 'Off', why: w.here ? 'It is set up and connected, and takes no turns while this is off.' : mine(m) ? 'Let your own minions run on this PC.' : 'Its owner can let their own minions run on it.' };
  if (!w.here && !w.host) return { tone: 'info', word: 'Not set up yet', why: 'Nothing runs there until that PC is set up: its row follows it from then on.' };
  if (!w.here) return { tone: 'warn', word: 'Away', why: `Last heard from ${w.seen ? ago(w.seen) : 'some time ago'}. ${w.wsl ? 'Signing out of Windows stops it: sign in there, and it comes back by itself.' : 'Turn that PC on; if it is on, "sudo citadel-worker status" there says why.'}` };
  if (w.twice) return { tone: 'warn', word: 'Two workers', why: "This PC's Citadel agent has a worker block in its config too, and is refused: take that block out. Its minion turns run in citadel-worker." };
  if (w.image?.state === 'failed') return { tone: 'danger', word: 'Image failed', why: `${w.image.text} It tries again in 10 minutes.` };
  if (w.image?.state === 'building') return { tone: 'info', word: 'Building its image', why: w.image.text };
  if (w.full) return { tone: 'warn', word: 'Disk cap reached', why: `It uses ${w.disk_gb} of ${w.caps?.disk_gb} GB, so no new turn starts there.` };
  if (!w.image) return { tone: 'info', word: 'Connecting', why: 'It is connected and is checking its image.' };
  if (w.claude_wanted) return { tone: 'warn', word: 'Wrong Claude version', why: `Its Claude is ${w.claude} and this server's is ${w.claude_wanted}. ${w.image.state === 'own' ? "Its image is its owner's own: update it there." : 'It updates itself.'}` };
  if (w.signed_in === false || (w.accounts?.length && !w.accounts.some((a) => a.there === 'in'))) return { tone: 'warn', word: 'Needs a Claude sign-in', why: 'No turn starts there until its owner signs in with one of their linked Claude accounts.' };
  if (w.test && w.test.done && !w.test.ok) return { tone: 'danger', word: 'Self-test failed', why: `No turn starts there until it passes. ${w.test.why ?? 'The checks below say what is wrong.'}` };
  if (w.signed_in === null) return { tone: 'info', word: 'Connecting', why: 'It is checking its sign-ins.' };
  if (!(m.roles?.find((r) => r.role === 'turns')?.projects ?? m.projects).length) return { tone: 'warn', word: 'Lent to no scheme', why: 'Pick the schemes whose minions may run there on its Minion turns card.' };
  if (!w.passed) return { tone: 'info', word: 'Not tested yet', why: mine(m) ? 'No turn starts there until its self-test passes: run it below.' : 'No turn starts there until its owner runs its self-test.' };
  return { tone: 'ok', word: 'Ready', why: `Its owner's minions run there, up to ${heldCaps(m)?.workers ?? '?'} at once.` };
}

/** The worker is all that computer runs: no agent of Citadel's was ever connected from it. */
const only = (m) => !m.online && !m.last_seen_at && m.worker?.on;

/** A worker-only row's state word and hue while its worker isn't ready; null leaves the row's own. */
export function workerWord(m) {
  if (!only(m) || m.status !== 'ready') return null;
  const { tone } = workerState(m);
  return { info: ['Setting up', 'running'], warn: ['Needs a fix', 'waiting'], danger: ['Needs a fix', 'danger'] }[tone] ?? null;
}

/** A row's reason with its Minion turns in it; they stand for it where the worker is all that computer runs. */
export function workerReason(m) {
  if (!m.worker?.on) return m.reason;
  const { word } = workerState(m);
  const turns = `Minion turns: ${word[0].toLowerCase()}${word.slice(1)}`;
  return only(m) || word === m.reason || m.reason === 'Runs minion turns' ? turns : `${m.reason} · ${turns}`;
}

/** A change to the row's worker, shown at once, with its request behind. */
function change(m, fields, send, label, redraw) {
  const now = () => (view.machines?.find((x) => x.id === m.id) ?? m).worker;
  const was = Object.fromEntries(Object.keys(fields).map((k) => [k, now()[k]]));
  const set = (vals) => {
    Object.assign(now(), vals);
    redraw();
  };
  optimistic({ key: `machine-worker:${m.id}`, apply: () => set(fields), send, undo: () => set(was), label });
}

function workerSwitch(m, redraw) {
  const { on } = m.worker;
  const shared = m.owner_id === null;
  const why = on ? null : shared ? 'Shared machines run no minions' : mine(m) ? null : 'Only its owner can switch this on';
  const flip = () => change(m, { on: !on }, () => api(`api/machines/${m.id}`, { method: 'PATCH', body: { worker: !on } }), `switch Minion turns ${on ? 'off' : 'on'} for ${m.name}`, redraw);
  return h('button', {
    type: 'button',
    class: 'rules-switch',
    role: 'switch',
    id: `worker-switch-${m.id}`,
    'aria-checked': String(on),
    'aria-label': `Minion turns on ${m.name}`,
    disabled: !!why,
    title: why ?? (on ? 'Start no more minions there; the ones running finish' : "Let its owner's minions run there"),
    onclick: flip,
  });
}

const shell = (tag, command) => markdownElement(`\`\`\`${tag}\n${command}\n\`\`\``);

/** A block that opens and closes, and stays as it was over a redraw. */
function folded(k, id, title, ...inside) {
  const el = h('details', { class: 'worker-fold', open: k.open.has(id) }, h('summary', {}, title), ...inside);
  el.addEventListener('toggle', () => k.open[el.open ? 'add' : 'delete'](id));
  return el;
}

/** The caps being typed, until that PC's own change under them; else its own, or the starting ones. */
const capsFor = (m, k) => (k.caps && k.capsOver === JSON.stringify(m.worker.caps) ? k.caps : (m.worker.caps ?? WORKER_CAPS));

/** Four numbers its owner sets; the command below follows them as they are typed. */
function capsInputs(m, k, follow) {
  const set = capsFor(m, k);
  const field = (key, label, unit) => {
    const [min, max] = WORKER_LIMITS[key];
    const input = h('input', { type: 'text', inputmode: 'numeric', id: `worker-cap-${m.id}-${key}`, value: String(set[key]), maxlength: String(max).length, title: `${min} to ${max}${unit ? ` ${unit}` : ''}`, 'aria-label': `${label}${unit ? ` (${unit})` : ''}` });
    input.oninput = () => {
      const n = /^[1-9]\d*$/.test(input.value.trim()) && Number(input.value) >= min && Number(input.value) <= max ? Number(input.value) : null;
      input.setAttribute('aria-invalid', String(n === null));
      // Half-typed, or out of bounds: the command keeps the last number that was neither.
      if (n === null) return;
      k.caps = { ...capsFor(m, k), [key]: n };
      k.capsOver = JSON.stringify(m.worker.caps);
      follow();
    };
    return h('label', { class: 'worker-cap' }, h('span', {}, label), h('span', { class: 'worker-cap-box' }, input, unit ? h('i', {}, unit) : null));
  };
  return h('div', { class: 'worker-caps' }, field('workers', 'Minions at once', ''), field('threads', 'CPU threads', ''), field('memory_gb', 'Memory', 'GB'), field('disk_gb', 'Disk', 'GB'));
}

/** The install command with this PC's own values. Its token is asked for once, when the block is first seen. */
function installBlock(m, k, redraw) {
  if (!m.token_showable) return h('p', { class: 'cui-notice', 'data-tone': 'info' }, 'This machine was linked before Citadel kept tokens, so the command can\'t be filled in. Press "New token" below once; then it shows here. Whatever is connected with the old token has to be installed again.');
  if (k.error) return failedLine(`Couldn't get this machine's token: ${k.error}`, { retry: () => ((k.error = null), redraw()) });
  if (!k.link) {
    if (!k.asking) {
      k.asking = true;
      api(`api/machines/${m.id}/token`)
        .then(
          (got) => (k.link = got),
          (err) => (k.error = err.message),
        )
        .finally(() => {
          k.asking = false;
          redraw();
        });
    }
    return loadingLine('Filling in the command…');
  }
  const win = windows(m);
  const box = h('div', { class: 'worker-command' });
  const draw = () => {
    const caps = capsFor(m, k);
    box.replaceChildren(shell(win ? 'powershell' : 'bash', (win ? machineSetupWorkerWindows : machineSetupWorkerLinux)(k.link.agent_url, k.link.token, caps)));
  };
  draw();
  const tab = (os, label) => h('button', { type: 'button', class: `chip${(os === 'windows') === win ? ' on' : ''}`, 'aria-pressed': String((os === 'windows') === win), onclick: () => ((k.os = os), redraw()) }, label);
  return h(
    'div',
    { class: 'worker-install' },
    m.worker.host ? null : h('div', { class: 'row worker-os', role: 'group', 'aria-label': 'That PC runs' }, tab('windows', 'Windows'), tab('linux', 'Linux')),
    capsInputs(m, k, draw),
    h('p', { class: 'small' }, win ? 'On that PC, open PowerShell as yourself (not as administrator) and run:' : 'On that PC, open a terminal and run (it asks for your password):'),
    box,
    h(
      'p',
      { class: 'muted small' },
      win ? 'It makes a Linux distro of its own, citadel-workers, with no reach into Windows, and starts with your logon. ' : 'It makes a user of its own, citadel-worker, and starts at boot. ',
      'It keeps its own program and its image current from this Citadel. Needs about 20 GB of disk to begin with',
      win ? ' and WSL 2. Signing out of Windows stops it. ' : '. ',
      h('b', {}, "The command holds this machine's token: don't share or screenshot it."),
    ),
  );
}

/** Changing caps on a worker that is set up: the numbers, and the command that makes them so there. */
function capsBlock(m, k) {
  const box = h('div', { class: 'worker-command' });
  const draw = () => {
    const caps = capsFor(m, k);
    const same = Object.keys(WORKER_CAPS).every((key) => caps[key] === m.worker.caps?.[key]);
    box.replaceChildren(same ? h('p', { class: 'muted small' }, 'These are its caps now. Change a number to get the command that sets it there.') : shell(m.worker.wsl ? 'powershell' : 'bash', workerCapsCommand(m.worker.wsl, caps)));
  };
  draw();
  return h('div', {}, capsInputs(m, k, draw), box);
}

function signIns(m, k) {
  const w = m.worker;
  const win = w.wsl;
  const tag = win ? 'powershell' : 'bash';
  const chip = (name, is, word) => toneChip(is ? 'ok' : is === false ? 'warn' : 'neutral', `${name}: ${word ?? (is ? 'signed in' : is === false ? 'not signed in' : 'checking')}`);
  const claudeNote = 'Claude Code opens its own sign-in. Type /exit once it says you are in.';
  // Linked accounts (#2061): each signs in there into its own folder, and a turn runs only on one signed in there. One account
  // keeps the single Claude step, unless it is signed in there to another organization: that says which and why.
  const one = w.accounts?.length === 1 ? w.accounts[0] : null;
  const several = (w.accounts?.length ?? 0) > 1 || one?.there === 'other';
  const scheme = location.hash.match(/^#\/p\/(\d+)/)?.[1];
  const yours = () => (scheme ? h('a', { href: `#/p/${scheme}/account` }, 'Settings → Your account') : 'Settings → Your account');
  const claude = several
    ? w.accounts.map((a) => [
        `Claude account ${a.n}`,
        a.there === 'in',
        `signin ${a.n}`,
        a.there === 'other' ? [`This PC is signed in to a different Claude organization than your account ${a.n} in Citadel: sign in again and pick that account's organization.`] : ['Sign in with the account that ', yours(), ` lists as account ${a.n}.`],
        a.there === 'other' ? 'other organization' : undefined,
      ])
    : [['Claude', one ? one.there === 'in' : w.signed_in, 'signin', [claudeNote]]];
  const steps = [...claude, ['GitHub', w.github, 'signin-github', ['So turns can push and open pull requests as you.']]];
  const how = ([name, , verb, note]) => h('div', { class: 'worker-sign' }, h('p', { class: 'small' }, h('b', {}, `${name}:`), ' ', ...note), shell(tag, workerCommand(win, verb)));
  const todo = steps.filter(([, is]) => is === false);
  const done = steps.filter(([, is]) => is !== false);
  return h(
    'section',
    { class: 'worker-part' },
    h('div', { class: 'worker-part-head' }, h('h4', {}, 'Sign-ins there'), ...steps.map(([name, is, , , word]) => chip(name, is, word))),
    w.image?.state === 'building' && todo.length ? h('p', { class: 'muted small' }, 'These work once its image is built.') : null,
    todo.length ? h('p', { class: 'small' }, `In ${win ? 'PowerShell' : 'a terminal'} on that PC:`, several && todo.some(([name]) => name !== 'GitHub') ? ` ${claudeNote}` : '') : null,
    ...todo.map(how),
    h('p', { class: 'muted small' }, several ? "You sign in on that PC yourself. Citadel sees only whether a sign-in is there, and its organization's id. A turn there runs on one of your accounts signed in there." : 'You sign in on that PC yourself. Citadel sees only whether a sign-in is there.'),
    done.length ? folded(k, 'sign', 'Sign in again', ...done.map(how)) : null,
  );
}

const MARK = { waiting: '○', running: '', ok: '✓', fail: '✕' };
const STATE_WORD = { waiting: 'not run yet', running: 'running', ok: 'passed', fail: 'failed' };

function selfTest(m, redraw) {
  const w = m.worker;
  const blank = Object.entries(WORKER_CHECKS).map(([key, name]) => ({ key, name, state: 'waiting', text: '' }));
  const test = w.test;
  const running = !!test && !test.done;
  const building = w.image?.state === 'building';
  const why = !w.here ? "Its worker isn't connected" : building ? 'Once its image is built' : running ? 'Running now' : null;
  const run = () => change(m, { test: { id: '', at: Date.now(), done: null, ok: false, why: null, lines: blank } }, () => api(`api/machines/${m.id}/self-test`, { method: 'POST' }), `run ${m.name}'s self-test`, redraw);
  const lines = test?.lines ?? blank;
  const passed = lines.filter((l) => l.state === 'ok').length;
  return h(
    'section',
    { class: 'worker-part' },
    h(
      'div',
      { class: 'worker-part-head' },
      h('h4', {}, 'Self-test'),
      test ? toneChip(running ? 'info' : test.ok ? 'ok' : 'danger', running ? `${passed} of ${lines.length}` : test.ok ? 'All passed' : `${lines.length - passed} of ${lines.length} failed`) : toneChip('neutral', 'Not run yet'),
      mine(m) && h('button', { type: 'button', class: test ? 'secondary small' : 'small', disabled: !!why, title: why ?? 'Takes about a minute; running turns go on', onclick: run }, running ? 'Running…' : test ? 'Test again' : 'Run the self-test'),
    ),
    test?.why ? h('p', { class: 'cui-notice', 'data-tone': 'danger' }, test.why) : null,
    h(
      'ul',
      { class: 'worker-checks' },
      lines.map((l) =>
        h(
          'li',
          { 'data-state': l.state },
          h('span', { class: 'worker-check-mark', role: 'img', 'aria-label': STATE_WORD[l.state] }, l.state === 'running' ? h('span', { class: 'cui-spin' }) : MARK[l.state]),
          h('span', { class: 'worker-check-name' }, l.name),
          l.text ? h('span', { class: 'worker-check-text' }, l.text) : null,
        ),
      ),
    ),
    w.passed ? h('p', { class: 'muted small', title: pacificStamp(w.passed) }, `Last passed whole ${ago(w.passed)}.`) : null,
  );
}

// ---------- What marked minions reach on that PC (Build 7 T8, src/host-reach.ts) ----------

/** One argument for that PC's shell, quoted. */
const quoted = (win, text) => (win ? `'${text.replaceAll("'", "''")}'` : `'${text.replaceAll("'", "'\\''")}'`);
const FOLDER_NAME = /^[a-z0-9][a-z0-9_-]{0,39}$/;

/** The folders its owner lets marked minions use, from the worker's own config there, and the command that changes them. */
function hostFolders(m, k) {
  const w = m.worker;
  const win = w.wsl;
  const tag = win ? 'powershell' : 'bash';
  const list = w.folders ?? [];
  const ask = k.folder;
  const box = h('div', { class: 'worker-command' });
  const draw = () => {
    const name = ask.name.trim();
    const path = ask.path.trim();
    box.replaceChildren(FOLDER_NAME.test(name) && path ? shell(tag, workerCommand(win, `folder add ${name} ${quoted(win, path)}${ask.write ? ' --write' : ''}`)) : h('p', { class: 'muted small' }, "Type a short name (a-z, 0-9, - and _) and the folder's full path to get the command that adds it."));
  };
  const field = (key, label, place) => {
    const input = h('input', { type: 'text', value: ask[key], placeholder: place, 'aria-label': label, spellcheck: 'false', autocomplete: 'off' });
    input.oninput = () => {
      ask[key] = input.value;
      if (key === 'name') input.setAttribute('aria-invalid', String(!!input.value.trim() && !FOLDER_NAME.test(input.value.trim())));
      draw();
    };
    return h('label', { class: 'worker-cap' }, h('span', {}, label), input);
  };
  const write = h('input', { type: 'checkbox', checked: ask.write });
  write.onchange = () => {
    ask.write = write.checked;
    draw();
  };
  draw();
  return h(
    'section',
    { class: 'worker-part' },
    h('div', { class: 'worker-part-head' }, h('h4', {}, 'Folders minions may use')),
    h('p', { class: 'muted small' }, `Only a minion marked to run on ${m.name}, on its owner's turn, sees these, at /host/<name>. Every other turn there sees none.`),
    w.folders === null
      ? h('p', { class: 'muted small' }, 'Shown once that PC is back.')
      : list.length
        ? h('ul', { class: 'worker-reach' }, ...list.map((f) => h('li', {}, h('code', {}, `/host/${f.name}`), h('span', { class: 'worker-reach-path' }, f.path), toneChip(f.write ? 'warn' : 'neutral', f.write ? 'read-write' : 'read-only'), f.ready ? null : toneChip('warn', 'not mounted'))))
        : h('p', { class: 'muted small' }, 'None yet.'),
    ...(w.folder_problems ?? []).map((p) => h('p', { class: 'cui-notice', 'data-tone': 'danger' }, p)),
    h('p', { class: 'small worker-reach-warn' }, h('b', {}, "Citadel can't roll these folders back."), ' What a minion changes or deletes there stays changed. Keep a backup of anything in them you care about, and give write access only where you need it.'),
    mine(m)
      ? folded(
          k,
          'folders',
          'Add or remove a folder',
          h(
            'div',
            { class: 'worker-install' },
            h('div', { class: 'worker-caps worker-folder-ask' }, field('name', 'Name', 'docs'), field('path', 'Path on that PC', win ? 'C:\\Users\\you\\Documents' : '/home/you/docs')),
            h('label', { class: 'small worker-folder-write' }, write, 'Minions may write there (read-only otherwise)'),
            h('p', { class: 'small' }, `In ${win ? 'PowerShell' : 'a terminal'} on that PC:`),
            box,
            ...list.map((f) => h('div', { class: 'worker-sign' }, h('p', { class: 'small' }, `To remove ${f.name}:`), shell(tag, workerCommand(win, `folder remove ${f.name}`)))),
          ),
        )
      : null,
  );
}

const PROGRAMS_EXAMPLE = `"programs": {
  "notepad": {
    "path": "C:\\\\Windows\\\\notepad.exe",
    "about": "Notepad",
    "args": true
  }
}`;

/** The programs its owner lets marked minions start (run_on_host), from that PC's agent config, and how to change them. */
function hostPrograms(m, k) {
  const list = m.programs;
  return h(
    'section',
    { class: 'worker-part' },
    h('div', { class: 'worker-part-head' }, h('h4', {}, 'Programs minions may start')),
    list === null || list === undefined
      ? h('p', { class: 'muted small' }, m.online ? "Its agent doesn't list programs yet: update it with the install command on that machine." : "Shown while that PC's agent is connected.")
      : list.length
        ? h('ul', { class: 'worker-reach' }, ...list.map((p) => h('li', {}, h('code', {}, p.name), h('span', { class: 'worker-reach-path' }, p.path), p.args ? toneChip('neutral', 'takes arguments') : null, p.about ? h('span', { class: 'muted small' }, p.about) : null)))
        : h('p', { class: 'muted small' }, 'None yet.'),
    mine(m) && list
      ? folded(
          k,
          'programs',
          'Change the programs',
          m.config_file
            ? h(
                'div',
                { class: 'worker-install' },
                h('p', { class: 'small' }, 'In PowerShell on that PC, open its agent config, add a "programs" block like this one and save; the agent picks it up within seconds:'),
                shell('powershell', `notepad ${quoted(true, m.config_file)}`),
                markdownElement(`\`\`\`json\n${PROGRAMS_EXAMPLE}\n\`\`\``),
                h('p', { class: 'muted small' }, 'A minion starts one by its name, with arguments only where "args" is true. The agent starts nothing that is not on this list, and nothing at all while a folder minions may write to holds the agent, its config or that program.'),
              )
            : h('p', { class: 'muted small' }, 'Its agent runs without a config file. Install it again with one (the install command on that machine) to list programs.'),
        )
      : null,
  );
}

/** Its caps as the worker holds them: that PC's own, lowered by any its owner set on the Machines page (Build 7 M3). */
export function heldCaps(m) {
  const own = m.worker?.caps ?? null;
  const page = m.roles?.find((r) => r.role === 'turns')?.caps ?? {};
  const keys = ['workers', 'threads', 'memory_gb', 'disk_gb'];
  if (!own && !keys.some((k) => page[k] != null)) return null;
  return Object.fromEntries(keys.map((k) => [k, Math.min(own?.[k] ?? Infinity, page[k] ?? Infinity)]).map(([k, v]) => [k, v === Infinity ? null : v]));
}

/** The Minion turns part of an opened row; inside its role card (`bare`), without its own switch and border. */
export function workerSection(m, redraw, { bare = false } = {}) {
  const w = m.worker;
  const k = keptFor(m.id);
  const st = workerState(m);
  const head = h(
    'div',
    { class: 'worker-head' },
    workerSwitch(m, redraw),
    h(
      'div',
      { class: 'worker-head-text' },
      h('span', { class: 'worker-head-line' }, h('b', {}, 'Minion turns'), w.on ? toneChip(st.tone, st.word) : null),
      h('span', { class: 'muted small' }, m.owner_id === null && !w.on ? 'A machine runs only its owner\'s minions, and this one is shared. To use that PC, add it again with "Mine" ticked and switch it on in that row.' : st.why),
    ),
  );
  if (!w.on) return bare ? h('div', { class: 'worker worker-bare' }) : h('div', { class: 'worker', 'data-tone': 'neutral' }, head);
  const owner = mine(m);
  const caps = heldCaps(m);
  return h(
    'div',
    { class: `worker${bare ? ' worker-bare' : ''}`, 'data-tone': st.tone },
    bare ? h('span', { class: 'muted small' }, st.why) : head,
    w.here && caps && w.caps
      ? statTiles([caps.workers, 'minions at once', 'running'], [caps.threads, 'CPU threads', 'running'], [`${caps.memory_gb} GB`, 'memory', 'running'], [`${w.disk_gb === null ? caps.disk_gb : Math.round(w.disk_gb)} GB`, w.disk_gb === null ? 'disk' : `disk of ${caps.disk_gb}`, w.full ? 'waiting' : 'running'])
      : null,
    owner ? null : h('p', { class: 'muted small' }, 'Its owner sets it up, signs in and sets its caps.'),
    owner && !w.host ? h('section', { class: 'worker-part' }, h('div', { class: 'worker-part-head' }, h('h4', {}, 'Run once on that PC')), installBlock(m, k, redraw)) : null,
    owner && w.here ? signIns(m, k) : null,
    w.host ? hostFolders(m, k) : null,
    w.host && w.wsl ? hostPrograms(m, k) : null,
    w.host ? selfTest(m, redraw) : null,
    owner && w.host ? folded(k, 'caps', bare ? "Change that PC's own caps (the most the page can give it)" : 'Change its caps', capsBlock(m, k)) : null,
    // Closed until asked for: its command shows the token, and fetches it only then.
    owner && w.host ? again(m, k, redraw) : null,
  );
}

/** The install command again, for an update or a new token, once the block is opened. */
function again(m, k, redraw) {
  const el = folded(k, 'again', 'Show the install command again', k.open.has('again') ? installBlock(m, k, redraw) : null);
  el.addEventListener('toggle', () => el.open && el.childElementCount === 1 && redraw());
  return el;
}
