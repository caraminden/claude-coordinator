// A role's Set up and Test on its card (Build 7 M4, src/role-setup.ts): the buttons, each step's line as it runs, the
// one administrator command a step needs, and the green tick with its report. The run comes back in the role's
// setup.run on the machines broadcast; a press shows at once, with its request behind (ui/optimistic.js).
/** @import { MachineRole, MachineRow, SetupRun } from './types.js' */
import { account, ago, api, h, openView, pacificStamp } from './base.js';
import { toneChip } from './look.js';
import { runnerAgentLines } from './machine-merge.js';
import { adminCommand, lastRun, SETUP_ROLES } from './role-setup.js';
import { markdownElement } from './ui/markdown.js';
import { optimistic } from './ui/optimistic.js';

/** @type {Record<SetupRun['steps'][number]['state'], string>} */
const MARK = { waiting: '○', running: '', ok: '✓', fail: '✕' };
/** @type {Record<SetupRun['steps'][number]['state'], string>} */
const STATE_WORD = { waiting: 'not run yet', running: 'running', ok: 'passed', fail: 'failed' };
/** @param {string | null} tag @param {string} command */
const shell = (tag, command) => markdownElement(`\`\`\`${tag}\n${command}\n\`\`\``);
/** What Set up does there, in one line, before it is pressed. @type {Record<string, string>} */
const ABOUT = {
  tools: 'Checks each MCP server and folder ticked here answers, and lists their tools.',
  screen: 'Turns screenshots on in its machine-agent.json, then takes a screenshot and opens and closes Notepad.',
  turns: 'Installs the worker (a WSL distro of its own on Windows), then runs its self-test.',
  gpu: 'Checks the GPU, podman and NVIDIA’s container toolkit, turns GPU jobs on, then runs nvidia-smi in a container.',
  ci: 'Shows the one command that installs the CI runner agent (as administrator), waits for it, then tests it. Each scheme ticked here gets its runner by itself when its CI first needs one.',
};

/** The row's token and address for the runner agent's install, by machine id: asked once a Set up shows it. @type {Map<number, { token?: string, url?: string, failed?: string }>} */
const installs = new Map();

/** CI's Set up: the runner agent's install lines with this row's token (one per OS this PC runs CI for), until it connects. @param {MachineRow} m @param {() => void} redraw */
function runnerInstall(m, redraw) {
  const got = installs.get(m.id);
  if (!got) {
    installs.set(m.id, {});
    api(`api/machines/${m.id}/token`)
      .then((/** @type {{ token: string, agent_url: string }} */ r) => installs.set(m.id, { token: r.token, url: r.agent_url }))
      .catch((/** @type {Error} */ err) => installs.set(m.id, { failed: err.message }))
      .finally(redraw);
  }
  if (got?.failed) return h('p', { class: 'cui-notice', 'data-tone': 'danger' }, `Couldn't get the install command: ${got.failed} `, h('button', { type: 'button', class: 'secondary small', onclick: () => (installs.delete(m.id), redraw()) }, 'Try again'));
  if (!got?.token || !got.url) return h('p', { class: 'muted small' }, 'Getting the install command…');
  const linux = m.report?.os === 'linux';
  return h(
    'div',
    { class: 'role-setup-admin' },
    linux ? null : runnerAgentLines(got.url, got.token, ['windows']),
    linux ? null : h('p', { class: 'small' }, 'For Linux jobs too, its runners run in a WSL distro of their own. Make it once, in a normal PowerShell (the CI runner guide\'s "Linux runners in WSL" has the rest):'),
    linux ? null : markdownElement('```powershell\nwsl --install Ubuntu-24.04 --name citadel-ci\n```'),
    runnerAgentLines(got.url, got.token, ['linux']),
  );
}

/** Who presses it: its owner, or an admin on a shared machine (the server's rule). @param {MachineRow} m */
const presses = (m) => (m.owner_id === null ? !!account?.admin : m.owner_id === account?.id);
/** @param {MachineRow} m @returns {MachineRow} */
const current = (m) => /** @type {MachineRow[] | undefined} */ (openView().machines)?.find((x) => x.id === m.id) ?? m;
/** @param {MachineRow} m @param {string} role */
const runOf = (m, role) => lastRun(current(m).roles?.find((r) => r.role === role));

/** @param {MachineRow} m @param {MachineRole} r @param {'setup' | 'test'} kind @param {() => void} redraw */
function press(m, r, kind, redraw) {
  const role = current(m).roles?.find((x) => x.role === r.role);
  const was = role?.setup ?? null;
  /** @param {MachineRole['setup']} setup */
  const set = (setup) => {
    const now = current(m).roles?.find((x) => x.role === r.role);
    if (now) now.setup = setup;
    redraw();
  };
  optimistic({
    key: `role-setup:${m.id}`,
    apply: () => set({ ...(was ?? {}), run: { id: '', role: /** @type {SetupRun['role']} */ (r.role), kind, at: Date.now(), by: account?.name ?? '', done: null, ok: null, why: null, admin: null, worker_install: false, steps: [{ text: 'Starting…', state: 'running' }], report: null, shot: null } }),
    send: () => api(`api/machines/${m.id}/roles/${r.role}/setup`, { method: 'POST', body: { kind } }),
    undo: () => set(was),
    label: `${kind === 'test' ? 'test' : 'set up'} ${r.name} on ${m.name}`,
  });
}

/** @param {SetupRun | null} run */
function chip(run) {
  // Before any run the role's own header chip says where it stands; this part adds only its button and what it does.
  if (!run) return null;
  if (!run.done) return toneChip('info', run.kind === 'test' ? 'Testing…' : 'Setting up…');
  return run.ok ? toneChip('ok', run.kind === 'test' ? '✓ Test passed' : '✓ Set up') : toneChip('danger', run.kind === 'test' ? 'Test failed' : 'Set up failed');
}

/** The administrator command a step needs, built from fixed words only (role-setup.js), with where it runs. */
/** @param {SetupRun} run */
function adminPart(run) {
  const a = adminCommand(run.admin);
  if (!a) return null;
  return h(
    'div',
    { class: 'role-setup-admin' },
    h('p', { class: 'cui-notice', 'data-tone': 'warn' }, h('b', {}, 'Needs an administrator: '), a.what, '. ', a.command ? (a.tag === 'powershell-admin' ? 'On that PC, open PowerShell as administrator and run:' : 'On that PC, in a terminal, run (it asks for your password):') : a.after),
    a.command ? shell(a.tag, a.command) : null,
    a.command ? h('p', { class: 'muted small' }, a.after) : null,
  );
}

/** Set up and Test on a role's card, and its last run; null for a role this release doesn't set up.
 * @param {MachineRow} m
 * @param {MachineRole} r
 * @param {() => void} redraw
 */
export function setupPart(m, r, redraw) {
  if (!SETUP_ROLES.includes(r.role)) return null;
  const run = runOf(m, r.role) ?? lastRun(r);
  const can = presses(m);
  const going = !!run && !run.done;
  const turnsHere = r.role === 'turns' && !!m.worker?.host;
  // Minion turns' own self-test (T5's) is on the card already once its worker is there: Set up is for a PC without one.
  // CI's runner agent is a program of its own: its Set up installs it with the PC's agent off or absent.
  const offline = r.role !== 'turns' && r.role !== 'ci' && !m.online;
  const why = going ? 'Running now' : offline ? `${m.name} is offline` : null;
  /** @param {'setup' | 'test'} kind @param {boolean} primary */
  const button = (kind, primary) =>
    h(
      'button',
      { type: 'button', class: primary ? 'small' : 'secondary small', disabled: !!why, title: why ?? (kind === 'setup' ? ABOUT[r.role] : 'Runs its self-test again; installs nothing'), onclick: () => press(m, r, kind, redraw) },
      going && run.kind === kind ? (kind === 'setup' ? 'Setting up…' : 'Testing…') : kind === 'setup' ? (run?.ok ? 'Set up again' : 'Set up') : 'Test',
    );
  const showSteps = run && (!run.done || !run.ok);
  return h(
    'section',
    { class: 'worker-part role-setup', 'data-role': r.role },
    h('div', { class: 'worker-part-head' }, h('h4', {}, 'Set up and test'), chip(run), can && !turnsHere ? button('setup', !run?.ok) : null, can && run?.ok && r.role !== 'turns' ? button('test', false) : null),
    !run && can ? h('p', { class: 'muted small' }, ABOUT[r.role]) : null,
    !can && !run ? h('p', { class: 'muted small' }, 'Its owner sets it up.') : null,
    // With an administrator command, that block says what to do: the run's own why would only repeat it.
    run?.why && !adminCommand(run.admin) ? h('p', { class: 'cui-notice', 'data-tone': 'danger' }, run.why) : null,
    run ? adminPart(run) : null,
    r.role === 'ci' && can && run && !run.done && run.worker_install ? runnerInstall(m, redraw) : null,
    showSteps
      ? h(
          'ul',
          { class: 'worker-checks' },
          run.steps.map((s) => h('li', { 'data-state': s.state }, h('span', { class: 'worker-check-mark', role: 'img', 'aria-label': STATE_WORD[s.state] }, s.state === 'running' ? h('span', { class: 'cui-spin' }) : MARK[s.state]), h('span', { class: 'worker-check-name' }, s.text))),
        )
      : null,
    run?.ok && run.report ? h('p', { class: 'small' }, run.report) : null,
    run?.shot && r.role === 'screen'
      ? h('a', { href: `api/machines/${m.id}/roles/screen/shot?at=${run.shot}`, target: '_blank', rel: 'noopener', class: 'role-setup-shot', title: 'Open the screenshot full size' }, h('img', { src: `api/machines/${m.id}/roles/screen/shot?at=${run.shot}`, alt: `The screenshot ${m.name}'s test took`, loading: 'lazy' }))
      : null,
    run?.done ? h('p', { class: 'muted small', title: pacificStamp(run.done) }, `${run.kind === 'test' ? 'Tested' : 'Set up'} by ${run.by} ${ago(run.done)}.`) : null,
  );
}
