// Jobs on a person's own machine (#857): a minion queues, reads and stops its own; a contraption its own; a machine's
// owner (or an admin) gives the go, pauses, resumes, stops, runs now and sets job hours. The agent's side is in
// routes/machines.ts (job-input, job-state, job-upload); the queue is src/machine-jobs.ts.
import { join } from 'node:path';
import type { ContraptionRow, Machine, MachineJob, Project } from '../db.ts';
import { HttpError, json, ownWrites, readJson, type App, type Ctx, type Route } from '../http.ts';
import { cleanKind, jobInputs, jobMachinesFor, type Actor, type Choice } from '../machine-jobs.ts';
import { ensureCoordinator } from './projects.ts';
import { projectSharedDir } from '../workspace.ts';

/** A job as it stands once this request's own writes have landed: the job helpers re-read it before then (#1244). */
const landed = async (app: App, job: MachineJob) => {
  await ownWrites();
  return app.jobs.view(app.store.getMachineJob(job.id) ?? job);
};

const people = { who: ['person'], refuse: "Only people decide on a machine's jobs" } as const;
const minion = { who: ['minion'], refuse: 'Only a minion queues jobs here' } as const;

const actor = ({ session }: Ctx): Actor => ({ uid: session.uid ?? -1, name: session.name, admin: !!session.admin });
const jobId = (ctx: Ctx) => {
  const id = Number(ctx.params.job);
  if (!Number.isInteger(id) || id < 1) throw new HttpError(404, 'No such job');
  return id;
};

/** A machine jobs may be queued on from a scheme: lent to it, with its agent's jobs block reported. The owner's go is the gate after that. */
function jobMachine(app: App, name: unknown, project: Project): Machine {
  if (typeof name !== 'string' || !name) throw new HttpError(400, "machine is required: the machine's name");
  const m = app.store.listMachines().find((x) => x.name === name.toLowerCase());
  if (!m || !jobMachinesFor(app.store, project.id).includes(m.name)) throw new HttpError(404, `No machine called ${name} runs jobs for ${project.name}: it must be lent to it, and its owner's machine-agent.json needs a jobs block`);
  return m;
}

/** The fields queue_job and a contraption's POST share. */
async function queueFrom(app: App, body: any, project: Project, roots: string[]) {
  const machine = jobMachine(app, body.machine, project);
  const kind = cleanKind(body.kind);
  const when = body.when ?? 'hours';
  if (when !== 'hours' && when !== 'now') throw new HttpError(400, 'when must be "hours" or "now"');
  const limitS = body.limit_min === undefined ? kind.max_limit_s : Math.round(Number(body.limit_min) * 60);
  const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 200) : '';
  const inputs = await jobInputs(body.inputs, roots);
  return { machine, kind, when: when as 'hours' | 'now', limitS, reason, inputs };
}

/** A person may read a job if they are in its scheme or decide on its machine. */
function readable(app: App, ctx: Ctx, id: number) {
  const job = app.jobs.get(id);
  const m = app.store.getMachine(job.machine_id);
  if (!app.store.canSee(ctx.session, job.project_id) && !(m && app.jobs.mayDecide(actor(ctx), m))) throw new HttpError(404, 'No such job');
  return job;
}

function contraptionJob(app: App, c: ContraptionRow, id: number) {
  const job = app.store.getMachineJob(id);
  // Another app's job answers as if it didn't exist.
  if (!job || job.contraption_id !== c.id) throw new HttpError(404, 'No such job');
  return job;
}

export const jobRoutes: Route[] = [
  // A minion's own: queue_job, job_status and stop_job (src/mcp.ts).
  {
    method: 'POST',
    path: '/api/tickets/:ticket/jobs',
    ...minion,
    async handler(ctx) {
      const { req, res, app, ticket } = ctx;
      const body = await readJson(req, 100_000);
      const project = app.store.getProject(ticket.project_id)!;
      // Inputs come from what the minion can already read: its worktree and the shared folders.
      const roots = [ticket.cwd, app.sharedDir(ticket), projectSharedDir(app.dataDir, project.id)];
      const q = await queueFrom(app, body, project, roots);
      const job = app.jobs.queue({ ...q, projectId: project.id, ticketId: ticket.id, contraptionId: null, askedBy: `#${ticket.number} ${ticket.title}`.slice(0, 120) });
      return json(res, 201, await landed(app, job));
    },
  },
  {
    method: 'GET',
    path: '/api/tickets/:ticket/jobs',
    who: ['minion', 'person'],
    refuse: "Only the minion and its scheme's people read its jobs",
    handler({ res, app, ticket }) {
      return json(res, 200, { jobs: app.store.machineJobs({ ticket: ticket.id }, 50).map((j) => app.jobs.view(j)) });
    },
  },
  {
    method: 'POST',
    path: '/api/tickets/:ticket/jobs/:job/stop',
    ...minion,
    async handler(ctx) {
      const job = ctx.app.jobs.get(jobId(ctx));
      if (job.ticket_id !== ctx.ticket.id) throw new HttpError(404, "No such job of this minion's");
      return json(ctx.res, 200, await landed(ctx.app, ctx.app.jobs.stopJob(job.id, { asker: true })));
    },
  },

  // The machine's owner, or an admin: the Machines page and the job card.
  {
    method: 'GET',
    path: '/api/machines/:machine/jobs',
    ...people,
    handler(ctx) {
      const { res, app, machine } = ctx;
      if (!app.jobs.mayDecide(actor(ctx), machine)) throw new HttpError(404, 'No such machine');
      return json(res, 200, { jobs: app.store.machineJobs({ machine: machine.id }, 100).map((j) => app.jobs.view(j)), settings: app.machines.view(machine).job_settings, kinds: app.store.jobKinds(machine.id) });
    },
  },
  {
    method: 'PATCH',
    path: '/api/machines/:machine/job-settings',
    ...people,
    handler: async (ctx) => json(ctx.res, 200, ctx.app.jobs.setSettings(ctx.machine, await readJson(ctx.req), actor(ctx))),
  },
  {
    // Remove an "Always allow this kind" (#859): the next job of that kind takes a go card again.
    method: 'DELETE',
    path: '/api/machines/:machine/job-kinds/:hash',
    ...people,
    handler(ctx) {
      ctx.app.jobs.forgetKind(ctx.machine, String(ctx.params.hash), actor(ctx));
      return json(ctx.res, 200, { ok: true });
    },
  },
  {
    method: 'GET',
    path: '/api/jobs/:job',
    ...people,
    handler: (ctx) => json(ctx.res, 200, ctx.app.jobs.view(readable(ctx.app, ctx, jobId(ctx)))),
  },
  {
    // { choice: "hours" | "now" | "always" | "no" }: the go card's answer from the Machines page or a job card.
    method: 'POST',
    path: '/api/jobs/:job/go',
    ...people,
    async handler(ctx) {
      const choice = (await readJson(ctx.req)).choice as Choice;
      if (!['hours', 'now', 'always', 'no'].includes(choice)) throw new HttpError(400, 'choice must be hours, now, always or no');
      return json(ctx.res, 200, await landed(ctx.app, ctx.app.jobs.decide(jobId(ctx), choice, actor(ctx))));
    },
  },
  ...(['pause', 'resume', 'stop', 'run-now'] as const).map(
    (action): Route => ({
      method: 'POST',
      path: `/api/jobs/:job/${action}`,
      ...people,
      async handler(ctx) {
        const { jobs } = ctx.app;
        const id = jobId(ctx);
        const who = actor(ctx);
        const job = action === 'pause' ? jobs.pause(id, who) : action === 'resume' ? jobs.resume(id, who) : action === 'stop' ? jobs.stopJob(id, who) : jobs.runNow(id, who);
        return json(ctx.res, 200, await landed(ctx.app, job));
      },
    }),
  ),

  // A contraption's own (contraption-ui skill, "Jobs"): inputs from its DATA_DIR, results in DATA_DIR/jobs/<id>/.
  {
    method: 'POST',
    path: '/api/contraptions/jobs',
    who: 'contraption',
    async handler({ req, res, app, contraption: c }) {
      const home = c.home_scheme === null ? undefined : app.store.getProject(c.home_scheme);
      if (!home) throw new HttpError(409, `${c.title} has no home scheme: an admin sets one in Settings → Contraptions`);
      const body = await readJson(req, 100_000);
      const q = await queueFrom(app, body, home, [app.services.dataDir(c)]);
      // Its go card goes to the home scheme's Taskmaster chat, which must exist first.
      await ensureCoordinator(app, home);
      const person = Number(body.person);
      const who = Number.isInteger(person) ? app.store.getUser(person)?.name : undefined;
      const job = app.jobs.queue({ ...q, projectId: home.id, ticketId: null, contraptionId: c.id, askedBy: `${c.title}${who ? ` for ${who}` : ''}`.slice(0, 120) });
      return json(res, 201, await landed(app, job));
    },
  },
  {
    method: 'GET',
    path: '/api/contraptions/jobs/:job',
    who: 'contraption',
    handler: (ctx) => json(ctx.res, 200, { ...ctx.app.jobs.view(contraptionJob(ctx.app, ctx.contraption, jobId(ctx))), results: join('jobs', String(jobId(ctx))) }),
  },
  {
    method: 'POST',
    path: '/api/contraptions/jobs/:job/stop',
    who: 'contraption',
    async handler(ctx) {
      const job = contraptionJob(ctx.app, ctx.contraption, jobId(ctx));
      return json(ctx.res, 200, await landed(ctx.app, ctx.app.jobs.stopJob(job.id, { asker: true })));
    },
  },
];
