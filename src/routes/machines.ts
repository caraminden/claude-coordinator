// Machines: people list and manage them; a machine's agent connects with its own token; a minion's
// turn opens sessions to one and sends them messages.
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { lendsMachine, machinesFor, managesMachine, taskmasterSeesMachine } from '../access.ts';
import { MACHINE_NAME, RESERVED_NAMES, WS_SUFFIX, hashToken, newToken } from '../machines.ts';
import type { Machine } from '../db.ts';
import { HttpError, json, readJson, type Ctx, type Route } from '../http.ts';

// The agent caps fetch_file at 20 MB too.
const MAX_MACHINE_UPLOAD = 20_000_000;
// Notes go into every thread's system prompt while the machine is online, so keep them short.
const MAX_MACHINE_NOTES = 2000;

function machineName(v: unknown): string {
  const name = typeof v === 'string' ? v.trim().toLowerCase() : '';
  if (!MACHINE_NAME.test(name)) throw new HttpError(400, 'Use 1 to 30 lowercase letters, digits and dashes, like godot-laptop');
  if (RESERVED_NAMES.has(name)) throw new HttpError(400, 'That name is taken by the app\'s own tools');
  if (name.endsWith(WS_SUFFIX)) throw new HttpError(400, `Names can't end in ${WS_SUFFIX}: that's how a machine's workspace tools are named`);
  return name;
}

/** A file a workspace session's fetch_file sends: saved in that minion's shared files, under machine-files/<machine>/. */
async function machineUpload({ req, res, url, app }: Ctx, machine: Machine) {
  const ticketId = app.machines.workspaceTicket(machine, url.searchParams.get('session') ?? '');
  const ticket = ticketId === null ? undefined : app.store.getTicket(ticketId);
  if (!ticket) throw new HttpError(410, 'No such workspace session');
  const name = basename((url.searchParams.get('name') ?? '').replace(/\\/g, '/')).replace(/[^\w.-]/g, '_').replace(/^\.+/, '').slice(0, 100) || 'file';
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
    } catch (err: any) {
      if (err.code !== 'EEXIST' || n > 999) throw err;
    }
  }
}

/** A route a machine's agent calls with its token, which reaches nothing else. */
const agent = (method: string, path: string, handler: (ctx: Ctx, machine: Machine) => unknown): Route => ({
  method, path, who: 'machine',
  handler(ctx) {
    const machine = ctx.app.machines.authenticate(ctx.req);
    if (!machine) throw new HttpError(401, 'Unknown machine token; make a new one in the Machines panel');
    return handler(ctx, machine);
  },
});

/** What a machine's agent calls: hold its stream open, pass on a message from its MCP server, its details, a file. */
export const agentRoutes: Route[] = [
  agent('GET', '/api/machines/connect', ({ url, res, app }, machine) => {
    const info = (k: string) => (url.searchParams.get(k) ?? '').replace(/[\x00-\x1f\x7f]/g, '').slice(0, 200);
    return app.machines.connectAgent(machine, res, { host: info('host'), command: info('command') });
  }),
  agent('POST', '/api/machines/send', async ({ req, res, app }, machine) => {
    // Room for screenshots, which MCP servers send as base64 images.
    const body = await readJson(req, 50_000_000);
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
const turns = { who: ['minion'], refuse: 'Only a minion\'s turn can use a machine' } as const;

/** The machines this Taskmaster's turn may see (#307), each as the Machines page shows it plus whom it goes to. */
function taskmasterMachines({ app, caller, project }: Ctx) {
  const asker = app.store.turnAsker(caller!.id);
  return app.store.listMachines().filter((m) => taskmasterSeesMachine(app.store, m, project, asker)).map((m) => {
    const view = app.machines.view(m);
    return {
      ...view,
      owner_name: m.owner_id === null ? null : app.store.getUser(m.owner_id)?.name ?? null,
      project_names: view.projects?.map((id) => app.store.getProject(id)?.name ?? `scheme ${id}`) ?? null,
      checked: app.machines.lastCheck(m.id),
    };
  });
}
const taskmaster = { who: ['taskmaster'], refuse: 'Only a Taskmaster lists and checks machines here; people use the Machines page' } as const;

export const machineRoutes: Route[] = [
  // On the app's own address only when machines have no address of their own (MACHINES_URL).
  ...agentRoutes.map((r): Route => ({
    ...r,
    handler(ctx) {
      if (ctx.app.machinesUrl) throw new HttpError(403, `Machines connect at ${ctx.app.machinesUrl.origin}, not here`);
      if (ctx.app.preview) throw new HttpError(403, 'Machines connect to the live app, not a preview');
      return r.handler(ctx);
    },
  })),

  { method: 'GET', path: '/api/machines', ...people, handler: ({ res, app, session }) => json(res, 200, machinesFor(session, app.machines.list())) },
  {
    method: 'POST', path: '/api/machines', ...people,
    async handler({ req, res, app, session }) {
      const body = await readJson(req);
      // A person's machine is their own (#306). An admin's is shared, as before, unless they say it's theirs.
      if (body.mine !== undefined && typeof body.mine !== 'boolean') throw new HttpError(400, 'mine must be true or false');
      const mine = !session.admin || body.mine === true;
      // Someone signed in with the old shared password has no id to own it by.
      if (mine && session.uid === undefined) throw new HttpError(403, 'Sign in with your own login to add a machine');
      const name = machineName(body.name);
      // On from the start for a machine added with a folder for minions (#305); off otherwise.
      if (body.workspace_tools !== undefined && typeof body.workspace_tools !== 'boolean') throw new HttpError(400, 'workspace_tools must be true or false');
      let machine;
      try {
        // The real hash goes in once the id (part of the token) is known.
        // An owned one is scoped to no scheme too: if its owner is ever removed, it reaches no one's turns.
        machine = app.store.createMachine(name, '', session.name, mine ? session.uid! : null, mine);
      } catch {
        throw new HttpError(409, 'A machine with that name already exists');
      }
      const token = newToken(machine.id);
      app.store.updateMachine(machine.id, { token_hash: hashToken(token), ...(body.workspace_tools ? { workspace_tools: 1 } : {}) });
      app.broadcast({ type: 'machines', machines: app.machines.list() });
      // The only time the token is shown; the app keeps just its hash.
      return json(res, 201, { machine: app.machines.view(app.store.getMachine(machine.id)!), token, agent_url: app.machinesUrl?.origin ?? null });
    },
  },
  {
    method: 'POST', path: '/api/machines/:machine/token', ...people,
    handler: managed(({ res, app, machine }) => {
      // A new token locks out whoever holds the old one, the connected agent included.
      const token = newToken(machine.id);
      app.store.updateMachine(machine.id, { token_hash: hashToken(token) });
      app.machines.disconnect(machine.id);
      return json(res, 200, { machine: app.machines.view(app.store.getMachine(machine.id)!), token, agent_url: app.machinesUrl?.origin ?? null });
    }),
  },
  {
    method: 'PATCH', path: '/api/machines/:machine', ...people,
    handler: managed(async ({ req, res, app, machine, session }) => {
      // Any of name, notes, workspace_tools and projects (the schemes it is lent to, or null for every scheme).
      const body = await readJson(req);
      let projects: number[] | null | undefined;
      if (body.projects !== undefined) {
        if (machine.owner_id !== null) throw new HttpError(400, 'A person\'s own machine goes to the turns they ask for, not to schemes');
        if (body.projects !== null && !(Array.isArray(body.projects) && body.projects.every((id: unknown) => Number.isInteger(id) && app.store.getProject(id as number)))) {
          throw new HttpError(400, 'projects must be null or a list of scheme ids');
        }
        projects = body.projects;
      }
      const fields: { name?: string; notes?: string; workspace_tools?: number } = {};
      if (body.workspace_tools !== undefined) {
        if (typeof body.workspace_tools !== 'boolean') throw new HttpError(400, 'workspace_tools must be true or false');
        fields.workspace_tools = body.workspace_tools ? 1 : 0;
      }
      if (body.name !== undefined) fields.name = machineName(body.name);
      if (body.notes !== undefined) {
        if (typeof body.notes !== 'string') throw new HttpError(400, 'notes must be text');
        fields.notes = body.notes.replace(/\r\n/g, '\n').trim();
        if (fields.notes.length > MAX_MACHINE_NOTES) throw new HttpError(400, `Notes are limited to ${MAX_MACHINE_NOTES.toLocaleString('en')} characters`);
      }
      try {
        app.store.updateMachine(machine.id, fields);
      } catch {
        throw new HttpError(409, 'A machine with that name already exists');
      }
      if (projects !== undefined) app.store.setMachineProjects(machine.id, projects);
      // Switched off or taken from a scheme: minions mid-turn lose the tools now, not at their next turn.
      if (fields.workspace_tools === 0) app.machines.endServer(machine.id, 'ws');
      if (projects !== undefined) {
        const now = app.store.getMachine(machine.id)!;
        app.machines.endSessionsWhere(machine.id, (id) => {
          const project = app.store.getProject(id);
          return !project || !lendsMachine(app.store, now, project);
        });
      }
      app.broadcast({ type: 'machines', machines: app.machines.list() });
      return json(res, 200, app.machines.view(app.store.getMachine(machine.id)!));
    }),
  },
  {
    method: 'DELETE', path: '/api/machines/:machine', ...people,
    handler: managed(({ res, app, machine }) => {
      app.store.deleteMachine(machine.id);
      app.machines.disconnect(machine.id);
      app.broadcast({ type: 'machines', machines: app.machines.list() });
      return json(res, 200, {});
    }),
  },

  // A contraption turn's MCP proxy (#306): the same, for its person's own machines only, with its turn's token.
  {
    method: 'GET', path: '/api/machines/:machineId/contraption-session', who: 'machine',
    handler({ req, res, app, params }) {
      const turn = contraptionTurn(ctxToken(req), app);
      const id = Number(params.machineId);
      // The owner check too: a removed machine's id can come back as someone else's.
      if (!turn.machines.includes(id) || app.store.getMachine(id)?.owner_id !== turn.person) throw new HttpError(403, 'That machine isn\'t this turn\'s person\'s, or the turn started without it');
      const who = `${app.store.getUser(turn.person)?.name ?? 'someone'} in ${app.store.listContraptions().find((c) => c.id === turn.contraption)?.title ?? 'a contraption'}`;
      if (!app.machines.openSession(id, { contraptionTurn: turn.id }, 'mcp', who, res)) throw new HttpError(503, 'That machine is offline');
    },
  },
  {
    method: 'POST', path: '/api/machines/:machineId/contraption-session/:session', who: 'machine',
    async handler({ req, res, app, params }) {
      const turn = contraptionTurn(ctxToken(req), app);
      if (!/^[0-9a-f]{24}$/.test(params.session)) throw new HttpError(404, 'Not found');
      const body = await readJson(req, 50_000_000);
      if (!app.machines.fromSession(params.session, { contraptionTurn: turn.id }, body.message)) throw new HttpError(503, 'That machine went offline');
      return json(res, 202, {});
    },
  },

  // The Taskmaster's look at the machines (#307): list them with their live state, and test one.
  {
    method: 'GET', path: '/api/projects/:project/machines', ...taskmaster,
    handler: (ctx) => json(ctx.res, 200, { machine_tools: !!ctx.project.machine_tools, machines: taskmasterMachines(ctx) }),
  },
  {
    method: 'POST', path: '/api/projects/:project/machines/:name/check', ...taskmaster,
    async handler(ctx) {
      const { app, caller, project, res, params } = ctx;
      const name = params.name.toLowerCase();
      const machine = taskmasterMachines(ctx).find((m) => m.name === name);
      if (!machine) throw new HttpError(404, `No machine called ${name} that this scheme can see`);
      if (!machine.online) return json(res, 200, { machine, results: [] });
      const results = await app.machines.check(machine.id, { ticketId: caller!.id, projectId: project.id }, `the ${project.name} Taskmaster's check`);
      return json(res, 200, { machine: { ...machine, checked: app.machines.lastCheck(machine.id) }, results });
    },
  },

  // A minion's MCP proxy: open a session to a machine (held open as a stream), then send it messages.
  {
    method: 'GET', path: '/api/machines/:machineId/session', ...turns,
    handler({ res, url, app, caller, params }) {
      const server = url.searchParams.get('server') === 'ws' ? 'ws' : 'mcp';
      const project = app.store.getProject(caller!.project_id);
      const machine = app.store.getMachine(Number(params.machineId));
      // A person's own (#306) opens only for a turn that got it at its start (src/runner.ts TurnState.owned),
      // which its owner asked for: never mid-turn, never for someone else's.
      // The owner check too: a removed machine's id can come back as someone else's.
      if (machine && machine.owner_id !== null && (!app.runner.ownedMachines(caller!.id).includes(machine.id) || machine.owner_id !== app.store.turnAsker(caller!.id))) {
        throw new HttpError(403, 'That machine is someone else\'s, or this turn started without it');
      }
      // A machine lent to chosen schemes opens only for a minion that would have got it at its turn's start
      // (src/runner.ts); any other still opens for a minion in any scheme, as before #303.
      if (machine?.scoped && machine.owner_id === null && (!project || caller!.kind === 'coordinator' || !project.machine_tools || !lendsMachine(app.store, machine, project))) {
        throw new HttpError(403, 'That machine isn\'t lent to this scheme');
      }
      const who = `#${caller!.number} in ${project?.name ?? 'a scheme'}`;
      if (!app.machines.openSession(Number(params.machineId), { ticketId: caller!.id, projectId: caller!.project_id }, server, who, res)) throw new HttpError(503, server === 'ws' ? 'That machine is offline, or its workspace tools are off' : 'That machine is offline');
    },
  },
  {
    method: 'POST', path: '/api/machines/:machineId/session/:session', ...turns,
    async handler({ req, res, app, caller, params }) {
      if (!/^[0-9a-f]{24}$/.test(params.session)) throw new HttpError(404, 'Not found');
      const body = await readJson(req, 50_000_000);
      if (!app.machines.fromSession(params.session, { ticketId: caller!.id, projectId: caller!.project_id }, body.message)) throw new HttpError(503, 'That machine went offline');
      return json(res, 202, {});
    },
  },
];
