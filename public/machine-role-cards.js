// A machine's roles' parts on the Machines page (Build 7 M3, specs/machine-connections.md sections 4 and 7; laid out by
// machine-card.js since Build 10 H3's take B): why a role can't run, how it stands, the schemes it is lent to as chips, its
// caps and fill order; and Pause all. Switching a role on lends it to every scheme its owner is
// in (the server's doing, "Every scheme you're in"); off drains. Only its owner or an admin changes anything, and caps
// on a person's own machine only its owner. Every click shows at once, with its request behind (ui/optimistic.js).
import { account, api, h, view } from './base.js';
import { WORKER_CAPS, WORKER_LIMITS, workerSize } from './machine-setup.js';
import { removing } from './machine-remove.js';
import { heldCaps, workerState } from './machine-worker-row.js';
import { lastRun } from './role-setup.js';
import { optimistic } from './ui/optimistic.js';
import { toast } from './ui/status.js';

/** @import { MachineRole, MachineRoleCaps, MachineRoleKey, MachineRow } from './types.js' */
/** @typedef {() => void} Redraw */

// The caps each role's card edits (spec section 7). CI's runners cap is the most awake at once; Build 7's balancer (M6) holds it.
/** @type {Record<string, [keyof MachineRoleCaps, string, string][]>} */
const CAPS = {
  turns: [
    ['workers', 'Minions at once', ''],
    ['threads', 'CPU threads', ''],
    ['memory_gb', 'Memory', 'GB'],
    ['disk_gb', 'Disk', 'GB'],
  ],
  ci: [['runners', 'Runners awake', '']],
  // The most CPU threads a build there may take (H2 sizes each build job to fit under it).
  builds: [['threads', 'CPU threads', '']],
};
/** Bounds of each cap on the page; workers and runners may be 0 (none at once). */
/** @type {Record<string, number[]>} */
const LIMITS = { ...WORKER_LIMITS, workers: [0, WORKER_LIMITS.workers[1]], runners: [0, 64] };

/** Its owner, or an admin (access.ts managesMachine). @param {MachineRow} m */
export const managesRoles = (m) => !!account?.admin || (m.owner_id !== null && m.owner_id === account?.id);
/** Caps are its owner's alone (spec section 7; every machine has one, #2184). @param {MachineRow} m */
const setsCaps = (m) => m.owner_id === account?.id;
/** The page's newest view of the machine. @param {MachineRow} m */
const current = (m) => /** @type {MachineRow[] | undefined} */ (view?.machines)?.find((x) => x.id === m.id) ?? m;
/** @param {MachineRow} m @param {MachineRoleKey} role */
export const roleOf = (m, role) => current(m).roles?.find((r) => r.role === role);
/** @param {number} id */
const schemeName = (id) => (view?.projects ?? []).find((p) => p.id === id)?.name ?? `scheme ${id}`;
// A run-gpu task (a test box's), or GPU jobs on in its agent's jobs block (what Set up turns on, Build 7 M4).
/** @param {MachineRow} m */
const hasGpu = (m) => !!m.jobs?.gpu || (m.workspaces ?? []).some((w) => w.tasks?.some((t) => t.name === 'run-gpu'));

/** Which machines have their caps editor open, and what is typed there, over redraws. @type {Map<string, Record<string, string>>} */
const editing = new Map();

/**
 * Change one role at once; the request goes behind, and a failure puts it back with a toast and Retry.
 * @param {MachineRow} m
 * @param {MachineRoleKey} role
 * @param {Record<string, unknown>} fields
 * @param {string} label
 * @param {Redraw} redraw
 * @param {Record<string, unknown>} [shown]
 */
export function changeRole(m, role, fields, label, redraw, shown = fields) {
  const was = Object.fromEntries(Object.keys(shown).map((k) => [k, structuredClone(/** @type {Record<string, unknown> | undefined} */ (roleOf(m, role))?.[k])]));
  /** @param {Record<string, unknown>} vals */
  const set = (vals) => {
    const r = roleOf(m, role);
    if (r) Object.assign(r, vals);
    redraw();
  };
  // Each sends the whole value it sets, so the newest wins; a failure rolls back only when nothing came after it.
  return optimistic({
    key: `machine-role:${m.id}:${role}`,
    sets: `machine-role:${m.id}:${role}:${Object.keys(fields).join(',')}`,
    apply: () => set(shown),
    send: () => api(`api/machines/${m.id}/roles`, { method: 'PATCH', body: { role, ...fields } }),
    undo: () => set(was),
    label,
  });
}

/** Why a role can't be used on this PC, when it can't (shown greyed while off); null when it can. @param {MachineRow} m @param {MachineRole} r */
export function cannot(m, r) {
  if (r.on) return null;
  if (removing(m)) return 'It is being removed: nothing new starts there.';
  // What the PC is (its agent's report), as the server judges it (src/machine-roles.ts roleCannot).
  const why = m.cannot?.[/** @type {MachineRoleKey} */ (r.role)];
  if (why) return why;
  if (r.role === 'ci' && m.report?.os === 'macos') return 'CI runners need Windows or Linux.';
  if (r.role === 'screen' && m.worker?.host && !m.worker.wsl) return 'Windows only, and this computer runs Linux.';
  if (r.role === 'turns' && !(m.owner_id === account?.id)) return 'Only its owner can switch Minion turns on.';
  if (r.role === 'gpu' && m.report && !m.report.gpu && !hasGpu(m)) return 'That PC reported no GPU.';
  if (r.role === 'builds' && m.report?.os === 'macos') return 'Builds need Linux, or Windows with WSL.';
  return null;
}

/** How a role stands, in a few words, and the tone of its chip. @param {MachineRow} m @param {MachineRole} r */
export function standing(m, r) {
  if (!r.on) return { text: m.paused?.includes(r.role) ? 'paused' : 'off', tone: 'neutral' };
  if (r.role === 'turns') {
    if (!m.worker) return { text: 'not set up yet', tone: 'info' };
    const st = workerState(m);
    return { text: st.word, tone: st.tone };
  }
  if (/** @type {MachineRoleKey} */ (r.role) !== 'turns' && !m.online && r.role !== 'ci') return { text: 'offline', tone: 'neutral' };
  if (r.role === 'tools') {
    const lend = m.lend;
    const parts = [lend?.server, lend?.workspaces?.length ? `${lend.workspaces.length} folder${lend.workspaces.length === 1 ? '' : 's'}` : ''].filter(Boolean);
    return parts.length ? { text: `✓ ${parts.join(', ')}`, tone: 'ok' } : { text: 'nothing ticked yet', tone: 'warn' };
  }
  if (r.role === 'screen') return m.screen ? { text: `✓ screen ${m.screen.holder ? 'busy' : 'free'}`, tone: 'ok' } : { text: 'not set up yet', tone: 'info' };
  if (r.role === 'ci') {
    if (m.runners) return m.online ? { text: '✓ runner host connected', tone: 'ok' } : { text: 'offline', tone: 'neutral' };
    // One PC's row (Build 7 M2b): its runner agent joins it, so CI stands by that agent, whatever the PC's own agent does.
    const n = m.runner_agents?.length ?? 0;
    if (n) return { text: `✓ runner agent${n > 1 ? 's' : ''} connected`, tone: 'ok' };
    return lastRun(r)?.done && !lastRun(r)?.ok ? { text: 'set up failed', tone: 'danger' } : { text: 'not set up yet', tone: 'info' };
  }
  if (r.role === 'gpu' && hasGpu(m)) return { text: '✓ GPU jobs ready', tone: 'ok' };
  if (r.role === 'builds' && lastRun(r)?.ok) return { text: '✓ builds ready', tone: 'ok' };
  // After a Set up that failed, the header says so too, not "not set up yet" over the section's red chip.
  const run = lastRun(r);
  return run?.done && !run.ok ? { text: 'set up failed', tone: 'danger' } : { text: 'not set up yet', tone: 'info' };
}

/** The schemes a role is lent to, as chips that switch: every scheme the viewer sees, and any already on its list. @param {MachineRow} m @param {MachineRole} r @param {Redraw} redraw */
export function schemeChips(m, r, redraw) {
  const can = managesRoles(m);
  const ids = [...new Set([...(view?.projects ?? []).map((p) => p.id), ...r.projects])];
  const chips = ids.map((id) => {
    const on = r.projects.includes(id);
    return h(
      'button',
      {
        type: 'button',
        class: `chip${on ? ' on' : ''}`,
        'aria-pressed': String(on),
        disabled: !can,
        title: can ? (on ? `Take ${r.name} on ${m.name} from ${schemeName(id)}: nothing new starts there for it` : `Lend ${r.name} on ${m.name} to ${schemeName(id)}`) : 'Only its owner or an admin changes this',
        onclick: () => {
          const list = roleOf(m, r.role)?.projects ?? r.projects;
          const projects = list.includes(id) ? list.filter((/** @type {number} */ x) => x !== id) : [...list, id];
          changeRole(m, r.role, { projects }, `change which schemes get ${r.name} on ${m.name}`, redraw);
        },
      },
      schemeName(id),
    );
  });
  return h('div', { class: 'chips role-schemes', role: 'group', 'aria-label': `Schemes that get ${r.name} on ${m.name}` }, chips.length ? chips : h('span', { class: 'muted small' }, 'No schemes to lend it to.'));
}

/** A role's caps: the numbers it holds, and "change" for whoever sets them. @param {MachineRow} m @param {MachineRole} r @param {Redraw} redraw */
export function capsLine(m, r, redraw) {
  const key = `${m.id}:${r.role}`;
  let words;
  if (r.role === 'ci') words = r.caps.runners != null ? `up to ${r.caps.runners} runner${r.caps.runners === 1 ? '' : 's'} awake at once` : 'every runner there may be awake';
  else if (r.role === 'builds') words = r.caps.threads != null ? `builds take up to ${r.caps.threads} CPU thread${r.caps.threads === 1 ? '' : 's'}` : 'builds may take every CPU thread there';
  else {
    const held = heldCaps(m);
    words = held ? [`up to ${held.workers ?? '?'} minions at once`, held.threads != null ? `${held.threads} threads` : '', held.memory_gb != null ? `${held.memory_gb} GB memory` : '', held.disk_gb != null ? `${held.disk_gb} GB disk` : ''].filter(Boolean).join(' · ') : 'caps from that PC once it is set up';
  }
  const change = setsCaps(m) && !editing.has(key) ? h('button', { type: 'button', class: 'link small', onclick: () => (editing.set(key, {}), redraw()) }, 'change') : null;
  return [h('div', { class: 'small muted role-caps' }, h('span', {}, words), change ? ' · ' : '', change), editing.has(key) ? capsEditor(m, r, redraw) : null];
}

/**
 * Its owner's order among their computers (Build 7 M6; Josh, 2026-11-25: "put work on machine 1 before using machine 2"):
 * turns fill 1 before 2. Only its owner sets it, and only once they have two; shown read-only to others once set.
 * @param {MachineRow} m
 * @param {Redraw} redraw
 */
export function orderLine(m, redraw) {
  const c = current(m);
  const theirs = /** @type {MachineRow[]} */ (view?.machines ?? []).filter((x) => x.owner_id === m.owner_id && !x.runners).length;
  if (c.priority == null && theirs < 2) return null;
  const words = c.priority === 1 ? "First among its owner's computers" : `Order ${c.priority} among its owner's computers`;
  if (m.owner_id !== account?.id) return c.priority == null ? null : h('div', { class: 'small muted role-caps' }, words);
  const most = Math.max(theirs, c.priority ?? 0);
  const pick = /** @type {HTMLSelectElement} */ (
    h(
      'select',
      {
        'aria-label': `Order of ${m.name} among your computers`,
        onchange: () => {
          const was = current(m).priority ?? null;
          const to = pick.value === '' ? null : Number(pick.value);
          const set = (/** @type {number | null} */ v) => ((current(m).priority = v), redraw());
          optimistic({
            key: `machine-order:${m.id}`,
            apply: () => set(to),
            send: () => api(`api/machines/${m.id}`, { method: 'PATCH', body: { priority: to } }),
            undo: () => set(was),
            label: `set the order of ${m.name}`,
          });
        },
      },
      h('option', { value: '', selected: c.priority == null }, 'No order'),
      ...Array.from({ length: most }, (_, i) => h('option', { value: String(i + 1), selected: c.priority === i + 1 }, i === 0 ? '1, first' : String(i + 1))),
    )
  );
  return h('label', { class: 'small muted role-caps role-order', title: 'Minion turns go to your first computer until it is full, then the next' }, 'Fill order ', pick);
}

/** A whole number in a cap's bounds, or null; blank is "that PC's own". @param {string} key @param {string} text @returns {{ ok: boolean, n: number | null }} */
const capValue = (key, text) => {
  const t = text.trim();
  if (t === '') return { ok: true, n: null };
  const [min, max] = LIMITS[key];
  const n = /^\d+$/.test(t) ? Number(t) : NaN;
  return { ok: Number.isInteger(n) && n >= min && n <= max, n };
};

/** @param {MachineRow} m @param {MachineRole} r @param {Redraw} redraw */
function capsEditor(m, r, redraw) {
  const key = `${m.id}:${r.role}`;
  const typed = /** @type {Record<string, string>} */ (editing.get(key));
  const caps = CAPS[r.role];
  const own = /** @type {Record<string, number> | null} */ (r.role === 'turns' ? (m.worker?.caps ?? null) : null);
  const shown = (/** @type {keyof MachineRoleCaps} */ k) => typed[k] ?? (r.caps[k] != null ? String(r.caps[k]) : '');
  const fields = caps.map(([k, label, unit]) => {
    const input = /** @type {HTMLInputElement} */ (h('input', { type: 'text', inputmode: 'numeric', id: `role-cap-${m.id}-${k}`, value: shown(k), placeholder: own?.[k] != null ? String(own[k]) : '', 'aria-label': `${label}${unit ? ` (${unit})` : ''}` }));
    input.oninput = () => {
      typed[k] = input.value;
      input.setAttribute('aria-invalid', String(!capValue(k, input.value).ok));
    };
    return h('label', { class: 'worker-cap' }, h('span', {}, label), h('span', { class: 'worker-cap-box' }, input, unit ? h('i', {}, unit) : null));
  });
  const save = h('button', { type: 'button', class: 'small' }, 'Save');
  const cancel = h('button', { type: 'button', class: 'secondary small', onclick: () => (editing.delete(key), redraw()) }, 'Cancel');
  save.onclick = () => {
    /** @type {Record<string, number | null>} */
    const next = {};
    for (const [k, label] of caps) {
      const v = capValue(k, shown(k));
      if (!v.ok) return toast(`${label}: a whole number from ${LIMITS[k][0]} to ${LIMITS[k][1]}, or blank for ${r.role === 'ci' || r.role === 'builds' ? 'no cap' : "that PC's own"}`, { tone: 'danger' });
      next[k] = v.n;
    }
    editing.delete(key);
    // The role keeps only the caps that are set (its other caps stay); null clears one on the server.
    const was = structuredClone(roleOf(m, r.role)?.caps ?? {});
    const kept = Object.fromEntries(Object.entries({ ...was, ...next }).filter(([, v]) => v !== null));
    optimistic({
      key: `machine-role:${m.id}:${r.role}`,
      sets: `machine-role:${m.id}:${r.role}:caps`,
      apply: () => {
        const t = roleOf(m, r.role);
        if (t) t.caps = kept;
        redraw();
      },
      send: () => api(`api/machines/${m.id}/roles`, { method: 'PATCH', body: { role: r.role, caps: next } }),
      undo: () => {
        const t = roleOf(m, r.role);
        if (t) t.caps = was;
        redraw();
      },
      label: `set the ${r.name} caps on ${m.name}`,
    });
  };
  // Threads and memory above its own take that PC's root helper (#2085); workers and disk the worker holds itself.
  const over = own && caps.some(([k]) => (k === 'threads' || k === 'memory_gb') && /** @type {number} */ (capValue(k, typed[k] ?? '').n) > own[k]);
  const hint =
    r.role === 'ci'
      ? 'Blank: no cap here, every runner registered there may be awake.'
      : r.role === 'builds'
        ? 'Blank: no cap here, a build may take every CPU thread there.'
        : own
          ? `Blank uses that PC's own cap; a number here is held there instead, above it too${over ? ". Threads and memory go up to what that PC has; if they don't take, run that PC's install command again" : ''}.`
          : "Blank is that PC's own cap, once it is set up.";
  return h('div', { class: 'role-caps-edit' }, h('b', { class: 'small' }, `${r.name} caps, set here`), h('div', { class: 'worker-caps' }, ...fields), h('p', { class: 'muted small' }, hint), h('div', { class: 'row' }, save, cancel));
}

/**
 * "Use this PC's size" (#2250): a worker still on the old fixed starting caps (6 minions, 8 threads, 24 GB), with none set
 * on the page, gets its PC's own size offered as page caps. One its owner set by hand is left alone. Null: no offer.
 * @param {MachineRow} m @returns {{ workers: number, threads: number, memory_gb: number } | null}
 */
export function sizeOffer(m) {
  const w = m.worker;
  const page = roleOf(m, 'turns')?.caps ?? {};
  if (!w?.here || !w.pc || !w.caps || !setsCaps(m)) return null;
  if (Object.entries(WORKER_CAPS).some(([k, v]) => w.caps?.[/** @type {keyof typeof WORKER_CAPS} */ (k)] !== v)) return null;
  if (page.workers != null || page.threads != null || page.memory_gb != null) return null;
  const { workers, threads, memory_gb } = workerSize(w.pc);
  return workers > WORKER_CAPS.workers || threads > WORKER_CAPS.threads || memory_gb > WORKER_CAPS.memory_gb ? { workers, threads, memory_gb } : null;
}

/** The offer's notice and its one button, which sets those page caps at once with the request behind. @param {MachineRow} m @param {Redraw} redraw */
export function sizeOfferPart(m, redraw) {
  const size = sizeOffer(m);
  if (!size) return null;
  const pc = /** @type {{ threads: number, memory_gb: number }} */ (m.worker?.pc);
  const use = () => {
    const was = structuredClone(roleOf(m, 'turns')?.caps ?? {});
    optimistic({
      key: `machine-role:${m.id}:turns`,
      sets: `machine-role:${m.id}:turns:caps`,
      apply: () => {
        const t = roleOf(m, 'turns');
        if (t) t.caps = { ...was, ...size };
        redraw();
      },
      send: () => api(`api/machines/${m.id}/roles`, { method: 'PATCH', body: { role: 'turns', caps: size } }),
      undo: () => {
        const t = roleOf(m, 'turns');
        if (t) t.caps = was;
        redraw();
      },
      label: `use ${m.name}'s size for its minions`,
    });
  };
  return h(
    'div',
    { class: 'cui-notice size-offer', 'data-tone': 'info' },
    h(
      'span',
      { class: 'small' },
      `Still on the old starting caps (${WORKER_CAPS.workers} minions, ${WORKER_CAPS.threads} threads, ${WORKER_CAPS.memory_gb} GB). This PC has ${pc.threads} threads and ${pc.memory_gb} GB: its size is ${size.workers} minions, ${size.threads} threads, ${size.memory_gb} GB, keeping the rest for you and CI.`,
    ),
    h('button', { type: 'button', class: 'small', onclick: use }, "Use this PC's size"),
  );
}

/** Pause all, or Resume once paused: every role that's on goes off (draining), and one click puts them back. @param {MachineRow} m @param {Redraw} redraw */
export function pauseButton(m, redraw) {
  if (!managesRoles(m)) return null;
  const paused = !!m.paused?.length;
  const anyOn = m.roles?.some((r) => r.on);
  if (!paused && !anyOn) return null;
  return h(
    'button',
    {
      type: 'button',
      class: 'secondary small',
      title: paused ? `Switch ${/** @type {MachineRoleKey[]} */ (m.paused).map((r) => m.roles?.find((x) => x.role === r)?.name ?? r).join(', ')} back on` : 'Switch every role off: what runs finishes, nothing new starts. One click puts them back.',
      onclick: () => {
        const was = { paused: current(m).paused ?? null, on: Object.fromEntries((current(m).roles ?? []).map((r) => [r.role, r.on])) };
        /** @param {MachineRoleKey[] | null} pausedTo @param {(r: MachineRole) => boolean} onOf */
        const set = (pausedTo, onOf) => {
          const c = current(m);
          c.paused = pausedTo;
          for (const r of c.roles ?? []) r.on = onOf(r);
          redraw();
        };
        const back = was.paused ?? [];
        const on = Object.entries(was.on)
          .filter(([, v]) => v)
          .map(([k]) => k);
        optimistic({
          key: `machine-pause:${m.id}`,
          apply: () => (paused ? set(null, (r) => r.on || back.includes(r.role)) : set([...back, .../** @type {MachineRoleKey[]} */ (on)], () => false)),
          send: () =>
            api(`api/machines/${m.id}/pause`, { method: 'POST', body: { pause: !paused } }).then((res) => {
              if (res?.errors?.length) toast(`Some of ${m.name}'s roles stayed off: ${res.errors.join('; ')}`, { tone: 'danger' });
            }),
          undo: () => set(was.paused, (r) => was.on[r.role] ?? r.on),
          label: paused ? `resume ${m.name}` : `pause ${m.name}`,
        });
      },
    },
    paused ? 'Resume' : 'Pause all',
  );
}
