// The Releases page's Code tab (#1988; Josh, 2026-11-25, "Split these: big and busy, top right"): each file a dot, its lines
// across and the minions that changed it in two weeks up, bigger for more bug fixes; the corner where a split pays most is
// marked, with the ranked list beside it (above it on a phone). Numbers are the server's daily count (src/code-counts.ts).
// "Start a split minion" drafts a message into your Taskmaster's box in that scheme; nothing starts until a person sends it.
import { api, h, icon, pacificStamp, view, svg as svgEl } from './base.js';
import { BIG, candidates, folders, score, shortName, splitDraft, zone } from './codemath.js';
import { loadDraft, saveDraft } from './composer.js';
import { emptyCard, meter, showFirst, toneChip } from './look.js';
import { openDialog } from './ui/dialog.js';
import { toast } from './ui/status.js';

/** @import { CodeCountsAnswer, CodeFile } from './types/code-map.js' */
/** @typedef {Record<string, { number: number; title: string }[]>} Splitting */
/** @typedef {{ f: CodeFile; x: number; y: number; r: number; el: SVGElement | null }} Dot */
/** @typedef {Partial<CodeCountsAnswer> & { error?: unknown }} CodeRead the read, or what ci.js keeps when it failed */

/** @param {number} id @returns {Promise<CodeCountsAnswer>} */
export const readCode = (id) => api(`api/projects/${id}/code-counts`);

/** @param {number} n */
const num = (n) => n.toLocaleString('en-US');
/** @param {number} n @param {string} one @param {string} [many] */
const plural = (n, one, many = `${one}s`) => `${num(n)} ${n === 1 ? one : many}`;
/** @param {CodeFile} f */
const facts = (f) => `${plural(f.lines, 'line')} · ${plural(f.changed, 'minion')}${f.bugs ? ` · ${plural(f.bugs, 'bug fix', 'bug fixes')}` : ''}`;
/** @param {number} project @param {number} n */
const minionHref = (project, n) => `#/p/${project}/t/${n}`;
/**
 * @template {HTMLElement | SVGElement} E
 * @param {E} el
 * @param {Record<string, string>} props
 * @returns {E}
 */
const put = (el, props) => {
  for (const [k, v] of Object.entries(props)) el.style.setProperty(k, v);
  return el;
};
/** Files with one change or a few lines are never an answer: they would only fill the bottom left. */
/** @param {CodeFile} f */
const drawn = (f) => f.changed >= 2 && f.lines >= 30;

// ---------- the draft ----------

/** "Start a split minion": the draft to look over, then into your Taskmaster's box in that scheme. Nothing is sent. */
/** @param {number} project @param {CodeFile} f @param {number} days */
function draftSplit(project, f, days) {
  const box = h('textarea', { class: 'code-draft', rows: 16, 'aria-label': 'The draft', spellcheck: 'true' });
  box.value = splitDraft(f, days);
  const go = async () => {
    const text = box.value.trim();
    dialog.close();
    if (!text) return;
    try {
      const tm = view?.projectId === project && view.coordinator ? view.coordinator : (await api(`api/projects/${project}?tickets=open`)).coordinator;
      const key = `cc-draft:${tm.id}`;
      const was = loadDraft(key)?.trim();
      if (!was?.includes(text)) saveDraft(key, was ? `${was}\n\n${text}` : text);
      location.hash = `#/p/${project}`;
    } catch (err) {
      toast(`Couldn't open your Taskmaster's chat: ${/** @type {Error} */ (err).message}`, { tone: 'warn', action: { label: 'Retry', run: go } });
    }
  };
  const dialog = openDialog({
    title: 'Start a split minion',
    className: 'code-dialog',
    body: [
      h('p', { class: 'muted' }, 'A draft for your Taskmaster. Nothing starts until you send it from that chat.'),
      box,
      h('div', { class: 'cui-dialog-actions code-actions' }, h('button', { type: 'button', class: 'cui-btn', onclick: () => dialog.close() }, 'Cancel'), h('button', { type: 'button', class: 'cui-btn cui-primary', onclick: go }, "Put it in your Taskmaster's box")),
    ],
  });
}

// ---------- the chart ----------

/** The dots, drawn at the box's own pixels so text and dots keep their size; `mark(path)` lights one, from the list or the chart. */
/**
 * @param {{ files: CodeFile[]; top: CodeFile[]; z: { lines: number; changed: number }; splitting: Splitting; inFolder: (f: CodeFile) => boolean; on: { light: (path: string | null) => void; pick: (path: string) => void } }} opts
 */
function chart({ files, top, z, on, splitting, inFolder }) {
  const el = h('div', { class: 'code-chart' });
  const tip = h('div', { class: 'ci-tip code-tip', hidden: true });
  /** @type {Dot[]} */
  let dots = [];
  let nameDots = () => {};
  let entered = false;
  const isTop = new Set(top.map((f) => f.path));
  const maxLines = Math.max(1000, ...files.map((f) => f.lines)) * 1.25;
  const maxChanged = Math.max(10, z.changed * 2, ...files.map((f) => f.changed)) * 1.3;
  /** @param {CodeFile} f */
  const kind = (f) => (splitting[f.path] ? 'on' : isTop.has(f.path) ? 'top' : 'rest');

  /** @param {number} W */
  function draw(W) {
    const phone = W < 520,
      H = Math.round(Math.max(320, Math.min(500, W * 0.78))),
      L = 34,
      R = 10,
      T = 28,
      B = 40;
    /** @param {number} lo @param {number} hi @param {number} a @param {number} b */
    const log = (lo, hi, a, b) => (/** @type {number} */ v) => a + ((Math.log(v) - Math.log(lo)) / (Math.log(hi) - Math.log(lo))) * (b - a);
    const x = log(30, maxLines, L, W - R),
      y = log(2, maxChanged, H - B, T);
    const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': `${plural(files.length, 'file')} by lines and by minions that changed them; ${plural(top.length, 'file')} in the marked corner. The table shows the same numbers.` });
    /** @param {number} tx @param {number} ty @param {string} words @param {string} cls @param {string} [anchor] */
    const text = (tx, ty, words, cls, anchor = 'start') => {
      const t = svgEl('text', { x: tx, y: ty, class: cls, 'text-anchor': anchor });
      t.textContent = words;
      svg.append(t);
    };
    const zx = x(z.lines),
      zy = y(z.changed);
    svg.append(svgEl('rect', { class: 'zone', x: zx, y: T - 8, width: Math.max(0, W - R - zx), height: Math.max(0, zy - T + 8), rx: 8 }));
    for (const v of [30, 100, 300, 1000, 3000, 10000].filter((v) => v < maxLines)) {
      svg.append(svgEl('line', { class: 'grid', x1: x(v), x2: x(v), y1: T, y2: H - B }));
      text(x(v), H - B + 16, num(v), 'axis', 'middle');
    }
    for (const v of [2, 5, 10, 25, 50, 100, 250, 500].filter((v) => v < maxChanged)) {
      svg.append(svgEl('line', { class: 'grid', x1: L, x2: W - R, y1: y(v), y2: y(v) }));
      text(L - 6, y(v) + 4, num(v), 'axis', 'end');
    }
    text((L + W) / 2, H - 5, 'Lines in the file', 'axis', 'middle');
    text(0, T - 14, 'Minions that changed it', 'axis');
    /** @param {CodeFile} f */
    const rOf = (f) => 3.5 + Math.sqrt(f.bugs) * (phone ? 1.3 : 2);
    dots = [...files]
      .sort((a, b) => b.bugs - a.bugs) // small dots on top of big ones
      .map((f) => ({ f, x: x(f.lines), y: y(f.changed), r: rOf(f), el: null }));
    dots.forEach((d, i) => {
      d.el = svgEl('circle', { class: `dot-${kind(d.f)}${entered ? '' : ' enter'}`, cx: d.x.toFixed(1), cy: d.y.toFixed(1), r: d.r.toFixed(1) });
      if (!entered) put(d.el, { '--i': String(Math.min(i, 60)) });
      svg.append(d.el);
    });
    entered = true;
    text(W - R - 2, T - 14, top.length ? 'Split these' : 'Big and busy: none yet', 'zone-name', 'end');
    const names = svgEl('g', {});
    svg.append(names);
    nameDots = () => label(names, { W, H, L, B, most: phone ? 4 : 8 });
    el.replaceChildren(svg, tip);
    filter();
  }

  // Names for the best few in the folder, each where no name or marked dot is already; one with no room goes without (its row and tip have it).
  /** @param {SVGElement} g @param {{ W: number; H: number; L: number; B: number; most: number }} box */
  function label(g, { W, H, L, B, most }) {
    g.replaceChildren();
    /** @type {number[][]} */
    const boxes = [];
    const paths = top.map((f) => f.path);
    /** @param {number[]} b @param {number[]} o */
    const hits = (b, o) => b[0] < o[2] && b[2] > o[0] && b[1] < o[3] && b[3] > o[1];
    for (const f of top.filter(inFolder).slice(0, most)) {
      const d = /** @type {Dot} */ (dots.find((o) => o.f === f)),
        words = shortName(f.path, paths),
        w = words.length * 6.9 + 4;
      /** @type {[number, number, string][]} */
      const spots = [
        [d.x + d.r + 5, d.y + 4, 'start'],
        [d.x - d.r - 5, d.y + 4, 'end'],
        [d.x, d.y - d.r - 5, 'middle'],
        [d.x, d.y + d.r + 14, 'middle'],
      ];
      for (const [x, y, anchor] of spots) {
        const x0 = anchor === 'start' ? x : anchor === 'end' ? x - w : x - w / 2,
          b = [x0, y - 12, x0 + w, y + 3];
        if (b[0] < L || b[2] > W - 2 || b[1] < 0 || b[3] > H - B) continue;
        if (boxes.some((o) => hits(b, o))) continue;
        if (dots.some((o) => o !== d && kind(o.f) !== 'rest' && inFolder(o.f) && hits(b, [o.x - o.r, o.y - o.r, o.x + o.r, o.y + o.r]))) continue;
        boxes.push(b);
        const t = svgEl('text', { x, y, class: 'name halo', 'text-anchor': anchor });
        t.textContent = words;
        g.append(t);
        break;
      }
    }
  }

  const filter = () => {
    for (const d of dots) /** @type {SVGElement} */ (d.el).classList.toggle('out', !inFolder(d.f));
    nameDots();
  };
  /** @param {Dot | null | undefined} d */
  const ring = (d) => {
    for (const o of dots) /** @type {SVGElement} */ (o.el).classList.toggle('lit', o === d);
  };
  /** @param {Dot | null} d */
  const show = (d) => {
    ring(d);
    if (!d) {
      tip.hidden = true;
      return;
    }
    const by = splitting[d.f.path];
    tip.replaceChildren(h('strong', {}, d.f.path), h('span', {}, facts(d.f)), d.f.who.length ? h('span', { class: 'muted' }, `Latest: ${d.f.who.map((n) => `#${n}`).join(', ')}`) : '', by ? h('span', {}, toneChip('violet', `#${by[0].number} is splitting it`)) : '');
    tip.hidden = false;
    const W = el.clientWidth,
      w = tip.offsetWidth,
      hgt = tip.offsetHeight;
    put(tip, { left: `${Math.max(0, d.x + d.r + 10 + w > W ? d.x - d.r - 10 - w : d.x + d.r + 10)}px`, top: `${Math.max(0, Math.min(el.clientHeight - hgt, d.y - hgt / 2))}px` });
  };
  /** @param {MouseEvent} ev */
  const near = (ev) => {
    const b = el.getBoundingClientRect(),
      px = ev.clientX - b.left,
      py = ev.clientY - b.top;
    /** @type {Dot | null} */
    let best = null;
    let gap = 22;
    for (const d of dots) {
      if (!inFolder(d.f)) continue;
      const g = Math.max(0, Math.hypot(d.x - px, d.y - py) - d.r) + (isTop.has(d.f.path) ? 0 : 0.5);
      if (g < gap) [best, gap] = [d, g];
    }
    return best;
  };
  /** @param {MouseEvent} ev */
  const move = (ev) => {
    const d = near(ev);
    show(d);
    el.classList.toggle('hit', !!d && isTop.has(d.f.path));
    on.light(d?.f.path ?? null);
  };
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerdown', move);
  el.addEventListener('pointerleave', () => {
    show(null);
    on.light(null);
  });
  el.addEventListener('click', (/** @type {MouseEvent} */ ev) => {
    const d = near(ev);
    if (d) on.pick(d.f.path);
  });
  let width = 0;
  new ResizeObserver(() => {
    const w = Math.round(el.clientWidth);
    if (w && w !== width) draw((width = w));
  }).observe(el);
  return { el, filter, light: (/** @type {string | null} */ path) => ring(dots.find((d) => d.f.path === path)) };
}

// ---------- the tab ----------

const kinds = new Map(); // scheme id -> { folder, table }: kept across reads
/** @type {{ id: number; data: CodeRead | null | undefined; el: HTMLElement } | null} */
let last = null; // { id, data, el }: the same read draws the same page, so a poll's redraw moves nothing

/** The Code tab for scheme `id`: `data` is its read, null while it's on its way, `{ error }` when that failed. */
/** @param {number} id @param {string} name @param {CodeRead | null | undefined} data @param {() => void} retry */
export function codeTab(id, name, data, retry) {
  if (last?.id === id && last.data === data && data?.kept) return last.el;
  const el = h('div', { class: 'code-tab' }, ...build(id, name, data, retry));
  last = { id, data, el };
  return el;
}

/** @param {number} id @param {string} name @param {CodeRead | null | undefined} data @param {() => void} retry */
function build(id, name, data, retry) {
  /** @param {...import('./base.js').Child} more */
  const head = (...more) => h('div', { class: 'ci-head' }, h('h3', {}, name), ...more);
  if (data?.error) return [head(), h('p', { class: 'error' }, "Couldn't read this scheme's files. ", h('button', { type: 'button', class: 'secondary small', onclick: retry }, 'Try again'))];
  if (!data) return [head(), h('div', { class: 'code-skeleton', 'aria-label': 'Reading the files' })];
  const k = data.kept;
  if (!data.repo) return [head(), emptyCard('No repo to count', 'A scheme with a git repo shows its files here, by size and by how many minions changed them.', { mark: '·', hue: 'muted' })];
  if (!k) return [head(), emptyCard('Not counted yet', 'Its files are counted from git once a day, one scheme at a time. The first count comes within a couple of hours, outside 3 to 6 AM Pacific.', { mark: '·', hue: 'muted' })];
  if (!k.at) return [head(), emptyCard("Its files couldn't be counted", `${k.error}. It is tried again tomorrow.`, { mark: '!', hue: 'waiting' })];
  const { splitting } = /** @type {CodeCountsAnswer} */ (data);
  const when = h('span', { class: 'muted small' }, `the last ${k.days} days on ${k.branch}, counted ${pacificStamp(k.at)}`);
  const stale = k.error ? h('div', { class: 'code-stale' }, toneChip('warn', 'Last count failed'), ' ', h('span', { class: 'muted' }, `These are the numbers from before. ${k.error}`)) : null;
  const files = k.files.filter(drawn);
  if (!files.length) return [head(when), stale ?? '', emptyCard('No file stands out', `Fewer than two minions changed any one file in ${k.days} days. Files show here as they get busy.`)];
  const top = /** @type {CodeFile[]} */ (candidates(files)),
    z = zone(files),
    open = top.filter((f) => !splitting[f.path]);
  const st = kinds.get(id) ?? { folder: '', table: false };
  kinds.set(id, st);
  /** @param {CodeFile} f */
  const inFolder = (f) => f.path.startsWith(st.folder);
  if (st.folder && !files.some(inFolder)) st.folder = '';

  /** @type {ReturnType<typeof chart>} */
  let map; // the chart, once drawn
  /** @type {Map<string, HTMLElement>} */
  const rows = new Map();
  const listBox = h('div', { class: 'code-list' });
  /** @param {string | null} path */
  const light = (path) => {
    for (const [p, r] of rows) r.classList.toggle('lit', p === path);
  };
  const names = top.map((f) => f.path);
  const best = top.length ? score(top[0]) : 1;
  /** @param {CodeFile} f */
  const rowOf = (f) => {
    const by = splitting[f.path];
    const dir = f.path.slice(0, f.path.length - /** @type {string} */ (f.path.split('/').at(-1)).length);
    const row = h(
      'li',
      { class: `code-row${by ? ' busy' : ''}`, tabindex: -1, onmouseenter: () => map.light(f.path), onmouseleave: () => map.light(null), onfocusin: () => map.light(f.path), onfocusout: () => map.light(null) },
      h('b', { class: 'code-rank' }, String(names.indexOf(f.path) + 1)),
      h(
        'div',
        { class: 'code-row-main' },
        h('div', { class: 'code-path', title: f.path }, h('b', {}, f.path.split('/').at(-1)), dir ? h('span', { class: 'muted' }, dir) : ''),
        meter(score(f) / best, facts(f)),
        by
          ? h('div', { class: 'code-by' }, toneChip('violet', 'Being split'), ...by.flatMap((m, i) => [i ? ', ' : ' ', h('a', { href: minionHref(id, m.number) }, `#${m.number} ${m.title}`)]))
          : h('button', { type: 'button', class: 'cui-btn cui-small code-start', 'aria-label': `Start a split minion for ${f.path}`, onclick: () => draftSplit(id, f, k.days) }, 'Start a split minion'),
      ),
    );
    rows.set(f.path, row);
    return row;
  };
  const drawList = () => {
    rows.clear();
    const shown = top.filter(inFolder);
    listBox.replaceChildren(
      h('h4', {}, 'Where a split pays most'),
      shown.length ? showFirst({ key: `code-${id}`, items: shown.map(rowOf), n: 5, noun: 'files', wrap: (xs) => h('ol', { class: 'code-rows' }, ...xs) }) : emptyCard('No file stands out', `Nothing ${st.folder ? `in ${st.folder}` : 'here'} is both over ${num(BIG)} lines and changed by ${z.changed} or more minions.`),
    );
  };
  map = chart({
    files,
    top,
    z,
    splitting,
    inFolder,
    on: {
      light,
      pick: (path) => {
        const r = rows.get(path);
        if (!r) return;
        if (!r.isConnected) /** @type {HTMLElement | null} */ (listBox.querySelector('.show-more'))?.click();
        (rows.get(path) ?? r).scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        rows.get(path)?.focus({ preventScroll: true });
      },
    },
  });
  const legend = h(
    'div',
    { class: 'ci-legend code-legend' },
    .../** @type {([string, string] | null)[]} */ ([['top', 'Big and busy'], Object.keys(splitting).length ? ['on', 'Being split'] : null, ['rest', 'The rest']])
      .filter(/** @returns {x is [string, string]} */ (x) => !!x)
      .map(([c, words]) => h('span', {}, h('i', { class: `code-key ${c}`, 'aria-hidden': 'true' }), words)),
    h('span', {}, h('i', { class: 'code-key sizes', 'aria-hidden': 'true' }), 'Bigger: more bug fixes'),
  );
  const stage = h('div', { class: 'code-stage' });
  const drawStage = () => {
    stage.classList.toggle('table', st.table);
    if (!st.table) return void stage.replaceChildren(legend, map.el);
    const shown = [...files].filter(inFolder).sort((a, b) => score(b) - score(a));
    stage.replaceChildren(
      showFirst({
        key: `code-table-${id}`,
        items: shown.map((f) => h('tr', {}, h('td', { class: 'code-td-path' }, f.path), h('td', {}, num(f.lines)), h('td', {}, num(f.changed)), h('td', {}, num(f.bugs)))),
        n: 14,
        noun: 'files',
        wrap: (xs) => h('table', { class: 'code-table' }, h('thead', {}, h('tr', {}, ...['File', 'Lines', 'Minions', 'Bug fixes'].map((t) => h('th', { scope: 'col' }, t)))), h('tbody', {}, ...xs)),
      }),
    );
  };
  const chips = h('div', { class: 'chips', role: 'group', 'aria-label': 'Folder' });
  const views = h('div', { class: 'chips', role: 'group', 'aria-label': 'Show as' });
  /** @param {string} words @param {boolean} on @param {() => void} pick @param {string} [title] */
  const chip = (words, on, pick, title) => h('button', { type: 'button', class: `chip${on ? ' on' : ''}`, 'aria-pressed': String(on), title, onclick: pick }, words);
  const drawChips = () => {
    chips.replaceChildren(
      ...['', ...folders(files)].map((f) =>
        chip(f || 'Everything', st.folder === f, () => {
          st.folder = f;
          drawChips();
          drawList();
          map.filter();
          if (st.table) drawStage();
          /** @type {HTMLElement | null} */ (chips.querySelector('.on'))?.focus();
        }),
      ),
    );
    views.replaceChildren(
      .../** @type {[string, boolean][]} */ ([
        ['Chart', false],
        ['Table', true],
      ]).map(([words, table]) =>
        chip(words, st.table === table, () => {
          st.table = table;
          drawChips();
          drawStage();
          /** @type {HTMLElement | null} */ (views.querySelector('.on'))?.focus();
        }),
      ),
    );
  };
  drawChips();
  drawList();
  drawStage();
  const lead = open[0] ?? top[0];
  const sum = !top.length
    ? [toneChip('ok', 'Nothing to split')]
    : !open.length
      ? [toneChip('violet', 'All being split'), h('span', {}, `${plural(top.length, 'file')} in the corner, each with a minion on it.`)]
      : [toneChip('warn', `${plural(open.length, 'file')} to split`), top.length > open.length ? toneChip('violet', `${top.length - open.length} being split`) : '', h('span', {}, 'First ', h('b', {}, shortName(lead.path, names)), `: ${facts(lead)}.`)];
  return [
    head(when),
    stale ?? '',
    h('section', { class: 'ci-block code-block', 'data-hue': open.length ? 'accent' : 'done' }, h('div', { class: 'code-sum' }, h('span', { class: 'settings-tile' }, icon('chart')), ...sum), h('div', { class: 'code-ctl' }, chips, views), h('div', { class: 'code-grid' }, stage, listBox)),
    h(
      'details',
      { class: 'code-how' },
      h('summary', {}, "How it's counted"),
      h(
        'p',
        { class: 'look-prose muted small' },
        `Code files only: tests, docs, other people's code and copies of Citadel's kit are left out. A minion counts once per file, and a commit that names no minion counts as one of its own. Busy is ${z.changed} minions here: 40, or a quarter of the busiest big file's where that is fewer. A change stops counting once its file is cut to under half the size it had, and a file never counts the minion that made it, so a split starts fresh.`,
      ),
    ),
  ];
}
