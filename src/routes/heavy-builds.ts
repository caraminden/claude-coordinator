// citadel-heavy's own calls (H2, src/heavy-builds.ts): where a heavy job goes, and a container job on a lent machine's
// Builds role, from its start to the files that come back. Only the minion itself calls these, from tools/heavy-builds.ts.
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { HttpError, json, readJson, sendFile, type App, type Ctx, type Route } from '../http.ts';
import { HEAVY_KINDS, isHeavyKind, KIND_IMAGE, KIND_SIZE } from '../heavy-builds.ts';
import { ENDED, jobInputs, safeRelPath } from '../machine-jobs.ts';
import { shippedImages } from '../role-setup.ts';
import { tmpDirFor } from '../turn-tmp.ts';
import { projectSharedDir } from '../workspace.ts';

const minion = { who: ['minion'], refuse: 'Only the minion itself places its heavy jobs' } as const;
/** The agent takes a command of at most 64 arguments; the recipe's own take six. */
const MAX_ARGS = 58;
const LIMIT_MIN = { default: 120, max: 12 * 60 };
/** What the image runs: the snapshot unpacked, the command in the caller's folder, then the files to bring back into /tmp/back.tgz, which the agent copies out. */
const SCRIPT = [
  'set -e',
  'mkdir -p /tmp/work',
  // The snapshot comes in on stdin (the agent's BuildRunner: nothing is bind-mounted).
  'tar -xzf - -C /tmp/work',
  'cd "/tmp/work/$1"',
  'back=$2',
  'shift 2',
  // The crates in the cargo cache volume; cargo itself stays on the image's PATH.
  '[ ! -d /cache/cargo ] || export CARGO_HOME=/cache/cargo',
  'set +e',
  '"$@"',
  's=$?',
  `[ -z "$back" ] || printf '%s\\n' "$back" | tar -czf /tmp/back.tgz --ignore-failed-read -T - || echo "citadel-heavy: some of the files to bring back could not be packed" >&2`,
  'exit $s',
].join('\n');

function placer(app: App): NonNullable<App['buildPlacer']> {
  if (!app.buildPlacer) throw new HttpError(503, 'This server places no heavy jobs', true);
  return app.buildPlacer;
}

/** A relative path inside the working copy ('' for its top). */
function relPath(v: unknown, what: string): string {
  if (v === '' || v === '.') return '';
  if (typeof v !== 'string') throw new HttpError(400, `${what} must be a relative path`);
  try {
    return safeRelPath(v).split('\\').join('/');
  } catch {
    throw new HttpError(400, `${what} must be a relative path inside the working copy, without ..`);
  }
}

function ownJob(ctx: Ctx, raw: unknown) {
  const id = Number(raw);
  const job = Number.isInteger(id) && id > 0 ? ctx.app.store.getMachineJob(id) : undefined;
  if (!job || job.ticket_id !== ctx.ticket.id || job.go !== 'builds') throw new HttpError(404, "No such heavy job of this minion's");
  return job;
}

const resultsDir = (app: App, projectId: number, id: number) => join(projectSharedDir(app.dataDir, projectId), 'jobs', String(id));

export const heavyBuildRoutes: Route[] = [
  {
    method: 'POST',
    path: '/api/tickets/:ticket/heavy-builds',
    ...minion,
    async handler(ctx) {
      const { req, res, app, ticket } = ctx;
      const body = (await readJson(req, 200_000)) ?? {};
      if (body.do === 'stop') return json(res, 200, app.jobs.view(app.jobs.stopJob(ownJob(ctx, body.job).id, { asker: true })));
      if (body.do === 'done') {
        // citadel-heavy took what came back: the results leave the shared folder, which is for people's files.
        const job = ownJob(ctx, body.job);
        if (!(ENDED as readonly string[]).includes(job.state)) throw new HttpError(409, `Job #${job.id} hasn't ended`);
        await fs.rm(resultsDir(app, job.project_id, job.id), { recursive: true, force: true });
        app.store.updateMachineJob(job.id, { swept_at: Date.now(), upload_bytes: 0 });
        return json(res, 200, { ok: true });
      }
      if (!isHeavyKind(body.kind)) throw new HttpError(400, `kind must be one of ${HEAVY_KINDS.join(', ')}`);
      const kind = body.kind;
      const size = body.size === undefined ? KIND_SIZE[kind] : Number(body.size);
      if (!Number.isInteger(size) || size < 1 || size > 256) throw new HttpError(400, 'size must be a whole number of threads');
      if (body.do === 'place') {
        return json(res, 200, {
          spots: placer(app)
            .place({ projectId: ticket.project_id, kind, size })
            .map(({ id, name, free }) => ({ id, name, free })),
        });
      }
      if (body.do !== 'start') throw new HttpError(400, 'do must be place, start, stop or done');
      const machine = app.store.getMachine(Number(body.machine));
      if (!machine || !placer(app).buildsMay(machine.id, ticket.project_id)) throw new HttpError(409, 'That machine takes no build jobs for this scheme now: place the job again', true);
      const argv = body.argv;
      if (!Array.isArray(argv) || !argv.length || argv.length > MAX_ARGS || !argv.every((a) => typeof a === 'string' && a.length <= 10_000 && !a.includes('\0'))) throw new HttpError(400, `argv must be the command, 1 to ${MAX_ARGS} arguments`);
      const back = body.back === undefined ? [] : body.back;
      if (!Array.isArray(back) || back.length > 50) throw new HttpError(400, 'back must be a list of at most 50 paths');
      const backs = back.map((b) => relPath(b, 'each path in back'));
      if (backs.some((b) => !b)) throw new HttpError(400, 'a path in back must name something inside the working copy');
      const minutes = body.minutes === undefined ? LIMIT_MIN.default : Number(body.minutes);
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > LIMIT_MIN.max) throw new HttpError(400, `minutes must be 1 to ${LIMIT_MIN.max}`);
      const image = shippedImages()[KIND_IMAGE[kind].image];
      if (!image) throw new HttpError(409, `Citadel's ${KIND_IMAGE[kind].image} build image isn't published`, true);
      // The snapshot sits in the minion's own temp folder, where tools/heavy-builds.ts wrote it.
      const inputs = await jobInputs([body.snapshot], [tmpDirFor(app.runner.tmpRoot(ticket.project_id), ticket.id)]);
      if (inputs.length !== 1 || inputs[0].name !== 'snapshot.tgz') throw new HttpError(400, 'snapshot must be a file called snapshot.tgz in your temp folder');
      const what = argv.join(' ').slice(0, 200);
      const job = app.jobs.queueBuild({
        machine,
        projectId: ticket.project_id,
        ticketId: ticket.id,
        askedBy: `#${ticket.number} ${ticket.title}`.slice(0, 120),
        kind: {
          name: kind,
          image,
          command: ['/bin/sh', '-c', SCRIPT, 'citadel-heavy', relPath(body.dir ?? '', 'dir'), backs.join('\n'), ...(argv as string[])],
          reads: [],
          gpu: false,
          network: true,
          resumable: false,
          max_limit_s: minutes * 60,
          threads: size,
          volume: KIND_IMAGE[kind].volume,
          at: KIND_IMAGE[kind].at,
          lane: 'builds',
        },
        inputs,
        limitS: minutes * 60,
        reason: what,
      });
      return json(res, 201, { job: job.id, machine: machine.name });
    },
  },
  {
    method: 'GET',
    path: '/api/tickets/:ticket/heavy-builds/:job',
    ...minion,
    handler(ctx) {
      const job = ownJob(ctx, ctx.params.job);
      const v = ctx.app.jobs.view(job);
      return json(ctx.res, 200, { id: job.id, state: job.state, exit_code: job.exit_code, error: job.error, machine: v.machine, online: ctx.app.machines.isOnline(job.machine_id), waits: v.waits, outputs: v.outputs, log_tail: v.log_tail });
    },
  },
  {
    method: 'GET',
    path: '/api/tickets/:ticket/heavy-builds/:job/file',
    ...minion,
    async handler(ctx) {
      const job = ownJob(ctx, ctx.params.job);
      const name = ctx.url.searchParams.get('name');
      if (name !== 'log' && name !== 'back') throw new HttpError(400, 'name must be log or back');
      const file = join(resultsDir(ctx.app, job.project_id, job.id), name === 'log' ? '.job.log' : 'back.tar');
      const st = await fs.stat(file).catch(() => null);
      if (!st?.isFile()) throw new HttpError(404, `Job #${job.id} has no ${name} here`);
      return sendFile(ctx.req, ctx.res, file, st.size, { 'Content-Type': 'application/octet-stream' });
    },
  },
];
