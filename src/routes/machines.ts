// Machines: people list and manage them; a machine's agent connects with its own token; a minion's
// turn opens sessions to one and sends them messages.
import { appOwners, hostLoad } from '../host-load.ts';
import { byMinion, REAPED, reapedRows } from '../reaper.ts';
import { readEmulatorLease } from '../emulator-lease.ts';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { lendsMachine, machinesFor, managesMachine, taskmasterSeesMachine } from '../access.ts';
import { runnerAsk } from '../ci-runner.ts';
import { heldRows } from '../ci-hold.ts';
import { readHeavyA, testCounts } from '../waits.ts';
import { ciJobReadRoutes, ciNumbersRoute, ciUploadRoute } from './ci-store.ts';
import { MACHINE_NAME, RESERVED_NAMES, WS_SUFFIX, cleanLend, storedCheck } from '../machines.ts';
import type { Machine } from '../db.ts';
import { HttpError, json, publicOrigin, ownWrites, readJson, str, type Ctx, type Route } from '../http.ts';
import { ensureCoordinatorFor } from './projects.ts';
import { pickFor } from '../../public/model-table.js';
import { thrown } from '../thrown.ts';
import { request } from 'node:http';
import { placedAt, sendFolder, syncTurns } from '../machine-turn.ts';

/** The reds an Investigate press is starting a minion for (#1491), by `<scheme>:<workflow>`: a second press waits for the first. */
const investigating = new Set<string>();

// The agent caps fetch_file at 20 MB too.
const MAX_MACHINE_UPLOAD = 20_000_000;
// Notes go into every thread's system prompt while the machine is online, so keep them short.
const MAX_MACHINE_NOTES = 2000;

function machineName(v: unknown): string {
  const name = typeof v === 'string' ? v.trim().toLowerCase() : '';
  if (!MACHINE_NAME.test(name)) throw new HttpError(400, 'Use 1 to 30 lowercase letters, digits and dashes, like godot-laptop');
  if (RESERVED_NAMES.has(name)) throw new HttpError(400, "That name is taken by the app's own tools");
  if (name.endsWith(WS_SUFFIX)) throw new HttpError(400, `Names can't end in ${WS_SUFFIX}: that's how a machine's workspace tools are named`);
  return name;
}

/** A machine's new notes, as minions will read them; throws on anything else. */
export function machineNotes(v: unknown): string {
  if (typeof v !== 'string') throw new HttpError(400, 'notes must be text');
  const notes = v.replace(/\r\n/g, '\n').trim();
  if (notes.length > MAX_MACHINE_NOTES) throw new HttpError(400, `Notes are limited to ${MAX_MACHINE_NOTES.toLocaleString('en')} characters`);
  return notes;
}

/**
 * Change a machine: any of name, notes, lend (what is ticked), workspace_tools, always_on and projects (the schemes it is
 * lent to: the whole list). The one write path for its settings: the Machines page's PATCH, and an approved notes card (#617).
 */
export async function patchMachine(app: Ctx['app'], session: Ctx['session'], machine: Machine, body: Record<string, unknown>) {
  if (!managesMachine(session, machine)) throw new HttpError(404, 'No such machine');
  const lend = body.lend === undefined ? undefined : cleanLend(body.lend);
  if (lend === null) throw new HttpError(400, "lend must be { server: a found MCP server's name or null, workspaces: [names] }");
  let projects: number[] | undefined;
  if (body.projects !== undefined) {
    // A scheme the person can't see isn't theirs to add; one already on the list (an admin's doing) may stay.
    const had = app.store.machineProjects(machine.id);
    if (!(Array.isArray(body.projects) && body.projects.every((id: unknown) => Number.isInteger(id) && app.store.getProject(id as number) && (had.includes(id as number) || app.store.canSee(session, id as number))))) {
      throw new HttpError(400, 'projects must be a list of scheme ids');
    }
    projects = body.projects;
  }
  const fields: { name?: string; notes?: string; workspace_tools?: number; always_on?: number } = {};
  for (const k of ['workspace_tools', 'always_on'] as const) {
    if (body[k] === undefined) continue;
    if (typeof body[k] !== 'boolean') throw new HttpError(400, `${k} must be true or false`);
    fields[k] = body[k] ? 1 : 0;
  }
  if (body.name !== undefined) fields.name = machineName(body.name);
  if (body.notes !== undefined) fields.notes = machineNotes(body.notes);
  // Awaited: on the DB write worker (#795) its UNIQUE failure only reaches this request through the promise.
  try {
    await app.store.updateMachine(machine.id, fields);
  } catch {
    throw new HttpError(409, 'A machine with that name already exists');
  }
  if (projects !== undefined) app.store.setMachineProjects(machine.id, projects);
  if (lend) app.machines.setLend(machine.id, lend);
  await ownWrites(); // what follows re-reads the grants and the machine (#1244)
  // Switched off or taken from a scheme: minions mid-turn lose the tools now, not at their next turn.
  if (fields.workspace_tools === 0) app.machines.endServer(machine.id, 'ws');
  // Switched on: its workspace tools get their first check now.
  if (fields.workspace_tools === 1) app.machines.checkIfDue(machine.id);
  // A job already running there goes on to its end (its minion hears of it); one that hasn't started never will (2MA9).
  if (projects !== undefined) app.jobs.drop(machine.id, `its scheme was taken off ${machine.name}`, (j) => (j.state === 'needs-go' || j.state === 'queued') && !app.store.machineGranted(machine.id, j.project_id));
  if (projects !== undefined) app.machines.endSessionsWhere(machine.id, (id) => !app.store.machineGranted(machine.id, id));
  app.broadcast({ type: 'machines', machines: app.machines.list() });
  return app.machines.view(app.store.getMachine(machine.id)!);
}

/** A file a workspace session's fetch_file sends: saved in that minion's shared files, under machine-files/<machine>/. */
async function machineUpload({ req, res, url, app }: Ctx, machine: Machine) {
  const ticketId = app.machines.workspaceTicket(machine, url.searchParams.get('session') ?? '');
  const ticket = ticketId === null ? undefined : app.store.getTicket(ticketId);
  if (!ticket) throw new HttpError(410, 'No such workspace session');
  const name =
    basename((url.searchParams.get('name') ?? '').replace(/\\/g, '/'))
      .replace(/[^\w.-]/g, '_')
      .replace(/^\.+/, '')
      .slice(0, 100) || 'file';
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_MACHINE_UPLOAD) throw new HttpError(413, 'Files are limited to 20 MB');
    chunks.push(chunk);
  }
  const dir = join(app.sharedDir(ticket), 'machine-files', machine.name);
  await mkdir(dir, { recursive: true });
  const dot = name.lastIndexOf('.');
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
  // Never overwrite: a second fetch of report.zip lands as report-2.zip.
  for (let n = 1; ; n++) {
    const path = join(dir, n === 1 ? name : `${stem}-${n}${ext}`);
    try {
      await writeFile(path, Buffer.concat(chunks), { flag: 'wx' });
      return json(res, 201, { path });
    } catch (err) {
      if (thrown(err).code !== 'EEXIST' || n > 999) throw err;
    }
  }
}

/** A route a machine's agent calls with its token, which reaches nothing else. */
const agent = (method: string | readonly string[], path: string, handler: (ctx: Ctx, machine: Machine) => unknown): Route => ({
  method,
  path,
  who: 'machine',
  handler(ctx) {
    const machine = ctx.app.machines.authenticate(ctx.req);
    if (!machine) throw new HttpError(401, 'Unknown machine token; make a new one in the Machines panel');
    return handler(ctx, machine);
  },
});

/**
 * A tool call home from a turn on a machine (Build 7 T2): its tool server's request, passed on by the machine's agent
 * with the machine's token, the turn's own in X-Turn-Authorization. Only for a turn placed on that machine and still
 * running; then it goes to this server's own address as the turn's request, where the turn's token is checked as ever.
 */
function turnCall({ req, res, url, params, app }: Ctx, machine: Machine) {
  const bearer = String(req.headers['x-turn-authorization'] ?? '');
  const ticketId = Number(/^Bearer (\d+)\./.exec(bearer)?.[1]);
  const dir = ticketId ? app.runner.turnDir(ticketId) : null;
  if (!dir || placedAt(dir)?.id !== machine.id) throw new HttpError(403, 'Not a turn running on this machine');
  const headers: Record<string, string> = { authorization: bearer };
  for (const h of ['content-type', 'content-length', 'accept', 'mcp-session-id', 'mcp-protocol-version', 'last-event-id']) if (typeof req.headers[h] === 'string') headers[h] = req.headers[h];
  return new Promise<void>((done) => {
    const out = request(new URL(`/${params.rest}${url.search}`, app.turnApi()), { method: req.method, headers }, (back) => {
      res.writeHead(back.statusCode ?? 502, back.headers);
      back.pipe(res).on('close', done);
    });
    out.on('error', () => {
      if (!res.headersSent) json(res, 502, { error: 'The server did not answer the tool call' });
      else res.destroy();
      done();
    });
    res.on('close', () => out.destroy());
    req.pipe(out);
  });
}

/** What a machine's agent calls: hold its stream open, pass on a message from its MCP server, its details, a file. */
export const agentRoutes: Route[] = [
  agent('GET', '/api/machines/connect', ({ url, res, app }, machine) => {
    const info = (k: string) => (url.searchParams.get(k) ?? '').replace(/[\x00-\x1f\x7f]/g, '').slice(0, 200);
    return app.machines.connectAgent(machine, res, { host: info('host'), command: info('command'), runners: url.searchParams.get('kind') === 'runners', managed: url.searchParams.get('v') === '2', os: url.searchParams.get('os') === 'linux' ? 'linux' : 'windows' });
  }),
  agent('POST', '/api/machines/send', async ({ req, res, app }, machine) => {
    // Room for screenshots, which MCP servers send as base64 images.
    const body = await readJson(req, 50_000_000);
    // A beat, { beat: true }, says the agent is awake (src/machines.ts BEAT_LOST_MS), and a test box's `screen` who has it (#1422); 409 if its stream is gone.
    if (body.beat === true) {
      if (!app.machines.beat(machine, body.screen)) throw new HttpError(409, 'Connect first');
      return json(res, 202, {});
    }
    if (typeof body.session !== 'string') throw new HttpError(400, 'session is required');
    // A gone session tells the agent to stop that copy of its MCP server.
    if (!app.machines.fromAgent(machine, body.session, body)) throw new HttpError(410, 'No such session');
    return json(res, 202, {});
  }),
  agent('POST', '/api/machines/info', async ({ req, res, app }, machine) => {
    if (!app.machines.setInfo(machine, await readJson(req, 200_000))) throw new HttpError(409, 'Connect first');
    return json(res, 202, {});
  }),
  agent('POST', '/api/machines/upload', machineUpload),
  // A worker's turns (Build 7 T2, src/machine-turn.ts): the sync it makes about every half second, a turn's folder to start it from, and its tool calls home.
  agent('POST', '/api/machines/turns', async ({ req, res }, machine) => json(res, 200, await syncTurns(machine.id, await readJson(req, 30_000_000)))),
  agent('GET', '/api/machines/turn-folder', async ({ res, url }, machine) => {
    if (!(await sendFolder(machine.id, url.searchParams.get('dir'), res))) throw new HttpError(404, 'Not a turn placed on this machine');
  }),
  agent(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], '/api/machines/turn-call/*rest', turnCall),
  // Jobs (#857, shared/project/specs/desktop-gpu-jobs.md "Wire contract"): one input file with the job's token, the
  // job's state every 10 s and on every change, and one result file, streamed to disk under the job's caps.
  agent('GET', '/api/machines/job-input', ({ req, res, url, app }, machine) => app.jobs.input(machine, req, res, url)),
  agent('POST', '/api/machines/job-state', async ({ req, res, app }, machine) => {
    app.jobs.report(machine, await readJson(req, 100_000));
    return json(res, 202, {});
  }),
  agent('POST', '/api/machines/job-upload', async ({ req, res, url, app }, machine) => json(res, 201, await app.jobs.upload(machine, req, url))),
  // A CI runner registration token for a scheme's repo (#320): tools/ci-runner/add-runner.ps1 calls it. With kind 'delete', a
  // runner's name and its label it hands out no token: Citadel takes that runner off GitHub itself (#476, remove-runner.ps1).
  agent('POST', '/api/machines/runner-token', async ({ req, res, app }, machine) => {
    const body = await readJson(req);
    if (body.kind === 'delete') return json(res, 200, await app.runnerTokens.unregister(machine, body.scheme, body.name, body.label));
    if (body.mint !== undefined && typeof body.mint !== 'boolean') throw new HttpError(400, 'mint must be true or false');
    if (body.kind !== undefined && body.kind !== 'register' && body.kind !== 'remove') throw new HttpError(400, 'kind must be register, remove or delete');
    return json(res, body.mint === false ? 200 : 201, await app.runnerTokens.issue(machine, body.scheme, body.mint !== false, body.kind ?? 'register'));
  }),
  // A CI runner agent's answer to a job (#328, public/runner-agent.mjs).
  agent('POST', '/api/machines/runner-result', async ({ req, res, app }, machine) => {
    if (!app.machines.runnerResult(machine, await readJson(req, 100_000))) throw new HttpError(410, 'No such runner job');
    return json(res, 202, {});
  }),
  // A CI runner agent's load sample, every 30 seconds (#534, src/ci-load.ts).
  agent('POST', '/api/machines/runner-load', async ({ req, res, app }, machine) => {
    if (!storedCheck(machine)?.runners) throw new HttpError(403, 'Only a CI runner host sends load samples');
    app.ciLoad.add(machine.id, await readJson(req, 500_000));
    return json(res, 202, {});
  }),
  // Not an agent's: a CI job's upload and reads, which check the job's own GitHub run token (#658, #1266).
  ciUploadRoute,
  ciNumbersRoute,
  ...ciJobReadRoutes,
  // A CI job's test file counts while its suite runs, about every 2 s (#1368, #1667): its run comes from its run token, as an
  // upload's does, and shows on its landing's wait and Releases. {done, total, file}: tools/progress-reporter.ts's lines; failed: the
  // files failed so far; phase 'rerun' while run-tests.sh reruns them alone, the counts then being the reruns'.
  {
    method: 'POST',
    path: '/api/ci-tests',
    who: 'machine',
    async handler({ req, res, app }) {
      const { claims } = await app.ciStore.caller(req);
      const body = await readJson(req, 10_000);
      const c = testCounts(body?.done, body?.total, body?.file ?? '', body?.failed ?? [], body?.phase ?? 'suite');
      if (!c) throw new HttpError(400, 'Send {done, total, file, failed?, phase?}: whole numbers, done at most total, total over 0; failed a list of file names; phase suite or rerun');
      app.ciTests?.(claims.repository, claims.runId, c);
      return json(res, 202, {});
    },
  },
  // An optional job asks before it starts (tools/ci-hold-ask.ts, #1902): told to wait, Citadel stops the run and starts it
  // again later, so it never waits long holding a runner.
  {
    method: 'POST',
    path: '/api/ci-hold',
    who: 'machine',
    async handler({ req, res, app }) {
      const { claims } = await app.ciStore.caller(req);
      return json(res, 200, (await app.ciHold?.ask(claims.repository, claims.runId)) ?? { go: true, why: null });
    },
  },
];

// Anyone signed in adds machines; each manages their own, and admins manage all (#306).
const people = { who: ['person'], refuse: 'Only people manage machines' } as const;

const ctxToken = (req: Ctx['req']) => (req.headers.authorization ?? '').match(/^Bearer (cmt_[\w-]+)$/)?.[1] ?? '';

/** The running contraption turn a machine proxy's token belongs to. */
function contraptionTurn(token: string, app: Ctx['app']) {
  const turn = token ? app.contraptionTurns.machineTurn(token) : null;
  if (!turn) throw new HttpError(401, 'Not a running contraption turn');
  return turn;
}

/** A machine route for its owner and admins; to anyone else the machine isn't there. */
const managed = (handler: (ctx: Ctx) => unknown) => (ctx: Ctx) => {
  if (!managesMachine(ctx.session, ctx.machine)) throw new HttpError(404, 'No such machine');
  return handler(ctx);
};
const turns = { who: ['minion'], refuse: "Only a minion's turn can use a machine" } as const;

/** The machines this Taskmaster's turn may see (#307), each as the Machines page shows it plus whom it goes to. */
function taskmasterMachines({ app, caller, project }: Ctx) {
  const asker = app.store.turnAsker(caller!.id);
  return app.store
    .listMachines()
    .filter((m) => taskmasterSeesMachine(app.store, m, project, asker))
    .map((m) => {
      const view = app.machines.view(m);
      return {
        ...view,
        owner_name: m.owner_id === null ? null : (app.store.getUser(m.owner_id)?.name ?? null),
        project_names: view.projects.map((id) => app.store.getProject(id)?.name ?? `scheme ${id}`),
        // Whether a minion turn its asker starts here gets it (src/runner.ts): an admin sees more than that.
        minions_get_it: lendsMachine(app.store, m, project, asker === null ? [] : [asker]),
        // The machine on the Machines page (#1638), for tool replies and cards to link.
        page: `#/p/${project.id}/machines/${m.name}`,
      };
    });
}
const taskmaster = { who: ['taskmaster'], refuse: 'Only a Taskmaster lists and checks machines here; people use the Machines page' } as const;

/** A scheme's CI runners on the runner agent's PC (#328): members ask, from the page, a minion or the Taskmaster. */
const runnerAskers = { who: ['person', 'minion', 'taskmaster'], refuse: "Only a scheme's members, its minions and its Taskmaster change its CI runners" } as const;
/** Whose ask a call is: the person signed in, or the person whose turn a minion or Taskmaster runs. */
const askerOf = ({ session, caller, app }: Ctx) => (caller ? app.store.turnAsker(caller.id) : (session.uid ?? null));

export const machineRoutes: Route[] = [
  {
    method: 'POST',
    path: '/api/projects/:project/ci-runners',
    ...runnerAskers,
    async handler(ctx) {
      const ask = runnerAsk(await readJson(ctx.req));
      return json(ctx.res, 202, await ctx.app.runnerJobs.start(ctx.project, askerOf(ctx), ask));
    },
  },
  {
    // ?wait=<seconds, up to 50> holds the answer until a running job ends.
    method: 'GET',
    path: '/api/projects/:project/ci-runners',
    ...runnerAskers,
    async handler({ res, url, app, project }) {
      const wait = Math.min(50, Math.max(0, Number(url.searchParams.get('wait')) || 0));
      return json(res, 200, { job: await app.runnerJobs.wait(project.id, wait * 1000) });
    },
  },
  // On the app's own address only when machines have no address of their own (MACHINES_URL).
  ...agentRoutes.map(
    (r): Route => ({
      ...r,
      handler(ctx) {
        if (ctx.app.machinesUrl) throw new HttpError(403, `Machines connect at ${ctx.app.machinesUrl.origin}, not here`);
        if (ctx.app.preview) throw new HttpError(403, 'Machines connect to the live app, not a preview');
        return r.handler(ctx);
      },
    }),
  ),

  // The CI desktop's load (#534): each PC with a runner agent, for admins and the members of a scheme with runners there.
  {
    method: 'GET',
    path: '/api/ci-desktop',
    ...people,
    // Everyone signed in sees every PC (Cara, 2026-11-11: "they should know if and how much their work is affecting the CI machine").
    handler: ({ res, app }) => json(res, 200, { pcs: app.ciLoad.views() }),
  },
  // The CI page (#968): each scheme they can see with its runners, queue, verdicts, runs and open problems, plus the CI desktop's load.
  {
    method: 'GET',
    path: '/api/ci',
    ...people,
    handler: ({ res, app, session }) => {
      // Each red's fix minion as the minions list draws it (#1078): its state, step and note, read now.
      const schemes = (app.ciHealth?.snapshot((id) => app.store.canSee(session, id)) ?? []).map((s) => ({
        ...s,
        problems: s.problems.map((x) => {
          const t = x.fixMinion && app.store.getTicketByNumber(s.id, x.fixMinion.number);
          if (!t) return x;
          const v = app.runner.view(t);
          return {
            ...x,
            fixTicket: {
              id: v.id,
              number: v.number,
              project_id: v.project_id,
              title: v.title,
              status: v.status,
              state: v.state,
              note: v.note,
              last_activity: v.last_activity,
              created_at: v.created_at,
              updated_at: v.updated_at,
              closed_at: v.closed_at,
              steps: v.steps,
              step_track: v.step_track,
              wait: v.wait,
              open_cards: v.open_cards,
              approvals: v.approvals,
              server_work: v.server_work,
              closing: v.closing,
              queued: v.queued,
              ship: v.ship,
            },
          };
        }),
      }));
      json(res, 200, { schemes, pcs: app.ciLoad.views(), now: Date.now() });
    },
  },
  // Investigate on a CI red (#1491; Cara, 2026-11-21, picked "Investigate button"): starts a fix minion for the red in its own
  // scheme at once (not a message to the Taskmaster, as a Status tile's does), a bug on the model table's tier, its turns on the
  // presser's login; its brief is the red's run, link, failing tests and error lines, and the red names it at once.
  {
    method: 'POST',
    path: '/api/projects/:project/ci/investigate',
    who: ['person'],
    refuse: 'Only people press Investigate',
    handler: async ({ req, res, app, project, session }) => {
      const body = await readJson(req);
      const workflow = Number(body.workflow);
      if (!Number.isSafeInteger(workflow) || workflow <= 0) throw new HttpError(400, 'workflow must be a workflow id');
      const key = `${project.id}:${workflow}`;
      if (investigating.has(key)) throw new HttpError(409, 'A fix minion for this red is starting already');
      const brief = app.ciHealth?.redBrief(project, workflow, session.name);
      if (!brief) throw new HttpError(404, 'That workflow is not red in this scheme');
      if (brief.open) return json(res, 200, { number: brief.open.number, title: brief.open.title, started: false });
      investigating.add(key);
      try {
        const tier = pickFor('bug');
        const { id, number } = await app.newMinion(project, { title: brief.title, props: { type: 'bug' }, model: tier.model, effort: tier.effort }, session.name);
        app.store.updateTicket(id, { person_id: session.uid ?? null });
        app.runner.send(id, session.name, brief.message, [], { brief: true });
        app.ciHealth!.named(project, workflow, number);
        json(res, 201, { number, title: brief.title, started: true });
      } finally {
        investigating.delete(key);
      }
    },
  },
  // The Status page (#1123): Citadel's own health and each app's week, the apps scoped to the schemes they can see.
  {
    method: 'GET',
    path: '/api/status',
    ...people,
    handler: async ({ res, app, session }) => {
      if (!app.status) return json(res, 200, null);
      json(res, 200, await app.status.read({ canSee: (id) => app.store.canSee(session, id), admin: !!session.admin, key: String(session.uid) }));
    },
  },
  // Investigate on a Status tile (#1273): the tile's numbers to the clicker's own Taskmaster in the tile's scheme (Cara picked
  // "Your own, in that scheme"), made for them as writing to it would. Only those who can see the scheme get a tile to press.
  {
    method: 'POST',
    path: '/api/status/investigate',
    who: ['person'],
    refuse: 'Only people press Investigate',
    handler: async ({ req, res, app, session }) => {
      if (!app.status) throw new HttpError(404, 'This server keeps no status');
      const body = await readJson(req);
      const target = str(body.target, 'Target', 80);
      const tile = str(body.tile, 'Tile', 60);
      if (!/^[a-z][a-z0-9-]*$/.test(tile) || !/^(citadel|app:[\w.-]+)$/.test(target)) throw new HttpError(400, 'Unknown tile');
      if (!Array.isArray(body.reasons) || body.reasons.length > 10) throw new HttpError(400, 'reasons must be a list of up to 10');
      const maybe = (v: unknown, field: string, max: number) => (v === undefined || v === null || v === '' ? '' : str(v, field, max));
      const sent = app.status.investigate({ canSee: (id) => app.store.canSee(session, id), admin: !!session.admin, key: String(session.uid) }, session.name, {
        target,
        tile,
        title: str(body.title, 'Title', 60),
        value: str(body.value, 'Value', 200),
        sub: maybe(body.sub, 'Line', 400),
        chart: maybe(body.chart, 'Chart', 2000),
        reasons: body.reasons.map((r: unknown) => str(r, 'Reason', 300)),
      });
      if (!sent) throw new HttpError(404, 'No such tile you can see');
      const tm = await ensureCoordinatorFor(app, app.store.getProject(sent.scheme)!, session.uid);
      app.runner.send(tm.id, session.name, sent.text);
      sent.record();
      json(res, 202, { taskmaster: tm.id, project: sent.scheme });
    },
  },
  // Host load (#1060): citadel-heavy's slots, line and pressure gate, and a week's waits per scheme. Everyone signed in sees it, like the CI desktop's.
  // An app's jobs count under its home scheme (#1068: TWIReader and twireader were two rows).
  {
    method: 'GET',
    path: '/api/host-load',
    ...people,
    handler: async ({ res, app, session }) => {
      if (!app.heavyDir) return json(res, 200, null);
      const owners = appOwners(
        app.store.listContraptions(),
        (id) => app.store.canSee(session, id),
        (id) => app.store.getProject(id)?.name,
      );
      const canSee = (id: number) => app.store.canSee(session, id);
      // What runs from which minion, and what closed minions left that was stopped this week (#1365, src/reaper.ts).
      const minions = app.reaper ? byMinion(await app.reaper.running(), app.store, canSee) : [];
      const reaped = reapedRows(app.store.healthEventsSince([REAPED], Date.now() - 7 * 24 * 3600_000), app.store, canSee);
      const load = hostLoad(app.heavyDir, Date.now(), undefined, owners, await readHeavyA(app.heavyDir));
      const long = load.long.map((j) => {
        const t = app.store.getTicket(j.ticket);
        return t && canSee(t.project_id) ? { ...j, number: t.number, schemeId: t.project_id } : j;
      });
      json(res, 200, { ...load, long, minions, reaped, hold: app.ciHold ? heldRows(app.ciHold.state(), app.store, canSee) : null });
    },
  },
  // Who holds the shared Android emulator's lease (#1128), for the Machines page.
  { method: 'GET', path: '/api/emulator-lease', ...people, handler: ({ res, app }) => json(res, 200, app.heavyDir ? readEmulatorLease(app.heavyDir) : null) },
  { method: 'GET', path: '/api/machines', ...people, handler: ({ res, app, session }) => json(res, 200, machinesFor(session, app.machines.list())) },
  {
    method: 'POST',
    path: '/api/machines',
    ...people,
    async handler({ req, res, app, session }) {
      const body = await readJson(req);
      // A person's machine is their own (#306). An admin's is shared, as before, unless they say it's theirs.
      if (body.mine !== undefined && typeof body.mine !== 'boolean') throw new HttpError(400, 'mine must be true or false');
      const mine = !session.admin || body.mine === true;
      // Someone signed in with the old shared password has no id to own it by.
      if (mine && session.uid === undefined) throw new HttpError(403, 'Sign in with your own login to add a machine');
      const name = machineName(body.name);
      // Adding is a name (#439): what it lends is ticked once its agent reports what it found. runners: a CI runner host.
      for (const k of ['always_on', 'runners'] as const) if (body[k] !== undefined && typeof body[k] !== 'boolean') throw new HttpError(400, `${k} must be true or false`);
      let machine;
      try {
        // The real hash goes in once the id (part of the token) is known.
        machine = app.store.createMachine(name, '', session.name, mine ? session.uid! : null);
      } catch {
        throw new HttpError(409, 'A machine with that name already exists');
      }
      const token = app.machines.issueToken(machine.id);
      // A runner host is one from the start, before its agent first connects: its line and its install line say so.
      app.store.updateMachine(machine.id, { ...(body.always_on === false ? { always_on: 0 } : {}), ...(body.runners ? { last_check: JSON.stringify({ at: machine.created_at, results: [], runners: true }) } : {}) });
      await ownWrites(); // the reply re-reads the machine (#1244)
      app.broadcast({ type: 'machines', machines: app.machines.list() });
      // Shown here, and again only to its owner (GET .../token, #1355).
      return json(res, 201, { machine: app.machines.view(app.store.getMachine(machine.id)!), token, agent_url: app.machinesUrl?.origin ?? publicOrigin(req, app.preview) });
    },
  },
  {
    method: 'POST',
    path: '/api/machines/:machine/token',
    ...people,
    handler: managed(async ({ req, res, app, machine }) => {
      // A new token locks out whoever holds the old one, the connected agent included.
      const token = app.machines.issueToken(machine.id);
      app.machines.disconnect(machine.id);
      await ownWrites(); // the reply re-reads the machine (#1244)
      // An offline machine's disconnect says nothing, and its row should now offer Show (#1355).
      app.broadcast({ type: 'machines', machines: app.machines.list() });
      return json(res, 200, { machine: app.machines.view(app.store.getMachine(machine.id)!), token, agent_url: app.machinesUrl?.origin ?? publicOrigin(req, app.preview) });
    }),
  },
  {
    // Its token again, to set up another tool on that computer without a relink (#1355). Only its owner's
    // (Cara, 2026-11-20, "Only its owner"): an admin who can relink a person's machine still can't read its token.
    method: 'GET',
    path: '/api/machines/:machine/token',
    ...people,
    handler: managed(({ req, res, app, machine, session }) => {
      if (!(machine.owner_id === null ? session.admin : machine.owner_id === session.uid)) throw new HttpError(403, 'Only its owner can show its token');
      const token = app.machines.shownToken(machine);
      if (!token) throw new HttpError(409, 'Linked before tokens were kept: make a new token once, and it can be shown from then on');
      return json(res, 200, { token, agent_url: app.machinesUrl?.origin ?? publicOrigin(req, app.preview) });
    }),
  },
  {
    method: 'PATCH',
    path: '/api/machines/:machine',
    ...people,
    handler: managed(async ({ req, res, app, machine, session }) => json(res, 200, await patchMachine(app, session, machine, await readJson(req)))),
  },
  {
    // Check now (#437): what the hourly check does, asked for; it answers once the check ends.
    method: 'POST',
    path: '/api/machines/:machine/check',
    ...people,
    handler: managed(async ({ res, app, machine }) => {
      if (!app.machines.isOnline(machine.id)) throw new HttpError(409, `${machine.name} is offline`);
      const results = await app.machines.check(machine.id);
      return json(res, 200, { machine: app.machines.view(app.store.getMachine(machine.id)!), results });
    }),
  },
  {
    method: 'DELETE',
    path: '/api/machines/:machine',
    ...people,
    handler: managed(async ({ res, app, machine }) => {
      // Before its rows go: the agent is told to stop, and each job's minion hears (2MA9).
      app.jobs.drop(machine.id, `${machine.name} was removed from Citadel`, () => true);
      app.store.deleteMachine(machine.id);
      app.ciLoad.forget(machine.id);
      app.machines.disconnect(machine.id);
      await ownWrites(); // the broadcast re-reads the list (#1244)
      app.broadcast({ type: 'machines', machines: app.machines.list() });
      return json(res, 200, {});
    }),
  },

  // A contraption turn's MCP proxy (#306): the same, for its person's own machines only, with its turn's token.
  {
    method: 'GET',
    path: '/api/machines/:machineId/contraption-session',
    who: 'machine',
    handler({ req, res, app, params }) {
      const turn = contraptionTurn(ctxToken(req), app);
      const id = Number(params.machineId);
      // The owner check too: a removed machine's id can come back as someone else's.
      if (!turn.machines.includes(id) || app.store.getMachine(id)?.owner_id !== turn.person) throw new HttpError(403, "That machine isn't this turn's person's, or the turn started without it");
      const who = `${app.store.getUser(turn.person)?.name ?? 'someone'} in ${app.store.listContraptions().find((c) => c.id === turn.contraption)?.title ?? 'a contraption'}`;
      if (!app.machines.openSession(id, { contraptionTurn: turn.id }, 'mcp', who, res)) throw new HttpError(503, 'That machine is offline', true);
    },
  },
  {
    method: 'POST',
    path: '/api/machines/:machineId/contraption-session/:session',
    who: 'machine',
    async handler({ req, res, app, params }) {
      const turn = contraptionTurn(ctxToken(req), app);
      if (!/^[0-9a-f]{24}$/.test(params.session)) throw new HttpError(404, 'Not found');
      const body = await readJson(req, 50_000_000);
      if (!app.machines.fromSession(params.session, { contraptionTurn: turn.id }, body.message)) throw new HttpError(503, 'That machine went offline', true);
      return json(res, 202, {});
    },
  },

  // The Taskmaster's look at the machines (#307): list them with their live state, and test one.
  {
    method: 'GET',
    path: '/api/projects/:project/machines',
    ...taskmaster,
    handler: (ctx) => {
      const machines = taskmasterMachines(ctx);
      // The names of the rest (#1638): one not lent here yet is what propose_machine_lend asks for.
      // Someone else's own machine stays out of sight, as it does everywhere (#306).
      const asker = ctx.app.store.turnAsker(ctx.caller!.id);
      const others = ctx.app.store
        .listMachines()
        .filter((m) => (m.owner_id === null || m.owner_id === asker) && !machines.some((x) => x.id === m.id) && !ctx.app.machines.view(m).runners)
        .map((m) => ({ name: m.name, owner_name: m.owner_id === null ? null : (ctx.app.store.getUser(m.owner_id)?.name ?? null) }));
      return json(ctx.res, 200, { machines, others });
    },
  },
  {
    method: 'POST',
    path: '/api/projects/:project/machines/:name/check',
    ...taskmaster,
    async handler(ctx) {
      const { app, caller, project, res, params } = ctx;
      const name = params.name.toLowerCase();
      const machine = taskmasterMachines(ctx).find((m) => m.name === name);
      if (!machine) throw new HttpError(404, `No machine called ${name} that this scheme can see`);
      if (!machine.online) return json(res, 200, { machine, results: [] });
      const results = await app.machines.check(machine.id);
      return json(res, 200, { machine: taskmasterMachines(ctx).find((m) => m.id === machine.id) ?? machine, results });
    },
  },

  // A minion's MCP proxy: open a session to a machine (held open as a stream), then send it messages.
  {
    method: 'GET',
    path: '/api/machines/:machineId/session',
    ...turns,
    handler({ res, url, app, caller, params }) {
      const server = url.searchParams.get('server') === 'ws' ? 'ws' : 'mcp';
      const project = app.store.getProject(caller!.project_id);
      const machine = app.store.getMachine(Number(params.machineId));
      // A person's own (#306) opens only for a turn that got it at its start (src/runner.ts TurnState.owned),
      // which its owner asked for: never mid-turn, never for someone else's.
      // The owner check too: a removed machine's id can come back as someone else's.
      if (machine && machine.owner_id !== null && (!app.runner.ownedMachines(caller!.id).includes(machine.id) || machine.owner_id !== app.store.turnAsker(caller!.id))) {
        throw new HttpError(403, "That machine is someone else's, or this turn started without it");
      }
      // A machine opens only for a minion in a scheme on its list (#438), as at its turn's start (src/runner.ts):
      // a scheme taken off the list mid-turn can't open it again.
      if (machine && (!project || caller!.kind === 'coordinator' || !app.store.machineGranted(machine.id, project.id))) {
        throw new HttpError(403, "That machine isn't lent to this scheme");
      }
      const who = `#${caller!.number} in ${project?.name ?? 'a scheme'}`;
      if (!app.machines.openSession(Number(params.machineId), { ticketId: caller!.id, projectId: caller!.project_id }, server, who, res)) throw new HttpError(503, server === 'ws' ? 'That machine is offline, or its workspace tools are off' : 'That machine is offline', true);
    },
  },
  {
    method: 'POST',
    path: '/api/machines/:machineId/session/:session',
    ...turns,
    async handler({ req, res, app, caller, params }) {
      if (!/^[0-9a-f]{24}$/.test(params.session)) throw new HttpError(404, 'Not found');
      const body = await readJson(req, 50_000_000);
      if (!app.machines.fromSession(params.session, { ticketId: caller!.id, projectId: caller!.project_id }, body.message)) throw new HttpError(503, 'That machine went offline', true);
      return json(res, 202, {});
    },
  },
];
