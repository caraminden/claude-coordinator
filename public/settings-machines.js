// The Machines settings page (split out of settings.js; take B since Build 10 H3): one card per computer you own (machine-card.js),
// the Connect a computer wizard, a New token's install lines, and each card's details and lending.
import { account, ago, api, h, icon, view } from './base.js';
import { agentLog, machineSetupPosix, machineSetupRunnerAgent, machineSetupRunnerAgentLinux, machineSetupWindows } from './machine-setup.js';
import { machineJobsSection } from './jobs.js';
import { connectWizardRedraw, openConnectPanel, openConnectWizard, reportLine } from './machine-connect.js';
import { isMine, lentLine, machineCard, ownerName } from './machine-card.js';
import { removing, renderRemovals, sendRemoval } from './machine-remove.js';
import { pauseButton } from './machine-role-cards.js';
import { forgetWorkerLink, workerReason } from './machine-worker-row.js';
import { emptyCard, toneChip } from './look.js';
import { settingsHelp, settingsTabs, settingsTitle } from './settings.js';
import { copyText, markdownElement } from './ui/markdown.js';
import { optimistic } from './ui/optimistic.js';
import { toast } from './ui/status.js';

// ---------- machines ----------

export function onMachinesUpdate(machines) {
  if (view?.kind !== 'project') return;
  view.machines = machines;
  renderMachineList();
}

/** A machine's status line as the server words it (#437): "Asleep · seen 3h ago". */
function machineStatusText(m) {
  const reason = `${workerReason(m)}${m.lend?.gpu_off ? ' · GPU jobs off' : ''}${m.screen ? ` · screen ${m.screen.holder ? 'busy' : 'free'}${m.screen.line.length ? `, ${m.screen.line.length} waiting` : ''}` : ''}`;
  if (!m.when) return reason;
  return `${reason} · ${m.when.label} ${m.when.label === 'added' ? new Date(m.when.at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : ago(m.when.at)}`;
}

/** A test box's screen (#1422): who has it, then its line (CI jobs first, then by arrival). */
function machineScreen(sc) {
  const user = (u, when) => `${u.what} for ${u.who}${u.since ? `, ${when} ${ago(u.since)}` : ''}`;
  return h(
    'div',
    { class: 'small' },
    h('div', {}, sc.holder ? user(sc.holder, 'started') : 'Free'),
    sc.line.length
      ? h(
          'ol',
          { class: 'machine-screen-line' },
          sc.line.map((u) => h('li', {}, user(u, 'joined'))),
        )
      : h('div', { class: 'muted' }, 'Nobody waiting'),
  );
}

/** Settings' Machines tab: add machines, show the line that connects one, tick what each lends, and remove them or replace their token. */
export function machinesPage(main = {}) {
  view.machineToken = null; // { id, name, token } a New token just made, shown until you leave the page
  shownTokens.clear();
  const section = h(
    'section',
    { class: 'artifacts-main machines-main' },
    h(
      'div',
      { class: 'ticket-head' },
      h('div', { class: 'row' }, ...settingsTitle(), h('span', { class: 'spacer' }), h('a', { class: 'close-view', href: `#/p/${view.projectId}`, title: 'Back to the Taskmaster', 'aria-label': 'Close' }, icon('close'))),
      settingsTabs(),
      h('div', { class: 'meta' }, settingsHelp('Your computers: what each does for you (your own minion turns) and for your schemes (CI, builds, Windows tests, GPU jobs, tools).', 'They dial out to this app (over the tailnet, where one is set up), so it never has to reach them. Only their owner changes them.')),
    ),
    // One way in (Build 10 H3, take B): Connect a computer; Add machine and Add a CI runner host are gone.
    h('div', { class: 'row machines-bar' }, h('h3', {}, 'Machines'), h('span', { class: 'spacer' }), h('button', { type: 'button', class: 'machine-connect-toggle', onclick: () => connectComputer() }, 'Connect a computer')),
    h('div', { id: 'machine-connect' }),
    h('div', { id: 'machine-setup' }),
    h('div', { id: 'machine-removals' }),
    h('div', { id: 'machine-list', class: 'machine-list' }),
    // The CI desktop's load moved to the CI page (#968, Cara: "move the CI box performance page from machines into here"), since #1423 the Releases page's Overview tab.
    h('p', { class: 'muted small' }, "CI runners, their queue and the CI PCs' load are on ", h('a', { href: `#/p/${view.projectId}/ci` }, "the Releases page's Overview tab"), '.'),
    h('p', { class: 'muted small' }, 'Nothing typed here runs a command on a machine.'),
    h('p', { id: 'emulator-lease', class: 'muted small', role: 'status' }, 'Android emulator: checking…'),
    h(
      'details',
      { class: 'small machine-facts' },
      h('summary', {}, 'What a lent machine can and cannot do'),
      h(
        'ul',
        { class: 'muted' },
        h('li', {}, h('strong', {}, 'One MCP server per machine.'), ' Connect another computer for a second one.'),
        h('li', {}, h('strong', {}, 'How minions see it.'), ' Its tools as ', h('code', {}, 'mcp__<name>__…'), ', its ticked folders as ', h('code', {}, 'mcp__<name>-ws__…'), ': git sync and the tasks its owner lists, nothing else.'),
        h('li', {}, h('strong', {}, 'Commands live on that computer.'), ' Commands and tasks are only in ', h('code', {}, 'machine-agent.json'), ' there, beside the agent.'),
        h('li', {}, h('strong', {}, 'For me is yours alone.'), ' Minion turns there run only your own turns, on your own Claude sign-in on that PC. For my schemes lends the rest to the schemes ticked on each role.'),
        h('li', {}, h('strong', {}, 'When a minion gets it.'), " At the start of its turn: the tools of every machine online and lent to its scheme, plus the machine's notes."),
      ),
    ),
  );
  watchLive();
  // Who holds the shared emulator, for anyone checking before they use it (#1128).
  api('api/emulator-lease')
    .then((/** @type {unknown} */ got) => {
      const l = /** @type {{ who: string, what?: string | null, until: number } | null} */ (got);
      const el = document.getElementById('emulator-lease');
      if (!el) return;
      el.replaceChildren('Android emulator (citadel-android) ', l ? toneChip('warn', `leased by ${l.who}`) : toneChip('ok', 'free'), l ? `${l.what ? ` for "${l.what}"` : ''}, until ${new Date(l.until).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })}.` : '');
    })
    .catch(() => document.getElementById('emulator-lease')?.remove());
  setTimeout(() => {
    // A link to one machine (#1638) opens its card's details, so its notes and token show at once.
    const focus = main.machine && view.machines?.find((m) => m.name === main.machine);
    if (focus) (view.machineOpen ??= new Set()).add(focus.id);
    renderMachineSetup();
    renderMachineList();
    if (focus) document.querySelector(`#machine-list .mcard[data-name="${focus.name}"]`)?.scrollIntoView({ block: 'start' });
  });
  return section;
}

/** What the cards' live numbers last read: each PC's load and each worker pool. @type {import('./machine-card.js').Live | null} */
let live = null;
let liveTimer = 0;

/** Read the live numbers now and every 30 s while the page is open: the CI PCs' load (api/ci-desktop), the worker pools (api/workers) and the runner pool's machines (api/ci/pool). */
function watchLive() {
  clearInterval(liveTimer);
  const read = () =>
    Promise.all([api('api/ci-desktop').catch(() => null), api('api/workers').catch(() => null), api('api/ci/pool').catch(() => null)]).then(([d, w, c]) => {
      live = { pcs: d?.pcs ?? [], pool: w?.machines ?? [], ci: c?.machines ?? [] };
      renderMachineList();
    });
  // The page isn't in the document yet on this first read; a later tick finding it gone means it was left.
  liveTimer = setInterval(() => (document.getElementById('machine-list') ? read() : clearInterval(liveTimer)), 30_000);
  read();
}

let connectPanel = null;

/**
 * Connect a computer's panel (Build 7 M2), for a new computer or, with `m`, an Update of an agent from before.
 * @param {import('./types.js').MachineRow | null} [m] the row an Update reconnects
 * @param {string | null} [inside] the computer it is a VM on
 */
function connectComputer(m = null, inside = null) {
  // A new computer gets the 3-step wizard (Build 10 H3); an Update of an agent from before keeps its panel on the page.
  if (!m) return openConnectWizard({ redraw: renderMachineList });
  const el = document.getElementById('machine-connect');
  if (!el) return;
  // One panel at a time: the one before stops watching its code, or its next look would draw over this one.
  connectPanel?.close({ quiet: true });
  connectPanel = openConnectPanel(el, { machine: m, inside });
  el.scrollIntoView({ block: 'nearest' });
}

/** @type {Record<'windows' | 'linux', { tag: string, where: string, line: (url: string, token: string) => string }>} */
const RUNNER_WAYS = {
  windows: { tag: 'powershell-admin', where: 'On that PC, open PowerShell as administrator (Run as administrator) and paste this. It replaces the runner agent there; its runners stay.', line: machineSetupRunnerAgent },
  linux: { tag: 'wsl', where: "In a root shell in the CI runners' WSL distro on that PC (wsl -d citadel-ci -u root), or sudo -i on a Linux PC, paste this. It replaces the Linux runner agent there; its runners stay.", line: machineSetupRunnerAgentLinux },
};

/**
 * The lines that reinstall a PC's runner agents with a new token, one per os.
 * @param {string} url
 * @param {string} token
 * @param {('windows' | 'linux')[]} osList
 */
const runnerAgentLines = (url, token, osList) => osList.map((os) => [h('p', { class: 'small' }, RUNNER_WAYS[os].where), markdownElement(`\`\`\`${RUNNER_WAYS[os].tag}\n${RUNNER_WAYS[os].line(url, token)}\n\`\`\``)]);

/** A machine just added or given a new token: what its install line needs. */
function setupFor(machine, token, url, runnerOs = []) {
  return { id: machine.id, name: machine.name, token, url: url ?? location.origin, runnerOs };
}

function renderMachineSetup() {
  const el = document.getElementById('machine-setup');
  if (!el) return;
  const t = view.machineToken;
  if (!t) return el.replaceChildren();
  const ways = [
    { os: 'windows', tab: 'Windows', label: 'Windows PowerShell: runs in the background, also after you close the window, and starts at every logon. No reboot.', text: machineSetupWindows(t.url, t.name, t.token), log: agentLog('windows', t.name) },
    { os: 'posix', tab: 'macOS or Linux', label: 'Terminal on macOS or Linux: runs in the background, also after you close the window, and starts at every login. No sudo.', text: machineSetupPosix(t.url, t.name, t.token), log: agentLog('posix', t.name) },
    {
      os: 'jobs',
      tab: 'GPU jobs (WSL)',
      label: 'Shell in the citadel-jobs WSL distro on that PC, as you, not root (wsl -d citadel-jobs; tools/jobs-runner/README.md sets the distro up first): runs GPU jobs from contraptions in podman.',
      text: machineSetupPosix(t.url, t.name, t.token),
      note: 'Then add a "jobs" block to ~/coordinator-agent/machine-agent.json in the distro (the README, step 6): the folders jobs may read, the time limit and the disk cap. Without it every job is refused.',
    },
  ];
  // Picked from this browser; the chips are for adding a computer from another one.
  view.machineSetupOs ??= guessOs();
  const os = view.machineSetupOs;
  const copy = h('button', { type: 'button', class: 'secondary small' }, 'Copy');
  copy.onclick = async () => {
    copy.textContent = (await copyText(ways.find((w) => w.os === os).text)) ? 'Copied' : "Couldn't copy";
  };
  const pick = (to) => {
    view.machineSetupOs = to;
    renderMachineSetup();
  };
  el.replaceChildren(
    h(
      'div',
      { class: 'machine-setup' },
      h('strong', {}, `Connect ${t.name}`),
      h('p', { class: 'small' }, "Don't screenshot this or paste it in a chat: the line holds the token, and anyone who has it can act as this machine."),
      h('p', { class: 'small' }, 'Its owner can show the token again from its line below. Paste this on that computer:'),
      h(
        'div',
        { class: 'row machine-setup-ways' },
        h(
          'div',
          { class: 'row', role: 'group', 'aria-label': 'Which computer' },
          ways.map((w) => h('button', { type: 'button', class: `chip${w.os === os ? ' on' : ''}`, 'aria-pressed': String(w.os === os), onclick: () => pick(w.os) }, w.tab)),
        ),
        h('span', { class: 'spacer' }),
        copy,
      ),
      ways.map((w) =>
        h(
          'div',
          { class: 'machine-setup-way', 'data-os': w.os, hidden: w.os !== os },
          h('p', { class: 'small' }, w.label),
          h('pre', {}, w.text),
          w.note ? h('p', { class: 'small muted' }, w.note) : h('p', { class: 'small muted' }, 'It writes what it prints to ', h('code', {}, w.log), ', and ends by printing how to watch that log, stop it and remove it.'),
        ),
      ),
      // Its runner agents held the old token too, so they reinstall with this one.
      t.runnerOs.length ? [h('div', { class: 'cui-notice', 'data-tone': 'warn', role: 'status' }, h('strong', {}, 'Its CI runner agent is cut off too.'), ' It used the old token: paste this on that PC as well, and its runners stay.'), runnerAgentLines(t.url, t.token, t.runnerOs)] : '',
      h('p', { class: 'small' }, `Once it connects, ${t.name}'s line below shows the MCP servers and folders it found there: open it and tick what to lend.`),
    ),
  );
}

/** The setup to show first: the viewer's own kind of computer, as the browser says it (a phone gets Windows). */
function guessOs() {
  const platform = /** @type {Navigator & { userAgentData?: { platform?: string } }} */ (navigator).userAgentData?.platform || navigator.platform || '';
  return /mac|linux|x11|cros/i.test(platform) && !/android/i.test(`${platform} ${navigator.userAgent}`) ? 'posix' : 'windows';
}

function renderMachineList() {
  const el = document.getElementById('machine-list');
  if (!el) return;
  view.machineOpen ??= new Set();
  connectWizardRedraw();
  renderRemovals(document.getElementById('machine-removals'), renderMachineList);
  // One card per computer you own (take B); others' computers lent to your schemes are one read-only line.
  const all = /** @type {import('./types.js').MachineRow[]} */ (view?.machines ?? []);
  const mine = all.filter(isMine);
  // A field someone is typing in keeps its place over a redraw.
  const at = el.contains(document.activeElement) && document.activeElement.id ? document.activeElement : null;
  const card = (/** @type {import('./types.js').MachineRow} */ m) => machineCard(m, { live, redraw: renderMachineList, tools: () => machineLends(m), head: isMine(m) ? machineHead(m) : h('span', { class: 'mcard-owner' }, toneChip('neutral', ownerName(m, live)), machineHead(m)), details: () => machineBody(m) });
  // An admin still reaches everyone's computers (to fix or remove one), closed under their own.
  const others = account?.admin ? all.filter((m) => !isMine(m)) : [];
  const theirs = others.length ? h('details', { class: 'mcard-others', open: !!view?.machineOthersOpen }, h('summary', { class: 'small' }, `Everyone else's computers (${others.length}, as an admin)`), ...others.map(card)) : '';
  if (theirs) theirs.addEventListener('toggle', () => view && (view.machineOthersOpen = theirs.open));
  el.replaceChildren(...(mine.length ? mine.map(card) : [emptyMachines()]), lentLine(all, live) ?? '', theirs);
  document.querySelector('.machines-bar .machine-connect-toggle')?.toggleAttribute('hidden', !mine.length);
  const back = at && document.getElementById(at.id);
  if (!back || back === document.activeElement) return;
  // What was typed, half-typed included, and whether it is refused, stay as the person left them.
  if (typeof at.value === 'string' && 'value' in back) back.value = at.value;
  if (at.hasAttribute('aria-invalid')) back.setAttribute('aria-invalid', at.getAttribute('aria-invalid'));
  back.focus({ preventScroll: true });
  if (at.selectionStart != null) back.setSelectionRange(at.selectionStart, at.selectionEnd);
}

/** No computers yet (take B's empty scene): what they're for, and the one button. */
function emptyMachines() {
  return h(
    'div',
    { class: 'machine-empty' },
    emptyCard('Connect your first computer', 'Lend its power to your schemes (CI, builds, Windows tests, GPU jobs, tools), and, if you sign in to Claude there, run your own minion turns on it.', { mark: '+', hue: 'accent' }),
    h('button', { type: 'button', class: 'machine-connect-first', onclick: () => connectComputer() }, 'Connect a computer'),
  );
}

/** Make a new token for a machine and show its install line. */
async function newMachineToken(m) {
  // One set up before #439 runs what its own command line says; the new line makes it report what it finds instead.
  const old = !m.runners && m.managed !== true && !m.lend;
  if (
    !confirm(
      `Make a new token for ${m.name}? Its current connection stops and it has to be installed again with the new line.${m.worker?.host ? ' Its minion worker stops too: run that command again as well (its row shows it).' : ''}${
        old ? '\n\nAfter that, what it lends is ticked here, from the MCP servers in that computer\'s Claude Code config and its machine-agent.json. If it runs a server from a command of its own, put that under "servers" in machine-agent.json there first.' : ''
      }`,
    )
  )
    return;
  const { machine, token, agent_url, runner_os } = await api(`api/machines/${m.id}/token`, { method: 'POST' }).catch((err) => alert(err.message) ?? {});
  if (!token) return;
  shownTokens.delete(m.id); // the old one stopped working
  forgetWorkerLink(m.id);
  view.machineToken = setupFor(machine, token, agent_url, runner_os);
  renderMachineSetup();
  document.getElementById('machine-setup')?.scrollIntoView({ block: 'nearest' });
}

function removeMachine(m) {
  if (!confirm(`Remove ${m.name}? Minions lose its tools and its token stops working.`)) return;
  if (view.machineToken?.id === m.id) view.machineToken = null;
  renderMachineSetup();
  sendRemoval(m, { redraw: renderMachineList, drop: () => onMachinesUpdate(view.machines.filter((x) => x.id !== m.id)) });
}

/** Check now (#437): its result can't be guessed, so only its own button shows it is busy. */
function checkMachine(m, button) {
  button.disabled = true;
  button.textContent = 'Checking…';
  api(`api/machines/${m.id}/check`, { method: 'POST' })
    .catch((err) => toast(`Couldn't check ${m.name}: ${err.message}`, { tone: 'danger' }))
    // The broadcast has redrawn the row by now; this is for one that didn't.
    .finally(() => {
      if (button.isConnected) {
        button.disabled = false;
        button.textContent = 'Check now';
      }
    });
}

/** The button on a machine's line that fixes what its status says, if one does (#437). */
function fixButton(m, open) {
  const b = (label, onclick, title) => h('button', { type: 'button', class: 'secondary small', title, onclick: (e) => onclick(e.currentTarget) }, label);
  switch (m.fix) {
    case 'check':
      return m.checking ? h('button', { type: 'button', class: 'secondary small', disabled: true }, 'Checking…') : b('Check now', (btn) => checkMachine(m, btn), 'Start its tools again and list them');
    case 'tick':
      return b(m.reason.startsWith('Found nothing') ? 'How to add' : 'Tick what it lends', open, 'Open its line: what it found on that computer, and how to add more there');
    case 'workspace_tools':
      return b('Turn on', () => patchMachine(m, { workspace_tools: true }, `switch workspace tools on for ${m.name}`, renderMachineList), 'Switch its workspace tools on, so minions get its folders');
    case 'lend':
      return b('Lend it', open, 'Pick the schemes whose minions get it');
    case 'token':
      return b('New token', () => newMachineToken(m), 'Install it again with the new line: it then reports what it finds there');
    case 'remove':
      return b('Remove', () => removeMachine(m));
    case 'always_on':
      return b('Not always on', () => patchMachine(m, { always_on: false }, `mark ${m.name} as not always on`, renderMachineList), 'A laptop that comes and goes: offline shows as Asleep, not Down');
    default:
      return '';
  }
}

/** What a machine's last check found: "MCP server (godot-ai), 47 tools · workspace tools, 8 tools". */
function machineChecked(m) {
  const results = m.checked?.results ?? [];
  const server = m.lend?.server ?? m.mcp_command;
  if (!results.length) return m.online ? 'Nothing it lends has been checked yet' : 'Shows once it connects and is checked';
  return results.map((r) => `${r.server === 'ws' ? 'workspace tools' : `MCP server${server ? ` (${server})` : ''}`}${r.ok ? `, ${r.tools.length} tool${r.tools.length === 1 ? '' : 's'}` : ": didn't start"}`).join(' · ');
}

// What machine-agent.json takes, for the Machines page; the owner writes it beside the agent on that computer.
const CONFIG_EXAMPLE = `{
  "servers": { "godot": { "run": ["uvx", "godot-ai", "attach"] } },
  "workspaces": { "delve": { "path": "C:\\\\Users\\\\you\\\\Projects\\\\delve" } }
}`;
const WORKSPACE_EXAMPLE = `{
  "workspaces": {
    "delve": {
      "path": "C:\\\\Users\\\\you\\\\Projects\\\\delve",
      "read": ["%APPDATA%\\\\Godot\\\\app_userdata\\\\Delve"],
      "tasks": {
        "build": {
          "run": ["dotnet", "build", "Delve.sln"],
          "hints": [{ "match": "MSB3027|used by another process", "say": "Close the game and the editor, then retry." }]
        },
        "import": { "run": ["cmd.exe", "/c", "tools\\\\prepare.cmd"], "about": "imports new art" }
      }
    },
    "vault": {
      "path": "%USERPROFILE%\\\\Documents\\\\Vault",
      "git_sync": false,
      "tasks": { "pull": { "run": ["git", "pull", "--ff-only"], "about": "Bring the minion's push into the vault now" } }
    }
  }
}`;

/** How a new server or folder gets onto a machine: in the file on that computer, never from here. */
function machineConfigHelp(open) {
  return h(
    'details',
    { class: 'small machine-config-help', open },
    h('summary', {}, 'Add a server or a folder: in machine-agent.json on that computer'),
    h('p', { class: 'muted' }, "The file sits beside the agent, in the coordinator-agent folder of that computer's home folder. The agent picks up changes by itself, and what it finds shows here to tick. A server is a program and its arguments (no shell); a folder is a path:"),
    h('pre', {}, CONFIG_EXAMPLE),
    h(
      'details',
      {},
      h('summary', {}, 'Folders with tasks, read folders and a vault that pulls'),
      h('p', { class: 'muted' }, 'In a ticked folder minions can check out pushed branches and run only the tasks listed, with no shell. "git_sync": false keeps them from checking anything out in a folder you keep on a branch yourself (an Obsidian vault with Obsidian Git, say); give that one a pull task instead.'),
      h('pre', {}, WORKSPACE_EXAMPLE),
    ),
  );
}

/** A folder as its agent reports it: its path, what else is readable and its tasks. */
function workspaceDetail(w) {
  return h(
    'div',
    { class: 'machine-workspace small' },
    h('div', {}, h('code', {}, w.path), w.git_sync === false ? h('span', { class: 'muted' }, ' · git_sync off') : ''),
    w.read.length ? h('div', { class: 'muted' }, 'Also readable: ', w.read.join(', ')) : '',
    w.tasks.length
      ? h(
          'ul',
          {},
          w.tasks.map((t) => h('li', {}, h('code', {}, t.name), ': ', t.run.join(' '), t.args ? ' …' : '', t.about ? h('span', { class: 'muted' }, ` (${t.about})`) : '')),
        )
      : '',
  );
}

/**
 * What a machine lends (#439). One whose agent reports what it found gets a tick per MCP server (one at a time)
 * and per folder; a tick saves at once and reaches the agent, with no new token. One set up before that lends
 * what its own command line says, shown as it is.
 */
function machineLends(m) {
  const problems = (m.problems ?? []).map((p) => h('p', { class: 'error small' }, p));
  const checked = h('p', { class: 'muted small' }, `Last check: ${machineChecked(m)}`);
  const workspaces = m.workspaces ?? [];
  if (m.managed === false) {
    // An agent from before #439: its MCP server is fixed on that computer, and its folders go together behind one switch.
    const all = h('input', { type: 'checkbox', checked: m.workspace_tools });
    all.onchange = () => patchMachine(m, { workspace_tools: all.checked }, `switch workspace tools ${all.checked ? 'on' : 'off'} for ${m.name}`, renderMachineList);
    return h(
      'div',
      { class: 'machine-lends' },
      m.servers.includes('mcp') ? h('div', { class: 'small' }, 'MCP server: ', h('code', {}, m.command || '?'), h('span', { class: 'muted' }, ' · set on that computer')) : '',
      m.servers.includes('ws') ? h('label', { class: 'row small', title: 'Lets minions check out pushed branches and run the listed tasks in every folder below' }, all, h('span', {}, 'All its folders')) : '',
      ...workspaces.map((w) => h('div', { class: 'machine-found' }, h('strong', { class: 'small' }, w.name), workspaceDetail(w))),
      m.servers.length ? '' : h('p', { class: 'muted small' }, 'Nothing: it runs no MCP server and lists no folder.'),
      h('p', { class: 'muted small' }, 'Set up before ticks: it lends what its own command line says. ', h('button', { type: 'button', class: 'link', onclick: () => newMachineToken(m) }, 'Reinstall to manage from here'), '.'),
      ...problems,
      checked,
    );
  }
  const lend = m.lend ?? { server: null, workspaces: [] };
  const save = (next) => patchMachine(m, { lend: next }, `change what ${m.name} lends`, renderMachineList);
  const tick = (on, change, ...label) => {
    const box = h('input', { type: 'checkbox', checked: on });
    box.onchange = () => change(box.checked);
    return h('label', { class: 'row small' }, box, h('span', {}, ...label));
  };
  const online = m.managed === true;
  const found = m.found ?? [];
  // Ticked but not there now (removed from that computer, or it is offline): still shown, so it can be unticked.
  const servers = [...found, ...(lend.server && !found.some((f) => f.name === lend.server) ? [{ name: lend.server, gone: true }] : [])];
  const folders = [...workspaces, ...lend.workspaces.filter((n) => !workspaces.some((w) => w.name === n)).map((name) => ({ name, gone: true }))];
  const gone = online ? 'not found there now' : 'ticked';
  return h(
    'div',
    { class: 'machine-lends' },
    servers.length
      ? h(
          'div',
          { class: 'machine-found' },
          h('div', { class: 'muted small' }, 'MCP server (one at a time)'),
          ...servers.map((f) => tick(lend.server === f.name, (on) => save({ ...lend, server: on ? f.name : null }), h('code', {}, f.name), h('span', { class: 'muted' }, f.gone ? ` · ${gone}` : f.from === 'file' ? ' · from machine-agent.json' : " · from Claude Code's config"))),
        )
      : '',
    folders.length
      ? h(
          'div',
          { class: 'machine-found' },
          h('div', { class: 'muted small' }, 'Folders'),
          ...folders.map((w) =>
            h(
              'div',
              {},
              tick(lend.workspaces.includes(w.name), (on) => save({ ...lend, workspaces: on ? [...lend.workspaces, w.name] : lend.workspaces.filter((n) => n !== w.name) }), h('strong', {}, w.name), w.gone ? h('span', { class: 'muted' }, ` · ${gone}`) : ''),
              w.gone ? '' : workspaceDetail(w),
            ),
          ),
        )
      : '',
    online
      ? servers.length || folders.length
        ? ''
        : h('p', { class: 'muted small' }, "It found no MCP server in Claude Code's config there and no machine-agent.json entries.")
      : h('p', { class: 'muted small' }, m.last_seen_at ? 'Offline: what it finds there shows once it connects.' : 'Once it connects, what it finds on that computer shows here to tick.'),
    servers.length || folders.length ? h('p', { class: 'cui-notice small' }, 'Minions run these tools on this computer, so only tick what you trust them with.') : '',
    online ? machineConfigHelp(!servers.length && !folders.length) : '',
    ...problems,
    m.checked?.results.length ? checked : '',
  );
}

/** One line of the quiet list (#437, take A): name, reason, status chip (#492), fix button; click it for the rest. */
/** The fixes a card's header carries (#437, Build 7 M2, M6b): Update an old agent, update an old CI agent, a fix. @param {MachineRow} m */
function machineHead(m) {
  const open = () => {
    view.machineOpen.add(m.id);
    renderMachineList();
  };
  const gone = removing(m);
  const fix = !gone && fixButton(m, open);
  // An agent from before reports nothing (Build 7 M2): Update gives the command that puts the new one in its place.
  const update = m.update && !gone && managesHere(m) && h('button', { type: 'button', class: 'secondary small', title: 'Its agent is from before: the new one says what this PC can do. Opens the command that replaces it', onclick: () => connectComputer(m) }, 'Update');
  // A CI runner agent from before the balancer (Build 7 M6b): the button opens its details at the update line.
  const ciUpdate = m.runner_update && !gone && managesHere(m) && h('button', { type: 'button', class: 'secondary small', title: "Its CI runner agent is from before: it can't update itself. Opens the line that updates it once, after which it does", onclick: open }, 'Update CI agent');
  const word = gone ? toneChip('info', 'Removing…') : null;
  return fix || update || ciUpdate || word ? h('span', { class: 'machine-fix' }, word || '', update || '', ciUpdate || '', fix || '') : null;
}

/** A card's Details: its computer, screen, notes, token and its buttons (its roles are on the card's tiles). */
function machineBody(m) {
  const check = h('button', { type: 'button', class: 'secondary small', disabled: !m.online || m.checking, title: m.online ? "Start its tools and list them, as a minion's turn would" : 'It is offline' }, m.checking ? 'Checking…' : 'Check now');
  check.onclick = () => checkMachine(m, check);
  const newToken = h('button', { type: 'button', class: 'secondary small', disabled: removing(m), title: 'Make a new token; the old one stops working and the machine disconnects', onclick: () => newMachineToken(m) }, 'New token');
  const remove = h('button', { type: 'button', class: 'secondary small', disabled: removing(m), onclick: () => removeMachine(m) }, removing(m) ? 'Removing…' : 'Remove');
  const alwaysOn = h('input', { type: 'checkbox', checked: m.always_on });
  alwaysOn.onchange = () => patchMachine(m, { always_on: alwaysOn.checked }, `mark ${m.name} as ${alwaysOn.checked ? '' : 'not '}always on`, renderMachineList);
  const kv = (label, ...value) => [h('span', { class: 'muted' }, label), h('div', {}, ...value)];
  return h(
    'div',
    { class: 'machine-body' },
    h(
      'div',
      { class: 'machine-kv' },
      m.runners ? kv('Does', 'Adds, lists and removes CI runners for schemes, when Citadel asks') : [],
      // Its roles (Build 7 M3, Josh: "A · A card per role, schemes inside"): the Tools ticks and Minion turns live in their cards.
      kv('Status', machineStatusText(m)),
      kv(
        'Computer',
        m.report ? h('div', { class: 'small' }, reportLine(m.report)) : '',
        h('span', {}, [m.host ?? m.worker?.host, m.online ? (m.command && !m.runners ? `runs ${m.command}` : '') : m.last_seen_at ? `last seen ${ago(m.last_seen_at)}` : m.worker?.host ? 'runs only minion turns' : 'never connected', m.sessions ? `${m.sessions} in use` : ''].filter(Boolean).join(' · ') || '—'),
        h('label', { class: 'row small always-on', title: 'On: offline over 5 minutes shows as Down. Off: a laptop that comes and goes shows as Asleep.' }, alwaysOn, h('span', {}, 'Always on')),
      ),
      m.screen ? kv('Screen', machineScreen(m.screen)) : [],
      m.runner_agents?.length || (m.runner_update && managesHere(m)) ? kv('CI agent', ...(m.runner_agents ?? []).map(ciAgentVersion), m.runner_update && managesHere(m) ? ciAgentUpdate(m) : '') : [],
      managesHere(m) ? kv('Name', machineRename(m)) : [],
      kv('Notes', machineNotes(m)),
      tokenIsMine(m) ? kv('Token', machineTokenShow(m)) : [],
    ),
    m.jobs ? machineJobsSection(m) : '',
    h('div', { class: 'row machine-buttons' }, m.runners ? '' : check, newToken, removing(m) ? null : pauseButton(m, renderMachineList), remove),
    ...(m.vms ?? []).map((/** @type {import('./types.js').MachineRow} */ vm) => machineVm(vm, m)),
  );
}

/** A VM on this computer (Build 10 H4: "really just a capability of a machine"): what it lends and its screen, inside its host's card.
 * @param {import('./types.js').MachineRow} vm
 * @param {import('./types.js').MachineRow} host */
function machineVm(vm, host) {
  const word = { ready: 'Ready', fix: 'Needs a fix', down: 'Down', asleep: 'Asleep', checking: 'Checking' }[vm.status];
  // Its agent's Update says to paste it inside the VM: run on the host, the host's agent would take the VM's row.
  const update = vm.update && managesHere(vm) && h('button', { type: 'button', class: 'secondary small', title: `Its agent is from before. Opens the command to paste inside ${vm.name}, not on ${host.name}`, onclick: () => connectComputer(vm, host.name) }, 'Update');
  return h('section', { class: 'machine-vm', 'aria-label': `VM: ${vm.name}` }, h('div', { class: 'row machine-vm-head' }, h('strong', {}, `VM: ${vm.name}`), h('span', { class: 'small muted' }, `${word} · ${machineStatusText(vm)}`), update || ''), machineBody(vm));
}

/** An old CI runner agent's update line, per OS: its install again, with the token already on that PC, so nothing else is cut off.
 * @type {Record<'windows' | 'linux', { tag: string, where: string, line: (u: string) => string }>} */
const CI_AGENT_UPDATE = {
  windows: {
    tag: 'powershell-admin',
    where: 'On that PC, open PowerShell as administrator (Run as administrator) and paste this:',
    line: (u) =>
      `$u = '${u}'; iwr "$u/ci-runner/install-runner-agent.ps1" -UseBasicParsing -OutFile "$env:TEMP\\install-runner-agent.ps1"; powershell -NoProfile -ExecutionPolicy Bypass -File "$env:TEMP\\install-runner-agent.ps1" -CitadelUrl $u -MachineToken (Get-Content "$env:ProgramData\\citadel-runner-agent\\machine-token" -Raw).Trim()`,
  },
  linux: {
    tag: 'wsl',
    where: "In a root shell in the CI runners' WSL distro on that PC (wsl -d citadel-ci -u root), or sudo -i on a Linux PC, paste this:",
    line: (u) => `u='${u}'; f=$(mktemp) && curl -fsSL "$u/ci-runner/install-runner-agent.sh" -o "$f" && CC_MACHINE_TOKEN=$(cat /opt/citadel-runner-agent/machine-token) bash "$f" "$u"`,
  },
};

/** Each CI runner agent's version and where its own update stands (#2310), as a toned chip and its why.
 * @param {NonNullable<import('./types.js').MachineRow['runner_agents']>[number]} r */
function ciAgentVersion(r) {
  const os = r.os === 'linux' ? 'Linux' : 'Windows';
  const u = r.update;
  if (!r.self_update) return h('div', { class: 'small' }, toneChip('warn', 'Can’t update itself'), ` ${os}: installed before it could. Run its install once more (below).`);
  if (!u) return h('div', { class: 'small' }, toneChip('neutral', 'Checking'), ` ${os}: hasn't said its version yet.`);
  const chip = { current: toneChip('ok', 'Up to date'), waiting: toneChip('info', 'Update waiting'), updating: toneChip('info', 'Updating'), failed: toneChip('danger', 'Update failed') }[u.state];
  const behind = u.state !== 'current' && r.latest && r.latest !== u.version ? [', Citadel has ', h('code', {}, r.latest)] : [];
  const why = u.why ? `. ${u.why[0].toUpperCase()}${u.why.slice(1)}.` : '';
  return h('div', { class: 'small' }, chip, ` ${os}: version `, h('code', {}, u.version), ...behind, why);
}

/** Why an old CI runner agent wants updating (Build 7 M6b), and the line for each one there.
 * @param {{ runner_update: { url?: string | null, os: ('windows' | 'linux')[], plans?: boolean } }} m */
function ciAgentUpdate(m) {
  const u = (m.runner_update.url ?? location.origin).replace(/\/$/, '');
  return h(
    'div',
    {},
    h(
      'div',
      { class: 'cui-notice', 'data-tone': 'warn', role: 'status' },
      h('strong', {}, 'Its CI runner agent is from before.'),
      m.runner_update.plans ? " It keeps every runner awake and squeezes the others to 30% while a ship runs, instead of following this PC's balance." : ' It can’t update itself yet.',
      ' Run its install once more; from then on it updates itself, and its runners and token stay.',
    ),
    m.runner_update.os.map((os) => [h('p', { class: 'small' }, CI_AGENT_UPDATE[os].where), markdownElement(`\`\`\`${CI_AGENT_UPDATE[os].tag}\n${CI_AGENT_UPDATE[os].line(u)}\n\`\`\``)]),
  );
}

/** Whether the viewer may relink this machine, as the server's managesMachine says: its owner, or an admin. */
const managesHere = (m) => !!account?.admin || (m.owner_id !== null && m.owner_id === account?.id);

/** Whether the viewer may show this machine's token (#1355): its owner's alone (Cara, 2026-11-20, "Only its owner"; every machine has one, #2184). */
const tokenIsMine = (m) => m.owner_id === account?.id;

/** Tokens shown on this page, by machine id, so a redraw from the live list keeps one open until Hide or leaving the page. */
const shownTokens = new Map();

/** Its token again, to set up another tool on that computer without a relink (#1355). */
function machineTokenShow(m) {
  if (!m.token_showable) return h('p', { class: 'cui-notice machine-token-old', 'data-tone': 'info' }, "Linked before Citadel kept tokens, so it can't be shown. New token replaces the one ", h('strong', {}, m.name), ' uses now (paste the new setup line on it once); from then on it can be shown here.');
  const fetchToken = async () => shownTokens.get(m.id) ?? (await api(`api/machines/${m.id}/token`)).token;
  const shown = shownTokens.get(m.id);
  const value = h('code', { class: 'machine-token-value' }, shown ?? `ccm_${m.id}_${'•'.repeat(43)}`); // as long as the real one, so Show wraps it the same and the buttons stay put
  const show = h('button', { type: 'button', class: 'secondary small' }, shown ? 'Hide' : 'Show');
  show.onclick = async () => {
    if (shownTokens.delete(m.id)) return renderMachineList();
    const token = await fetchToken().catch((err) => toast(`Couldn't show the token: ${err.message}`) ?? null);
    if (token) shownTokens.set(m.id, token);
    renderMachineList();
  };
  const copy = h('button', { type: 'button', class: 'secondary small' }, 'Copy');
  copy.onclick = async () => {
    const token = await fetchToken().catch((err) => toast(`Couldn't copy the token: ${err.message}`) ?? null);
    if (token) toast((await copyText(token)) ? 'Token copied' : "Couldn't copy");
  };
  return h('div', { class: 'machine-token' }, value, h('div', { class: 'row' }, show, copy), h('p', { class: 'small muted' }, 'Use it to connect another tool on that computer; tools already connected keep working. Keep it out of chats.'));
}

/** Its name, which its owner changes here: a VM's row links to its Hyper-V VM by name (Build 10 H4), and a CI runner host's row (H6) keeps the host's.
 * @param {import('./types.js').MachineRow} m */
function machineRename(m) {
  const name = h('input', { value: m.name, maxlength: 30, pattern: '[a-z0-9][a-z0-9\\-]*', 'aria-label': `${m.name}'s name`, autocomplete: 'off', class: 'machine-rename' });
  const save = h('button', { type: 'button', class: 'secondary small' }, 'Rename');
  save.onclick = () => {
    const to = name.value.trim().toLowerCase();
    if (to && to !== m.name) patchMachine(m, { name: to }, `rename ${m.name}`, renderMachineList);
  };
  return h('div', { class: 'row machine-connect-name' }, name, save);
}

/** A machine's notes for minions: a collapsed editor that keeps an open draft through re-renders. */
function machineNotes(m) {
  const notes = h('textarea', { rows: 4, maxlength: 2000, placeholder: 'What minions should know: never restart it, where the repo is cloned, what to check first…' });
  notes.value = m.notes ?? '';
  const saved = h('span', { class: 'muted small', role: 'status' });
  const summary = h('summary', {});
  const summarize = (text) => {
    summary.textContent = text ? text.split('\n')[0] : 'Add notes for minions';
  };
  summarize(m.notes);
  const save = h('button', { type: 'button', class: 'small' }, 'Save notes');
  // The field keeps what was typed either way; a refusal only says it isn't saved.
  save.onclick = () =>
    patchMachine(m, { notes: notes.value }, `save the notes on ${m.name}`, (ok, x) => {
      summarize(x.notes);
      saved.textContent = ok ? 'Saved; minions get them from their next turn.' : 'Not saved.';
    });
  notes.addEventListener('input', () => {
    saved.textContent = '';
  });
  // Keep an open notes editor open (and its draft) when the list re-renders for a status change.
  const old = /** @type {HTMLDetailsElement | null} */ (document.querySelector(`.machine-notes[data-id="${m.id}"]`));
  const editing = old?.open;
  if (editing) notes.value = /** @type {HTMLTextAreaElement} */ (old.querySelector('textarea')).value;
  return h('details', { class: 'machine-notes', 'data-id': m.id, open: editing }, summary, notes, h('div', { class: 'row' }, save, saved));
}

/**
 * Change a machine's fields at once and PATCH them behind; shown(ok, machine) redraws what shows them. A refusal
 * puts the old values back, unless a later change replaced them; the server's broadcast then has the last word.
 */
function patchMachine(m, fields, label, shown) {
  const now = () => view.machines?.find((x) => x.id === m.id) ?? m;
  const was = Object.fromEntries(Object.keys(fields).map((k) => [k, now()[k]]));
  const set = (vals, ok) => shown(ok, Object.assign(now(), vals));
  optimistic({
    key: `machine:${m.id}`,
    apply: () => set(fields, true),
    send: () => api(`api/machines/${m.id}`, { method: 'PATCH', body: fields }),
    undo: () => Object.entries(fields).every(([k, v]) => now()[k] === v) && set(was, false), // unless a later change replaced them
    label,
  });
}
