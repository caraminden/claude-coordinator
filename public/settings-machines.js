// The Machines settings page: the list, the add form, the setup steps and each machine's lending (split out of settings.js).
import { account, ago, api, h, icon, view } from './base.js';
import { agentLog, machineSetupPosix, machineSetupRunnerAgent, machineSetupRunnerAgentLinux, machineSetupWindows } from './machine-setup.js';
import { machineJobsSection } from './jobs.js';
import { openConnectPanel, reportLine } from './machine-connect.js';
import { removing, renderRemovals, sendRemoval } from './machine-remove.js';
import { forgetWorkerLink, workerReason, workerSection, workerWord } from './machine-worker-row.js';
import { settingsHelp, settingsRow, settingsTabs, settingsTitle } from './settings.js';
import { copyText } from './ui/markdown.js';
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

/** Whether this scheme's minions get a machine for the viewer: a shared one lent here, or their own (their turns get it). */
const oursHere = (m) => !m.runners && m.gets?.includes(view.projectId) && (m.owner_id === null || m.owner_id === account?.id);

/** The add form (#439): a name, and nothing about what it lends, which is ticked once its agent reports. runners: a CI runner host. */
function machineAddForm(runners, label) {
  const name = h('input', { name: 'name', placeholder: runners ? 'desktop-ci-runners' : 'godot-laptop', required: true, maxlength: 30, autocomplete: 'off', pattern: '[a-z0-9][a-z0-9\\-]*' });
  const alwaysOn = runners ? null : h('input', { type: 'checkbox', name: 'always_on', checked: true });
  // Everyone else's machine is their own (#306); an admin's is shared unless they tick this.
  const mine = !runners && account?.admin ? h('input', { type: 'checkbox', name: 'mine' }) : null;
  const status = h('span', { class: 'muted', role: 'status' });
  const form = h(
    'form',
    { class: `machine-add${runners ? ' runners' : ''}` },
    h('label', {}, 'Name', name),
    alwaysOn ? h('label', { class: 'check', title: 'On: offline over 5 minutes shows as Down. Off: a laptop that comes and goes shows as Asleep.' }, alwaysOn, h('span', {}, 'Always on (untick for a laptop)')) : '',
    mine ? h('label', { class: 'check', title: "Off: a shared machine, lent to schemes under Who gets it. On: only turns you ask for get it, in schemes you are in, and your contraptions' turns." }, mine, h('span', {}, 'Mine: only my turns use it')) : '',
    h('button', { type: 'submit' }, label),
    status,
    // The steps sit in the form they are about (#492), not in a paragraph under the list.
    runners
      ? h(
          'ol',
          { class: 'settings-steps' },
          h('li', {}, h('strong', {}, 'Name it'), ' and press Add CI runner host.'),
          h('li', {}, h('strong', {}, 'Paste the line it shows'), ' on that PC, as administrator or root. Any 64-bit Intel or AMD PC with Windows, or Linux with systemd.'),
          h('li', {}, h('strong', {}, 'Open its line and pick the schemes'), ' under Runs CI for. Only those schemes can put runners on it: CI there runs code their members push.'),
        )
      : h(
          'ol',
          { class: 'settings-steps' },
          h('li', {}, h('strong', {}, 'Name it'), ' and press Add machine.'),
          h('li', {}, h('strong', {}, 'Paste the line it shows'), ' on that computer. It needs Node 18 or newer.'),
          h('li', {}, h('strong', {}, 'Open its line and tick what to lend.'), ' It reports the MCP servers set up for Claude Code there, and the servers and folders its owner lists in ', h('code', {}, 'machine-agent.json'), '.'),
        ),
  );
  const toggle = h('button', { type: 'button', class: runners ? 'secondary small' : 'machine-add-toggle secondary', 'aria-expanded': 'false' }, runners ? 'Add a CI runner host' : 'Add by name');
  const show = (on) => {
    form.hidden = !on;
    toggle.setAttribute('aria-expanded', String(on));
    if (on) name.focus();
  };
  toggle.onclick = () => show(form.hidden);
  form.hidden = true;
  form.onsubmit = async (e) => {
    e.preventDefault();
    status.textContent = 'Adding…';
    try {
      const { machine, token, agent_url } = await api('api/machines', { method: 'POST', body: { name: name.value.trim().toLowerCase(), ...(alwaysOn && !alwaysOn.checked ? { always_on: false } : {}), ...(mine?.checked ? { mine: true } : {}), ...(runners ? { runners: true } : {}) } });
      view.machineToken = setupFor(machine, token, agent_url);
      name.value = '';
      status.textContent = '';
      show(false);
      renderMachineSetup();
      document.getElementById('machine-setup')?.scrollIntoView({ block: 'nearest' });
    } catch (err) {
      status.textContent = err.message;
    }
  };
  return { form, toggle, show };
}

/** Settings' Machines tab: add machines, show the line that connects one, tick what each lends, and remove them or replace their token. */
export function machinesPage(main = {}) {
  view.machineToken = null; // { id, name, token } just made, shown until you leave the page
  shownTokens.clear();
  const add = machineAddForm(false, 'Add machine');
  // A CI runner host is a different program with a different job, so it has its own add and install line (#439).
  const runners = machineAddForm(true, 'Add CI runner host');
  const section = h(
    'section',
    { class: 'artifacts-main machines-main' },
    h(
      'div',
      { class: 'ticket-head' },
      h('div', { class: 'row' }, ...settingsTitle(), h('span', { class: 'spacer' }), h('a', { class: 'close-view', href: `#/p/${view.projectId}`, title: 'Back to the Taskmaster', 'aria-label': 'Close' }, icon('close'))),
      settingsTabs(),
      h(
        'div',
        { class: 'meta' },
        account?.admin
          ? settingsHelp('Computers that lend their MCP tools to minions while they are connected, in the schemes listed under Who gets it.', 'They dial out to this app (over the tailnet, where one is set up), so it never has to reach them. Citadel checks each one as it connects and hourly.')
          : settingsHelp('Your computers, lending their MCP tools to the minion turns you ask for, in the schemes you list under Who gets it.', 'They dial out to this app (over the tailnet, where one is set up), so it never has to reach them. Only you and the admins can change them.'),
      ),
    ),
    // Connect a computer (Build 7 M2) is the way in; Add by name stays for a shared machine and the GPU jobs distro's line.
    h('div', { class: 'row machines-bar' }, h('h3', {}, 'Machines'), h('span', { class: 'spacer' }), h('button', { type: 'button', class: 'machine-connect-toggle', onclick: () => connectComputer() }, 'Connect a computer'), add.toggle),
    add.form,
    h('div', { id: 'machine-connect' }),
    h('div', { id: 'machine-setup' }),
    h('div', { id: 'machine-removals' }),
    h('div', { id: 'machine-list', class: 'machine-list' }),
    h('p', { id: 'emulator-lease', class: 'muted small', role: 'status' }, 'Android emulator: checking…'),
    // The CI desktop's load moved to the CI page (#968, Cara: "move the CI box performance page from machines into here"), since #1423 the Releases page's Overview tab.
    h('p', { class: 'muted small' }, "CI runners, their queue and the CI PCs' load are on ", h('a', { href: `#/p/${view.projectId}/ci` }, "the Releases page's Overview tab"), '.'),
    h('div', { class: 'row machines-bar runners-bar' }, h('span', { class: 'muted small' }, "A CI runner host adds and removes schemes' CI runners on its PC, for the schemes you lend it to."), h('span', { class: 'spacer' }), runners.toggle),
    runners.form,
    h('p', { class: 'muted small' }, 'Nothing typed here runs a command on a machine.'),
    h(
      'details',
      { class: 'small machine-facts' },
      h('summary', {}, 'What a lent machine can and cannot do'),
      h(
        'ul',
        { class: 'muted' },
        h('li', {}, h('strong', {}, 'One MCP server per machine.'), ' Add another machine for a second one.'),
        h('li', {}, h('strong', {}, 'How minions see it.'), ' Its tools as ', h('code', {}, 'mcp__<name>__…'), ', its ticked folders as ', h('code', {}, 'mcp__<name>-ws__…'), ': git sync and the tasks its owner lists, nothing else.'),
        h('li', {}, h('strong', {}, 'Commands live on that computer.'), ' Commands and tasks are only in ', h('code', {}, 'machine-agent.json'), ' there, beside the agent.'),
        h('li', {}, h('strong', {}, "A person's own machine"), " goes only to turns they ask for: their minions' turns in schemes they are in, and their contraptions' turns."),
        h('li', {}, h('strong', {}, 'When a minion gets it.'), " At the start of its turn: the tools of every machine online and lent to its scheme, plus the machine's notes."),
      ),
    ),
  );
  api('api/emulator-lease')
    .then((l) => {
      const el = document.getElementById('emulator-lease');
      if (!el) return;
      if (!l) el.textContent = 'Android emulator (citadel-android): free.';
      else el.textContent = `Android emulator (citadel-android): leased by ${l.who}${l.what ? ` for "${l.what}"` : ''}, until ${new Date(l.until).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.`;
    })
    .catch(() => document.getElementById('emulator-lease')?.remove());
  setTimeout(() => {
    // A link to one machine (#1638) opens its row, so its scheme list and ticks show at once.
    const focus = main.machine && view.machines?.find((m) => m.name === main.machine);
    if (focus) (view.machineOpen ??= new Set()).add(focus.id);
    renderMachineSetup();
    renderMachineList();
    if (focus) document.querySelector(`#machine-list .machine-row[data-name="${focus.name}"]`)?.scrollIntoView({ block: 'start' });
    if (!view.machines?.length) connectComputer();
  });
  return section;
}

let connectPanel = null;

/** Connect a computer's panel (Build 7 M2), for a new computer or, with `m`, an Update of an agent from before. */
function connectComputer(m = null) {
  const el = document.getElementById('machine-connect');
  if (!el) return;
  // One panel at a time: the one before stops watching its code, or its next look would draw over this one.
  connectPanel?.close({ quiet: true });
  connectPanel = openConnectPanel(el, { machine: m });
  el.scrollIntoView({ block: 'nearest' });
}

/** A machine just added or given a new token: what its install line needs. */
function setupFor(machine, token, url) {
  return { id: machine.id, name: machine.name, token, url: url ?? location.origin, runners: machine.runners };
}

function renderMachineSetup() {
  const el = document.getElementById('machine-setup');
  if (!el) return;
  const t = view.machineToken;
  if (!t) return el.replaceChildren();
  const ways = t.runners
    ? [
        {
          os: 'runner',
          tab: 'Windows',
          label: 'Administrator PowerShell on the Windows PC that hosts the CI runners (tools/ci-runner/README.md): installs the runner agent as a background task.',
          text: machineSetupRunnerAgent(t.url, t.token),
          note: 'It checks Node 18+ and Git for Windows, registers the task Citadel runner agent (SYSTEM, at startup), starts it and waits until this machine shows online. No reboot, and no runner is touched.',
        },
        {
          os: 'runner-linux',
          tab: 'Linux in WSL',
          label: 'Root shell in the CI runners\' WSL distro on the Windows PC (wsl -d citadel-ci -u root; tools/ci-runner/README.md, "Linux runners in WSL"): installs the Linux runner agent as a systemd service.',
          text: machineSetupRunnerAgentLinux(t.url, t.token),
          note: "The first time, it sets up /etc/wsl.conf and asks you to restart the distro and paste this again. Then it installs Node, git and the runner's libraries, starts the agent and waits until this machine shows online. Use a host of its own for this, not the Windows agent's.",
        },
        {
          os: 'runner-plain',
          tab: 'Linux',
          label: 'Root shell (sudo -i) on a Linux PC (tools/ci-runner/README.md, "Linux runners on plain Linux"): installs the same agent as a systemd service. CI jobs run as a user of their own, with no sudo.',
          text: machineSetupRunnerAgentLinux(t.url, t.token),
          note: "It installs Node, git and the runner's libraries where they are missing (Debian or Ubuntu; elsewhere it names what to install), starts the agent and waits until this machine shows online. All CI there is held to 75% of the PC, or the owner's own number in /opt/citadel-runner-agent/caps.json.",
        },
      ]
    : [
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
  const os = t.runners ? (view.runnerSetupOs ?? 'runner') : view.machineSetupOs;
  const copy = h('button', { type: 'button', class: 'secondary small' }, 'Copy');
  copy.onclick = async () => {
    copy.textContent = (await copyText(ways.find((w) => w.os === os).text)) ? 'Copied' : "Couldn't copy";
  };
  const pick = (to) => {
    if (t.runners) view.runnerSetupOs = to;
    else view.machineSetupOs = to;
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
      t.runners ? '' : h('p', { class: 'small' }, `Once it connects, ${t.name}'s line below shows the MCP servers and folders it found there: open it and tick what to lend.`),
    ),
  );
}

/** The setup to show first: the viewer's own kind of computer, as the browser says it (a phone gets Windows). */
function guessOs() {
  const platform = navigator.userAgentData?.platform || navigator.platform || '';
  return /mac|linux|x11|cros/i.test(platform) && !/android/i.test(`${platform} ${navigator.userAgent}`) ? 'posix' : 'windows';
}

function renderMachineList() {
  const el = document.getElementById('machine-list');
  if (!el) return;
  view.machineOpen ??= new Set();
  renderRemovals(document.getElementById('machine-removals'), renderMachineList);
  const scheme = view.project?.name ?? 'This scheme';
  const runners = view.machines.filter((m) => m.runners);
  const ours = view.machines.filter(oursHere);
  const others = view.machines.filter((m) => !m.runners && !ours.includes(m));
  const group = (title, list) => (list.length ? [h('h3', { class: 'settings-section' }, title), h('div', { class: 'settings-rows' }, ...list.map(machineLine))] : []);
  // A field someone is typing in keeps its place over a redraw.
  const at = el.contains(document.activeElement) && document.activeElement.id ? document.activeElement : null;
  el.replaceChildren(...group(`${scheme}'s minions get`, ours), ...group(ours.length ? 'Other machines' : 'Machines', others), ...group('CI runners', runners), view.machines.length ? '' : h('p', { class: 'muted small' }, 'No machines yet.'));
  const back = at && document.getElementById(at.id);
  if (!back || back === document.activeElement) return;
  // What was typed, half-typed included, and whether it is refused, stay as the person left them.
  if (typeof at.value === 'string' && 'value' in back) back.value = at.value;
  if (at.hasAttribute('aria-invalid')) back.setAttribute('aria-invalid', at.getAttribute('aria-invalid'));
  back.focus({ preventScroll: true });
  if (at.selectionStart != null) back.setSelectionRange(at.selectionStart, at.selectionEnd);
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
  const { machine, token, agent_url } = await api(`api/machines/${m.id}/token`, { method: 'POST' }).catch((err) => alert(err.message) ?? {});
  if (!token) return;
  shownTokens.delete(m.id); // the old one stopped working
  forgetWorkerLink(m.id);
  view.machineToken = setupFor(machine, token, agent_url);
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
    .catch((err) => toast(`Couldn't check ${m.name}: ${err.message}`, { tone: 'error' }))
    // The broadcast has redrawn the row by now; this is for one that didn't.
    .finally(() => {
      if (button.isConnected) {
        button.disabled = false;
        button.textContent = 'Check now';
      }
    });
}

const schemeName = (id) => (view.projects ?? []).find((p) => p.id === id)?.name ?? `scheme ${id}`;

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
 * One switch for the machine's GPU jobs (#1175, Josh's pick): shown once a lent folder has the GPU task, and while off.
 * next(off) is the lend to save.
 */
function gpuSwitch(lend, lent, next, save) {
  if (!lend?.gpu_off && !lent.some((w) => w.tasks?.some((t) => t.name === 'run-gpu'))) return '';
  const box = h('input', { type: 'checkbox', checked: !lend?.gpu_off });
  box.onchange = () => save(next(!box.checked));
  return h('div', { class: 'machine-found' }, h('div', { class: 'muted small' }, 'GPU jobs'), h('label', { class: 'row small' }, box, h('span', {}, h('code', {}, 'run-gpu'), h('span', { class: 'muted' }, lend?.gpu_off ? ' · off: refused until ticked again' : ' · untick to refuse them and stop one running'))));
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
      gpuSwitch(
        m.lend,
        m.workspace_tools ? workspaces : [],
        (off) => ({ server: null, workspaces: [], before_ticks: true, ...(m.lend?.worker ? { worker: true } : {}), ...(off ? { gpu_off: true } : {}) }),
        (next) => patchMachine(m, { lend: next }, `switch GPU jobs for ${m.name}`, renderMachineList),
      ),
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
  const { gpu_off: _, ...gpuOn } = lend;
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
    gpuSwitch(
      lend,
      workspaces.filter((w) => lend.workspaces.includes(w.name)),
      (off) => (off ? { ...gpuOn, gpu_off: true } : gpuOn),
      save,
    ),
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
function machineLine(m) {
  const open = () => {
    view.machineOpen.add(m.id);
    renderMachineList();
  };
  const gone = removing(m);
  const [workWord, workHue] = gone ? ['Removing…', 'waiting'] : (workerWord(m) ?? []);
  const word = workWord ?? { ready: 'Ready', fix: 'Needs a fix', down: 'Down', asleep: 'Asleep', checking: 'Checking' }[m.status];
  const isOpen = view.machineOpen.has(m.id);
  const fix = !gone && fixButton(m, open);
  const [row, sum] = settingsRow({ icon: m.runners ? 'plug' : 'monitor', hue: workHue ?? { ready: 'done', fix: 'waiting', down: 'danger' }[m.status] ?? 'muted', title: m.name, summary: `${word} · ${machineStatusText(m)}`, open: isOpen }, machineBody(m));
  // An agent from before reports nothing (Build 7 M2): Update gives the command that puts the new one in its place.
  const update = m.update && !gone && managesHere(m) && h('button', { type: 'button', class: 'secondary small', title: 'Its agent is from before: the new one says what this PC can do. Opens the command that replaces it', onclick: () => connectComputer(m) }, 'Update');
  // The fix stays on the closed line (#437, take A); a button inside a summary doesn't toggle the row.
  if (fix || update) sum.after(h('span', { class: 'machine-fix' }, update || '', fix || ''));
  row.classList.add('machine-row', 'machine-line', m.status);
  row.dataset.name = m.name;
  row.addEventListener('toggle', () => {
    if (row.open === view.machineOpen.has(m.id)) return;
    view.machineOpen[row.open ? 'add' : 'delete'](m.id);
  });
  return row;
}

/** A machine's line opened: what it lends, who gets it, its computer, notes and its buttons. */
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
      m.runners ? kv('Does', 'Adds, lists and removes CI runners for schemes, when Citadel asks') : kv('Lends', machineLends(m)),
      m.runners ? kv('Runs CI for', m.owner_id === null && !m.scoped ? 'Every scheme an admin owns' : machineLending(m)) : kv('Who gets it', m.owner_id === null ? '' : h('div', { class: 'small muted' }, `Only turns ${m.created_by} asks for (and their contraptions), in:`), machineLending(m)),
      kv(
        'Computer',
        m.report ? h('div', { class: 'small' }, reportLine(m.report)) : '',
        h('span', {}, [m.host ?? m.worker?.host, m.online ? (m.command && !m.runners ? `runs ${m.command}` : '') : m.last_seen_at ? `last seen ${ago(m.last_seen_at)}` : m.worker?.host ? 'runs only minion turns' : 'never connected', m.sessions ? `${m.sessions} in use` : ''].filter(Boolean).join(' · ') || '—'),
        h('label', { class: 'row small always-on', title: 'On: offline over 5 minutes shows as Down. Off: a laptop that comes and goes shows as Asleep.' }, alwaysOn, h('span', {}, 'Always on')),
      ),
      // Not while it drains: its Minion turns switch would turn it back on.
      m.worker && !removing(m) ? h('div', { class: 'machine-wide' }, workerSection(m, renderMachineList)) : [],
      m.screen ? kv('Screen', machineScreen(m.screen)) : [],
      kv('Notes', machineNotes(m)),
      tokenIsMine(m) ? kv('Token', machineTokenShow(m)) : [],
    ),
    m.jobs ? machineJobsSection(m) : '',
    h('div', { class: 'row machine-buttons' }, m.runners ? '' : check, newToken, remove),
  );
}

/** Whether the viewer may relink this machine, as the server's managesMachine says: its owner, or an admin. */
const managesHere = (m) => !!account?.admin || (m.owner_id !== null && m.owner_id === account?.id);

/** Whether the viewer may show this machine's token (#1355): its owner's own, an admin's for a shared one (Cara, 2026-11-20, "Only its owner"). */
const tokenIsMine = (m) => (m.owner_id === null ? !!account?.admin : m.owner_id === account?.id);

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
  const old = document.querySelector(`.machine-notes[data-id="${m.id}"]`);
  const editing = old?.open;
  if (editing) notes.value = old.querySelector('textarea').value;
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

/** Which schemes' minions get a machine (#438): its one list, as chips with a remove button each, and "+ scheme". */
function machineLending(m) {
  const now = () => (view.machines?.find((x) => x.id === m.id) ?? m).projects ?? [];
  const save = (projects) => patchMachine(m, { projects }, `change which schemes get ${m.name}`, renderMachineList);
  const chips = now().map((id) =>
    h(
      'span',
      { class: 'chip scheme-chip' },
      h('span', {}, schemeName(id)),
      h(
        'button',
        {
          type: 'button',
          title: m.runners ? `Stop ${m.name} taking new runners for ${schemeName(id)}. Remove its runners first: ones already there keep running` : `Take ${m.name} from ${schemeName(id)}: its minions lose it now, mid-turn too`,
          'aria-label': `Remove ${schemeName(id)}`,
          onclick: () => save(now().filter((x) => x !== id)),
        },
        '×',
      ),
    ),
  );
  const rest = (view.projects ?? []).filter((p) => !now().includes(p.id));
  const add = h(
    'select',
    { class: 'add-scheme', 'aria-label': `Lend ${m.name} to a scheme`, hidden: !rest.length },
    h('option', { value: '' }, '+ scheme'),
    rest.map((p) => h('option', { value: p.id }, p.name)),
  );
  add.onchange = () => add.value && save([...now(), Number(add.value)]);
  return h('div', { class: 'machine-lending', 'data-id': m.id }, chips, chips.length ? '' : h('span', { class: 'muted small' }, 'No scheme gets it yet.'), add);
}
