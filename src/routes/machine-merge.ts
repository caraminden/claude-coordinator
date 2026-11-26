// "These are one computer: merge" (Build 7 M2b, src/machine-merge.ts): the owner presses it on either row and gets the
// lines that reinstall the moving row's runner agents with the kept row's token; each agent that connects to the kept row
// counts, and with all of them there the CI role moves over and the other row goes (finishMerge).
import { managesMachine } from '../access.ts';
import type { Machine } from '../db.ts';
import { type Merge, MERGES_KEY, merges, mergedCi, mergeOf, type Os, pickKept } from '../machine-merge.ts';
import { HttpError, json, ownWrites, publicOrigin, readJson, type App, type Ctx, type Route } from '../http.ts';
import { dropMachine } from './machines.ts';

/** As the token's Show (routes/machines.ts): the merge shows the kept row's token, so only its owner, or an admin for an ownerless one. */
const ownsToken = (session: Ctx['session'], m: Machine) => (m.owner_id === null ? !!session.admin : m.owner_id === session.uid);

function lines(app: App, ctx: Ctx, merge: Merge) {
  const into = app.store.getMachine(merge.into)!;
  const from = app.store.getMachine(merge.from)!;
  const token = app.machines.shownToken(into);
  if (!token) throw new HttpError(409, `${into.name}'s token was made before tokens were kept: make a new token for it once (its agents reconnect with it), then merge`);
  return { into: { id: into.id, name: into.name }, from: { id: from.id, name: from.name }, os: merge.os, token, agent_url: app.machinesUrl?.origin ?? publicOrigin(ctx.req, app.preview) };
}

async function told(app: App) {
  await ownWrites(); // the broadcast re-reads the list
  app.broadcast({ type: 'machines', machines: app.machines.list() });
}

/**
 * A runner agent connected to `machine` (MachineRelay.onRunner): when a merge into it waits on that agent and every other
 * one it moves, the CI role moves over and the other row goes, retiring its token. Before that, both rows work as they did.
 */
export async function finishMerge(app: App, machine: Machine) {
  const merge = merges(app.store).find((m) => m.into === machine.id);
  const here = app.machines.runnersOn(machine.id).map((r) => r.os);
  if (!merge || !merge.os.every((os) => here.includes(os))) return;
  const from = app.store.getMachine(merge.from)!;
  const into = app.store.getMachine(merge.into)!;
  const ci = (m: Machine) => app.store.machineRoles(m.id).find((r) => r.role === 'ci')!;
  const caps = { ...ci(from).caps, ...ci(into).caps };
  delete caps.ticks;
  app.store.setMachineRole(into.id, 'ci', { on: true, projects: mergedCi(app.store, from, into), caps, setup: { ...ci(into).setup, runner_agent: true } });
  app.store.moveRunnerLoad(from.id, into.id);
  app.ciLoad.moved(from.id, into.id);
  app.store.setSetting(
    MERGES_KEY,
    merges(app.store).filter((m) => m.from !== merge.from),
  );
  console.log(`Machines (M2b): ${from.name} merged into ${into.name}; its runner agents (${merge.os.join(', ')}) now connect there, and its token is retired.`);
  await dropMachine(app, from);
}

const people = { who: ['person'], refuse: 'Only people manage machines' } as const;

export const machineMergeRoutes: Route[] = [
  {
    // Start (or show again) a merge of this row with another on the same PC: {with: <machine id>}.
    method: 'POST',
    path: '/api/machines/:machine/merge',
    ...people,
    async handler(ctx) {
      const { app, session, res } = ctx;
      const machine = ctx.machine;
      const body = await readJson(ctx.req);
      const other = Number.isSafeInteger(body.with) ? app.store.getMachine(body.with as number) : undefined;
      if (!managesMachine(session, machine) || !other || !managesMachine(session, other)) throw new HttpError(404, 'No such machine');
      if (!ownsToken(session, machine) || !ownsToken(session, other)) throw new HttpError(403, "Only the machines' owner can merge them: it shows the kept one's token");
      // As its twins in routes/machines.ts: a row being removed takes no new token holder, and gives none up mid-removal.
      const gone = [machine, other].find((m) => app.machineCopies?.removing(m.id));
      if (gone) throw new HttpError(409, `${gone.name} is being removed: merge once it is gone, or not at all`);
      const waiting = mergeOf(app.store, machine.id);
      if (waiting && [waiting.from, waiting.into].includes(other.id)) return json(res, 200, lines(app, ctx, waiting));
      if (waiting || mergeOf(app.store, other.id)) throw new HttpError(409, 'One of these is already being merged with another machine: cancel that first');
      if (!app.machines.samePc(machine).some((m) => m.id === other.id)) throw new HttpError(409, `${machine.name} and ${other.name} don't report one hostname, so Citadel can't tell they are one computer`);
      const { into, from } = pickKept(machine, other, (m) => app.machines.view(m).runners);
      const os: Os[] = app.machines.runnersOn(from.id).map((r) => r.os);
      const kept = app.machines.lastCheck(from.id)?.os;
      if (!os.length && kept) os.push(kept);
      if (!os.length) throw new HttpError(409, `${from.name}'s runner agent isn't connected and hasn't said which runners it adds: start it once, then merge`);
      const merge: Merge = { from: from.id, into: into.id, os: os.sort(), by: session.name, at: Date.now() };
      const shown = lines(app, ctx, merge);
      app.store.setSetting(MERGES_KEY, [...merges(app.store), merge]);
      await told(app);
      // Its runner agents may already be on the kept row (run before, or both rows' agents share the token now).
      await finishMerge(app, into);
      return json(res, 201, shown);
    },
  },
  {
    // Stop waiting: both rows stay as they are.
    method: 'DELETE',
    path: '/api/machines/:machine/merge',
    ...people,
    async handler(ctx) {
      const { app, session, res } = ctx;
      const machine = ctx.machine;
      if (!managesMachine(session, machine)) throw new HttpError(404, 'No such machine');
      const merge = mergeOf(app.store, machine.id);
      if (merge)
        app.store.setSetting(
          MERGES_KEY,
          merges(app.store).filter((m) => m.from !== merge.from),
        );
      await told(app);
      return json(res, 200, {});
    },
  },
];
