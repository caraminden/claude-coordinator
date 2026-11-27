// Removing a machine on the Machines page (Build 7 #2044; specs/worker-machines.md §4): its row says Removing… at the click,
// and a worker's owner gets the command that takes the worker off that PC, in a block that outlives the row.
/** @import { MachineRemoveReply, MachineRow } from './types.js' */
import { account, api, h, openView } from './base.js';
import { markdownElement } from './ui/markdown.js';
import { optimistic } from './ui/optimistic.js';

/** The removals this app has started, until Done: kept over redraws and page switches. @type {Map<string, { name: string, command: { tag: 'powershell' | 'bash', command: string } | null }>} */
const removals = new Map();
/** @type {Set<string>} */
const seen = new Set();

// A removed machine's id goes to the next one added, so its created time is part of the key.
/** @param {Pick<MachineRow, 'id' | 'created_at'>} m */
const key = (m) => `${m.id}:${m.created_at}`;

/** Its row shows Removing…: clicked here, or the server says it is draining. @param {unknown} row a MachineRow of view.machines */
export const removing = (row) => {
  const m = /** @type {Pick<MachineRow, 'id' | 'created_at' | 'removing'>} */ (row);
  return !!m.removing || removals.has(key(m));
};

/**
 * The command that takes a removed worker off its PC, for the shell that PC's worker ran in; null when it had none.
 * @param {Pick<MachineRow, 'worker'>} machine
 * @param {MachineRemoveReply} reply
 */
export function uninstallFor(machine, reply) {
  // A 202 means copies or turns of a worker are there, whatever the row had heard of it.
  if (!reply.removing && !machine.worker?.host) return null;
  /** @type {'powershell' | 'bash'} */
  const tag = machine.worker?.wsl ? 'powershell' : 'bash';
  return { tag, command: reply.uninstall[tag] };
}

/**
 * DELETE it. `redraw` draws the list again, `drop` takes its row out of it.
 * @param {Pick<MachineRow, 'id' | 'name' | 'created_at' | 'worker'>} machine
 * @param {{ redraw: () => void, drop: () => void }} fns
 */
export function sendRemoval(machine, { redraw, drop }) {
  optimistic({
    key: `machine:${machine.id}`,
    apply: () => {
      removals.set(key(machine), { name: machine.name, command: null });
      redraw();
    },
    send: () => api(`api/machines/${machine.id}`, { method: 'DELETE' }),
    undo: () => {
      removals.delete(key(machine));
      redraw();
    },
    label: `remove ${machine.name}`,
  }).then(
    (reply) => {
      const command = uninstallFor(machine, reply);
      if (command) removals.set(key(machine), { name: machine.name, command });
      else removals.delete(key(machine));
      // A 202 keeps its row until its agent has cleared the copies there.
      if (reply.removing) redraw();
      else drop();
    },
    () => {}, // the toast said so
  );
}

/** @type {Record<'powershell' | 'bash', string>} */
const WHERE = { powershell: 'in a normal PowerShell window on that PC (not as administrator)', bash: 'in a terminal on that computer' };

/**
 * The commands to run, above the list.
 * @param {HTMLElement | null} el
 * @param {() => void} redraw
 */
export function renderRemovals(el, redraw) {
  if (!el) return;
  // One draining that this page never clicked (its owner's reload or other tab): its command is kept from here on too.
  // A VM (Build 10 H4) is inside its computer's row, so it is still there while it is.
  const machines = /** @type {MachineRow[]} */ (openView().machines).flatMap((m) => [m, ...(m.vms ?? [])]);
  for (const m of machines) if (m.removing && m.owner_id === account?.id) removals.set(key(m), { name: m.name, command: uninstallFor(m, { removing: true, uninstall: /** @type {MachineRemoveReply['uninstall']} */ (m.removing) }) });
  /** @type {[string, { name: string, command: { tag: 'powershell' | 'bash', command: string } | null }, boolean][]} */
  const shown = [...removals].filter(([, r]) => r.command).map(([id, r]) => [id, r, machines.some((m) => key(m) === id)]);
  // Left alone while nothing changed, so a selection in a command survives the list's redraws.
  const drawn = JSON.stringify(shown);
  if (el.dataset.drawn === drawn) return;
  el.dataset.drawn = drawn;
  el.replaceChildren(
    ...shown.map(([id, { name, command: kept }, there]) => {
      const command = /** @type {NonNullable<typeof kept>} */ (kept); // shown holds only rows with one
      const done = h('button', { type: 'button', class: 'secondary small' }, 'Done');
      done.onclick = () => {
        removals.delete(id);
        seen.delete(id);
        redraw();
      };
      const box = h(
        'div',
        { class: 'machine-setup machine-removal' },
        h('b', {}, there ? `Removing ${name}…` : `${name} is removed`),
        there ? h('p', { class: 'cui-notice', 'data-tone': 'warn' }, `Don't run this yet. Turns running there finish and its copies are cleared first: wait until ${name} leaves the list below.`) : '',
        h('p', { class: 'small' }, `${there ? 'Then, to' : 'To'} take the worker off it, run this ${WHERE[command.tag]}:`),
        markdownElement(`\`\`\`${command.tag}\n${command.command}\n\`\`\``),
        there ? '' : h('div', { class: 'row' }, h('span', { class: 'spacer' }), done),
      );
      box.dataset.name = name;
      // Remove was pressed down the list, so a command new on the page is brought into sight.
      if (!seen.has(id)) requestAnimationFrame(() => box.scrollIntoView({ block: 'nearest' }));
      seen.add(id);
      return box;
    }),
  );
}
