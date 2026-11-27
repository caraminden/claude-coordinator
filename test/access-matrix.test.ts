// Who may call what: every API route server.ts mounts, called as each kind of caller, against a recorded
// snapshot of the status and error each got (one block per route). A change here is a change in who
// may do what, so it gets looked at. A new route is probed without anyone listing it: run with
// UPDATE_ACCESS_MATRIX=1 to add its block, and read the 8 answers before committing them. Never
// rewrite the snapshot to turn a changed answer green without knowing why it changed.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Auth } from '../src/auth.ts';
import { Store } from '../src/db.ts';
import { json } from './typed.ts';
import { Contraptions } from '../src/contraptions.ts';
import type { Route } from '../src/http.ts';
import { bootServer, PASSWORD, SECRET, tempRoot } from './helpers.ts';

const SNAPSHOT = join(import.meta.dirname, 'access-matrix.snapshot.json');
const tmp = tempRoot('access-matrix-');
const root = tmp.dir;
const data = join(root, 'data');
mkdirSync(data, { recursive: true });
after(() => tmp.teardown()); // ends the detached turns before deleting their folders (#271)

// The world, made before the server starts: two schemes, each with a Taskmaster, and two minions in A.
const store = new Store(join(data, 'coordinator.db'));
const A = store.createProject('A', null);
const B = store.createProject('B', null);
function thread(projectId: number, kind: 'ticket' | 'coordinator', title: string) {
  const t = store.createTicket({ project_id: projectId, kind, title, permission_mode: 'default', created_by: 'Cara' });
  const cwd = join(root, 'work', String(t.id));
  mkdirSync(cwd, { recursive: true });
  store.setTicketDir(t.id, cwd, null);
  return store.getTicket(t.id)!;
}
const TA = thread(A.id, 'coordinator', 'Coordinator');
const TB = thread(B.id, 'coordinator', 'Coordinator');
const M1 = thread(A.id, 'ticket', 'One');
const M2 = thread(A.id, 'ticket', 'Two');
const schedule = () => store.schedules.create({ project_id: A.id, name: 'S', cron: '0 9 * * 1', brief: 'b', type: 'chore', created_by: 'Cara' });
const S = schedule();
// Every machine has an owner (Build 10 H1): Mo, in scheme A, who lent its tools to every turn there.
const MO = store.createUser({ name: 'Mo', login: 'mo' });
store.addMember(A.id, MO.id);
const machine = (name: string) => store.createMachine(name, 'x', 'Mo', MO.id);
const MX = machine('mx');
store.setMachineProjects(MX.id, [A.id]); // lent to scheme A only (#438): its minions may open it, B's may not
store.setMachineRole(MX.id, 'tools', { caps: { everyone: true } });
// A pinned artifact stays listed (as missing) whatever the startup scan finds.
store.syncArtifacts(M1, [{ path: 'report.md', size: 1, mtime: 1 }]);
const ART = store.listArtifacts(A.id)[0];
store.setArtifactPinned(ART.id, 'Cara');

const service = createServer((_req, res) => res.end('ok')); // a contraption's service: answers everything
const servicePort = await tmp.serve(service);
const CX = new Contraptions(store, SECRET, join(data, 'contraptions')).register({
  name: 'cx',
  title: 'CX',
  port: servicePort,
  icon: null,
  home_scheme: null,
  open_paths: '["/link"]',
  default_model: null,
  turn_cap: null,
});

const tokens = new Auth(PASSWORD, SECRET);
const bearer = (id: number) => ({ Authorization: `Bearer ${tokens.agentToken(id)}` });

// The probes come from the route table itself: every route server.ts mounts, in its order, so a new
// route can't go unprobed. A probe's path is the route's with each parameter filled from FILL; the
// loaded rows keep a short name (:t a ticket, :p scheme A, :s, :a, :m) that the call fills in.
type Probe = { method: string; path: string; fresh?: 'schedule' | 'machine'; notAsPerson?: boolean };
const FILL: Record<string, string> = {
  ticket: ':t',
  project: ':p',
  schedule: ':s',
  artifact: ':a',
  machine: ':m',
  machineId: ':m',
  person: '999',
  token: 'not-a-token',
  view: '0',
  name: 'nope',
  session: '0123456789abcdef01234567',
  turn: '1',
  event: '1',
  key: 'k',
  slug: 'nope',
  template: 'nope',
  to: 'nope',
  rest: 'x',
  app: 'nope',
  number: '1',
  list: 'apps',
  file: '1',
  upload: '0123456789abcdef0123456789abcdef',
  job: '1',
  hash: 'nohash',
  id: '1',
  row: 'nope',
  wait: '1',
  role: 'tools',
};
// Routes probed at other paths than FILL gives: a query the route needs, or more than one case.
const PATHS: Record<string, string[]> = {
  'GET /api/github/link': ['/api/github/link?project=:p'],
  'GET /api/github/callback': ['/api/github/callback?state=x&code=y'],
  'GET /api/projects/:project/tickets': ['/api/projects/:p/tickets', '/api/projects/:p/tickets?include_closed=1'],
  'GET /api/projects/:project/search': ['/api/projects/:p/search', '/api/projects/:p/search?q=one&ticket=:t'],
  'GET /api/projects/:project/memory': ['/api/projects/:p/memory?q=one'],
  'GET /api/tickets/:ticket/events': ['/api/tickets/:t/events', '/api/tickets/:t/events?after=0', '/api/tickets/:t/events?before=1000&limit=5&from=1'],
  'GET /api/files/:token/*path': ['/api/files/t1-0.zzzzzz.forged/report.md'],
  'GET /api/contraptions/media/*path': ['/api/contraptions/media/x.png'],
  'DELETE /api/contraptions/media/*path': ['/api/contraptions/media/x.png'],
  'HEAD /api/files/:token/*path': ['/api/files/t1-0.zzzzzz.forged/report.md'],
  'GET /api/tickets/:ticket/images/:name': ['/api/tickets/:t/images/0123456789abcdef01234567.png'],
  'GET /api/tickets/:ticket/uploads/:name': ['/api/tickets/:t/uploads/nothing.txt'],
  'HEAD /api/tickets/:ticket/uploads/:name': ['/api/tickets/:t/uploads/nothing.txt'],
  'GET /api/contraptions/sessions': ['/api/contraptions/sessions?person=1'],
  'DELETE /api/contraptions/sessions/:session': ['/api/contraptions/sessions/acolyte?person=1'],
};
// Routes that delete their row get a new schedule or machine per call.
const FRESH: Record<string, Probe['fresh']> = { 'DELETE /api/schedules/:schedule': 'schedule', 'DELETE /api/machines/:machine': 'machine' };
// Routes whose success starts a real container: only their refusals are probed (test/claude-link.test.ts
// and test/codex-link.test.ts cover the rest).
const NOT_AS_PERSON = new Set(['POST /api/me/claude', 'POST /api/me/codex']);
// Routes that leave something behind that changes other routes' answers go after all the rest, people
// after threads: a failed GitHub sign-in is kept for the account page, and a tune-up starts a
// Taskmaster turn, which retires tmA's token.
const LAST = new Set(['GET /api/github/callback', 'POST /api/projects/:project/tune-up']);
const PEOPLE = ['person', 'member', 'outsider'];
// Answers that look wrong, so they are probed but kept out of the snapshot until a person decides
// (#452, handoffs/handoff-access-matrix-findings.md). Fixed or accepted: drop the line and pin the answer.
const UNDECIDED = new Set([
  // Any member may start a tune-up, though changing the scheme's settings is its owner's.
  'POST /api/projects/:p/tune-up as member',
]);
// What the table can't express: wrong methods, unknown paths, and a contraption's proxied paths.
const EXTRA_TICKET: Probe[] = [
  { method: 'PUT', path: '/api/tickets/:t' },
  { method: 'GET', path: '/api/tickets/:t/messages' },
  { method: 'POST', path: '/api/tickets/:t/nonsense' },
];
const EXTRA: Probe[] = [
  { method: 'DELETE', path: '/api/projects/:p' },
  { method: 'PUT', path: '/api/projects/:p/properties' },
  { method: 'GET', path: '/api/push/subscription' },
  { method: 'POST', path: '/api/machines/:m' },
  { method: 'GET', path: '/api/nonsense' },
  // src/apps.ts: cx is enabled for the admin only, /link is open.
  { method: 'GET', path: '/apps/cx/x' },
  { method: 'POST', path: '/apps/cx/x' },
  { method: 'GET', path: '/apps/cx/link' },
  { method: 'GET', path: '/apps/nope/' },
];

/** Every route server.ts hands to router(), read from its source: importing it would boot the server. */
async function mountedRoutes(): Promise<Route[]> {
  const routeNames = (file: string, call: RegExp) => [...readFileSync(join(import.meta.dirname, '..', file), 'utf8').matchAll(call)].flatMap((m) => m[1].match(/\w+Routes\b/g) ?? []);
  // apiRoutes is src/routes/all.ts's one table of them, which the readers match too (#1628).
  const names = routeNames('server.ts', /\brouter\(([^)]*)\)/g).flatMap((n) => (n === 'apiRoutes' ? routeNames('src/routes/all.ts', /apiRoutes = \[([^\]]*)\]/g) : [n]));
  const exported: Record<string, Route[]> = {};
  for (const f of readdirSync(join(import.meta.dirname, '..', 'src', 'routes'))) Object.assign(exported, await import(`../src/routes/${f}`));
  assert.ok(names.length >= 9, `server.ts should hand its route arrays to router(); found ${names.join(', ') || 'none'}`);
  // An array server.ts mounts that isn't one of src/routes' exports would go unprobed.
  assert.deepEqual(
    names.filter((n) => !Array.isArray(exported[n])),
    [],
    'route arrays server.ts mounts that src/routes/ does not export',
  );
  return names.flatMap((n) => exported[n]);
}
const TICKET_ROUTES: Probe[] = [];
const OTHER_ROUTES: Probe[] = [];
const LAST_ROUTES: Probe[] = [];
const seen = new Set<string>();
for (const route of await mountedRoutes()) {
  for (const method of [route.method].flat()) {
    const key = `${method} ${route.path}`;
    // The agent routes are mounted twice: on the app's address and on the machines' own.
    if (seen.has(key)) continue;
    seen.add(key);
    const filled = () => route.path.replace(/[:*](\w+)/g, (_, name) => FILL[name] ?? assert.fail(`${key}: no FILL for :${name} in test/access-matrix.test.ts`));
    for (const path of PATHS[key] ?? [filled()]) {
      (LAST.has(key) ? LAST_ROUTES : route.path.includes(':ticket') ? TICKET_ROUTES : OTHER_ROUTES).push({ method, path, fresh: FRESH[key], notAsPerson: NOT_AS_PERSON.has(key) });
    }
  }
}
for (const key of [...Object.keys(PATHS), ...Object.keys(FRESH), ...NOT_AS_PERSON, ...LAST]) assert.ok(seen.has(key), `${key} is no route any more: drop its hint`);
TICKET_ROUTES.push(...EXTRA_TICKET);
OTHER_ROUTES.push(...EXTRA);

test('every route answers each kind of caller as recorded', { timeout: 120_000 }, async () => {
  const srv = await bootServer({ root });
  after(() => srv.stop()); // waits for the server to exit, so it isn't writing when the folder goes (#218)
  // Besides the admin (person): a member of scheme A who doesn't own it, and someone in no scheme.
  const invited = async (name: string) => {
    const made = await fetch(`${srv.base}/api/people`, { method: 'POST', headers: { Cookie: srv.cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) }).then((r) => json<{ token: string; person: { id: number } }>(r));
    const res = await fetch(`${srv.base}/api/invite/${made.token}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'a-long-password' }) });
    return { id: made.person.id as number, cookie: res.headers.get('set-cookie')!.split(';')[0] };
  };
  const [member, outsider] = [await invited('Max'), await invited('Olive')];
  store.addMember(A.id, member.id);
  // A contraption whose service (above) answers everything, enabled for the admin.
  store.setContraptionUser(CX.id, store.findUser('name', 'Cara')!.id, true, null);
  const callers: Record<string, Record<string, string>> = {
    anon: {},
    person: { Cookie: srv.cookie },
    member: { Cookie: member.cookie },
    outsider: { Cookie: outsider.cookie },
    tmA: bearer(TA.id),
    tmB: bearer(TB.id),
    m1: bearer(M1.id),
    m2: bearer(M2.id),
  };
  let n = 0;
  const probe = async (who: string, p: Probe, t: number) => {
    const id = p.fresh === 'schedule' ? schedule().id : p.fresh === 'machine' ? machine(`fresh-${n++}`).id : null;
    const path = p.path
      .replace(':t', String(t))
      .replace(':p', String(A.id))
      .replace(':s', String(id ?? S.id))
      .replace(':a', String(ART.id))
      .replace(':m', String(id ?? MX.id));
    const res = await fetch(srv.base + path, {
      method: p.method,
      headers: { ...callers[who], ...(p.method === 'GET' || p.method === 'HEAD' ? {} : { 'Content-Type': 'application/json' }) },
      body: p.method === 'GET' || p.method === 'HEAD' ? undefined : '{}',
    });
    // Event streams and machine sessions never end; the status is all we want.
    const text = /event-stream/.test(res.headers.get('content-type') ?? '') ? (await res.body?.cancel(), '') : await res.text();
    let error = '';
    try {
      error = JSON.parse(text).error ?? '';
    } catch {}
    return `${res.status}${error ? ` ${error}` : ''}`;
  };
  // One block per route, holding each caller's answer: a new route is one block in one place.
  const got: Record<string, Record<string, string>> = {};
  for (const who of Object.keys(callers)) {
    const ask = (p: Probe) => !(p.notAsPerson && PEOPLE.includes(who));
    for (const [target, t] of [
      ['minion1', M1.id],
      ['taskmasterA', TA.id],
    ] as const) {
      for (const p of TICKET_ROUTES.filter(ask)) (got[`${p.method} ${p.path.replace(':t', `:${target}`)}`] ??= {})[who] = await probe(who, p, t);
    }
    for (const p of OTHER_ROUTES.filter(ask)) (got[`${p.method} ${p.path}`] ??= {})[who] = await probe(who, p, M1.id);
  }
  for (const who of [...Object.keys(callers).filter((w) => !PEOPLE.includes(w)), ...PEOPLE]) {
    for (const p of LAST_ROUTES) (got[`${p.method} ${p.path}`] ??= {})[who] = await probe(who, p, M1.id);
  }
  // By path, then method, so one thing's routes sit together.
  const byPath = (k: string) => k.replace(/^(\S+) (.*)$/, '$2 $1');
  const block = (k: string) =>
    Object.fromEntries(
      Object.keys(callers)
        .filter((who) => who in got[k] && !UNDECIDED.has(`${k} as ${who}`))
        .map((who) => [who, got[k][who]]),
    );
  for (const u of UNDECIDED) assert.ok(got[u.split(' as ')[0]]?.[u.split(' as ')[1]], `${u} is probed no more: drop it from UNDECIDED`);
  const sorted = Object.fromEntries(
    Object.keys(got)
      .sort((a, b) => byPath(a).localeCompare(byPath(b)))
      .map((k) => [k, block(k)]),
  );
  if (process.env.UPDATE_ACCESS_MATRIX === '1') {
    writeFileSync(SNAPSHOT, JSON.stringify(sorted, null, 1) + '\n');
    return;
  }
  // A deleted snapshot fails rather than quietly writing today's answers as the new truth.
  assert.ok(existsSync(SNAPSHOT), `${SNAPSHOT} is missing: restore it from git, or write it with UPDATE_ACCESS_MATRIX=1 and read every answer before committing`);
  const want: Record<string, Record<string, string>> = JSON.parse(readFileSync(SNAPSHOT, 'utf8'));
  const diffs = [...new Set([...Object.keys(want), ...Object.keys(sorted)])]
    .flatMap((k) => Object.keys({ ...want[k], ...sorted[k] }).map((who) => [k, who, want[k]?.[who], sorted[k]?.[who]] as const))
    .filter(([, , was, now]) => was !== now)
    .map(([k, who, was, now]) => `${k} as ${who}: was ${was ?? '(none)'}, now ${now ?? '(none)'}`);
  assert.deepEqual(diffs, []);
});
