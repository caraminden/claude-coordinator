// Connect a computer (Build 7 M2, specs/machine-connections.md section 2): one button, a panel with the OS guessed
// from this browser, and one tagged command carrying a join code (one use, 15 minutes). The panel watches the code:
// once the PC's agent swaps it and connects, it turns to Connected with what the PC reported, named from its
// hostname, which can be changed here. An agent from before reports nothing: its row's Update opens the same panel
// for that row.
/** @import { MachineJoin, MachineJoinLook, MachineReport, MachineRole, MachineRow } from './types.js' */
import { api, h, view } from './base.js';
import { toneChip } from './look.js';
import { SHARED_ROLES } from './machine-card.js';
import { cannot, changeRole, standing } from './machine-role-cards.js';
import { machineJoinPosix, machineJoinWindows } from './machine-setup.js';
import { adminFor, press, setupPart } from './role-setup-card.js';
import { lastRun, SETUP_ROLES } from './role-setup.js';
import { openDialog } from './ui/dialog.js';
import { markdownElement } from './ui/markdown.js';
import { toast } from './ui/status.js';

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
 * onDone runs when it is closed. wizard: step 1 of the Connect wizard, which has its own title and close, and hears
 * each change of state through onState.
 * @param {HTMLElement} el
 * inside: the computer a VM runs on (Build 10 H4), so its Update says to paste it in the VM, not on that computer.
 * @param {{ machine?: Pick<MachineRow, 'id' | 'name'> | null, inside?: string | null, onDone?: () => void, wizard?: boolean, onState?: (state: string, got: MachineRow | null) => void }} [opts]
 */
export function openConnectPanel(el, { machine = null, inside = null, onDone = () => {}, wizard = false, onState = () => {} } = {}) {
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
        wizard ? null : h('div', { class: 'row' }, h('strong', {}, machine ? `Update ${machine.name}` : 'Connect a computer'), h('span', { class: 'spacer' }), h('button', { type: 'button', class: 'secondary small', onclick: () => close() }, done ? 'Done' : 'Close')),
        done ? connected() : steps(way, command),
      ),
    );
    onState(st.state, st.got);
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
    machine && inside ? h('div', { class: 'cui-notice', 'data-tone': 'warn' }, `${machine.name} is a VM on ${inside}: paste this inside the VM, not on ${inside}, or ${inside}'s agent takes the VM's place.`) : '',
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
      wizard ? null : h('p', { class: 'small muted' }, 'Its line below shows what it found there. Switch on what it should lend from there.'),
    ];
  };
  make();
  return { close };
}

/** The open wizard's redraw, for the page's machines updates (a role's set-up steps move as its PC reports). @type {(() => void) | null} */
let wizardDraw = null;
/** Redraw the open Connect wizard, if any. */
export const connectWizardRedraw = () => wizardDraw?.();

/** @type {{ v: 'both' | 'me' | 'us', title: string, line: string }[]} */
const USES = [
  { v: 'both', title: 'Both', line: 'Your turns plus sharing' },
  { v: 'me', title: 'Just me', line: 'Your own worker pool' },
  { v: 'us', title: 'My schemes', line: 'CI, builds, tests, GPU' },
];

/**
 * The roles Citadel picks for a new computer from what it found and what it's for: Minion turns for me, every shared role it
 * can do for my schemes.
 * @template {{ role: string }} R
 * @param {{ roles?: R[] }} m
 * @param {'both' | 'me' | 'us'} use
 * @param {(r: R) => string | null} why why it can't do a role, or null
 * @returns {R[]}
 */
export function pickRoles(m, use, why) {
  const keys = [...(use === 'us' ? [] : ['turns']), ...(use === 'me' ? [] : SHARED_ROLES)];
  return keys.flatMap((k) => {
    const r = m.roles?.find((x) => x.role === k);
    return r && !why(r) ? [r] : [];
  });
}

/**
 * Connect a computer (Build 10 H3, take B's wizard): one modal, a bottom sheet on a phone, in 3 steps. 1 paste one line
 * (the join panel above); 2 what it's for: Both, Just me or My schemes, with the roles Citadel picked from what it found;
 * 3 set up: each role's live steps, and an administrator paste where one needs it (role-setup-card.js, M4's).
 * @param {{ redraw?: () => void }} [opts] the page's redraw, once roles are switched on
 */
export function openConnectWizard({ redraw = () => {} } = {}) {
  /** @type {{ state: string, got: MachineRow | null, use: 'both' | 'me' | 'us', setting: MachineRole[] | null, queue: MachineRole[] }} */
  const st = { state: 'making', got: null, use: 'both', setting: null, queue: [] };
  const panel = h('div', { class: 'machine-wizard-panel' });
  const rest = h('div', { class: 'machine-wizard-rest' });
  const bar = h('ol', { class: 'machine-wizard-steps', 'aria-label': 'Steps' });
  const done = h('button', { type: 'button', class: 'secondary small machine-wizard-close' }, 'Cancel');
  /** The newest view of the new computer: the page's, once it has it. */
  const now = () => /** @type {MachineRow | null} */ ((st.got && /** @type {MachineRow[] | undefined} */ (view?.machines)?.find((x) => x.id === st.got?.id)) ?? st.got);
  const draw = () => {
    const step = st.setting ? 2 : st.state === 'connected' ? 1 : 0;
    bar.replaceChildren(...['Paste one line', "What it's for", 'Set up'].map((t, i) => h('li', { 'data-state': i < step ? 'done' : i === step ? 'now' : 'todo', 'aria-current': i === step ? 'step' : null }, h('span', { class: 'machine-wizard-n' }, i < step ? '✓' : String(i + 1)), t)));
    done.textContent = step === 2 ? 'Done' : 'Cancel';
    panel.hidden = step === 2;
    rest.replaceChildren(...(step === 1 ? purpose() : step === 2 ? setting() : []));
    if (step === 2) next();
  };
  // A PC runs one Set up at a time (src/role-setup.ts): the next starts once the last one's run is done.
  const next = () => {
    const m = now();
    // A role already setting up (pressed on its card first) is under way: it leaves the queue.
    st.queue = st.queue.filter((q) => lastRun(m?.roles?.find((x) => x.role === q.role))?.done !== null);
    if (!m || !st.queue.length || m.roles?.some((x) => lastRun(x)?.done === null)) return;
    press(m, /** @type {MachineRole} */ (st.queue.shift()), 'setup', draw);
  };
  const purpose = () => {
    const m = /** @type {MachineRow} */ (now());
    const picks = pickRoles(m, st.use, (r) => cannot(m, r));
    const go = h('button', { type: 'button', disabled: !picks.length, title: picks.length ? undefined : 'It can’t do any of these: pick another' }, 'Set it up');
    go.onclick = () => {
      st.setting = picks;
      st.queue = [];
      draw();
      // Each role goes on (lent to every scheme you're in), then joins the Set up queue once its switch is saved (a
      // Retry from its toast included); one that fails stays off, with its toast, and the rest go on without it.
      for (const r of picks)
        (r.on ? Promise.resolve() : changeRole(m, r.role, { on: true }, `switch ${r.name} on on ${m.name}`, () => (redraw(), draw()))).then(
          () => {
            if (!SETUP_ROLES.includes(r.role)) return;
            st.queue.push(r);
            st.queue.sort((a, b) => picks.indexOf(a) - picks.indexOf(b));
            draw();
          },
          () => {},
        );
    };
    return [
      h('b', {}, "What's it for?"),
      h(
        'div',
        { class: 'machine-wizard-use', role: 'group', 'aria-label': "What it's for" },
        USES.map((u) => h('button', { type: 'button', 'aria-pressed': String(st.use === u.v), onclick: () => ((st.use = u.v), draw()) }, h('b', {}, u.title), h('span', { class: 'muted small' }, u.line))),
      ),
      h('p', { class: 'small muted' }, picks.length ? `Citadel picks the roles from what it found: ${picks.map((r) => r.name).join(', ')}. You can change each later on its card.` : 'It can’t do any of these roles, from what it found.'),
      h('div', { class: 'row machine-wizard-go' }, h('span', { class: 'spacer' }), go),
    ];
  };
  const setting = () => {
    const m = /** @type {MachineRow} */ (now());
    // The agent's one elevate script holds every role's administrator step (H2): its paste shows once, on the first role.
    const pasted = new Set();
    return [
      h('p', { class: 'small' }, `Setting up ${m.name}. Each role's steps show here as its PC does them; you can close this and follow them on its card.`),
      ...(st.setting ?? []).map((was) => {
        const r = m.roles?.find((x) => x.role === was.role) ?? was;
        const s = standing(m, r);
        // Queued behind another role's Set up: it says so, with no button to start a second one at once.
        if (st.queue.some((q) => q.role === r.role) && lastRun(r)?.done !== null)
          return h(
            'section',
            { class: 'machine-wizard-role', 'data-role': r.role },
            h('div', { class: 'row' }, h('b', {}, r.name), h('span', { class: 'spacer' }), toneChip('neutral', 'Waits its turn')),
            h('p', { class: 'muted small' }, 'Its Set up starts once the one before it is done: a computer sets up one role at a time.'),
          );
        const cmd = adminFor(m, r);
        const admin = !cmd || !pasted.has(cmd);
        if (cmd) pasted.add(cmd);
        return h('section', { class: 'machine-wizard-role', 'data-role': r.role }, h('div', { class: 'row' }, h('b', {}, r.name), h('span', { class: 'spacer' }), toneChip(s.tone, s.text)), setupPart(m, r, draw, { admin }));
      }),
    ];
  };
  let conn = /** @type {{ close: (o?: { quiet?: boolean }) => void } | null} */ (null);
  const dialog = openDialog({
    title: 'Connect a computer',
    className: 'machine-wizard',
    body: [bar, panel, rest, h('div', { class: 'row machine-wizard-foot' }, h('span', { class: 'spacer' }), done)],
    onClose: () => {
      conn?.close({ quiet: true });
      wizardDraw = null;
    },
  });
  done.onclick = () => dialog.close();
  wizardDraw = draw;
  conn = openConnectPanel(panel, {
    wizard: true,
    onState: (state, got) => {
      const was = st.state;
      st.state = state;
      st.got = got;
      if (state !== was || state === 'connected') draw();
    },
  });
  draw();
  return dialog;
}
