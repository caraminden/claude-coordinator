// Cloud helpers' routes (#2187): Citadel's cloud helpers switch, which a minion's turn reads before it hands work to a cloud session
// (src/cloud-flakes.ts, HELPERS_SWITCH; #2200 reuses it), and the nightly cloud sweep's: which files tools/cloud-flake.ts reruns, the
// flakiest of 14 days counting only sightings off the cloud (its own don't pick themselves), and the night it posts back, on the
// Test health tab. While the switch is off (the default) the sweep's are refused.
import { HELPERS_OFF, helpersOn, keepNights, nightSightings, readNight, SWEEP, type SweepNight, sweepsKey } from '../cloud-flakes.ts';
import { FLAKE_WINDOW_MS } from '../flakes.ts';
import { HttpError, json, readJson, type Route } from '../http.ts';
import { repoSlug } from '../prlinks.ts';

export const cloudHelperRoutes: Route[] = [
  {
    method: 'GET',
    path: '/api/tickets/:ticket/cloud-helpers/switch',
    who: ['minion'],
    refuse: "Only a minion's turn hands work to a cloud helper",
    handler({ res, app }) {
      json(res, 200, { on: helpersOn(app.store) });
    },
  },
  {
    // What only the server sees for citadel-cloud's pick of a place (#2200, Cara's "Helper checks first"): the switch, and
    // whether a PC lending this scheme CI has room for a suite now with no ship or CI waiting there.
    method: 'GET',
    path: '/api/tickets/:ticket/cloud-helpers/place',
    who: ['minion'],
    refuse: "Only a minion's turn hands work to a cloud helper",
    handler({ res, app, ticket }) {
      const slug = repoSlug(app.store.getProject(ticket.project_id)?.repo_url ?? null);
      json(res, 200, { on: helpersOn(app.store), machine: !!slug && (app.heavy?.room(slug) ?? false) });
    },
  },
  {
    method: 'GET',
    path: '/api/tickets/:ticket/cloud-sweep/picks',
    who: ['minion'],
    refuse: "Only a minion's turn runs the cloud sweep",
    handler({ res, url, app, ticket }) {
      if (!helpersOn(app.store)) throw new HttpError(409, HELPERS_OFF);
      const n = Math.min(50, Math.max(1, Number(url.searchParams.get('n')) || SWEEP.files));
      json(res, 200, { files: app.store.flakeCounts(ticket.project_id, Date.now() - FLAKE_WINDOW_MS, n, true).map((f) => f.file) });
    },
  },
  {
    method: 'POST',
    path: '/api/tickets/:ticket/cloud-sweep',
    who: ['minion'],
    refuse: "Only a minion's turn runs the cloud sweep",
    async handler({ req, res, app, ticket }) {
      if (!helpersOn(app.store)) throw new HttpError(409, HELPERS_OFF);
      const night = readNight(await readJson(req), ticket.number ?? null, Date.now());
      if (typeof night === 'string') throw new HttpError(400, night);
      const { store } = app;
      const last = store.getSetting<SweepNight[]>(sweepsKey(ticket.project_id))?.[0];
      // A retried post of the same night would count its sightings twice.
      if (last && last.minion === night.minion && last.sha === night.sha && last.minutes === night.minutes && last.error === night.error && JSON.stringify(last.files) === JSON.stringify(night.files)) throw new HttpError(409, 'That night is already posted');
      store.setSetting(sweepsKey(ticket.project_id), keepNights(store.getSetting<SweepNight[]>(sweepsKey(ticket.project_id)) ?? [], night));
      const seen = nightSightings(night);
      if (seen.length) store.addFlakeEvents(ticket.project_id, ticket.id, night.sha, night.at, seen);
      json(res, 200, { ok: true, sightings: seen.length, costUsd: night.costUsd });
    },
  },
];
