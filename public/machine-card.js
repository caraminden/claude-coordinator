// The Machines page's card per computer (Build 10 H3, take B; Cara, 2026-11-26, "Two switches: for me, for my schemes";
// specs/one-kind-of-machine.md section 4): a header with what the PC has, a "For me" tile (Minion turns) and a "For my
// schemes" tile (every shared role) each with a big switch, "Choose what it shares" one level down, and a bar of how its
// threads split now from live numbers only. Every switch shows at once with its request behind (ui/optimistic.js).
import { account, h, view } from './base.js';
import { toneChip } from './look.js';
import { cannot, capsLine, changeRole, managesRoles, orderLine, roleOf, schemeChips, standing } from './machine-role-cards.js';
import { heldCaps, signInPart, workerSection, workerState } from './machine-worker-row.js';
import { setupPart } from './role-setup-card.js';
import { lastRun } from './role-setup.js';

/** @import { MachineRole, MachineRoleKey, MachineRow, WorkerMachine } from './types.js' */
/** @typedef {() => void} Redraw */
/** @typedef {{ cores: number, cpu: number, runners: number, wsl: number | null, vms: Record<string, number> }} PcNow one PC's load now (src/ci-load.ts PcView.now) */
/** @typedef {{ pcs: { host: string, now: PcNow | null }[], pool: WorkerMachine[] }} Live what api/ci-desktop and api/workers last said */

/** The roles a PC lends to its owner's schemes, in the page's order (spec section 3). @type {MachineRoleKey[]} */
export const SHARED_ROLES = ['ci', 'builds', 'screen', 'gpu', 'tools'];

/** Which cards and parts are open, over redraws, by machine id. @type {Map<number, { choose: boolean, me: boolean, role: string | null }>} */
const open = new Map();
/** @param {number} id */
const openFor = (id) => open.get(id) ?? open.set(id, { choose: false, me: false, role: null }).get(id) ?? { choose: false, me: false, role: null };

/** A card of the viewer's own: their computer (every machine has an owner, #2184). @param {MachineRow} m */
export const isMine = (m) => m.owner_id === account?.id;

/** It stopped calling in: the agent is gone and no worker is here. @param {MachineRow} m */
const away = (m) => !m.online && !m.worker?.here;

/**
 * What the For my schemes switch does: with any shared role on, switch those off (they drain); with none on, switch on
 * every one this PC can do. Returns the roles to flip and which way.
 * @param {{ role: string, on: boolean }[]} roles the PC's shared roles
 * @param {(role: string) => boolean} can whether it can do a role that's off
 * @returns {{ on: boolean, roles: string[] }}
 */
export function sharedFlip(roles, can) {
  const on = roles.filter((r) => r.on);
  if (on.length) return { on: false, roles: on.map((r) => r.role) };
  return { on: true, roles: roles.filter((r) => can(r.role)).map((r) => r.role) };
}

/**
 * The thread split bar's parts, in threads, from live numbers only (Josh, 2026-11-26, "progress bars match reality"; spec
 * section 4: a part with no live number is left out, never guessed). `busy` is the PC's whole CPU now: free is what it
 * leaves idle, and what's busy beyond the measured schemes and me parts is "other" (the PC's own programs, or a part
 * that's on with no number). Schemes take their share of busy first, me what's left of it.
 * @param {{ total: number | null, busy: number | null, me: number | null, us: number | null, meOn: boolean, usOn: boolean }} n
 * @returns {{ part: 'me' | 'us' | 'other' | 'free', n: number }[]}
 */
export function threadParts({ total, busy, me, us, meOn, usOn }) {
  if (!total || busy == null) return [];
  let left = Math.max(0, Math.min(busy, total));
  /** @param {number | null} n @param {boolean} on */
  const take = (n, on) => {
    const k = on && n ? Math.min(Math.max(0, n), left) : 0;
    left -= k;
    return k;
  };
  const u = take(us, usOn);
  const m = take(me, meOn);
  /** @type {[ 'me' | 'us' | 'other' | 'free', number ][]} */
  const all = [
    ['me', m],
    ['us', u],
    ['other', left],
    ['free', total - Math.max(0, Math.min(busy, total))],
  ];
  return all.filter(([, n]) => n > 0).map(([part, n]) => ({ part, n }));
}

/** Its load now from the CI PCs' samples, matched by hostname; null when its runner agent sends none. @param {MachineRow & { host?: string | null }} m @param {Live | null} live */
const pcOf = (m, live) => {
  const host = (m.report?.host ?? m.host ?? '').toLowerCase();
  return (host && live?.pcs.find((p) => p.host.toLowerCase() === host)?.now) || null;
};

/** @param {number} at */
const clock = (at) => new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });

/** "Online, 45% busy", "Away since 9:12 PM PST". @param {MachineRow} m @param {PcNow | null} pc */
function statusLine(m, pc) {
  if (away(m)) return m.last_seen_at ? `Away since ${clock(m.last_seen_at)}` : 'Never connected';
  return pc ? `Online, ${Math.round(pc.cpu)}% busy` : 'Online';
}

/** The specs and capability chips (VM, WSL, GPU, a signed-in screen) from what its agent reported. @param {MachineRow} m @param {PcNow | null} pc */
function chips(m, pc) {
  const r = m.report;
  /** @param {number} n */
  const gb = (n) => `${n >= 10 ? Math.round(n) : n} GB`;
  const specs = r ? [r.os_name || r.os, r.threads ? `${r.threads} threads` : '', r.memory_gb ? gb(r.memory_gb) : '', r.disk_free_gb != null ? `${gb(r.disk_free_gb)} free` : ''].filter(Boolean) : [];
  const caps = r ? [r.wsl?.present ? `WSL${r.wsl.version ? ` ${r.wsl.version.split('.')[0]}` : ''}` : '', r.gpu ?? '', r.os === 'windows' && r.screen ? 'Signed-in screen' : ''].filter(Boolean) : [];
  // Its VM rows (Build 10 H4) and the VMs its samples saw, once each.
  const vms = [...new Set([...(m.vms ?? []).map((v) => v.name), ...Object.keys(pc?.vms ?? {})])].map((n) => `VM: ${n}`);
  if (!specs.length && !caps.length && !vms.length) return null;
  return h('span', { class: 'mcard-specs' }, ...specs.map((x) => h('span', {}, x)), ...[...caps, ...vms].map((x) => h('span', { class: 'cap' }, x)));
}

/** A big switch. @param {{ on: boolean, label: string, disabled?: boolean, title?: string, onclick: () => void }} o */
const bigSwitch = ({ on, label, disabled = false, title, onclick }) => h('button', { type: 'button', class: 'rules-switch mcard-switch', role: 'switch', 'aria-checked': String(on), 'aria-label': label, disabled, title, onclick });

/** A link-styled toggle with its arrow. @param {string} text @param {boolean} isOpen @param {() => void} onclick @param {string} [cls] */
const opener = (text, isOpen, onclick, cls = '') => h('button', { type: 'button', class: `link small mcard-open ${cls}`.trim(), 'aria-expanded': String(isOpen), onclick }, `${text} ${isOpen ? '▴' : '▾'}`);

/**
 * The For me tile: Minion turns, by how the worker stands.
 * @param {MachineRow} m @param {Live | null} live @param {Redraw} redraw
 */
function meTile(m, live, redraw) {
  const r = roleOf(m, 'turns');
  const w = m.worker;
  const o = openFor(m.id);
  const gone = away(m);
  const why = r ? cannot(m, r) : 'Its roles show once the server has them.';
  const st = w?.on ? workerState(m) : null;
  const need = st?.word === 'Needs a Claude sign-in';
  const installed = !!w?.host || !!w?.here;
  const flip = (/** @type {boolean} */ on) => {
    if (!r) return;
    // The worker follows its role on the server; set it here too so the tile changes at once.
    const shown = { on };
    changeRole(
      m,
      'turns',
      { on },
      `switch Minion turns ${on ? 'on' : 'off'} on ${m.name}`,
      () => {
        if (m.worker) m.worker.on = !!roleOf(m, 'turns')?.on;
        redraw();
      },
      shown,
    );
  };
  const pool = live?.pool.find((p) => p.id === m.id);
  const caps = heldCaps(m);
  let big;
  let sub = 'Your own minion turns, on your own Claude sign-in here. Nobody else’s.';
  if (why && !r?.on) [big, sub] = ['Can’t run turns here', why];
  else if (!r?.on && !installed) big = 'Not set up';
  else if (gone) big = 'Away';
  else if (!r?.on) big = 'Off';
  else if (!installed) [big, sub] = ['Not set up', 'Set it up once on that PC: the worker, then your Claude sign-in there.'];
  else if (need) [big, sub] = ['Sign in to Claude here', 'The login stays on this PC; only your turns use it.'];
  else if (st?.word === 'Ready') big = pool ? `My worker pool: ${pool.used} of ${pool.size} busy` : `My worker pool: up to ${caps?.workers ?? '?'} at once`;
  else [big, sub] = [st?.word ?? 'Off', st?.why ?? sub];
  // Not set up and off: Set up in the switch's place (spec section 4) switches it on and opens its steps.
  const control =
    !r?.on && !installed && !why && managesRoles(m)
      ? h('button', { type: 'button', class: 'small secondary', onclick: () => ((o.me = true), flip(true)) }, 'Set up')
      : bigSwitch({ on: !!r?.on, label: `Minion turns on ${m.name}`, disabled: gone || !managesRoles(m) || (!!why && !r?.on), title: why ?? (r?.on ? 'Off: what runs finishes, nothing new starts' : 'Let your own minions run on this PC'), onclick: () => flip(!r?.on) });
  const tone = need ? 'need' : r?.on && !gone ? 'on' : '';
  return h(
    'div',
    { class: `mcard-tile me ${tone}`.trim() },
    h('div', { class: 'mcard-tile-head' }, h('span', { class: 'mcard-ttl' }, 'For me'), h('span', { class: 'spacer' }), control),
    h('div', { class: 'mcard-big' }, big),
    h('div', { class: 'muted small' }, sub),
    need && w?.here && !gone ? signInPart(m) : null,
    r?.on && w ? opener(installed ? 'Its worker' : 'Set-up steps', o.me, () => ((o.me = !o.me), redraw())) : null,
  );
}

/**
 * The For my schemes tile: one switch for every shared role it can do.
 * @param {MachineRow} m @param {Redraw} redraw
 */
function usTile(m, redraw) {
  const o = openFor(m.id);
  const roles = SHARED_ROLES.map((k) => roleOf(m, k)).filter((r) => !!r);
  const on = roles.filter((r) => r.on);
  const gone = away(m);
  const can = managesRoles(m);
  const plan = sharedFlip(roles, (k) => {
    const r = roleOf(m, /** @type {MachineRoleKey} */ (k));
    return !!r && !cannot(m, r);
  });
  const flip = () => {
    for (const k of plan.roles) {
      const r = /** @type {MachineRole} */ (roleOf(m, /** @type {MachineRoleKey} */ (k)));
      const shown = plan.on && !r.projects.length && m.owner_id === account?.id ? { on: true, projects: (view?.projects ?? []).map((p) => p.id) } : { on: plan.on };
      changeRole(m, r.role, { on: plan.on }, `switch ${r.name} ${plan.on ? 'on' : 'off'} on ${m.name}`, redraw, shown);
    }
  };
  const schemes = new Set(on.flatMap((r) => r.projects));
  return h(
    'div',
    { class: `mcard-tile us ${on.length && !gone ? 'on' : ''}`.trim() },
    h(
      'div',
      { class: 'mcard-tile-head' },
      h('span', { class: 'mcard-ttl' }, 'For my schemes'),
      h('span', { class: 'spacer' }),
      bigSwitch({ on: on.length > 0, label: `Share ${m.name}`, disabled: gone || !can || !plan.roles.length, title: !can ? 'Only its owner or an admin changes this' : on.length ? 'Off: what runs finishes, nothing new starts' : 'On: every role it can do, lent to every scheme you’re in', onclick: flip }),
    ),
    h('div', { class: 'mcard-big' }, gone ? 'Away' : on.length ? `Sharing ${on.length} thing${on.length === 1 ? '' : 's'}` : 'Not shared'),
    h('div', { class: 'muted small' }, on.length ? `${on.map((r) => r.name).join(', ')} · ${schemes.size} scheme${schemes.size === 1 ? '' : 's'}` : 'CI, builds, tests and GPU jobs for every scheme you’re in'),
    roles.length ? opener(o.choose ? 'Done choosing' : 'Choose what it shares', o.choose, () => ((o.choose = !o.choose), redraw()), 'mcard-choose-open') : null,
  );
}

/**
 * Choose what it shares: one row per role for my schemes with its tick, state, "N schemes" (opens its chips) and limit.
 * @param {MachineRow} m @param {Redraw} redraw @param {() => Node | null} [tools] the Tools ticks
 */
function chooseRows(m, redraw, tools) {
  const o = openFor(m.id);
  const can = managesRoles(m);
  const rows = SHARED_ROLES.map((k) => roleOf(m, k))
    .filter((r) => !!r)
    .map((r) => {
      const why = cannot(m, r);
      const st = standing(m, r);
      const tick = h('input', { type: 'checkbox', checked: r.on, disabled: !can || away(m) || (!!why && !r.on), 'aria-label': `${r.name} on ${m.name}` });
      tick.onchange = () => {
        const on = !roleOf(m, r.role)?.on;
        const shown = on && !r.projects.length && m.owner_id === account?.id ? { on, projects: (view?.projects ?? []).map((p) => p.id) } : { on };
        changeRole(m, r.role, { on }, `switch ${r.name} ${on ? 'on' : 'off'} on ${m.name}`, redraw, shown);
      };
      const isOpen = o.role === r.role;
      const n = r.projects.length;
      return h(
        'div',
        { class: 'mcard-choose-row', 'data-role': r.role, 'data-on': String(r.on), 'aria-disabled': String(!!why && !r.on), title: why ?? undefined },
        h('label', { class: 'mcard-tick' }, tick, h('b', {}, r.name)),
        h('span', { class: 'mcard-choose-state' }, why && !r.on ? h('span', { class: 'muted small' }, why) : toneChip(st.tone, st.text)),
        r.on ? opener(`${n} scheme${n === 1 ? '' : 's'}`, isOpen, () => ((o.role = isOpen ? null : r.role), redraw())) : null,
        // #2184: its owner lent it to every turn in those schemes; without it only their own turns use it.
        r.on && r.caps?.everyone ? h('span', { title: `Every turn in its schemes can use it, not only its owner's` }, toneChip('info', "Everyone's turns")) : null,
        r.on && (r.role === 'ci' || r.role === 'builds') ? capsLine(m, r, redraw) : null,
        isOpen && r.on ? h('div', { class: 'mcard-choose-more' }, schemeChips(m, r, redraw), r.role === 'tools' ? (tools?.() ?? null) : null, setupPart(m, r, redraw)) : null,
      );
    });
  return h('div', { class: 'mcard-choose', role: 'group', 'aria-label': `What ${m.name} shares` }, ...rows);
}

/** How its threads split now: me (turns' threads), schemes (CI runners and VMs, from its samples) and free. @param {MachineRow} m @param {PcNow | null} pc */
function splitBar(m, pc) {
  if (away(m)) return null; // nothing live to split
  const total = m.report?.threads ?? pc?.cores ?? null;
  const turns = roleOf(m, 'turns');
  const meOn = !!turns?.on && !!m.worker?.here;
  const usRoles = SHARED_ROLES.map((k) => roleOf(m, k)).filter((r) => r?.on);
  const usOn = usRoles.length > 0 && !away(m);
  const screenOn = !!roleOf(m, 'screen')?.on;
  /** Its share of the PC now, in threads. @param {number | null | undefined} pct */
  const threads = (pct) => (pc && total && pct != null ? Math.round((pct / 100) * total) : null);
  const usPct = pc ? pc.runners + (screenOn ? Object.values(pc.vms).reduce((a, x) => a + x, 0) : 0) : null;
  // Me is WSL's CPU, where turns run; a PC whose turns don't run in WSL has no live number for them, so they count as other.
  // shortcut: Linux CI runners inside WSL count in both WSL and runners (schemes take theirs first); split them once the runner agent reports WSL's own.
  const parts = threadParts({ total, busy: threads(pc?.cpu), me: threads(pc?.wsl), us: threads(usPct), meOn, usOn });
  if (!parts.length || !total) return null;
  const word = { me: 'me', us: 'schemes', other: 'other', free: 'free' };
  const bar = h(
    'div',
    { class: 'mcard-split', role: 'img', 'aria-label': `${total} threads: ${parts.map((p) => `${word[p.part]} ${p.n}`).join(', ')}` },
    ...parts.map((p) => {
      const el = h('div', { class: p.part }, `${word[p.part]} ${p.n}`);
      el.style.setProperty('flex-basis', `${(p.n / total) * 100}%`);
      return el;
    }),
  );
  const builds = roleOf(m, 'builds');
  const caps = [turns?.on && heldCaps(m)?.threads != null ? `turns up to ${heldCaps(m)?.threads}` : '', builds?.on && builds.caps.threads != null ? `builds up to ${builds.caps.threads}` : ''].filter(Boolean);
  return h('div', { class: 'mcard-split-wrap' }, bar, h('div', { class: 'muted small' }, `${total} threads. Citadel shares them out as the work comes${caps.length ? `; your caps: ${caps.join(', ')}` : ''}.`));
}

/**
 * One computer's card.
 * @param {MachineRow} m
 * @param {{ live: Live | null, redraw: Redraw, tools?: () => Node | null, head?: Node | null, details?: () => Node }} ctx
 */
export function machineCard(m, { live, redraw, tools, head = null, details }) {
  const o = openFor(m.id);
  const pc = pcOf(m, live);
  const gone = away(m);
  const roles = SHARED_ROLES.map((k) => roleOf(m, k)).filter((r) => !!r);
  // A role switched off while others share: say so, with the way back (the mock's "a role off" scene).
  const offs = roles.filter((r) => !r.on && !cannot(m, r));
  const turns = roleOf(m, 'turns');
  // Its computer, notes, token and Remove, closed until asked for; it stays as the person left it over a redraw.
  const more = h('details', { class: 'mcard-details', open: !!view?.machineOpen?.has(m.id) }, h('summary', { class: 'small' }, 'Details: its computer, notes, token, remove'));
  if (more.open && details) more.append(details());
  more.addEventListener('toggle', () => {
    if (more.open && view) (view.machineOpen ??= new Set()).add(m.id);
    else view?.machineOpen?.delete(m.id);
    if (more.open && more.childElementCount === 1 && details) more.append(details());
  });
  return h(
    'div',
    { class: `mcard${gone ? ' away' : ''}`, 'data-name': m.name, 'data-id': String(m.id) },
    h('div', { class: 'mcard-head' }, h('span', { class: `dot ${gone ? 'asleep' : m.status}` }), h('h4', {}, m.name), h('span', { class: 'muted small' }, statusLine(m, pc)), h('span', { class: 'spacer' }), chips(m, pc), head),
    h('div', { class: 'mcard-tiles' }, meTile(m, live, redraw), usTile(m, redraw)),
    // Its worker once it's here, and Minion turns' Set up steps (an administrator paste among them) until they pass.
    o.me && turns?.on ? h('div', { class: 'mcard-me-more' }, m.worker ? workerSection(m, redraw, { bare: true }) : null, !m.worker?.here || lastRun(turns)?.ok !== true ? setupPart(m, turns, redraw) : null, m.worker ? capsLine(m, turns, redraw) : null, m.worker ? orderLine(m, redraw) : null) : null,
    o.choose ? chooseRows(m, redraw, tools) : null,
    !o.choose && !gone && roles.some((r) => r.on) && offs.length ? h('div', { class: 'muted small' }, `${offs.map((r) => r.name).join(', ')} ${offs.length === 1 ? 'is' : 'are'} off. `, h('button', { type: 'button', class: 'link small', onclick: () => ((o.choose = true), redraw()) }, 'Change')) : null,
    splitBar(m, pc),
    details ? more : null,
  );
}

/**
 * Whose computer it is: the owner's name where the workers pool has it (its row is by owner_id), else who added it, which
 * Connect makes the owner.
 * @param {MachineRow & { created_by?: string }} m
 * @param {Live | null} live
 */
export const ownerName = (m, live) => live?.pool.find((p) => p.id === m.id)?.owner ?? m.created_by ?? 'someone';

/**
 * Others' computers lent to the viewer's schemes, as one read-only line with their owners; hover says what, and for which.
 * @param {MachineRow[]} machines
 * @param {Live | null} [live]
 */
export function lentLine(machines, live = null) {
  const names = new Map((view?.projects ?? []).map((p) => [p.id, p.name]));
  const lent = machines
    .filter((m) => !isMine(m))
    .map((m) => ({ m, on: (m.roles ?? []).filter((r) => r.on && r.projects.some((id) => names.has(id))) }))
    .filter((x) => x.on.length);
  if (!lent.length) return null;
  const owner = (/** @type {MachineRow} */ m) => ownerName(m, live);
  return h(
    'p',
    { class: 'muted small mcard-lent' },
    'Lent to your schemes by others: ',
    ...lent.flatMap(({ m, on }, i) => [
      i ? ', ' : '',
      h(
        'span',
        {
          class: 'mcard-lent-one',
          tabindex: '0',
          title: on
            .map(
              (r) =>
                `${r.name}, for ${r.projects
                  .map((id) => names.get(id))
                  .filter(Boolean)
                  .join(', ')}`,
            )
            .join('; '),
        },
        h('b', {}, m.name),
        ` (${owner(m)})`,
      ),
    ]),
  );
}
