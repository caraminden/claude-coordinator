// A machine's Minion turns on its row of the Machines page (Build 7 T5): the switch, the one command that makes that PC a
// worker, its caps, the owner's sign-ins there and the self-test. Citadel changes nothing on that PC: every change is a
// command its owner runs.
import { account, ago, api, h, view } from './base.js';
import { statTiles, toneChip } from './look.js';
import { machineSetupWorkerLinux, machineSetupWorkerWindows, WORKER_CAPS, WORKER_CHECKS, workerCapsCommand, workerCommand } from './machine-setup.js';
import { markdownElement } from './ui/markdown.js';
import { optimistic } from './ui/optimistic.js';
import { failedLine, loadingLine } from './ui/state.js';

/** What the page holds for a row between redraws, by machine id: its token and address, the picked OS, caps being typed, open blocks. */
const kept = new Map();
const keptFor = (id) => kept.get(id) ?? kept.set(id, { link: null, asking: false, error: null, os: null, caps: null, open: new Set() }).get(id);

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
  if (!w.here && !w.host) return { tone: 'info', word: 'Not set up yet', why: 'Run the command below once on that PC.' };
  if (!w.here) return { tone: 'warn', word: 'Away', why: `Last heard from ${w.seen ? ago(w.seen) : 'some time ago'}. ${w.wsl ? 'Signing out of Windows stops it until its owner signs in again.' : 'It is off, or off the network.'}` };
  if (w.image?.state === 'failed') return { tone: 'danger', word: 'Image failed', why: `${w.image.text} It tries again in 10 minutes.` };
  if (w.image?.state === 'building') return { tone: 'info', word: 'Building its image', why: w.image.text };
  if (w.full) return { tone: 'warn', word: 'Disk cap reached', why: `It uses ${w.disk_gb} of ${w.caps?.disk_gb} GB, so no new turn starts there.` };
  if (!w.image) return { tone: 'info', word: 'Connecting', why: 'It is connected and is checking its image.' };
  if (w.claude_wanted) return { tone: 'warn', word: 'Wrong Claude version', why: `Its Claude is ${w.claude} and this server's is ${w.claude_wanted}. ${w.image.state === 'own' ? "Its image is its owner's own: update it there." : 'It updates itself.'}` };
  if (w.signed_in === false) return { tone: 'warn', word: 'Needs a Claude sign-in', why: 'No turn starts there until its owner signs in.' };
  if (w.test && w.test.done && !w.test.ok) return { tone: 'danger', word: 'Self-test failed', why: w.test.why ?? 'The checks below say what is wrong.' };
  if (w.signed_in === null) return { tone: 'info', word: 'Connecting', why: 'It is checking its sign-ins.' };
  if (!m.projects.length) return { tone: 'warn', word: 'Lent to no scheme', why: 'Pick the schemes whose minions may run there under "Who gets it".' };
  if (!w.passed) return { tone: 'info', word: 'Not tested yet', why: 'Run the self-test once.' };
  return { tone: 'ok', word: 'Ready', why: `Its owner's minions run there, up to ${w.caps?.workers ?? '?'} at once.` };
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

/** Four numbers its owner sets; the command below follows them as they are typed. */
function capsInputs(m, k, follow) {
  const set = k.caps ?? m.worker.caps ?? WORKER_CAPS;
  const field = (key, label, unit, max) => {
    const input = h('input', { type: 'text', inputmode: 'numeric', id: `worker-cap-${m.id}-${key}`, value: String(set[key]), maxlength: String(max).length, 'aria-label': `${label}${unit ? ` (${unit})` : ''}` });
    input.oninput = () => {
      const n = /^[1-9]\d*$/.test(input.value.trim()) ? Math.min(max, Number(input.value)) : null;
      input.setAttribute('aria-invalid', String(n === null));
      // Half-typed: the command keeps its last whole number.
      if (n === null) return;
      k.caps = { ...(k.caps ?? m.worker.caps ?? WORKER_CAPS), [key]: n };
      follow();
    };
    return h('label', { class: 'worker-cap' }, h('span', {}, label), h('span', { class: 'worker-cap-box' }, input, unit ? h('i', {}, unit) : null));
  };
  return h('div', { class: 'worker-caps' }, field('workers', 'Minions at once', '', 64), field('threads', 'CPU threads', '', 1024), field('memory_gb', 'Memory', 'GB', 4096), field('disk_gb', 'Disk', 'GB', 99999));
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
    const caps = k.caps ?? m.worker.caps ?? WORKER_CAPS;
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
      'Needs about 20 GB of disk to begin with',
      win ? ' and WSL 2. Signing out of Windows stops it. ' : '. ',
      h('b', {}, "The command holds this machine's token: don't share or screenshot it."),
    ),
  );
}

/** Changing caps on a worker that is set up: the numbers, and the command that makes them so there. */
function capsBlock(m, k) {
  const box = h('div', { class: 'worker-command' });
  const draw = () => {
    const caps = k.caps ?? m.worker.caps;
    const same = !caps || Object.keys(WORKER_CAPS).every((key) => caps[key] === m.worker.caps?.[key]);
    box.replaceChildren(same ? h('p', { class: 'muted small' }, 'These are its caps now. Change a number to get the command that sets it there.') : shell(m.worker.wsl ? 'powershell' : 'bash', workerCapsCommand(m.worker.wsl, caps)));
  };
  draw();
  return h('div', {}, capsInputs(m, k, draw), box);
}

function signIns(m, k) {
  const w = m.worker;
  const win = w.wsl;
  const tag = win ? 'powershell' : 'bash';
  const chip = (name, is) => toneChip(is ? 'ok' : is === false ? 'warn' : 'neutral', `${name}: ${is ? 'signed in' : is === false ? 'not signed in' : 'checking'}`);
  const steps = [
    ['Claude', w.signed_in, 'signin', 'Claude Code opens its own sign-in. Type /exit once it says you are in.'],
    ['GitHub', w.github, 'signin-github', 'So turns can push and open pull requests as you.'],
  ];
  const how = ([name, , verb, note]) => h('div', { class: 'worker-sign' }, h('p', { class: 'small' }, h('b', {}, name), ' ', note), shell(tag, workerCommand(win, verb)));
  const todo = steps.filter(([, is]) => is === false);
  const done = steps.filter(([, is]) => is !== false);
  return h(
    'section',
    { class: 'worker-part' },
    h('div', { class: 'worker-part-head' }, h('h4', {}, 'Sign-ins there'), chip('Claude', w.signed_in), chip('GitHub', w.github)),
    w.image?.state === 'building' && todo.length ? h('p', { class: 'muted small' }, 'These work once its image is built.') : null,
    todo.length ? h('p', { class: 'small' }, `In ${win ? 'PowerShell' : 'a terminal'} on that PC:`) : null,
    ...todo.map(how),
    h('p', { class: 'muted small' }, 'You sign in on that PC yourself. Citadel sees only whether a sign-in is there.'),
    done.length ? folded(k, 'sign', todo.length ? 'Sign in again' : 'Sign in as someone else, or again', ...done.map(how)) : null,
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
      h('button', { type: 'button', class: test ? 'secondary small' : 'small', disabled: !!why, title: why ?? 'Takes about a minute; running turns go on', onclick: run }, running ? 'Running…' : test ? 'Test again' : 'Run the self-test'),
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
    w.passed ? h('p', { class: 'muted small', title: new Date(w.passed).toLocaleString(undefined, { timeZone: 'America/Los_Angeles', timeZoneName: 'short' }) }, `Last passed whole ${ago(w.passed)}.`) : null,
  );
}

/** The Minion turns part of an opened row. */
export function workerSection(m, redraw) {
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
  if (!w.on) return h('div', { class: 'worker', 'data-tone': 'neutral' }, head);
  const owner = mine(m);
  const caps = w.caps;
  return h(
    'div',
    { class: 'worker', 'data-tone': st.tone },
    head,
    w.here && caps
      ? statTiles([caps.workers, 'minions at once', 'running'], [caps.threads, 'CPU threads', 'running'], [`${caps.memory_gb} GB`, 'memory', 'running'], [`${w.disk_gb === null ? caps.disk_gb : Math.round(w.disk_gb)} GB`, w.disk_gb === null ? 'disk' : `disk of ${caps.disk_gb}`, w.full ? 'waiting' : 'running'])
      : null,
    owner ? null : h('p', { class: 'muted small' }, 'Its owner sets it up, signs in and changes its caps on that PC.'),
    owner && !w.host ? h('section', { class: 'worker-part' }, h('div', { class: 'worker-part-head' }, h('h4', {}, 'Run once on that PC')), installBlock(m, k, redraw)) : null,
    owner && w.here ? signIns(m, k) : null,
    w.host ? selfTest(m, redraw) : null,
    owner && w.host ? folded(k, 'caps', 'Change its caps', capsBlock(m, k)) : null,
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
