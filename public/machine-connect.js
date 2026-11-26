// Connect a computer (Build 7 M2, specs/machine-connections.md section 2): one button, a panel with the OS guessed
// from this browser, and one tagged command carrying a join code (one use, 15 minutes). The panel watches the code:
// once the PC's agent swaps it and connects, it turns to Connected with what the PC reported, named from its
// hostname, which can be changed here. An agent from before reports nothing: its row's Update opens the same panel
// for that row.
/** @import { MachineJoin, MachineJoinLook, MachineReport, MachineRow } from './types.js' */
import { api, h } from './base.js';
import { markdownElement } from './ui/markdown.js';
import { toast } from './ui/status.js';
import { machineJoinPosix, machineJoinWindows } from './machine-setup.js';

const OSES = [
  { os: 'windows', tab: 'Windows', tag: 'powershell', where: 'Open PowerShell on that PC (not as administrator) and paste this. It needs Node 18 or newer.' },
  { os: 'linux', tab: 'Linux', tag: 'bash', where: 'Open a terminal on that PC (no sudo) and paste this. It needs Node 18 or newer.' },
  { os: 'macos', tab: 'macOS', tag: 'bash', where: 'Open Terminal on the Mac (no sudo) and paste this. It needs Node 18 or newer.', note: 'A Mac lends tools and folders only: CI runners, Minion turns and the Windows screen need Windows or Linux.' },
];

/**
 * This browser's kind of computer; a phone or anything unknown gets Windows, the usual PC.
 * @param {string} [platform]
 * @param {string} [agent]
 * @returns {'windows' | 'linux' | 'macos'}
 */
export function guessJoinOs(platform = /** @type {Navigator & { userAgentData?: { platform?: string } }} */ (globalThis.navigator)?.userAgentData?.platform || globalThis.navigator?.platform || '', agent = globalThis.navigator?.userAgent ?? '') {
  if (/android|iphone|ipad/i.test(`${platform} ${agent}`)) return 'windows';
  if (/mac/i.test(platform)) return 'macos';
  return /linux|x11|cros/i.test(platform) ? 'linux' : 'windows';
}

/**
 * What a PC reported, in one line: "Windows 11, 32 threads, 64 GB, RTX 4080, WSL 2.3.26".
 * @param {MachineReport | null | undefined} r
 */
export function reportLine(r) {
  if (!r) return '';
  /** @param {number} n */
  const gb = (n) => `${n >= 10 ? Math.round(n) : n} GB`;
  return [
    r.os_name || r.os,
    r.threads ? `${r.threads} threads` : '',
    r.memory_gb ? gb(r.memory_gb) : '',
    r.disk_free_gb != null ? `${gb(r.disk_free_gb)} free` : '',
    r.gpu ?? '',
    r.wsl ? (r.wsl.present ? `WSL ${r.wsl.version ?? ''} ready`.replace('  ', ' ') : 'no WSL') : r.in_wsl ? 'inside WSL' : '',
    r.os === 'windows' && r.screen === false ? 'no one signed in' : '',
    r.admin ? 'admin available' : '',
  ]
    .filter(Boolean)
    .join(', ');
}

/** @param {number} at */
const when = (at) => new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

/**
 * The panel, drawn into `el`. machine: an Update of that row (an agent from before); none: a new computer.
 * onDone runs when it is closed.
 * @param {HTMLElement} el
 * @param {{ machine?: Pick<MachineRow, 'id' | 'name'> | null, onDone?: () => void }} [opts]
 */
export function openConnectPanel(el, { machine = null, onDone = () => {} } = {}) {
  /** @type {{ os: string, join: MachineJoin | null, state: string, got: MachineRow | null, timer: ReturnType<typeof setInterval> | 0, failed: string, closed?: boolean }} */
  const st = { os: guessJoinOs(), join: null, state: 'making', got: null, timer: 0, failed: '' };
  /** @param {{ quiet?: boolean }} [opts] */
  const close = ({ quiet = false } = {}) => {
    clearInterval(st.timer || undefined);
    st.closed = true;
    if (quiet) return;
    el.replaceChildren();
    onDone();
  };
  const make = () => {
    st.join = null;
    st.state = 'making';
    st.failed = '';
    draw();
    api(machine ? `api/machines/${machine.id}/join` : 'api/machines/joins', { method: 'POST' })
      .then((/** @type {MachineJoin} */ j) => {
        if (st.closed) return;
        st.join = j;
        st.state = 'waiting';
        draw();
        clearInterval(st.timer || undefined);
        st.timer = setInterval(look, 2000);
      })
      .catch((err) => {
        if (st.closed) return;
        st.state = 'failed';
        st.failed = err.message;
        draw();
      });
  };
  const look = () => {
    if (!el.isConnected) return clearInterval(st.timer || undefined);
    api(`api/machines/joins/${/** @type {MachineJoin} */ (st.join).id}`)
      .then((/** @type {MachineJoinLook} */ r) => {
        if (st.closed) return; // a look already on its way when the panel closed
        if (r.state === st.state && JSON.stringify(r.machine?.report) === JSON.stringify(st.got?.report)) return;
        st.state = r.state;
        st.got = r.machine;
        if (r.state === 'connected' || r.state === 'expired') clearInterval(st.timer || undefined);
        draw();
      })
      .catch(() => {}); // the next look tries again
  };
  const draw = () => {
    const way = /** @type {(typeof OSES)[number]} */ (OSES.find((w) => w.os === st.os)); // st.os is always one of them
    const command = st.join && (st.os === 'windows' ? machineJoinWindows : machineJoinPosix)(st.join.agent_url, st.join.code);
    const done = st.state === 'connected';
    el.replaceChildren(
      h(
        'div',
        { class: 'machine-setup machine-connect', role: 'region', 'aria-label': machine ? `Update ${machine.name}` : 'Connect a computer' },
        h('div', { class: 'row' }, h('strong', {}, machine ? `Update ${machine.name}` : 'Connect a computer'), h('span', { class: 'spacer' }), h('button', { type: 'button', class: 'secondary small', onclick: () => close() }, done ? 'Done' : 'Close')),
        done ? connected() : steps(way, command),
      ),
    );
  };
  /** @param {(typeof OSES)[number]} way @param {string | null} command */
  const steps = (way, command) => [
    h(
      'div',
      { class: 'row machine-setup-ways' },
      h(
        'div',
        { class: 'row', role: 'group', 'aria-label': 'Which computer' },
        OSES.map((w) =>
          h(
            'button',
            {
              type: 'button',
              class: `chip${w.os === st.os ? ' on' : ''}`,
              'aria-pressed': String(w.os === st.os),
              onclick: () => {
                st.os = w.os;
                draw();
              },
            },
            w.tab,
          ),
        ),
      ),
    ),
    machine ? h('p', { class: 'small' }, `This replaces the agent on ${machine.name}: it keeps its name and what it lends.`) : '',
    h('p', { class: 'small' }, way.where),
    command ? markdownElement(`\`\`\`${way.tag}\n${command}\n\`\`\``) : h('pre', { class: 'muted' }, st.state === 'failed' ? 'No code yet.' : 'Making a code…'),
    way.note ? h('p', { class: 'small muted' }, way.note) : '',
    status(),
  ];
  // Where the code stands, as a toned notice (Citadel's look: a status is never a bare grey sentence).
  const status = () => {
    /** @param {string} label */
    const again = (label) => h('button', { type: 'button', class: 'secondary small', onclick: make }, label);
    /** @param {string} tone @param {...(string | HTMLElement)} kids */
    const notice = (tone, ...kids) => h('div', { class: 'cui-notice machine-connect-status', 'data-tone': tone, role: 'status' }, ...kids);
    if (st.state === 'failed') return notice('danger', h('span', {}, `Couldn't make a code: ${st.failed} `), again('Try again'));
    if (st.state === 'making') return '';
    if (st.state === 'expired') return notice('warn', h('span', {}, 'This code ran out before a computer used it. '), again('New code'));
    if (st.state === 'joined') return notice('info', h('strong', {}, `It took the code${st.got ? ` as ${st.got.name}` : ''}`), ': waiting for its agent to connect…');
    return [notice('info', h('strong', {}, 'Waiting for the computer…')), h('p', { class: 'small muted' }, `The code works once, until ${when(/** @type {MachineJoin} */ (st.join).expires_at)}. It installs the agent as a service of your own and needs no admin.`)];
  };
  const connected = () => {
    const m = /** @type {MachineRow} */ (st.got);
    const name = h('input', { value: m.name, maxlength: 30, pattern: '[a-z0-9][a-z0-9\\-]*', 'aria-label': 'Its name', autocomplete: 'off' });
    const save = h('button', { type: 'button', class: 'secondary small' }, 'Rename');
    const rename = () => {
      const to = name.value.trim().toLowerCase();
      if (!to || to === m.name) return;
      const was = m.name;
      m.name = to; // shown at once; a refusal puts it back
      draw();
      api(`api/machines/${m.id}`, { method: 'PATCH', body: { name: to } }).catch((err) => {
        m.name = was;
        draw();
        toast(`Couldn't rename ${was}: ${err.message}`, { tone: 'danger', action: { label: 'Retry', run: rename } });
      });
    };
    save.onclick = rename;
    return [
      h('p', { class: 'cui-notice', 'data-tone': 'ok', role: 'status' }, h('strong', {}, `Connected: ${m.name}`), m.report ? `, ${reportLine(m.report)}` : ''),
      h('div', { class: 'row machine-connect-name' }, h('label', { class: 'small' }, 'Name ', name), save),
      h('p', { class: 'small muted' }, 'Its line below shows what it found there. Switch on what it should lend from there.'),
    ];
  };
  make();
  return { close };
}
