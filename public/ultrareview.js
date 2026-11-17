// Ultra review (#432): a person runs `claude ultrareview` on their own Claude login, on this minion's
// branch or on an area of the scheme's repo, and the findings land in this chat. It spends a free run or
// usage credits, so the dialog says so and the server only takes it from a person who confirmed.
import { api, h } from './base.js';
import { openDialog } from './ui/dialog.js';

const COST = 'It uses one of your 3 free ultra reviews, or about $5-25 in usage credits once those are gone. Citadel can\'t see how many free runs you have left, and a run counts as soon as it starts, even if it fails.';

/** The header's button: every open chat can review an area; a minion with a branch can also review that. */
export function ultraButton(t) {
  if (t.status === 'closed') return '';
  return h('button', { type: 'button', class: 'secondary act-ultra', title: 'Run an ultra review on your own Claude account: this branch, or an area of the repo', onclick: () => openUltra(t) },
    'Ultra', h('span', { class: 'wide-only' }, ' review'));
}

const fmt = (n) => n.toLocaleString('en-US');

function openUltra(t) {
  const hasBranch = t.kind !== 'coordinator' && !!t.branch;
  const radio = (value, label, extra = {}) => h('label', { class: 'ur-mode' }, h('input', { type: 'radio', name: 'mode', value, ...extra }), label);
  const branchOpt = radio('branch', hasBranch ? h('span', {}, 'This minion\'s branch ', h('code', {}, t.branch)) : 'This minion\'s branch (none)', { checked: hasBranch, disabled: !hasBranch });
  const areaOpt = radio('area', 'An area of the repo', { checked: !hasBranch });
  const paths = h('textarea', { name: 'paths', rows: 4, placeholder: 'src/db.ts src/mcp.ts src/routes', spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Paths in the area' });
  const pathsBox = h('label', { class: 'ur-paths' }, 'Paths (files or folders, space or line separated)', paths);
  const size = h('p', { class: 'ur-size muted', role: 'status' });
  const err = h('p', { class: 'cui-notice ur-err', 'data-tone': 'danger', role: 'alert', hidden: true });
  const btn = h('button', { type: 'submit', disabled: true }, 'Start ultra review');
  const form = h('form', { class: 'ur-form' },
    h('div', { class: 'ur-modes' }, branchOpt, areaOpt),
    pathsBox,
    size,
    h('p', { class: 'ur-cost' }, 'Runs on ', h('strong', {}, 'your own Claude account'), '. ', COST, ' It takes 5-15 minutes, up to 45, and the findings land in this chat.'),
    err,
    h('div', { class: 'row sheet-actions' }, h('span', { class: 'spacer' }),
      h('button', { type: 'button', class: 'secondary', onclick: () => dialog.close() }, 'Cancel'), btn));
  const dialog = openDialog({ title: 'Ultra review', className: 'new-scheme ultra-review', body: form });

  const mode = () => form.elements.mode.value;
  const pathList = () => paths.value.split(/[\s,]+/).filter(Boolean);
  let checked = null;
  let timer = null;
  let seq = 0;
  // The size check reads git only, never the CLI: it's free, so it runs as the choice changes.
  const check = async () => {
    const n = ++seq;
    checked = null;
    btn.disabled = true;
    err.hidden = true;
    pathsBox.hidden = mode() !== 'area';
    if (mode() === 'area' && !pathList().length) return void (size.textContent = 'Name the files or folders to review.');
    size.textContent = 'Measuring the diff…';
    const q = new URLSearchParams({ mode: mode() });
    if (mode() === 'area') for (const p of pathList()) q.append('path', p);
    try {
      const r = await api(`api/tickets/${t.id}/ultrareview?${q}`);
      if (n !== seq) return;
      const over = r.size.files > r.limits.files || r.size.lines > r.limits.lines;
      const what = r.mode === 'branch' ? `${r.branch} against ${r.base}` : `the area, against ${r.base} without it`;
      size.replaceChildren(`Reviews ${what}: `, h('strong', {}, `${fmt(r.size.files)} file${r.size.files === 1 ? '' : 's'}, ${fmt(r.size.lines)} changed lines`),
        over ? h('span', { class: 'ur-over' }, ` Over the CLI's limit of ${fmt(r.limits.files)} files and ${fmt(r.limits.lines)} lines: it will refuse before using a run.`) : ` (limit ${fmt(r.limits.files)} files, ${fmt(r.limits.lines)} lines).`);
      if (!r.linked) return showErr('Your Claude plan isn\'t linked (Settings → Your account), so there\'s no login of yours to run it on.');
      if (r.running) return showErr('You already have an ultra review running. Wait for its findings first.');
      checked = { mode: r.mode, paths: r.paths };
      btn.disabled = false;
    } catch (ex) {
      if (n !== seq) return;
      size.textContent = '';
      showErr(ex.message);
    }
  };
  const showErr = (text) => {
    err.textContent = text;
    err.hidden = false;
  };
  const later = () => {
    clearTimeout(timer);
    btn.disabled = true;
    timer = setTimeout(check, 400);
  };
  form.addEventListener('change', (e) => e.target.name === 'mode' && check());
  paths.addEventListener('input', later);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!checked) return;
    btn.disabled = true;
    btn.textContent = 'Starting…';
    err.hidden = true;
    try {
      await api(`api/tickets/${t.id}/ultrareview`, { method: 'POST', body: { mode: checked.mode, paths: checked.paths, confirm: true } });
      dialog.close();
    } catch (ex) {
      showErr(ex.message);
      btn.disabled = false;
      btn.textContent = 'Start ultra review';
    }
  });
  check();
  (hasBranch ? btn : paths).focus();
}

const what = (d) => (d.mode === 'branch' ? h('span', {}, 'branch ', h('code', {}, d.branch), ' against ', h('code', {}, d.base)) : h('span', {}, 'area ', d.paths.flatMap((p, i) => [i ? ', ' : '', h('code', {}, p)])));

/** The chat's card for a review: busy until its result settles it with the findings, or why it failed. */
export function ultraCard(data) {
  const status = h('div', { class: 'ur-status muted', role: 'status' }, 'Running on ', data.by, '\'s Claude account: 5-15 minutes, up to 45', h('span', { class: 'state-dots', 'aria-hidden': 'true' }, h('i', {}, '.'), h('i', {}, '.'), h('i', {}, '.')));
  const card = h('div', { class: 'qcard ur-card busy', 'data-ultra': data.id },
    h('div', { class: 'who' }, 'Ultra review'),
    h('div', { class: 'qtitle' }, data.by, ' started an ultra review of ', what(data), ` (${fmt(data.size.files)} files, ${fmt(data.size.lines)} lines)`),
    status);
  card.settle = (r) => {
    card.classList.remove('busy');
    card.classList.toggle('failed', !r.ok);
    const body = h('pre', { class: 'ur-findings' }, r.text);
    status.replaceChildren(r.ok
      ? h('details', { open: true }, h('summary', {}, 'Findings', r.file ? h('span', { class: 'muted' }, ` · saved to ${r.file.split('/').pop()} in this chat's shared folder`) : ''), body)
      : h('div', {}, h('div', { class: 'ur-fail' }, r.code == null ? 'It didn\'t finish.' : `It failed (exit code ${r.code}).`), body));
  };
  return card;
}

/** A result whose card isn't in the log (it was paged out): shown on its own. */
export function ultraResult(r) {
  const card = ultraCard({ id: r.id, by: 'Someone', mode: 'area', paths: [], size: { files: 0, lines: 0 } });
  card.querySelector('.qtitle').textContent = 'Ultra review finished';
  card.settle(r);
  return card;
}

