// The kit's fake Citadel (kit/skills/contraption-ui/fake-citadel/) against the real contraption API: the same
// probes go to both and each must answer with the same status and the same body keys, so a change to the
// real API's shape fails here until the fake follows (and an app's tests, which run on the fake, with it).
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Contraptions } from '../src/contraptions.ts';
import { Store } from '../src/db.ts';
import { startFakeCitadel } from '../kit/skills/contraption-ui/fake-citadel/fake-citadel.ts';
import { bootServer, SECRET, stopTurns } from './helpers.ts';

const root = mkdtempSync(join(tmpdir(), 'fake-contract-'));
const data = join(root, 'data');
mkdirSync(data, { recursive: true });
after(async () => {
  await stopTurns(root);
  rmSync(root, { recursive: true, force: true });
});

const store = new Store(join(data, 'coordinator.db'));
const Cara = store.createUser({ name: 'Cara', login: 'cara', admin: true });
const Josh = store.createUser({ name: 'Josh', login: 'josh' });
const Rachel = store.createUser({ name: 'Rachel', login: 'rachel' });
const Dana = store.createUser({ name: 'Dana', login: 'dana' }); // exists, not enabled
const Peek = store.createProject('Peek Auras', null, Cara.id);
store.addMember(Peek.id, Rachel.id);
const keys = new Contraptions(store, SECRET, join(data, 'contraptions'));
const peek = keys.register({ name: 'peek-auras', title: 'Peek Auras', port: 9102, icon: null, home_scheme: Peek.id, open_paths: '[]', default_model: null, turn_cap: null });
for (const u of [Josh, Rachel]) store.setContraptionUser(peek.id, u.id, true, Cara.id);
const REAL_KEY = readFileSync(join(data, 'contraptions', 'peek-auras', 'contraption.key'), 'utf8');

type Probe = { name: string; method?: string; path: string; body?: unknown; raw?: string; type?: string; auth?: boolean; headers?: Record<string, string> };
const probes: Probe[] = [
  { name: 'no key', path: '/api/contraptions/home?person=2', auth: false },
  { name: 'home, a non-member', path: `/api/contraptions/home?person=${Josh.id}` },
  { name: 'home, a member', path: `/api/contraptions/home?person=${Rachel.id}` },
  { name: 'home, not enabled', path: `/api/contraptions/home?person=${Dana.id}` },
  { name: 'home, a bad person', path: '/api/contraptions/home?person=x' },
  { name: 'ask: a bug', method: 'POST', path: '/api/contraptions/asks', body: { person: Josh.id, kind: 'bug', text: 'It broke' } },
  { name: 'ask: a feature from a non-member is a proposal', method: 'POST', path: '/api/contraptions/asks', body: { person: Josh.id, kind: 'feature', text: 'More auras' } },
  { name: 'ask: data with nothing', method: 'POST', path: '/api/contraptions/asks', body: { person: Josh.id, kind: 'data' } },
  { name: 'ask: a bad kind', method: 'POST', path: '/api/contraptions/asks', body: { person: Josh.id, kind: 'rant', text: 'x' } },
  { name: 'ask: not enabled', method: 'POST', path: '/api/contraptions/asks', body: { person: Dana.id, kind: 'bug', text: 'x' } },
  { name: 'ask: not JSON', method: 'POST', path: '/api/contraptions/asks', raw: '{', type: 'application/json' },
  { name: 'ask: wrong content type', method: 'POST', path: '/api/contraptions/asks', raw: 'x', type: 'text/plain' },
  { name: 'spend', method: 'POST', path: '/api/contraptions/spend', body: { service: 'azure-speech', usd: 0.42 } },
  { name: 'spend: no usd', method: 'POST', path: '/api/contraptions/spend', body: { service: 'azure-speech' } },
  { name: 'sessions', path: `/api/contraptions/sessions?person=${Josh.id}` },
  { name: 'sessions: not enabled', path: `/api/contraptions/sessions?person=${Dana.id}` },
  { name: 'delete a missing session', method: 'DELETE', path: `/api/contraptions/sessions/nope?person=${Josh.id}` },
  { name: 'openrouter', path: `/api/contraptions/openrouter?person=${Josh.id}` },
  { name: 'media list', path: `/api/contraptions/media?person=${Josh.id}` },
  { name: 'cancel a turn nobody started', method: 'POST', path: '/api/contraptions/turns/nope/cancel' },
  { name: 'verdict on no turn', method: 'POST', path: '/api/contraptions/turns/nope/verdict', body: { verdict: 'pass' } },
  { name: 'verdict that is neither', method: 'POST', path: '/api/contraptions/turns/nope/verdict', body: { verdict: 'meh' } },
  { name: 'message to no turn', method: 'POST', path: '/api/contraptions/turns/nope/messages', body: { person: Josh.id, text: 'hi' } },
  { name: 'minion, a non-member', path: `/api/contraptions/minions/1?person=${Josh.id}` },
  { name: 'minion, a bad number', path: `/api/contraptions/minions/x?person=${Rachel.id}` },
  { name: 'minions, too many', path: `/api/contraptions/minions?person=${Rachel.id}&n=${Array.from({ length: 51 }, (_, i) => i + 1)}` },
  { name: 'relay to nobody', path: '/api/contraptions/relay/ghost/x', headers: { 'X-Citadel-Person': String(Josh.id) } },
  { name: 'turn: not JSON', method: 'POST', path: '/api/contraptions/turns', raw: '{', type: 'application/json' },
  { name: 'turn: wrong content type', method: 'POST', path: '/api/contraptions/turns', raw: 'x', type: 'text/plain' },
  { name: 'turn: blank prompt', method: 'POST', path: '/api/contraptions/turns', body: { person: Josh.id, session: 's', prompt: ' ' } },
  { name: 'turn: a bad session name', method: 'POST', path: '/api/contraptions/turns', body: { person: Josh.id, session: 'a b', prompt: 'hi' } },
  { name: 'turn: a bad effort', method: 'POST', path: '/api/contraptions/turns', body: { person: Josh.id, session: 's', prompt: 'hi', effort: 'max' } },
  { name: 'turn: a person who is not enabled', method: 'POST', path: '/api/contraptions/turns', body: { person: Dana.id, session: 's', prompt: 'hi' } },
];

// What a call answered, reduced to what an app can lean on: the status, and for JSON the body's keys (an
// array's first item too); for a stream, its events' names and the error's code.
async function observe(base: string, key: string, p: Probe) {
  const res = await fetch(base + p.path, {
    method: p.method ?? (p.body !== undefined || p.raw !== undefined ? 'POST' : 'GET'),
    headers: {
      ...(p.auth === false ? {} : { Authorization: `Bearer ${key}` }),
      ...(p.body !== undefined ? { 'Content-Type': 'application/json' } : p.type ? { 'Content-Type': p.type } : {}),
      ...p.headers,
    },
    body: p.raw ?? (p.body === undefined ? undefined : JSON.stringify(p.body)),
  });
  const text = await res.text();
  if (/event-stream/.test(res.headers.get('content-type') ?? '')) {
    const events = [...text.matchAll(/^event: (.+)\ndata: (.+)$/gm)].map((m) => ({ event: m[1], data: JSON.parse(m[2]) }));
    return { status: res.status, stream: events.map((e) => (e.event === 'error' ? `error:${e.data.code}` : e.event)) };
  }
  let body: unknown = text;
  try { body = JSON.parse(text); } catch {}
  const keysOf = (v: any): unknown => (Array.isArray(v) ? v.slice(0, 1).map(keysOf) : v && typeof v === 'object' ? Object.keys(v).sort() : typeof v);
  return { status: res.status, keys: keysOf(body) };
}

test('the fake answers every probe the way the real API does', { timeout: 120_000 }, async () => {
  const srv = await bootServer({ root });
  after(() => srv.stop());
  const fake = await startFakeCitadel({
    app: 'peek-auras',
    people: [Josh, Rachel, Dana].map((u) => ({ id: u.id, login: u.login, name: u.name, apps: u === Dana ? [] : ['peek-auras'], member: u === Rachel })),
    home: { id: Peek.id, name: 'Peek Auras' },
  });
  after(() => fake.close());
  for (const p of probes) {
    const real = await observe(srv.base, REAL_KEY, p);
    const faked = await observe(fake.url, fake.key, p);
    assert.deepEqual(faked, real, `${p.name}: the fake answered ${JSON.stringify(faked)}, the real API ${JSON.stringify(real)}`);
  }
});

test('a scripted turn plays back the events the real stream has, in order', async () => {
  const fake = await startFakeCitadel({
    app: 'peek-auras',
    script: () => [{ text: 'Looking.' }, { tool: 'mcp__aura__find', input: { q: 'fire' } }, { text: 'Found it.' }, { grunt: 'check', steps: [{ text: 'hm' }] }],
  });
  after(() => fake.close());
  const res = await fetch(`${fake.url}/api/contraptions/turns`, {
    method: 'POST', headers: { Authorization: `Bearer ${fake.key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ person: 1, session: 's', prompt: 'find fire' }),
  });
  const events = [...(await res.text()).matchAll(/^event: (.+)$/gm)].map((m) => m[1]);
  assert.deepEqual(events, ['start', 'text', 'tool', 'tool_result', 'text', 'tool', 'text', 'tool_result', 'end']);
  assert.equal(fake.turns[0].prompt, 'find fire');
});

test('the identity header it signs verifies the way api.md says to', async () => {
  const { createPublicKey, verify } = await import('node:crypto');
  const fake = await startFakeCitadel({ app: 'peek-auras' });
  after(() => fake.close());
  const pub = createPublicKey(readFileSync(join(fake.keysDir, 'identity.pub')));
  const m = /^v1\.([\w-]+)\.([\w-]+)$/.exec(fake.identity())!;
  assert.ok(verify(null, Buffer.from(`v1.${m[1]}`), pub, Buffer.from(m[2], 'base64url')));
  const c = JSON.parse(Buffer.from(m[1], 'base64url').toString());
  assert.deepEqual([c.app, c.sub, c.exp - c.iat], ['peek-auras', 1, 60]);
});

test('a relayed call reaches the other app signed for it, with from and fromTitle', async () => {
  const { createServer } = await import('node:http');
  let seen = '';
  const other = createServer((req, res) => { seen = String(req.headers['x-citadel-identity']); res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}'); }).listen(0, '127.0.0.1');
  await new Promise((r) => other.once('listening', r));
  const fake = await startFakeCitadel({
    app: 'mandate',
    apps: { ledger: { title: 'Ledger', relayPaths: ['/app-api/'], origin: () => `http://127.0.0.1:${(other.address() as import('node:net').AddressInfo).port}` } },
    people: [{ id: 1, login: 't', name: 'T', apps: ['mandate', 'ledger'] }],
  });
  after(() => { other.close(); return fake.close(); });
  const call = (path: string) => fetch(`${fake.url}/api/contraptions/relay/ledger${path}`, { headers: { Authorization: `Bearer ${fake.key}`, 'X-Citadel-Person': '1' } });
  assert.equal((await call('/app-api/x')).status, 200);
  const claims = JSON.parse(Buffer.from(seen.split('.')[1], 'base64url').toString());
  assert.deepEqual([claims.app, claims.from, claims.sub], ['ledger', 'mandate', 1]);
  assert.equal((await call('/private')).status, 404); // not under relay_paths
});
