// Heavy jobs off the server tell Citadel about their room (Build 7 M6c, #2120, src/heavy-place.ts):
//  - a heavy CI job's last step (tools/heavy-done.ts), with its own GitHub run token (Josh's pick, "GitHub's run token"):
//    its room on the PC is free at once, rather than at Citadel's next look at GitHub;
//  - a PC's agent, with the PC's token, before and while it runs a Windows test run (public/machine-agent.mjs).
import { HttpError, json, readJson, type Route } from '../http.ts';

const RUNNER = /^[\w.-]{1,100}$/;
const KEY = /^[\w-]{1,40}$/;

export const heavyRoutes: Route[] = [
  {
    method: 'POST',
    path: '/api/heavy/done',
    who: 'machine',
    async handler({ req, res, app }) {
      const { claims } = await app.ciStore.caller(req);
      const body = (await readJson(req, 2_000)) ?? {};
      if (typeof body.runner !== 'string' || !RUNNER.test(body.runner)) throw new HttpError(400, "Send {runner}: the job's RUNNER_NAME");
      return json(res, 200, { freed: (await app.heavy?.doneRun(claims.repository, claims.runId, body.runner)) ?? false });
    },
  },
  {
    method: 'POST',
    path: '/api/machines/heavy',
    who: 'machine',
    async handler({ req, res, app }) {
      const machine = app.machines.authenticate(req);
      if (!machine) throw new HttpError(401, 'Unknown machine token; make a new one in the Machines panel');
      const body = (await readJson(req, 2_000)) ?? {};
      if (typeof body.key !== 'string' || !KEY.test(body.key)) throw new HttpError(400, 'Send {op: ask or done, key, label?}: key a job id');
      // An older server, or one with no balancer for this PC, lets it start: a run never waits on Citadel's absence.
      if (!app.heavy) return json(res, 200, { go: 'start' });
      if (body.op === 'done') {
        app.heavy.agentDone(machine.id, body.key);
        return json(res, 200, {});
      }
      if (body.op !== 'ask') throw new HttpError(400, 'op is ask or done');
      const label = typeof body.label === 'string' && body.label.length <= 100 ? body.label : 'Windows test run';
      return json(res, 200, { go: app.heavy.agentAsk(machine.id, body.key, label) });
    },
  },
];
