// A role's Set up and Test (Build 7 M4, src/role-setup.ts): the owner's press, the agent's word on each step, and the
// Windows screen test's screenshot.
import { stat } from 'node:fs/promises';
import { managesMachine } from '../access.ts';
import type { Machine } from '../db.ts';
import { HttpError, json, readJson, sendFile, type Ctx, type Route } from '../http.ts';
import { MAX_SHOT, type RoleSetups } from '../role-setup.ts';

function setupsOf(app: Ctx['app']): RoleSetups {
  if (!app.machines.roleSetups) throw new HttpError(503, 'No role setup here');
  return app.machines.roleSetups;
}

/** A route a machine's agent calls with its token (as routes/machines.ts's). */
const agent = (method: string, path: string, handler: (ctx: Ctx, machine: Machine) => unknown): Route => ({
  method,
  path,
  who: 'machine',
  handler(ctx) {
    const machine = ctx.app.machines.authenticate(ctx.req);
    if (!machine) throw new HttpError(401, 'Unknown machine token; make a new one in the Machines panel');
    return handler(ctx, machine);
  },
});

const people = { who: ['person'], refuse: 'Only people manage machines' } as const;

export const roleSetupRoutes: Route[] = [
  {
    // { kind: 'setup' | 'test' }: its steps come over the machines broadcast, in the role's setup.run.
    method: 'POST',
    path: '/api/machines/:machine/roles/:role/setup',
    ...people,
    async handler({ req, res, app, machine, session, params }) {
      if (!managesMachine(session, machine)) throw new HttpError(404, 'No such machine');
      const body = await readJson(req);
      const person = session.uid === undefined ? undefined : app.store.getUser(session.uid);
      if (!person) throw new HttpError(403, 'Sign in again');
      const run = setupsOf(app).start(machine, params.role, body.kind ?? 'setup', { id: person.id, name: person.name, admin: !!person.admin });
      return json(res, 202, { run, machine: app.machines.view(app.store.getMachine(machine.id)!) });
    },
  },
  {
    // The screen test's screenshot, for those who manage the machine.
    method: 'GET',
    path: '/api/machines/:machine/roles/screen/shot',
    ...people,
    async handler({ req, res, app, machine, session }) {
      if (!managesMachine(session, machine)) throw new HttpError(404, 'No such machine');
      const file = setupsOf(app).shotFile(machine.id);
      const size = (await stat(file).catch(() => null))?.size;
      if (!size) throw new HttpError(404, 'No screenshot yet');
      return sendFile(req, res, file, size, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
    },
  },
  agent('POST', '/api/machines/role-setup', async ({ req, res, app }, machine) => {
    if (!setupsOf(app).heard(machine, await readJson(req, 50_000))) throw new HttpError(410, 'No such setup running');
    return json(res, 200, { ok: true });
  }),
  agent('POST', '/api/machines/role-setup/shot', async ({ req, res, url, app }, machine) => {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_SHOT) throw new HttpError(413, 'A screenshot is at most 20 MB');
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    // A PNG's own first bytes: nothing else is kept or served as one.
    if (!bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) throw new HttpError(400, 'Not a PNG');
    if (!(await setupsOf(app).shot(machine, url.searchParams.get('id') ?? '', bytes))) throw new HttpError(410, 'No such setup running');
    return json(res, 200, { ok: true });
  }),
];
