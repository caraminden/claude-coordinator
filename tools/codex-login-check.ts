// What src/codex-lock.ts rests on, checked against the `codex` that is installed (#636): app-servers that
// refresh one login at once reuse its single-use refresh token, and the login check stops that. (That a
// running app-server reloads a token another process refreshed was checked by hand: it takes 50 s to show
// near expiry, and the 401 path needs a stand-in for the model endpoint.) A made-up login in a temp CODEX_HOME and a
// stand-in for OpenAI's token endpoint and ChatGPT backend: no real login is read, and config.toml points
// codex at the stand-in. Not part of the suite: CI's runners have no codex, and a skipped test fails a
// land. Run it by hand after a codex upgrade, on a machine that has codex:
//   tools/citadel-node --test tools/codex-login-check.ts
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { codexLock } from '../src/codex-lock.ts';

assert.equal(spawnSync('codex', ['--version'], { stdio: 'ignore' }).status, 0, 'this check needs codex installed');
const root = mkdtempSync(join(tmpdir(), 'codex-race-'));
const DAY = 86400;

// The stand-in. Refresh tokens are single-use, as OpenAI's are: the token of generation n is rt-n, and the
// backend takes any access token.
const seen = { accepted: 0, reused: 0 };
let gen = 0;
let delayMs = 0;
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
function jwt(n: number, left: number): string {
  const now = Math.floor(Date.now() / 1000);
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ exp: now + left, iat: now + left - 10 * DAY, email: 'fake@example.com', n, 'https://api.openai.com/auth': { chatgpt_plan_type: 'pro', chatgpt_account_id: 'acct-fake', chatgpt_user_id: 'user-fake' } })}.sig`;
}
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const json = (status: number, o: object) => (res.writeHead(status, { 'content-type': 'application/json' }), res.end(JSON.stringify(o)));
    if (req.url === '/oauth/token') {
      const ok = JSON.parse(body).refresh_token === `rt-${gen}`;
      if (ok) gen++; // at once: a second use of the old token is a reuse, however close behind
      ok ? seen.accepted++ : seen.reused++;
      const n = gen;
      return void setTimeout(() => (ok ? json(200, { id_token: jwt(n, 10 * DAY), access_token: jwt(n, 10 * DAY), refresh_token: `rt-${n}` }) : json(401, { error: { message: 'Your refresh token has already been used.', code: 'refresh_token_reused' } })), delayMs);
    }
    json(200, { plan_type: 'pro', rate_limit: { allowed: true, limit_reached: false, primary_window: { used_percent: 1, limit_window_seconds: 18000, reset_after_seconds: 100, reset_at: Math.floor(Date.now() / 1000) + 100 } } });
  });
});
let url = '';
before(() => new Promise<void>((r) => server.listen(0, '127.0.0.1', () => ((url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`), r()))));
const children = new Set<ChildProcess>();
after(async () => {
  for (const c of children) c.kill('SIGKILL');
  await new Promise((r) => server.close(r));
  server.closeAllConnections();
  rmSync(root, { recursive: true, force: true });
});

function writeLogin(home: string, n: number, left: number) {
  writeFileSync(join(home, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', OPENAI_API_KEY: null, tokens: { id_token: jwt(n, left), access_token: jwt(n, left), refresh_token: `rt-${n}`, account_id: 'acct-fake' }, last_refresh: new Date().toISOString() }), { mode: 0o600 });
}
/** A CODEX_HOME with the made-up login at generation 0, `left` seconds from expiry, and the stand-in reset to match. */
function home(left: number): { dir: string; env: Record<string, string | undefined> } {
  const dir = mkdtempSync(join(root, 'home-'));
  writeFileSync(join(dir, 'config.toml'), `chatgpt_base_url = "${url}/backend-api/"\n`);
  writeLogin(dir, 0, left);
  gen = seen.accepted = seen.reused = 0;
  return { dir, env: { PATH: process.env.PATH, HOME: dir, CODEX_HOME: dir, CODEX_REFRESH_TOKEN_URL_OVERRIDE: `${url}/oauth/token` } };
}

/** A JSON-RPC reply from `codex app-server`: only the fields read. */
interface Reply {
  id?: number;
  method?: string;
  error?: { message?: string };
}

/** A `codex app-server` as a review starts it; `usage()` reads the account's usage (a backend call with the access token). */
function appServer(env: Record<string, string | undefined>) {
  const child = spawn('codex', ['app-server', '-c', 'cli_auth_credentials_store="file"', '-c', 'history.persistence="none"'], { env: env as NodeJS.ProcessEnv, stdio: ['pipe', 'pipe', 'ignore'] });
  children.add(child);
  child.on('exit', () => children.delete(child));
  const waiting = new Map<number, (m: Reply) => void>();
  let id = 1;
  let buf = '';
  child.stdout!.on('data', (c) => {
    buf += c;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      let m: Reply | undefined;
      try {
        m = JSON.parse(buf.slice(0, nl));
      } catch {}
      buf = buf.slice(nl + 1);
      if (m?.id !== undefined && m.method === undefined) waiting.get(m.id)?.(m), waiting.delete(m.id);
    }
  });
  const call = (method: string, params: object) => new Promise<Reply>((r) => (waiting.set(++id, r), child.stdin!.write(JSON.stringify({ id, method, params }) + '\n')));
  const ready = call('initialize', { clientInfo: { name: 'citadel-test', version: '1' }, capabilities: { experimentalApi: false } }).then(() => child.stdin!.write(JSON.stringify({ method: 'initialized' }) + '\n'));
  return {
    usage: async (): Promise<string> => (await ready, await call('account/rateLimits/read', {})).error?.message ?? 'ok',
    stop: () => new Promise<void>((r) => (child.exitCode !== null || child.signalCode !== null ? r() : (child.once('exit', () => r()), child.kill('SIGKILL')))),
  };
}
const until = async (cond: () => boolean, ms: number) => {
  for (const end = Date.now() + ms; !cond() && Date.now() < end; ) await new Promise((r) => setTimeout(r, 50));
};

test('without the login check, app-servers started together on a stale login reuse its refresh token', { timeout: 60_000 }, async () => {
  const { env } = home(60);
  delayMs = 3000; // the first refresh is still on its way while the others start
  const servers = [1, 2, 3, 4].map(() => appServer(env));
  for (const s of servers) void s.usage();
  await until(() => seen.accepted + seen.reused >= 4, 30_000);
  await Promise.all(servers.map((s) => s.stop()));
  assert.equal(seen.accepted, 1);
  assert.ok(seen.reused >= 1, `the race this lock exists for: ${seen.reused} refreshes were refused as reused`);
});

test('with the login check, runs started together on a stale login make one refresh and all go on', { timeout: 90_000 }, async () => {
  const { dir, env } = home(60);
  delayMs = 300;
  const results = await Promise.all(
    [1, 2, 3, 4].map(async () => {
      const gate = await codexLock(dir, () => {}, { env });
      const s = appServer(env);
      const usage = await s.usage();
      await s.stop();
      gate.unlock();
      return { usage, serial: gate.serial };
    }),
  );
  assert.equal(seen.reused, 0);
  // Two when codex's own start-up refresh (under 5 minutes left) comes before the one asked for: the same process, one after the other.
  assert.ok(seen.accepted === 1 || seen.accepted === 2, `${seen.accepted} refreshes`);
  assert.deepEqual(
    results,
    [1, 2, 3, 4].map(() => ({ usage: 'ok', serial: false })),
    'none kept the lock, all read their usage on the new token',
  );
});
