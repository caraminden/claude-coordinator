// Who may call what: every API route, called as each kind of caller, against a recorded snapshot of
// the status and error each got. The route table (src/http.ts) must give the same answers the old
// hand-written checks did; a change here is a change in who may do what, so it gets looked at.
// UPDATE_ACCESS_MATRIX=1 rewrites the snapshot.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Auth } from '../src/auth.ts';
import { Store } from '../src/db.ts';
import { bootServer, PASSWORD, SECRET } from './helpers.ts';

const SNAPSHOT = join(import.meta.dirname, 'access-matrix.snapshot.json');
const root = mkdtempSync(join(tmpdir(), 'access-matrix-'));
const data = join(root, 'data');
mkdirSync(data, { recursive: true });
after(() => rmSync(root, { recursive: true, force: true }));

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
const machine = (name: string) => store.createMachine(name, 'x', 'Cara');
const MX = machine('mx');
// A pinned artifact stays listed (as missing) whatever the startup scan finds.
store.syncArtifacts(M1, [{ path: 'report.md', size: 1, mtime: 1 }]);
const ART = store.listArtifacts(A.id)[0];
store.setArtifactPinned(ART.id, 'Cara');

const tokens = new Auth(PASSWORD, SECRET);
const bearer = (id: number) => ({ Authorization: `Bearer ${tokens.agentToken(id)}` });

// Each route, with :t (a ticket), :p (scheme A), :s, :a, :m filled in below. `fresh` makes a new
// schedule or machine per call, for routes that delete theirs.
type Probe = { method: string; path: string; fresh?: 'schedule' | 'machine' };
const P = (method: string, path: string, fresh?: Probe['fresh']): Probe => ({ method, path, fresh });
const TICKET_ROUTES: Probe[] = [
  P('GET', '/api/tickets/:t'), P('PATCH', '/api/tickets/:t'), P('PUT', '/api/tickets/:t/person-note'), P('POST', '/api/tickets/:t/seen'),
  P('GET', '/api/tickets/:t/branch'), P('GET', '/api/tickets/:t/file'), P('PUT', '/api/tickets/:t/uploads'),
  P('GET', '/api/tickets/:t/events'), P('GET', '/api/tickets/:t/events?after=0'),
  P('GET', '/api/tickets/:t/events?before=1000&limit=5&from=1'), P('POST', '/api/tickets/:t/messages'), P('POST', '/api/tickets/:t/unqueue'),
  P('POST', '/api/tickets/:t/continue'), P('POST', '/api/tickets/:t/comments'), P('POST', '/api/tickets/:t/questions'),
  P('POST', '/api/tickets/:t/settle'), P('POST', '/api/tickets/:t/strike'), P('POST', '/api/tickets/:t/answer'),
  P('POST', '/api/tickets/:t/plans'), P('POST', '/api/tickets/:t/verdict'), P('POST', '/api/tickets/:t/approvals'),
  P('GET', '/api/tickets/:t/approvals'), P('POST', '/api/tickets/:t/approve'), P('PUT', '/api/tickets/:t/properties'),
  P('POST', '/api/tickets/:t/stop'), P('POST', '/api/tickets/:t/status'), P('POST', '/api/tickets/:t/coordinator'),
  P('POST', '/api/tickets/:t/deploy'), P('POST', '/api/tickets/:t/preview'), P('POST', '/api/tickets/:t/wake'),
  P('POST', '/api/tickets/:t/close'), P('GET', '/api/tickets/:t/images/0123456789abcdef01234567.png'),
  P('GET', '/api/tickets/:t/uploads/nothing.txt'),
  // Wrong methods and unknown actions.
  P('PUT', '/api/tickets/:t'), P('GET', '/api/tickets/:t/messages'), P('POST', '/api/tickets/:t/nonsense'),
];
const OTHER_ROUTES: Probe[] = [
  P('POST', '/api/login'), P('POST', '/api/logout'), P('GET', '/api/health'), P('GET', '/api/me'),
  P('GET', '/api/machines/connect'), P('POST', '/api/machines/send'), P('POST', '/api/machines/info'), P('POST', '/api/machines/upload'),
  P('GET', '/api/stream'), P('GET', '/api/costs'), P('GET', '/api/prs'), P('POST', '/api/taskmaster'),
  P('GET', '/api/projects'), P('POST', '/api/projects'), P('GET', '/api/catalogue'), P('GET', '/api/projects/:p'), P('PATCH', '/api/projects/:p'),
  P('GET', '/api/projects/:p/instructions/history'), P('GET', '/api/projects/:p/instructions/sources'),
  // Scheme B is id 2, so tmB stands in for the Citadel scheme's Taskmaster (GLOBAL_OWNER).
  P('GET', '/api/app/instructions'), P('PUT', '/api/app/instructions'), P('GET', '/api/app/instructions/history'),
  P('GET', '/api/app/settings'), P('PUT', '/api/app/settings'), P('POST', '/api/projects/:p/github'),
  P('GET', '/api/projects/:p/tickets'), P('GET', '/api/projects/:p/tickets?include_closed=1'), P('POST', '/api/projects/:p/tickets'), P('GET', '/api/projects/:p/briefs'), P('GET', '/api/projects/:p/properties'), P('POST', '/api/projects/:p/properties/keys'),
  P('POST', '/api/projects/:p/properties/values'), P('POST', '/api/projects/:p/properties/review'),
  P('POST', '/api/projects/:p/properties/proposals'), P('GET', '/api/projects/:p/inbox'), P('GET', '/api/projects/:p/recap'),
  P('GET', '/api/projects/:p/views'), P('POST', '/api/projects/:p/views'), P('DELETE', '/api/projects/:p/views/0'),
  P('GET', '/api/projects/:p/schedules'), P('POST', '/api/projects/:p/schedules'), P('PATCH', '/api/schedules/:s'),
  P('DELETE', '/api/schedules/:s', 'schedule'), P('GET', '/api/projects/:p/search'), P('GET', '/api/projects/:p/search?q=one&ticket=:t'), P('GET', '/api/projects/:p/artifacts'),
  P('GET', '/api/projects/:p/shared'), P('GET', '/api/projects/:p/shared/file'), P('POST', '/api/projects/:p/shared/pin'), P('GET', '/api/artifacts/:a'),
  P('GET', '/api/artifacts/:a/raw'), P('GET', '/api/files/t1-0.zzzzzz.forged/report.md'), P('POST', '/api/artifacts/:a/pin'), P('POST', '/api/projects/:p/artifacts/pin'),
  P('POST', '/api/artifact-data'), P('POST', '/api/projects/:p/artifact-data'),
  P('GET', '/api/push/key'), P('PUT', '/api/push/subscription'), P('POST', '/api/push/subscription'),
  P('PATCH', '/api/push/subscription'), P('DELETE', '/api/push/subscription'),
  P('GET', '/api/machines'), P('POST', '/api/machines'), P('POST', '/api/machines/:m/token'), P('PATCH', '/api/machines/:m'),
  P('DELETE', '/api/machines/:m', 'machine'), P('GET', '/api/machines/:m/session'),
  P('POST', '/api/machines/:m/session/0123456789abcdef01234567'),
  // Wrong methods and unknown paths.
  P('DELETE', '/api/projects/:p'), P('PUT', '/api/projects/:p/properties'), P('GET', '/api/push/subscription'),
  P('POST', '/api/machines/:m'), P('GET', '/api/nonsense'),
];

test('every route answers each kind of caller as recorded', { timeout: 120_000 }, async () => {
  const srv = await bootServer({ root });
  after(() => srv.proc.kill());
  const callers: Record<string, Record<string, string>> = {
    anon: {}, person: { Cookie: srv.cookie }, tmA: bearer(TA.id), tmB: bearer(TB.id), m1: bearer(M1.id), m2: bearer(M2.id),
  };
  let n = 0;
  const probe = async (who: string, p: Probe, t: number) => {
    const id = p.fresh === 'schedule' ? schedule().id : p.fresh === 'machine' ? machine(`fresh-${n++}`).id : null;
    const path = p.path.replace(':t', String(t)).replace(':p', String(A.id)).replace(':s', String(id ?? S.id))
      .replace(':a', String(ART.id)).replace(':m', String(id ?? MX.id));
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
  const got: Record<string, string> = {};
  for (const who of Object.keys(callers)) {
    for (const [target, t] of [['minion1', M1.id], ['taskmasterA', TA.id]] as const) {
      for (const p of TICKET_ROUTES) got[`${who} ${p.method} ${p.path.replace(':t', `:${target}`)}`] = await probe(who, p, t);
    }
    for (const p of OTHER_ROUTES) got[`${who} ${p.method} ${p.path}`] = await probe(who, p, M1.id);
  }
  const sorted = Object.fromEntries(Object.entries(got).sort(([a], [b]) => a.localeCompare(b)));
  if (process.env.UPDATE_ACCESS_MATRIX === '1' || !existsSync(SNAPSHOT)) {
    writeFileSync(SNAPSHOT, JSON.stringify(sorted, null, 1) + '\n');
    return;
  }
  const want: Record<string, string> = JSON.parse(readFileSync(SNAPSHOT, 'utf8'));
  const diffs = [...new Set([...Object.keys(want), ...Object.keys(sorted)])]
    .filter((k) => want[k] !== sorted[k])
    .map((k) => `${k}: was ${want[k] ?? '(none)'}, now ${sorted[k] ?? '(none)'}`);
  assert.deepEqual(diffs, []);
});
