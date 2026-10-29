// The Start button on a brief in the file viewer (#129): a tap opens a sheet filled in from the brief,
// a second starts the minion, and the button then reads "Started as #N" for everyone.
import { api, h } from './core.js';
import { briefMessage, findBriefs, matchType } from './briefs.js';

/**
 * Hang a Start button on each brief in `doc`, the markdownDoc of `text`. `file` says where it is:
 * its scheme, the path the viewer shows (the brief's key), the path a minion can read, and its name.
 */
export function addBriefButtons(doc, text, file) {
  const briefs = findBriefs(text, file.name);
  if (!briefs.length) return;
  const tops = doc.querySelectorAll(':scope > :is(h1, h2, h3, h4, h5, h6)');
  const slots = new Map();
  for (const b of briefs) {
    const slot = h('div', { class: 'brief-start' });
    slots.set(b.heading, slot);
    if (b.index < 0) doc.prepend(slot);
    else tops[b.index]?.after(slot);
    show(slot, b, file, null);
  }
  api(`api/projects/${file.projectId}/briefs?path=${encodeURIComponent(file.path)}`).then((started) => {
    for (const s of started) {
      const b = briefs.find((x) => x.heading === s.heading);
      if (b) show(slots.get(b.heading), b, file, s.number);
    }
  }).catch(() => {});
}

function show(slot, brief, file, number) {
  slot.replaceChildren(number
    ? h('a', { class: 'button secondary started', href: `#/p/${file.projectId}/t/${number}` }, `Started as #${number}`)
    : h('button', { type: 'button', class: 'secondary', title: 'Start this brief as a new minion', onclick: () => openSheet(slot, brief, file) },
      brief.heading ? 'Start as a minion' : 'Start this handoff as a minion'));
}

let types = null; // the scheme's registered types, fetched once per scheme
async function typeValues(projectId) {
  if (types?.projectId !== projectId) {
    const reg = await api(`api/projects/${projectId}/properties`).catch(() => ({ keys: [] }));
    const values = reg.keys.find((k) => k.key === 'type')?.values.filter((v) => v.status === 'active') ?? [];
    types = { projectId, values };
  }
  return types.values;
}

async function openSheet(slot, brief, file) {
  const values = await typeValues(file.projectId);
  const message = briefMessage(brief, file.abs ?? file.path);
  const err = h('p', { class: 'error', hidden: true });
  const title = h('input', { name: 'title', required: true, maxlength: 120, value: brief.title, autocomplete: 'off' });
  const type = h('select', { name: 'type' },
    h('option', { value: '' }, 'Let the minion pick'),
    values.map((v) => h('option', { value: v.value, selected: v.value === matchType(brief.typeHint, values) }, v.label || v.value)));
  const after = h('input', { name: 'after', inputmode: 'numeric', pattern: '#?\\d+', placeholder: '#N', autocomplete: 'off', 'aria-label': 'Start after minion number' });
  const when = h('select', { name: 'when', 'aria-label': 'Once that minion is' }, h('option', { value: 'live' }, 'is live'), h('option', { value: 'merged' }, 'is merged'));
  const lines = message.split('\n').length;
  const btn = h('button', { type: 'submit' }, 'Start minion');
  const form = h('form', { class: 'start-brief-form' },
    h('label', {}, 'Title', title),
    h('label', {}, 'Type', type),
    h('div', { class: 'label' }, 'Start after (optional)', h('div', { class: 'row' }, after, h('span', { class: 'muted' }, 'once it'), when)),
    h('details', {}, h('summary', {}, `First message (${lines} line${lines === 1 ? '' : 's'})`), h('pre', { class: 'artifact-text' }, message)),
    err,
    h('div', { class: 'row sheet-actions' }, h('span', { class: 'spacer' }),
      h('button', { type: 'button', class: 'secondary', onclick: () => dialog.close() }, 'Cancel'), btn));
  const dialog = h('dialog', { class: 'new-scheme start-brief', 'aria-label': 'Start a minion' },
    h('div', { class: 'row' }, h('h2', {}, 'Start a minion'), h('span', { class: 'spacer' }),
      h('button', { type: 'button', class: 'close', 'aria-label': 'Close', onclick: () => dialog.close() }, '×')),
    h('p', { class: 'muted small from' }, `From ${brief.heading || 'the handoff'} in ${file.name}`),
    form);
  dialog.addEventListener('close', () => dialog.remove());
  dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    btn.disabled = true;
    btn.textContent = 'Starting…';
    err.hidden = true;
    const n = after.value.replace('#', '').trim();
    try {
      const t = await api(`api/projects/${file.projectId}/tickets`, { method: 'POST', body: {
        title: title.value, message, brief: { path: file.path, heading: brief.heading },
        ...(type.value ? { properties: { type: type.value } } : {}),
        ...(n ? { start_after: Number(n), start_when: when.value } : {}),
      } });
      dialog.close();
      show(slot, brief, file, t.number);
    } catch (ex) {
      // Someone else started it meanwhile: show theirs instead of a second minion.
      const theirs = await api(`api/projects/${file.projectId}/briefs?path=${encodeURIComponent(file.path)}`).catch(() => []);
      const number = theirs.find((s) => s.heading === brief.heading)?.number;
      if (number) {
        dialog.close();
        return show(slot, brief, file, number);
      }
      err.textContent = ex.message;
      err.hidden = false;
      btn.disabled = false;
      btn.textContent = 'Start minion';
    }
  });
  document.body.append(dialog);
  dialog.showModal();
  title.focus();
}
