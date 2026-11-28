// One boot-and-login for the tests that drive a real server as several people (hidden-schemes, member-schemes):
// Cara is the admin, `person(name, password)` invites someone, and `call(who, path)` speaks as them.
import { join } from 'node:path';
import { listeningPort, PASSWORD, SECRET, TEST_ZONE, type TempRoot } from './helpers.ts';
import { json, type Reply } from './typed.ts';

const repo = join(import.meta.dirname, '..');

export async function bootPeople(tmp: TempRoot) {
  const cookies: Record<string, string> = {};
  const server = tmp.spawn(process.execPath, [join(repo, 'server.ts')], {
    env: {
      ...process.env,
      MACHINES_URL: undefined,
      CITADEL_HOST_SIGNALS: 'fixed',
      CITADEL_ZONE: TEST_ZONE,
      PORT: '0',
      DATA_DIR: join(tmp.dir, 'data'),
      CLAUDE_BIN: '/bin/false',
      CLAUDE_CONFIG_DIR: join(tmp.dir, 'claude'),
      COORDINATOR_PASSWORD: PASSWORD,
      SESSION_SECRET: SECRET,
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const base = `http://127.0.0.1:${await listeningPort(server)}`;
  const res = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Cara', password: PASSWORD }) });
  cookies.Cara = res.headers.get('set-cookie')!.split(';')[0];
  async function call<T = unknown>(who: string, path: string, opts: { method?: string; body?: unknown } = {}): Promise<Reply<T>> {
    const r = await fetch(base + path, {
      method: opts.method ?? 'GET',
      headers: { Cookie: cookies[who], ...(opts.body ? { 'Content-Type': 'application/json' } : {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    return { status: r.status, data: await json<T>(r) };
  }
  async function person(name: string, password: string): Promise<number> {
    const { data: made } = await call<{ token: string; person: { id: number } }>('Cara', '/api/people', { method: 'POST', body: { name } });
    const invite = await fetch(`${base}/api/invite/${made.token}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
    cookies[name] = invite.headers.get('set-cookie')!.split(';')[0];
    return made.person.id;
  }
  return { base, call, person };
}
