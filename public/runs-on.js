// Where a minion's turns run (Build 7 T4; src/runs-on.ts): anywhere, at perigee only, or on one computer of the
// person's own. Opened from the minion's right-click menu.
import { ago, api, h, view } from './base.js';
import { renderSidebar } from './sidebar.js';
import { renderTyping } from './thread.js';
import { openDialog } from './ui/dialog.js';
import { optimistic } from './ui/optimistic.js';

const objects = (id) => new Set([view?.tickets?.get(id), view?.ticket?.id === id && view.ticket].filter(Boolean));

function setRunsOn(t, on) {
  const was = new Map([...objects(t.id)].map((o) => [o, o.runs_on ?? null]));
  const show = (of) => {
    for (const o of objects(t.id)) o.runs_on = of(o);
    renderSidebar();
    if (view?.id === t.id) renderTyping();
  };
  optimistic({
    key: `runs-on:${t.id}`,
    apply: () => show(() => (on === 'anywhere' ? null : { on, by: 'you', at: Date.now() })),
    send: () => api(`api/tickets/${t.id}/runs-on`, { method: 'PUT', body: { on } }),
    undo: () => show((o) => was.get(o) ?? null),
    label: `set where #${t.number ?? t.id} runs`,
  })
    .then(({ runs_on }) => show(() => runs_on))
    .catch(() => {});
}

export function openRunsOn(t) {
  const now = t.runs_on?.on ?? 'anywhere';
  let machines = null; // not read yet
  let failed = null;
  const list = h('div', { class: 'hue-rows', role: 'radiogroup', 'aria-label': 'Runs on' });
  const option = (value, name, line, off) =>
    h(
      'label',
      { class: `runs-on-opt${off ? ' off' : ''}` },
      h('input', {
        type: 'radio',
        name: 'runs-on',
        value,
        checked: now === value,
        disabled: !!off,
        onchange: () => {
          dialog.close();
          setRunsOn(t, value);
        },
      }),
      h('span', {}, h('b', {}, name), h('span', { class: 'muted small' }, line)),
    );
  const draw = () => {
    const rows = (machines ?? []).map((m) => option(m.name, `${m.name} only`, m.why ? `Can't be picked: ${m.why}` : `It waits while ${m.name} is off, away or busy`, m.why && m.name !== now));
    const gone = !['anywhere', 'perigee'].includes(now) && machines && !machines.some((m) => m.name === now);
    list.replaceChildren(
      option('anywhere', 'Anywhere', 'At perigee; on your own connected computer when perigee is full or someone with none waits for it'),
      option('perigee', 'Perigee only', 'Never on another computer'),
      ...rows,
      gone ? option(now, `${now} only`, "Not yours to pick, or it isn't connected to Citadel any more", true) : '',
      machines && !rows.length ? h('p', { class: 'muted small' }, 'No connected computer runs minion turns yet.') : machines ? '' : h('p', { class: 'muted small' }, failed ? `Couldn't read your computers: ${failed}` : 'Reading your computers…'),
    );
  };
  const dialog = openDialog({
    title: `Where #${t.number ?? t.id} runs`,
    className: 'runs-on',
    body: [h('p', { class: 'muted small' }, t.runs_on ? `Set by ${t.runs_on.by}, ${ago(t.runs_on.at)}. A change counts from its next turn.` : 'A change counts from its next turn.'), list],
  });
  draw();
  api(`api/tickets/${t.id}/runs-on`)
    .then((r) => (machines = r.machines))
    .catch((err) => (failed = err.message))
    .finally(draw);
}
