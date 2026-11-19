// Two read-outs on the Releases page (#1060): the claims a scheme holds (the pipeline lane and other single-holder
// duties, src/claims.ts) with a Release button, and Citadel's post-deploy watch (src/deploy-watch.ts): each deploy's
// checks at +20 min, +1 h and +24 h, before against after. The server decides every verdict; nothing here knows a threshold.
import { ago, api, h } from './base.js';
import { optimistic } from './ui/optimistic.js';
import { hueRow, showFirst, statTiles, toneChip } from './look.js';
import { settingsRow } from './settings.js';

const claims = new Map(); // projectId → [claim view]
let watch = null; // deploy-watch deploys, or null

/** Reads one scheme's claims (a `claims` event, or the first look). Quiet on failure: the card just has no claims line. */
export async function loadClaims(projectId, redraw) {
  try {
    claims.set(projectId, (await api(`api/projects/${projectId}/claims`)).claims);
    redraw();
  } catch { /* an older server, or a restart's gap */ }
}

export async function loadWatch(redraw) {
  try {
    watch = (await api('api/deploy-watch')).deploys;
    redraw();
  } catch { /* as above */ }
}

const OFFSETS = { 1_200_000: '+20 min', 3_600_000: '+1 h', 86_400_000: '+24 h' };

export function claimsBlock(projectId, redraw) {
  const list = claims.get(projectId) ?? [];
  if (!list.length) return '';
  // Each claim is a row that opens (Citadel's look, #1068): who holds it on the closed line, the note and Release inside.
  const rows = list.map((c) => settingsRow({ key: `claim:${projectId}/${c.name}`, icon: 'lock', hue: 'held', title: c.name,
    summary: [toneChip('violet', 'Held'), `${c.holder_name} · ${c.since_text}`] },
  hueRow({ hue: 'held', meta: h('button', { type: 'button', class: 'btn-small', title: `Free ${c.name}; its holder is told nothing`, onclick: () => optimistic({
    key: `claim:${projectId}/${c.name}`,
    apply: () => { claims.set(projectId, (claims.get(projectId) ?? []).filter((x) => x.name !== c.name)); redraw(); },
    send: () => api(`api/projects/${projectId}/claims/${encodeURIComponent(c.name)}`, { method: 'DELETE' }),
    undo: () => { claims.set(projectId, list); redraw(); },
    label: `release ${c.name}`,
  }) }, 'Release') }, h('b', {}, c.holder_name), ' ', h('span', { class: 'muted' }, `${c.since_text}${c.note ? ` · ${c.note}` : ''}`)))[0]);
  return h('section', { class: 'rel-claims' }, h('h3', { class: 'settings-section', 'data-hue': 'held' }, 'Held by one at a time'),
    h('div', { class: 'settings-rows' }, ...rows));
}

const verdict = (r) => (r.worse ? 'worse' : 'fine');

/** One check of a deploy: its offset and verdict on a bar in the verdict's hue, then each reading under it. */
function checkRows(d, c) {
  const offset = OFFSETS[c.offset] ?? `+${c.offset / 60000} min`;
  const note = (t) => h('span', { class: 'muted' }, t);
  if (c.len === null) return [hueRow({ hue: 'muted', lead: offset }, note(d.alerted ? 'not run: an earlier check raised the alert' : 'not due yet'))];
  if (!c.readings.length) return [hueRow({ hue: 'muted', lead: offset }, note('window too short to compare (the next deploy cut it)'))];
  const bad = c.readings.filter((r) => r.worse).length;
  return [hueRow({ hue: bad ? 'danger' : 'done', lead: offset, meta: toneChip(bad ? 'danger' : 'ok', bad ? `${bad} worse` : 'Fine') },
    `${c.readings.length} readings`),
  ...c.readings.map((r) => hueRow({ hue: r.worse ? 'danger' : 'done', meta: `${r.before} → ${r.after} · ${verdict(r)}` }, `${r.name}`))];
}

export function watchBlock() {
  if (!watch?.length) return '';
  const rows = watch.map((d, i) => {
    const run = d.checks.filter((c) => c.readings.length).length; // a window the next deploy cut short compared nothing
    const worse = d.checks.reduce((n, c) => n + c.readings.filter((r) => r.worse).length, 0);
    const [tone, word] = d.alerted ? ['danger', 'Raised an alert'] : worse ? ['warn', `${worse} worse`] : run ? ['ok', 'Fine'] : ['neutral', 'Not checked yet'];
    return settingsRow({ key: `watch:${d.commit}`, icon: 'eye', hue: d.alerted ? 'danger' : worse ? 'waiting' : 'done', open: i === 0, title: d.commit.slice(0, 8),
      summary: [toneChip(tone, word), `live ${ago(d.at)} · ${run}/${d.checks.length} checks compared`] },
    statTiles([`${run} of ${d.checks.length}`, 'checks compared', 'running'], [String(worse), 'readings worse', worse ? 'danger' : 'done']),
    h('div', { class: 'hue-rows' }, ...d.checks.flatMap((c) => checkRows(d, c))))[0];
  });
  return h('section', { class: 'rel-watch' }, h('h3', { class: 'settings-section', 'data-hue': 'running' }, 'Post-deploy watch'),
    showFirst({ key: 'watch-deploys', items: rows, n: 5, noun: 'deploys', wrap: (xs) => h('div', { class: 'settings-rows' }, ...xs) }),
    h('p', { class: 'look-prose' }, 'Each reading in the window after a deploy against the same window before it. It only warns: it never reverts.'));
}
