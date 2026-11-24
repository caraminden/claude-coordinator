// Ultra review (#432): a person runs `claude ultrareview` on their own Claude login, on this minion's
// branch or on an area of the scheme's repo, and the findings land in this chat. It spends a free run or
// usage credits, so the dialog says so and the server only takes it from a person who confirmed.
import { api, h } from './base.js';
import { openDialog } from './ui/dialog.js';
import { optimistic } from './ui/optimistic.js';
import { toneChip } from './look.js';

const COST = "It uses one of your 3 free ultra reviews, or about $5-25 in usage credits once those are gone. Citadel can't see how many free runs you have left, and a run counts as soon as it starts, even if it fails.";

/** The header's button: every open chat can review an area; a minion with a branch can also review that. */
export function ultraButton(t) {
  if (t.status === 'closed') return '';
  return h('button', { type: 'button', class: 'secondary act-ultra', title: 'Run an ultra review on your own Claude account: this branch, or an area of the repo', onclick: () => openUltra(t) }, 'Ultra', h('span', { class: 'wide-only' }, ' review'));
}

const fmt = (n) => n.toLocaleString('en-US');

function openUltra(t) {
  const hasBranch = t.kind !== 'coordinator' && !!t.branch;
  const radio = (value, label, extra = {}) => h('label', { class: 'ur-mode' }, h('input', { type: 'radio', name: 'mode', value, ...extra }), label);
  const branchOpt = radio('branch', hasBranch ? h('span', {}, "This minion's branch ", h('code', {}, t.branch)) : "This minion's branch (none)", { checked: hasBranch, disabled: !hasBranch });
  const areaOpt = radio('area', 'An area of the repo', { checked: !hasBranch });
  const batchOpt = radio('batch', 'Several areas: a draft pull request for each, started one by one');
  const paths = h('textarea', { name: 'paths', rows: 4, placeholder: 'src/db.ts src/mcp.ts src/routes', spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Paths in the area' });
  const pathsBox = h('label', { class: 'ur-paths' }, 'Paths (files or folders, space or line separated)', paths);
  const size = h('p', { class: 'ur-size muted', role: 'status' });
  const err = h('p', { class: 'cui-notice ur-err', 'data-tone': 'danger', role: 'alert', hidden: true });
  const btn = h('button', { type: 'submit', disabled: true }, 'Start ultra review');
  const batch = batchPanel(t, () => dialog);
  const cost = h('p', { class: 'ur-cost' }, 'Runs on ', h('strong', {}, 'your own Claude account'), '. ', COST, ' It takes 5-15 minutes, up to 45, and the findings land in this chat.');
  const form = h('form', { class: 'ur-form' }, h('div', { class: 'ur-modes' }, branchOpt, areaOpt, batchOpt), pathsBox, size, batch.el, cost, err, h('div', { class: 'row sheet-actions' }, h('span', { class: 'spacer' }), h('button', { type: 'button', class: 'secondary', onclick: () => dialog.close() }, 'Cancel'), btn));
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
    batch.el.hidden = mode() !== 'batch';
    btn.hidden = cost.hidden = mode() === 'batch';
    if (mode() === 'batch') return void (size.textContent = '');
    if (mode() === 'area' && !pathList().length) return void (size.textContent = 'Name the files or folders to review.');
    size.textContent = 'Measuring the diff…';
    const q = new URLSearchParams({ mode: mode() });
    if (mode() === 'area') for (const p of pathList()) q.append('path', p);
    try {
      const r = await api(`api/tickets/${t.id}/ultrareview?${q}`);
      if (n !== seq) return;
      const over = r.size.files > r.limits.files || r.size.lines > r.limits.lines;
      const what = r.mode === 'branch' ? `${r.branch} against ${r.base}` : `the area, against ${r.base} without it`;
      size.replaceChildren(
        `Reviews ${what}: `,
        h('strong', {}, `${fmt(r.size.files)} file${r.size.files === 1 ? '' : 's'}, ${fmt(r.size.lines)} changed lines`),
        over ? h('span', { class: 'ur-over' }, ` Over the CLI's limit of ${fmt(r.limits.files)} files and ${fmt(r.limits.lines)} lines: it will refuse before using a run.`) : ` (limit ${fmt(r.limits.files)} files, ${fmt(r.limits.lines)} lines).`,
      );
      if (!r.linked) return showErr("Your Claude plan isn't linked (Settings → Your account), so there's no login of yours to run it on.");
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
  // Someone with prepped reviews here opens on them.
  batch.load().then((rows) => {
    if (rows.length && form.elements.mode.value !== 'batch') {
      form.elements.mode.value = 'batch';
      check();
    }
  });
}

const STATE = { prepping: ['info', 'Prepping'], ready: ['ok', 'Ready'], running: ['violet', 'Running'], failed: ['danger', 'Failed'] };

/**
 * The batch form (#1399): areas to prep, each into its own draft pull request on the person's own GitHub login, and
 * the prepped ones, each with its own Start. Nothing runs until Start, which bills the person who presses it.
 */
function batchPanel(t, dialogOf) {
  let rows = [];
  let github = true;
  let poll = null;
  const list = h('div', { class: 'ur-rows' });
  const areas = h('div', { class: 'ur-areas' });
  const refused = h('div', { class: 'cui-notice ur-refused', 'data-tone': 'danger', role: 'alert', hidden: true });
  const noGithub = h('p', { class: 'cui-notice', 'data-tone': 'warn', hidden: true }, "You haven't linked GitHub (Settings → Your account). Each area's draft pull request goes out as your own GitHub login, and Citadel never uses anyone else's.");
  const prep = h('button', { type: 'button', onclick: () => send() }, 'Prep draft PRs');
  const add = h('button', { type: 'button', class: 'secondary', onclick: () => addArea(true) }, '+ Add area');
  const listBox = h('div', { class: 'ur-rows-box' }, h('h4', {}, 'Prepped'), list, h('p', { class: 'ur-cost' }, 'Each Start runs on ', h('strong', {}, 'your own Claude account'), ' and the findings land in this chat. ', COST));
  const el = h(
    'div',
    { class: 'ur-batch', hidden: true },
    listBox,
    h('h4', {}, 'Areas to prep'),
    h('p', { class: 'ur-cost muted' }, 'Prepping is free: a draft pull request per area as your GitHub login (only ', h('code', {}, 'review/…'), " branches, CI skipped). An area over the CLI's limit is refused with its size."),
    noGithub,
    areas,
    refused,
    h('div', { class: 'row ur-batch-actions' }, add, h('span', { class: 'spacer' }), prep),
  );

  function addArea(focus = false, a = {}) {
    const name = h('input', { name: 'area-name', placeholder: 'Name, e.g. Database', autocomplete: 'off', value: a.name || '', 'aria-label': 'Area name' });
    const ps = h('textarea', { name: 'area-paths', rows: 2, placeholder: 'src/db.ts src/db', spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Paths in the area' });
    ps.value = a.paths || '';
    const q = h('input', { name: 'area-question', placeholder: 'Question for the review (optional)', autocomplete: 'off', value: a.question || '', 'aria-label': 'Question for the review' });
    const box = h(
      'fieldset',
      { class: 'ur-area' },
      h(
        'div',
        { class: 'row' },
        name,
        h(
          'button',
          {
            type: 'button',
            class: 'secondary ur-remove',
            title: 'Remove this area',
            'aria-label': 'Remove this area',
            onclick: () => {
              box.remove();
              if (!areas.children.length) addArea(true);
            },
          },
          '×',
        ),
      ),
      ps,
      q,
    );
    box.read = () => ({ name: name.value.trim(), paths: ps.value.split(/[\s,]+/).filter(Boolean), question: q.value.trim() });
    areas.append(box);
    if (focus) name.focus();
  }
  addArea();

  const draw = () => {
    list.replaceChildren(...rows.map(rowEl));
    listBox.hidden = !rows.length;
    noGithub.hidden = github;
    prep.disabled = !github;
    clearTimeout(poll);
    // While a PR is being opened or a review runs, the rows follow it.
    if (rows.some((r) => r.state === 'prepping' || r.state === 'running')) poll = setTimeout(() => dialogOf()?.open && load(), 3000);
  };

  const rowEl = (r) => {
    const [tone, word] = STATE[r.state] || ['neutral', r.state];
    const start = h('button', { type: 'button', disabled: r.state !== 'ready', onclick: () => startRow(r) }, r.state === 'ready' && r.error ? 'Retry' : 'Start');
    const drop = h('button', { type: 'button', class: 'secondary', disabled: r.state === 'running', onclick: () => discard(r) }, 'Discard');
    return h(
      'div',
      { class: 'ur-row', 'data-row': r.id },
      h(
        'div',
        { class: 'ur-row-head' },
        h('strong', { class: 'ur-row-name' }, r.name),
        toneChip(tone, word),
        h('span', { class: 'muted ur-row-size' }, `${fmt(r.size.lines)} lines, ${fmt(r.size.files)} file${r.size.files === 1 ? '' : 's'}`),
        r.pr?.url ? h('a', { href: r.pr.url, target: '_blank', rel: 'noopener' }, `PR #${r.pr.number}`) : h('span', { class: 'muted' }, 'Opening PR…'),
      ),
      h(
        'div',
        { class: 'ur-row-paths muted' },
        r.paths.flatMap((p, i) => [i ? ', ' : '', h('code', {}, p)]),
      ),
      r.error ? h('div', { class: 'ur-row-err' }, r.error) : '',
      h('div', { class: 'row ur-row-actions' }, h('span', { class: 'spacer' }), drop, start),
    );
  };

  const setRow = (id, patch) => {
    rows = patch ? rows.map((x) => (x.id === id ? { ...x, ...patch } : x)) : rows.filter((x) => x.id !== id);
    draw();
  };

  function startRow(r) {
    optimistic({
      key: `ur:${r.id}`,
      label: `start the ultra review of ${r.name}`,
      apply: () => setRow(r.id, { state: 'running', error: undefined }),
      send: () => api(`api/tickets/${t.id}/ultrareview/batch/${r.id}/start`, { method: 'POST', body: { confirm: true } }),
      undo: () => {
        rows = rows.some((x) => x.id === r.id) ? rows.map((x) => (x.id === r.id ? r : x)) : [...rows, r];
        draw();
      },
    });
  }

  function discard(r) {
    optimistic({
      key: `ur:${r.id}`,
      label: `discard the ultra review of ${r.name}`,
      apply: () => setRow(r.id, null),
      send: () => api(`api/tickets/${t.id}/ultrareview/batch/${r.id}`, { method: 'DELETE' }),
      undo: () => {
        rows = [...rows.filter((x) => x.id !== r.id), r].sort((a, b) => a.at - b.at);
        draw();
      },
    });
  }

  async function send() {
    const boxes = [...areas.children];
    const asks = boxes.map((b) => b.read());
    const filled = asks.map((a, i) => [a, boxes[i]]).filter(([a]) => a.paths.length);
    refused.hidden = true;
    if (!filled.length) return showRefused([{ name: '', error: 'Name the files or folders for at least one area.' }]);
    prep.disabled = true;
    prep.textContent = 'Prepping…';
    try {
      const r = await api(`api/tickets/${t.id}/ultrareview/batch`, { method: 'POST', body: { areas: filled.map(([a]) => a) } });
      rows = r.rows;
      // Areas that went through leave the form; refused ones stay to be split or fixed.
      const kept = new Set(r.refused.map((x) => filled[x.index]?.[1]));
      for (const [, b] of filled) if (!kept.has(b)) b.remove();
      if (!areas.children.length) addArea();
      if (r.refused.length) showRefused(r.refused);
    } catch (ex) {
      showRefused([{ name: '', error: ex.message }]);
    } finally {
      prep.textContent = 'Prep draft PRs';
      draw();
    }
  }

  const showRefused = (xs) => {
    refused.replaceChildren(...xs.map((x) => h('div', {}, x.name ? h('strong', {}, `${x.name}: `) : '', x.error)));
    refused.hidden = false;
  };

  async function load() {
    try {
      const r = await api(`api/tickets/${t.id}/ultrareview/batch`);
      rows = r.rows;
      github = r.github;
    } catch {
      // The single-review check above says what's wrong; the batch just stays empty.
    }
    draw();
    return rows;
  }

  return { el, load };
}

const what = (d) =>
  d.mode === 'branch'
    ? h('span', {}, 'branch ', h('code', {}, d.branch), ' against ', h('code', {}, d.base))
    : h(
        'span',
        {},
        'area ',
        d.paths.flatMap((p, i) => [i ? ', ' : '', h('code', {}, p)]),
      );

/** The chat's card for a review: busy until its result settles it with the findings, or why it failed. */
export function ultraCard(data) {
  const status = h('div', { class: 'ur-status muted', role: 'status' }, 'Running on ', data.by, "'s Claude account: 5-15 minutes, up to 45", h('span', { class: 'state-dots', 'aria-hidden': 'true' }, h('i', {}, '.'), h('i', {}, '.'), h('i', {}, '.')));
  const card = h(
    'div',
    { class: 'qcard ur-card busy', 'data-ultra': data.id },
    h('div', { class: 'who' }, 'Ultra review'),
    h('div', { class: 'qtitle' }, data.by, ' started an ultra review of ', what(data), ` (${fmt(data.size.files)} files, ${fmt(data.size.lines)} lines)`),
    data.pr ? prLine(data.pr) : '',
    data.question ? h('div', { class: 'ur-question' }, h('span', { class: 'muted' }, 'Question: '), data.question) : '',
    status,
  );
  card.settle = (r) => {
    if (r.pr && !card.querySelector('.ur-pr')) card.querySelector('.qtitle').after(prLine(r.pr));
    card.classList.remove('busy');
    card.classList.toggle('failed', !r.ok);
    const body = h('pre', { class: 'ur-findings' }, r.text);
    status.replaceChildren(
      r.ok
        ? h('details', { open: true }, h('summary', {}, 'Findings', r.file ? h('span', { class: 'muted' }, ` · saved to ${r.file.split('/').pop()} in this chat's shared folder`) : ''), body)
        : h('div', {}, h('div', { class: 'ur-fail' }, r.code == null ? "It didn't finish." : `It failed (exit code ${r.code}).`), body),
    );
  };
  return card;
}

const prLine = (pr) => h('div', { class: 'ur-pr muted' }, 'Via draft pull request ', h('a', { href: pr.url, target: '_blank', rel: 'noopener' }, `#${pr.number}`), ', closed once the findings are in');

/** A result whose card isn't in the log (it was paged out): shown on its own. */
export function ultraResult(r) {
  const card = ultraCard({ id: r.id, by: 'Someone', mode: 'area', paths: [], size: { files: 0, lines: 0 } });
  card.querySelector('.qtitle').textContent = 'Ultra review finished';
  card.settle(r);
  return card;
}
