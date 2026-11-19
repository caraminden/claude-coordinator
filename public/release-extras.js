// Two read-outs on the Releases page (#1060): the claims a scheme holds (the pipeline lane and other single-holder
// duties, src/claims.ts) with a Release button, and Citadel's post-deploy watch (src/deploy-watch.ts): each deploy's
// checks at +20 min, +1 h and +24 h, before against after. The server decides every verdict; nothing here knows a threshold.
import { ago, api, h } from './base.js';
import { optimistic } from './ui/optimistic.js';

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
  return h('section', { class: 'rel-claims' }, h('h4', {}, 'Held by one at a time'),
    ...list.map((c) => h('div', { class: 'rel-claim' },
      h('b', {}, c.name), h('span', {}, c.holder_name), h('span', { class: 'muted' }, `${c.since_text}${c.note ? ` · ${c.note}` : ''}`),
      h('button', { type: 'button', class: 'btn-small', title: `Free ${c.name}; its holder is told nothing`, onclick: () => optimistic({
        key: `claim:${projectId}/${c.name}`,
        apply: () => { claims.set(projectId, (claims.get(projectId) ?? []).filter((x) => x.name !== c.name)); redraw(); },
        send: () => api(`api/projects/${projectId}/claims/${encodeURIComponent(c.name)}`, { method: 'DELETE' }),
        undo: () => { claims.set(projectId, list); redraw(); },
        label: `release ${c.name}`,
      }) }, 'Release'))));
}

const verdict = (r) => (r.worse ? 'worse' : 'fine');

export function watchBlock() {
  if (!watch?.length) return '';
  return h('section', { class: 'rel-watch' }, h('h4', {}, 'Post-deploy watch'),
    h('p', { class: 'muted small' }, 'Each reading in the window after a deploy against the same window before it. It only warns: it never reverts.'),
    ...watch.map((d) => h('details', { class: 'rel-watch-deploy', open: d === watch[0] },
      h('summary', {}, h('code', {}, d.commit.slice(0, 8)), ` live ${ago(d.at)}`, d.alerted ? h('b', { class: 'rel-watch-bad' }, ' · it raised an alert') : ''),
      ...d.checks.map((c) => h('div', { class: 'rel-watch-check' },
        h('b', {}, OFFSETS[c.offset] ?? `+${c.offset / 60000} min`),
        c.len === null ? h('span', { class: 'muted' }, d.alerted ? 'not run: an earlier check raised the alert' : 'not due yet')
          : !c.readings.length ? h('span', { class: 'muted' }, 'window too short to compare (the next deploy cut it)')
            : h('ul', {}, ...c.readings.map((r) => h('li', { class: `rel-watch-${verdict(r)}` }, `${r.name}: ${r.before} → ${r.after} · ${verdict(r)}`))))))));
}
