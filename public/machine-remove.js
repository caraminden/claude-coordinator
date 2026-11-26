// Removing a machine on the Machines page (Build 7 #2044; specs/worker-machines.md §4): its row says Removing… at the click,
// and a worker's owner gets the command that takes the worker off that PC, in a block that outlives the row.
import { api, h, view } from './base.js';
import { markdownElement } from './ui/markdown.js';
import { optimistic } from './ui/optimistic.js';

/** The removals this app has started, by machine id, until Done: kept over redraws and page switches. */
const removals = new Map();
const seen = new Set();

/** Its row shows Removing… */
export const removing = (id) => removals.has(id);

/** The command that takes a removed worker off its PC, for the shell that PC's worker ran in; null when it had none. */
export function uninstallFor(machine, reply) {
  // A 202 means copies or turns of a worker are there, whatever the row had heard of it.
  if (!reply.removing && !machine.worker?.host) return null;
  const tag = machine.worker?.wsl ? 'powershell' : 'bash';
  return { tag, command: reply.uninstall[tag] };
}

/** DELETE it. `redraw` draws the list again, `drop` takes its row out of it. */
export function sendRemoval(machine, { redraw, drop }) {
  optimistic({
    key: `machine:${machine.id}`,
    apply: () => {
      removals.set(machine.id, { name: machine.name, command: null });
      redraw();
    },
    send: () => api(`api/machines/${machine.id}`, { method: 'DELETE' }),
    undo: () => {
      removals.delete(machine.id);
      redraw();
    },
    label: `remove ${machine.name}`,
  }).then(
    (reply) => {
      const command = uninstallFor(machine, reply);
      if (command) removals.set(machine.id, { name: machine.name, command });
      else removals.delete(machine.id);
      // A 202 keeps its row until its agent has cleared the copies there.
      if (reply.removing) redraw();
      else drop();
    },
    () => {}, // the toast said so
  );
}

const WHERE = { powershell: 'in a normal PowerShell window on that PC (not as administrator)', bash: 'in a terminal on that computer' };

/** The commands to run, above the list. */
export function renderRemovals(el, redraw) {
  if (!el) return;
  const shown = [...removals].filter(([, r]) => r.command).map(([id, r]) => [id, r, view.machines.some((m) => m.id === id)]);
  // Left alone while nothing changed, so a selection in a command survives the list's redraws.
  const key = JSON.stringify(shown);
  if (el.dataset.key === key) return;
  el.dataset.key = key;
  el.replaceChildren(
    ...shown.map(([id, { name, command }, there]) => {
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
        h('p', { class: 'small' }, there ? `Turns running there finish and its copies are cleared first. Once its line is gone, run this ${WHERE[command.tag]}:` : `To take the worker off it, run this ${WHERE[command.tag]}:`),
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
