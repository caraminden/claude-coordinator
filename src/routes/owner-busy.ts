// A machine's owner's own use, for CI (Build 11 P4, src/owner-busy.ts): the machine agent's word on what is in front of its
// person, and the card's Pause, Resume and "Run CI anyway". None of them touches a running job.
import { managesMachine } from '../access.ts';
import { HttpError, json, readJson, type Route } from '../http.ts';
import { FRONTS, PAUSE_FOR, type Front, type PauseFor } from '../owner-busy.ts';

/** The pool's owner-busy, or 503 in a server without one. */
const ownerBusy = (app: Parameters<Route['handler']>[0]['app']) => {
  if (!app.ownerBusy) throw new HttpError(503, 'The runner pool is not running here');
  return app.ownerBusy;
};

export const ownerBusyRoutes: Route[] = [
  {
    // A Windows machine agent says what is in front of its person, every 30 seconds (public/machine-agent.mjs watchFront).
    method: 'POST',
    path: '/api/machines/front',
    who: 'machine',
    async handler({ req, res, app }) {
      const machine = app.machines.authenticate(req);
      if (!machine) throw new HttpError(401, 'Unknown machine token; make a new one in the Machines panel');
      const { front } = await readJson(req, 1_000);
      if (!FRONTS.includes(front as Front)) throw new HttpError(400, 'front must be "game", "fullscreen", "presenting" or null');
      app.ownerBusy?.front(machine.id, front as Front);
      json(res, 202, {});
    },
  },
  {
    // { for: "hour" | "tomorrow" | "resumed" } pauses CI there; { for: null } resumes. New jobs only: running ones finish.
    method: 'POST',
    path: '/api/machines/:machine/ci-pause',
    who: ['person'],
    refuse: 'Only people manage machines',
    async handler({ req, res, app, machine, session }) {
      if (!managesMachine(session, machine)) throw new HttpError(404, 'No such machine');
      const body = await readJson(req, 1_000);
      const busy = ownerBusy(app);
      if (body.for === null) {
        console.log(`Runner pool: ${session.name} resumed CI on ${machine.name}`);
        return json(res, 200, busy.resume(machine.id));
      }
      if (!PAUSE_FOR.includes(body.for as PauseFor)) throw new HttpError(400, 'for must be "hour", "tomorrow", "resumed" or null (resume)');
      const use = busy.pause(machine.id, body.for as PauseFor, session.name);
      console.log(`Runner pool: ${session.name} paused CI on ${machine.name} ${use.pause?.words}`);
      json(res, 200, use);
    },
  },
  {
    // "Run CI anyway": jobs start there again for this busy spell; the next one steps back again.
    method: 'POST',
    path: '/api/machines/:machine/ci-anyway',
    who: ['person'],
    refuse: 'Only people manage machines',
    handler({ res, app, machine, session }) {
      if (!managesMachine(session, machine)) throw new HttpError(404, 'No such machine');
      const busy = ownerBusy(app);
      if (!busy.anyway(machine.id)) throw new HttpError(409, `${machine.name} isn't stepping back now`);
      console.log(`Runner pool: ${session.name} runs CI on ${machine.name} anyway while it's busy`);
      json(res, 200, busy.use(machine.id));
    },
  },
];
