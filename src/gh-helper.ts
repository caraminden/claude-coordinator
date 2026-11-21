// One person's GitHub reader that stays up (#1542, Cara 2026-11-21: "little servers that stay up and respond to
// requests ... like maybe the github example"). The server starts one per GitHub login on its first read (src/gh-api.ts)
// and sends one line on stdin: { socket, nonce, token, api }. It answers GETs on that unix socket over a connection to
// GitHub it keeps open, so a read starts no `gh`. A request must carry the nonce, which only the server knows: other
// processes of this account can't read GitHub as someone else through it. The token comes on stdin, not in the env, so
// /proc/<pid>/environ doesn't show it. It exits when idle, when the server goes (stdin closes), or on any setup failure.
import { execFile } from 'node:child_process';
import { chmod, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { promisify } from 'node:util';

export const IDLE_MS = 10 * 60_000;
/** The most of a body it passes on, as `gh api`'s maxBuffer in ghGet. */
export const MAX_BODY = 16 * 1024 * 1024;

interface Init { socket: string; nonce: string; token: string | null; api?: string; idleMs?: number }

async function main() {
  // The server going away closes stdin, at any point: the helper goes with it.
  process.stdin.on('end', () => process.exit(0));
  process.stdin.on('close', () => process.exit(0));
  const line = await new Promise<string>((done) => {
    let got = '';
    process.stdin.setEncoding('utf8').on('data', (d: string) => {
      got += d;
      if (got.includes('\n')) done(got.slice(0, got.indexOf('\n')));
    });
  });
  const init = JSON.parse(line) as Init;
  // No token from the server: the login gh itself would use (the box's, or GH_CONFIG_DIR's), read once.
  const token = init.token || (await promisify(execFile)('gh', ['auth', 'token'], { timeout: 15_000 }).then((r) => r.stdout.trim(), () => ''));
  if (!token) process.exit(3); // no login: the server reads through `gh` as before, which says why
  const api = (init.api ?? 'https://api.github.com').replace(/\/$/, '');
  let idle: NodeJS.Timeout;
  const rest = () => {
    clearTimeout(idle);
    idle = setTimeout(() => process.exit(0), init.idleMs ?? IDLE_MS);
  };
  rest();

  const server = createServer({ allowHalfOpen: true }, (conn) => {
    let req = '';
    conn.setEncoding('utf8');
    conn.on('error', () => {});
    conn.on('data', async (d) => {
      req += d;
      const nl = req.indexOf('\n');
      if (nl < 0) {
        if (req.length > 64 * 1024) conn.destroy();
        return;
      }
      conn.removeAllListeners('data');
      let ask: { nonce?: unknown; path?: unknown; etag?: unknown };
      try {
        ask = JSON.parse(req.slice(0, nl));
      } catch {
        return conn.destroy();
      }
      if (ask.nonce !== init.nonce || typeof ask.path !== 'string' || /^[a-z]+:|^\/\//i.test(ask.path)) return conn.destroy();
      rest();
      try {
        const res = await fetch(`${api}/${ask.path.replace(/^\/+/, '')}`, {
          headers: {
            authorization: `token ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'citadel-gh-helper',
            ...(typeof ask.etag === 'string' ? { 'if-none-match': ask.etag } : {}),
          },
          signal: AbortSignal.timeout(30_000),
        });
        const body = Buffer.from(await res.arrayBuffer());
        if (body.length > MAX_BODY) return conn.end(`${JSON.stringify({ error: 'too big' })}\n`);
        conn.write(`${JSON.stringify({ status: res.status, etag: res.headers.get('etag') })}\n`);
        conn.end(body);
      } catch (err: any) {
        conn.end(`${JSON.stringify({ error: String(err?.message ?? err) })}\n`);
      }
    });
  });
  server.on('error', () => process.exit(4));
  await rm(init.socket, { force: true }); // a stale socket from a helper that died
  server.listen(init.socket, async () => {
    await chmod(init.socket, 0o600);
    process.stdout.write('ready\n');
  });
}

main().catch(() => process.exit(1));
