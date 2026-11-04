// Machines: people list and manage them; a machine's agent connects with its own token; a minion's
// turn opens sessions to one and sends them messages.
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { lendsMachine, machinesFor, managesMachine, personsMachine } from '../access.ts';
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

/** A machine route for its owner and admins; to anyone else the machine isn't there. */
const managed = (handler: (ctx: Ctx) => unknown) => (ctx: Ctx) => {
  if (!managesMachine(ctx.session, ctx.machine)) throw new HttpError(404, 'No such machine');
  return handler(ctx);
};
const turns = { who: ['minion'], refuse: 'Only a minion\'s turn can use a machine' } as const;

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
      // Someone signed in with the old shared password has no id to own it by.
      if (!session.admin && session.uid === undefined) throw new HttpError(403, 'Sign in with your own login to add a machine');
      const name = machineName(body.name);
      // On from the start for a machine added with a folder for minions (#305); off otherwise.
      if (body.workspace_tools !== undefined && typeof body.workspace_tools !== 'boolean') throw new HttpError(400, 'workspace_tools must be true or false');
      let machine;
      try {
        // The real hash goes in once the id (part of the token) is known.
        // A person's machine goes to no scheme until they tick one; an admin's goes to every admin-owned scheme, as before.
        machine = app.store.createMachine(name, '', session.name, session.uid ?? null, !session.admin);
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
        // Someone who isn't an admin ticks only schemes they're in (a scheme they aren't in answers as missing).
        const seen = (id: number) => !!app.store.getProject(id) && app.store.canSee(session, id);
        if (body.projects !== null && !(Array.isArray(body.projects) && body.projects.every((id: unknown) => Number.isInteger(id) && seen(id as number)))) {
          throw new HttpError(400, 'projects must be null or a list of scheme ids');
        }
        if (body.projects === null && personsMachine(app.store, machine)) {
          throw new HttpError(400, 'A person\'s own machine goes only to the schemes ticked for it');
        }
        // Ticks they can't see (one an admin made, or a scheme they've left) stay as they were.
        projects = body.projects && [...body.projects, ...(machine.scoped ? app.store.machineProjects(machine.id).filter((id) => !app.store.canSee(session, id)) : [])];
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

  // A minion's MCP proxy: open a session to a machine (held open as a stream), then send it messages.
  {
    method: 'GET', path: '/api/machines/:machineId/session', ...turns,
    handler({ res, url, app, caller, params }) {
      const server = url.searchParams.get('server') === 'ws' ? 'ws' : 'mcp';
      const project = app.store.getProject(caller!.project_id);
      const machine = app.store.getMachine(Number(params.machineId));
      // A machine lent to chosen schemes, or a person's own (#306), opens only for a minion that would have got
      // it at its turn's start (src/runner.ts); any other still opens for a minion in any scheme, as before #303.
      if (machine && (machine.scoped || personsMachine(app.store, machine)) && (!project || caller!.kind === 'coordinator' || !project.machine_tools || !lendsMachine(app.store, machine, project))) {
        throw new HttpError(403, 'That machine isn\'t lent to this scheme');
      }
      const who = `#${caller!.number} in ${project?.name ?? 'a scheme'}`;
      if (!app.machines.openSession(Number(params.machineId), caller!, server, who, res)) throw new HttpError(503, server === 'ws' ? 'That machine is offline, or its workspace tools are off' : 'That machine is offline');
    },
  },
  {
    method: 'POST', path: '/api/machines/:machineId/session/:session', ...turns,
    async handler({ req, res, app, caller, params }) {
      if (!/^[0-9a-f]{24}$/.test(params.session)) throw new HttpError(404, 'Not found');
      const body = await readJson(req, 50_000_000);
      if (!app.machines.fromSession(params.session, caller!.id, body.message)) throw new HttpError(503, 'That machine went offline');
      return json(res, 202, {});
    },
  },
];
