// Machines: people list and manage them; a machine's agent connects with its own token; a minion's
// turn opens sessions to one and sends them messages.
import { boxCapacity } from '../box-capacity.ts';
import { HOST_SAMPLE_KEEP_MS } from '../db-rows.ts';
import { appOwners, hostLoad } from '../host-load.ts';
import { byMinion, REAPED, reapedRows } from '../reaper.ts';
import { readEmulatorLease } from '../emulator-lease.ts';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { lendsRole, machinesFor, managesMachine, taskmasterSeesMachine } from '../access.ts';
import { readLongJobsA } from '../long-jobs.ts';
import { runnerAsk } from '../ci-runner.ts';
import { heldRows } from '../ci-hold.ts';
import { readHeavyA, testCounts } from '../waits.ts';
import { ciJobReadRoutes, ciNumbersRoute, ciUploadRoute } from './ci-store.ts';
import { MACHINE_NAME, RESERVED_NAMES, WS_SUFFIX, cleanLend, storedCheck } from '../machines.ts';
import type { Machine } from '../db.ts';
import { hostReach, startedLine } from '../host-reach.ts';
import { cleanCaps, isRole, ROLE_NAMES, ROLES, type Role, type RoleRow } from '../machine-roles.ts';
import { pausedRoles, setPaused, unpause } from '../machine-pause.ts';
import { HttpError, json, publicOrigin, ownWrites, readJson, str, type App, type Ctx, type Route } from '../http.ts';
import { uploadsDir } from './files.ts';
import { ensureCoordinatorFor } from './projects.ts';
import { pickFor } from '../../public/model-table.js';
import { thrown } from '../thrown.ts';
import { request } from 'node:http';
import { projectSharedDir } from '../workspace.ts';
import { readsDisk, stateCall, syncScript, type StateDeps } from '../machine-sync.ts';
import { askCheckpoint, AWAY_MS, endAway, heardAt, liveOn, machineLink, owned, placedAt, sendFolder, syncTurns } from '../machine-turn.ts';
import { UNINSTALL } from '../machine-away.ts';
import { BLOB_BYTES } from '../worker-join.ts';
import { joinState, makeJoin, redeemJoin } from '../machine-join.ts';
import { roleSetupAgentRoutes } from './role-setup.ts';

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
  if (body.worker !== undefined && typeof body.worker !== 'boolean') throw new HttpError(400, 'worker must be true or false');
  const worker = body.worker as boolean | undefined;
  // A machine being removed takes no new starts (spec section 4): its page hides the switch, and the server holds to it too.
  if ((worker ?? lend?.worker) && app.machineCopies?.removing(machine.id)) throw new HttpError(409, `${machine.name} is being removed: it takes no new turns`);
  // A machine runs only its owner's turns, on a sign-in they make there themselves: nobody else offers it, though an admin may switch it off.
  if ((worker ?? lend?.worker) && !app.machines.lendsWorker(machine) && machine.owner_id !== session.uid) {
    throw new HttpError(403, machine.owner_id === null ? `${machine.name} is a shared machine, and a machine runs only its owner's minions: add that computer again as your own` : 'Only its owner can switch Minion turns on');
  }
  const fields: { name?: string; notes?: string; workspace_tools?: number; always_on?: number; priority?: number | null } = {};
  // Its owner's order among their computers (Build 7 M6; Josh, 2026-11-25: "put work on machine 1 before using machine 2"): theirs alone, like caps.
  if (body.priority !== undefined) {
    if (machine.owner_id !== session.uid) throw new HttpError(403, 'Only its owner can set its order');
    if (!(body.priority === null || (Number.isInteger(body.priority) && (body.priority as number) >= 1 && (body.priority as number) <= 99))) throw new HttpError(400, 'priority must be a whole number from 1 to 99, or null for no order');
    fields.priority = body.priority as number | null;
  }
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
  if (typeof fields.name === 'string') app.runner.runsOn.renamed(machine.id, machine.name, fields.name);
  if (projects !== undefined) app.store.setMachineProjects(machine.id, projects);
  if (lend || worker !== undefined) app.machines.setLend(machine.id, lend ?? null, worker);
  if (worker !== undefined || fields.priority !== undefined) app.runner.turnLine.pump();
  await ownWrites(); // what follows re-reads the grants and the machine (#1244)
  // Switched off or taken from a scheme: minions mid-turn lose the tools now, not at their next turn.
  if (fields.workspace_tools === 0) app.machines.endServer(machine.id, 'ws');
  // Switched on: its workspace tools get their first check now.
  if (fields.workspace_tools === 1) app.machines.checkIfDue(machine.id);
  // A job already running there goes on to its end (its minion hears of it); one that hasn't started never will (2MA9).
  if (projects !== undefined) app.jobs.drop(machine.id, `its scheme was taken off ${machine.name}`, (j) => (j.state === 'needs-go' || j.state === 'queued') && !app.store.roleGrants(machine.id, 'gpu', j.project_id));
  if (projects !== undefined) app.machines.endSessionsWhere(machine.id, (id) => !app.store.roleGrants(machine.id, 'tools', id));
  app.broadcast({ type: 'machines', machines: app.machines.list() });
  return app.machines.view(app.store.getMachine(machine.id)!);
}

/** A machine's roles as GET and PATCH roles answer them: each with its name people read; the Tools ticks stay in the machine's own view (lend). */
const rolesView = (roles: RoleRow[]) => roles.map(({ caps: { ticks: _, ...caps }, ...r }) => ({ ...r, name: ROLE_NAMES[r.role], caps }));

/**
 * Change one of a machine's roles (Build 7 M1): { role, on?, projects? (the whole list), caps? }. Its owner and admins
 * (managesMachine). Switched on with no list, a role keeps the list it had, or with none is lent to every scheme its
 * owner is in (Josh, 2026-11-25: "Every scheme you're in"; an ownerless machine's: the ones the person switching it can see).
 */
export async function patchRoles(app: Ctx['app'], session: Ctx['session'], machine: Machine, body: Record<string, unknown>) {
  if (!managesMachine(session, machine)) throw new HttpError(404, 'No such machine');
  if (!isRole(body.role)) throw new HttpError(400, `role must be one of ${ROLES.join(', ')}`);
  const role = body.role;
  if (body.on !== undefined && typeof body.on !== 'boolean') throw new HttpError(400, 'on must be true or false');
  const was = app.store.machineRoles(machine.id).find((r) => r.role === role)!;
  let projects: number[] | undefined;
  if (body.projects !== undefined) {
    // As the machine's PATCH: a scheme the person can't see isn't theirs to add; one already on the list (an admin's doing) may stay.
    if (!(Array.isArray(body.projects) && body.projects.every((id: unknown) => Number.isInteger(id) && app.store.getProject(id as number) && (was.projects.includes(id as number) || app.store.canSee(session, id as number))))) {
      throw new HttpError(400, 'projects must be a list of scheme ids');
    }
    projects = body.projects;
  }
  let caps: ReturnType<typeof cleanCaps> | undefined;
  try {
    caps = body.caps === undefined ? undefined : cleanCaps(body.caps);
  } catch (err) {
    throw new HttpError(400, (err as Error).message);
  }
  // A machine runs only its owner's turns, on a sign-in they make there themselves: nobody else offers it, though an admin may switch it off.
  if (role === 'turns' && body.on === true && !was.on && machine.owner_id !== session.uid) {
    throw new HttpError(403, machine.owner_id === null ? `${machine.name} is a shared machine, and a machine runs only its owner's minions: add that computer again as your own` : 'Only its owner can switch Minion turns on');
  }
  if (role === 'turns' && body.on === true && !was.on && app.machineCopies?.removing(machine.id)) throw new HttpError(409, `${machine.name} is being removed: it takes no new turns`);
  // Caps on a person's own machine are set by its owner's own sign-in only (spec section 7, Josh: "On the page").
  if (body.caps !== undefined && machine.owner_id !== null && machine.owner_id !== session.uid) throw new HttpError(403, 'Only its owner can set its caps');
  const owner = machine.owner_id === null ? null : app.store.getUser(machine.owner_id);
  const who = owner ? { uid: owner.id, admin: !!owner.admin } : session;
  const everyScheme = app.store
    .listProjects()
    .filter((p) => app.store.canSee(who, p.id))
    .map((p) => p.id);
  const roles = app.store.setMachineRole(machine.id, role, { ...(typeof body.on === 'boolean' ? { on: body.on } : {}), ...(projects ? { projects } : {}), ...(caps ? { caps } : {}), everyScheme });
  if (body.on === true) unpause(app.store, machine.id, role);
  await ownWrites(); // what follows re-reads the grants (#1244)
  app.machines.rolesChanged(machine.id);
  if (role === 'turns') app.runner.turnLine.pump();
  // A job already running goes on to its end; one that hasn't started never will (2MA9). A turn mid-call loses the tools now.
  app.jobs.drop(machine.id, `its scheme was taken off ${machine.name}`, (j) => (j.state === 'needs-go' || j.state === 'queued') && !app.store.roleGrants(machine.id, 'gpu', j.project_id));
  if (role === 'tools') app.machines.endSessionsWhere(machine.id, (id) => !app.store.roleGrants(machine.id, 'tools', id));
  app.broadcast({ type: 'machines', machines: app.machines.list() });
  return { roles: rolesView(roles), machine: app.machines.view(app.store.getMachine(machine.id)!) };
}

/**
 * Pause all on a machine's row (spec section 7, "drains, one click back"): each role that's on goes off through
 * patchRoles, as its own switch would, and the setting keeps which, for the click back. Resume switches those on again;
 * one that can't come back (Minion turns by someone other than its owner) stays off and its words come back.
 */
export async function pauseMachine(app: Ctx['app'], session: Ctx['session'], machine: Machine, body: Record<string, unknown>) {
  if (!managesMachine(session, machine)) throw new HttpError(404, 'No such machine');
  if (typeof body.pause !== 'boolean') throw new HttpError(400, 'pause must be true or false');
  const errors: string[] = [];
  if (body.pause) {
    const on: Role[] = app.store
      .machineRoles(machine.id)
      .filter((r) => r.on)
      .map((r) => r.role);
    if (!on.length) throw new HttpError(409, `Nothing is switched on on ${machine.name}`);
    // Kept first, so a role that is switched off by now is one the click back brings back.
    setPaused(app.store, machine.id, [...(pausedRoles(app.store, machine.id) ?? []), ...on]);
    for (const role of on) await patchRoles(app, session, machine, { role, on: false });
  } else {
    for (const role of pausedRoles(app.store, machine.id) ?? []) {
      try {
        await patchRoles(app, session, machine, { role, on: true });
      } catch (err) {
        errors.push(`${ROLE_NAMES[role]}: ${(err as Error).message}`);
      }
    }
    setPaused(app.store, machine.id, []);
  }
  await ownWrites();
  app.broadcast({ type: 'machines', machines: app.machines.list() });
  return { machine: app.machines.view(app.store.getMachine(machine.id)!), errors };
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

const stateDeps = (app: App): StateDeps => ({
  store: app.store,
  files: (t) => app.sharedDir(t),
  uploads: (t) => uploadsDir(app, t),
  shared: (p) => projectSharedDir(app.dataDir, p.id),
  landing: (id) => app.landings.get(id)?.code === null,
  note: (id, text) => app.runner.emit(id, 'note', { text }),
  // Work a machine sent home aside: an open minion hears it as a message (it may act on it), a closed one keeps a line.
  tell: (id, text) => (app.store.getTicket(id)?.status === 'closed' ? app.runner.emit(id, 'note', { text }) : app.runner.send(id, 'System', text)),
});

function workersOf(app: Ctx['app']) {
  if (!app.machines.workers) throw new HttpError(503, 'No worker machines here');
  return app.machines.workers;
}

/** A machine's row and all it lends go. A worker's turns still there end as away (they carry on at perigee). */
export async function dropMachine(app: App, machine: Machine) {
  for (const dir of await liveOn(machine.id)) await endAway(dir, Date.now(), true);
  // Before its rows go: the agent is told to stop, and each job's minion hears (2MA9).
  app.jobs.drop(machine.id, `${machine.name} was removed from Citadel`, () => true);
  app.store.deleteMachine(machine.id);
  setPaused(app.store, machine.id, []); // ids are reused: a new PC must not inherit its Resume
  app.machineCopies?.forget(machine.id);
  app.runner.turnLine.forget(machine.id);
  app.ciLoad.forget(machine.id);
  app.machines.workers?.forget(machine.id);
  app.machines.disconnect(machine.id);
  await ownWrites(); // the broadcast re-reads the list (#1244)
  app.broadcast({ type: 'machines', machines: app.machines.list() });
}

/** Machines being removed whose agent has deleted every copy there, or that went offline meanwhile: their rows go now. */
export async function dropRemoved(app: App) {
  for (const id of app.machineCopies?.removals() ?? []) {
    const m = app.store.getMachine(id);
    if (!m) app.machineCopies!.forget(id);
    // Every copy cleared, or kept for what can't come home (its uninstall deletes those); or silent AWAY_MS by its syncs.
    else if ((Object.values(app.machineCopies!.all(id)).every((c) => c.stays && !c.away) && !(await liveOn(id)).length) || Date.now() - heardAt(id) >= AWAY_MS) await dropMachine(app, m);
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
async function turnCall({ req, res, url, params, app }: Ctx, machine: Machine) {
  const bearer = String(req.headers['x-turn-authorization'] ?? '');
  const ticketId = Number(/^Bearer (\d+)\./.exec(bearer)?.[1]);
  const dir = ticketId ? app.runner.turnDir(ticketId) : null;
  if (!dir || placedAt(dir)?.id !== machine.id) throw new HttpError(403, 'Not a turn running on this machine');
  const headers: Record<string, string> = { authorization: bearer };
  for (const h of ['content-type', 'content-length', 'accept', 'mcp-session-id', 'mcp-protocol-version', 'last-event-id']) if (typeof req.headers[h] === 'string') headers[h] = req.headers[h];
  const reads = req.method !== 'GET' && readsDisk(params.rest);
  const problem = reads ? await askCheckpoint(dir, reads === 'must' ? 60_000 : 15_000) : null;
  if (problem && reads === 'must') throw new HttpError(503, `This turn's files could not come home first: ${problem}.`);
  return new Promise<void>((done) => {
    const out = request(new URL(`/${params.rest}${url.search}`, app.turnApi()), { method: req.method, headers }, (back) => {
      res.writeHead(back.statusCode ?? 502, reads ? { ...back.headers, 'x-citadel-sync': dir } : back.headers);
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
  // Connect a computer (Build 7 M2): the command's agent swaps its join code for its machine's token. No token yet, so anyone
  // on the machines' address may try; the code, one use and 15 minutes, is the whole check.
  {
    method: 'POST',
    path: '/api/machines/join',
    who: 'anyone',
    async handler({ req, res, app }) {
      const joined = redeemJoin(
        app.store,
        // A runner agent on this PC's row holds its token too (M2b): an Update replaces only the machine agent, so it keeps it.
        (id) => {
          const m = app.store.getMachine(id);
          const kept = m && app.store.machineRoles(id).find((r) => r.role === 'ci')?.setup?.runner_agent ? app.machines.shownToken(m) : null;
          return kept ?? app.machines.issueToken(id);
        },
        await readJson(req, 20_000),
        Date.now(),
        (id) => !!app.machineCopies?.removing(id),
      );
      await ownWrites(); // the panel's next look re-reads the row
      app.broadcast({ type: 'machines', machines: app.machines.list() });
      return json(res, 201, joined);
    },
  },
  agent('GET', '/api/machines/connect', ({ url, res, app }, machine) => {
    const info = (k: string) => (url.searchParams.get(k) ?? '').replace(/[\x00-\x1f\x7f]/g, '').slice(0, 200);
    // Whether a CI runner agent applies the balancer's plan (Build 7 M6b): one from before shows its row's update line.
    if (url.searchParams.get('kind') === 'runners') app.machines.runnerPlans.set(`${machine.id}:${url.searchParams.get('os') === 'linux' ? 'linux' : 'windows'}`, url.searchParams.get('plans') === '1');
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
  agent('POST', '/api/machines/turns', async ({ req, res, app }, machine) => {
    if (app.machines.workers?.refuses(machine.id, req.headers['x-citadel-worker'])) throw new HttpError(409, `${machine.name}'s minion turns run in its own worker program (citadel-worker): take the worker block out of this agent's config`);
    return json(res, 200, await syncTurns(machine.id, await readJson(req, 30_000_000)));
  }),
  agent('GET', '/api/machines/turn-folder', async ({ res, url }, machine) => {
    if (!(await sendFolder(machine.id, url.searchParams.get('dir'), res))) throw new HttpError(404, 'Not a turn placed on this machine');
  }),
  agent(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], '/api/machines/turn-call/*rest', turnCall),
  // A placed turn's worktree, session and folders, down before it and home at each checkpoint (Build 7 T3, src/machine-sync.ts).
  agent(['GET', 'POST'], '/api/machines/state/*rest', async ({ req, res, url, params, app }, machine) => {
    if (params.rest === 'script') return res.writeHead(200, { 'Content-Type': 'text/javascript' }).end((await syncScript()).text);
    const dir = url.searchParams.get('dir') ?? '';
    // A copy whose turn has ended (T6, src/machine-away.ts) may only send home what it holds, and be cleared: also one
    // whose folder is still here, ended while its machine was away.
    const copy = app.machineCopies && (app.machineCopies.held(machine.id, dir) || !(await owned(machine.id, dir))) ? app.machineCopies.copyAt(machine.id, dir) : null;
    const at = copy ?? ((await owned(machine.id, dir)) ? placedAt(dir) : null);
    if (!at) throw new HttpError(410, 'Not a turn placed on this machine');
    return stateCall(stateDeps(app), params.rest, dir, at, req, res, !!copy);
  }),
  // A worker's own program (Build 7 T5, src/worker-join.ts): how it stands, every 2 s, and what its self-test measures.
  agent('POST', '/api/machines/worker', async ({ req, res, app }, machine) => json(res, 200, await workersOf(app).report(machine, await readJson(req, 50_000)))),
  agent('GET', '/api/machines/worker/scratch', async ({ res, app }, machine) => {
    const scratch = await workersOf(app).sendScratch(machine.id);
    if (!scratch) throw new HttpError(409, 'No self-test is running');
    return json(res, 200, scratch);
  }),
  agent('POST', '/api/machines/worker/scratch', async ({ req, res, app }, machine) => {
    const why = await workersOf(app).takeScratch(machine.id, str((await readJson(req, 5_000_000)).bundle, 'bundle', 4_000_000));
    return json(res, 200, { ok: why === null, why });
  }),
  agent('GET', '/api/machines/worker/blob', ({ res, url, app }, machine) => {
    if (!workersOf(app).testing(machine.id)) throw new HttpError(409, 'No self-test is running');
    const body = Buffer.alloc(Math.min(BLOB_BYTES, Math.max(0, Math.floor(Number(url.searchParams.get('bytes'))) || 0)));
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': body.length, 'Cache-Control': 'no-store' }).end(body);
  }),
  agent('POST', '/api/machines/worker/blob', async ({ req, res, app }, machine) => {
    if (!workersOf(app).testing(machine.id)) throw new HttpError(409, 'No self-test is running');
    let bytes = 0;
    for await (const chunk of req) if ((bytes += chunk.length) > BLOB_BYTES) throw new HttpError(413, 'Too much');
    return json(res, 200, { bytes });
  }),
  // Jobs (#857, shared/project/specs/desktop-gpu-jobs.md "Wire contract"): one input file with the job's token, the
  // job's state every 10 s and on every change, and one result file, streamed to disk under the job's caps.
  agent('GET', '/api/machines/job-input', ({ req, res, url, app }, machine) => app.jobs.input(machine, req, res, url)),
  agent('POST', '/api/machines/job-state', async ({ req, res, app }, machine) => {
    app.jobs.report(machine, await readJson(req, 100_000));
    return json(res, 202, {});
  }),
  // A start of one of its owner's programs for a marked minion (Build 7 T8, src/host-reach.ts): the agent's word on it.
  agent('POST', '/api/machines/host-started', async ({ req, res, app }, machine) => {
    if (!app.machines.hostStarts.answer(machine.id, await readJson(req, 10_000))) throw new HttpError(404, 'No such start waits for this machine');
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
    // A runner agent on its own row, or beside the PC's agent on one row (Build 7 M2b).
    if (!storedCheck(machine)?.runners && !app.machines.runnersOn(machine.id).length) throw new HttpError(403, 'Only a CI runner agent sends load samples');
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
  ...roleSetupAgentRoutes,
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
        minions_get_it: lendsRole(app.store, m, 'tools', project, asker === null ? [] : [asker]),
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
  // How many minions fit (#1987): load against the turns running, for whoever sees the Status page's box tiles.
  {
    method: 'GET',
    path: '/api/box-capacity',
    ...people,
    handler: ({ res, app }) => json(res, 200, boxCapacity(app.store.boxReadings(Date.now() - HOST_SAMPLE_KEEP_MS))),
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
      const load = hostLoad(app.heavyDir, await readHeavyA(app.heavyDir), Date.now(), undefined, owners, await readLongJobsA(app.heavyDir).catch(() => []));
      const long = load.long.map((j) => {
        const t = app.store.getTicket(j.ticket);
        return t && canSee(t.project_id) ? { ...j, number: t.number, schemeId: t.project_id } : j;
      });
      json(res, 200, { ...load, long, minions, reaped, hold: app.ciHold ? { ...heldRows(app.ciHold.state(), app.store, canSee), cap: app.runnerCap?.text(canSee) ?? null } : null });
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
    // Connect a computer (Build 7 M2): a join code for the command the panel shows, one use and 15 minutes. The machine
    // is the asker's own, as one a person adds is (#306); an admin's too, since it is their PC.
    method: 'POST',
    path: '/api/machines/joins',
    ...people,
    async handler({ req, res, app, session }) {
      if (session.uid === undefined) throw new HttpError(403, 'Sign in with your own login to connect a computer');
      const join = makeJoin(app.store, { uid: session.uid, name: session.name }, session.uid, null);
      await ownWrites();
      return json(res, 201, { ...join, agent_url: app.machinesUrl?.origin ?? publicOrigin(req, app.preview) });
    },
  },
  {
    // Update an agent from before (Build 7 M2): a join code for this row, whose new agent reports what the PC can do. Who
    // may make it a new token may update it.
    method: 'POST',
    path: '/api/machines/:machine/join',
    ...people,
    handler: managed(async ({ req, res, app, machine, session }) => {
      if (app.machineCopies?.removing(machine.id)) throw new HttpError(409, `${machine.name} is being removed: it can't be updated`);
      const join = makeJoin(app.store, { uid: session.uid ?? null, name: session.name }, machine.owner_id, machine);
      await ownWrites();
      return json(res, 201, { ...join, name: machine.name, agent_url: app.machinesUrl?.origin ?? publicOrigin(req, app.preview) });
    }),
  },
  {
    // How a code the asker made is going, for the panel that shows it: waiting, expired, joined, or connected with the row.
    method: 'GET',
    path: '/api/machines/joins/:id',
    ...people,
    handler({ res, app, session, params }) {
      const join = app.store.machineJoin(Number(params.id));
      if (!join || join.asker_id === null || join.asker_id !== session.uid) throw new HttpError(404, 'No such join code');
      const machine = join.joined_id === null ? undefined : app.store.getMachine(join.joined_id);
      const view = machine ? app.machines.view(machine) : null;
      return json(res, 200, { id: join.id, expires_at: join.expires_at, state: joinState(join, !!view?.online && view.reported && (view.connected_at ?? 0) >= join.used_at!), machine: view });
    },
  },
  {
    method: 'POST',
    path: '/api/machines/:machine/token',
    ...people,
    handler: managed(async ({ req, res, app, machine }) => {
      // Its agent is still clearing its copies: a new token would cut it off before they are home.
      if (app.machineCopies?.removing(machine.id)) throw new HttpError(409, `${machine.name} is being removed: it gets no new token until its copies are cleared, or remove it now`);
      // A new token locks out whoever holds the old one, the connected agent included: on one PC's row its runner agents too,
      // so the reply names them and the page shows their lines (M2b).
      const runnerOs = app.machines.view(machine).runners ? [] : app.machines.runnersOn(machine.id).map((r) => r.os);
      const token = app.machines.issueToken(machine.id);
      app.machines.disconnect(machine.id);
      await ownWrites(); // the reply re-reads the machine (#1244)
      // An offline machine's disconnect says nothing, and its row should now offer Show (#1355).
      app.broadcast({ type: 'machines', machines: app.machines.list() });
      return json(res, 200, { machine: app.machines.view(app.store.getMachine(machine.id)!), token, runner_os: runnerOs, agent_url: app.machinesUrl?.origin ?? publicOrigin(req, app.preview) });
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
    // Its roles, each switched on or off with its schemes and caps (Build 7 M1).
    method: 'GET',
    path: '/api/machines/:machine/roles',
    ...people,
    handler: managed(({ res, app, machine }) => json(res, 200, { roles: rolesView(app.store.machineRoles(machine.id)) })),
  },
  {
    method: 'PATCH',
    path: '/api/machines/:machine/roles',
    ...people,
    handler: managed(async ({ req, res, app, machine, session }) => json(res, 200, await patchRoles(app, session, machine, await readJson(req)))),
  },
  {
    // Pause all (Build 7 M3): { pause: true } switches every role that's on off, draining; { pause: false } puts them back.
    method: 'POST',
    path: '/api/machines/:machine/pause',
    ...people,
    handler: managed(async ({ req, res, app, machine, session }) => json(res, 200, await pauseMachine(app, session, machine, await readJson(req)))),
  },
  {
    // Its worker's self-test (Build 7 T5); its lines come over the machines broadcast.
    method: 'POST',
    path: '/api/machines/:machine/self-test',
    ...people,
    handler: managed(({ res, app, session, machine }) => {
      const workers = workersOf(app);
      // It runs work on their PC, as their turns do.
      if (machine.owner_id !== session.uid) throw new HttpError(403, 'Only its owner can run its self-test');
      if (!app.machines.lendsWorker(machine)) throw new HttpError(409, `Minion turns are off for ${machine.name}`);
      if (!workers.here(machine.id)) throw new HttpError(409, `${machine.name}'s worker isn't running`);
      if (app.machines.shipsAtWorker(machine.id)) throw new HttpError(409, "A ship's tests are running on that PC: run it once they end");
      if (workers.testing(machine.id)) throw new HttpError(409, 'Its self-test is already running');
      workers.startTest(machine);
      return json(res, 202, { machine: app.machines.view(machine) });
    }),
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
    handler: managed(async ({ res, app, machine, url }) => {
      const copies = app.machineCopies;
      // A worker's copies of minions go first (Build 7 T6): its Minion turns switch goes off, its turns there run out, and
      // its agent sends home what never came and deletes the rest; the row goes once it has (dropRemoved). Offline, or
      // with ?now, it goes at once: what is there stays there, and its turns carry on at perigee.
      if (copies && url.searchParams.get('now') === null && machineLink.online(machine.id) && (Object.keys(copies.all(machine.id)).length || (await liveOn(machine.id)).length)) {
        copies.remove(machine.id);
        if (app.machines.lendsWorker(machine)) app.store.setMachineRole(machine.id, 'turns', { on: false });
        app.machines.pokeWorker(machine.id);
        await ownWrites();
        app.broadcast({ type: 'machines', machines: app.machines.list() });
        return json(res, 202, { removing: true, uninstall: UNINSTALL });
      }
      await dropMachine(app, machine);
      return json(res, 200, { uninstall: UNINSTALL });
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
      // A machine opens only for a minion in a scheme its Tools role is lent to (#438, M1), as at its turn's start
      // (src/runner.ts): a scheme taken off the list, or Tools switched off, mid-turn can't open it again.
      if (machine && (!project || caller!.kind === 'coordinator' || !app.store.roleGrants(machine.id, 'tools', project.id))) {
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
  // run_on_host (Build 7 T8, src/host-reach.ts): start one of the PC's owner's listed programs, for a minion whose running
  // turn reaches that PC's host. The agent checks the name against its own list; its refusal names the list.
  {
    method: 'POST',
    path: '/api/machines/run-on-host',
    ...turns,
    async handler({ req, res, app, caller }) {
      // Again here, not only at its start: a mark cleared or a machine given away mid-turn ends its reach. Before the body
      // and after it, so a turn that ended while it was read starts nothing.
      const reached = () => {
        const at = app.runner.hostReachOf(caller!.id);
        const machine = at && app.store.getMachine(at.id);
        if (!at || !machine || !hostReach(app.runner.runsOn.get(caller!.id), machine, app.store.turnAsker(caller!.id))) {
          throw new HttpError(403, "This turn doesn't reach a machine's host: only a minion marked to run on a machine, on a turn of that machine's owner, while it runs there");
        }
        return machine;
      };
      reached();
      const body = await readJson(req, 100_000);
      const machine = reached();
      const program = str(body.program, 'program', 40);
      const args = body.args === undefined ? [] : body.args;
      if (!Array.isArray(args) || !args.every((a) => typeof a === 'string')) throw new HttpError(400, 'args must be a list of text');
      const got = await app.machines.hostStarts.start(machine.id, program, args);
      if (!got.ok) throw new HttpError(409, `${machine.name}: ${got.error}`);
      app.runner.emit(caller!.id, 'note', { text: startedLine(program, machine.name, args) });
      return json(res, 200, { machine: machine.name, pid: got.pid });
    },
  },
];
