// The pair contraption-read and mandate-items both need: a fake `claude -p` that calls one of Citadel's agent routes
// mid-turn from a plan file, and a stand-in Mandate that records the app-api calls it is sent.
import { chmodSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { join } from 'node:path';

/**
 * Writes `<root>/claude-fake`. Each turn runs the calls in `<root>/plan-<ticket id>.json` (each `{ [field]: name, method?, body? }`
 * against `route + name`), then appends what came back to `<root>/turns.jsonl`. `<root>/api` holds Citadel's base URL.
 * A call with no body sends `bodyDefault`, or none.
 */
export function planClaude(root: string, opts: { route: string; field: string; bodyDefault?: object }): string {
  const bin = join(root, 'claude-fake');
  writeFileSync(
    bin,
    `#!${process.execPath}
const { appendFileSync, existsSync, readFileSync } = require('node:fs');
require('node:readline').createInterface({ input: process.stdin }).once('line', async (prompt) => {
  const planFile = ${JSON.stringify(root)} + '/plan-' + process.env.COORDINATOR_TICKET + '.json';
  const plan = existsSync(planFile) ? JSON.parse(readFileSync(planFile, 'utf8')) : [];
  const api = readFileSync(${JSON.stringify(join(root, 'api'))}, 'utf8');
  const out = [];
  for (const c of plan) {
    const body = c.body ?? ${JSON.stringify(opts.bodyDefault)};
    const r = await fetch(api + ${JSON.stringify(opts.route)} + c[${JSON.stringify(opts.field)}], {
      method: c.method ?? 'POST', body: body && JSON.stringify(body),
      headers: { Authorization: 'Bearer ' + process.env.COORDINATOR_TOKEN, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    });
    out.push({ status: r.status, data: await r.json() });
  }
  appendFileSync(${JSON.stringify(join(root, 'turns.jsonl'))}, JSON.stringify({ ticket: Number(process.env.COORDINATOR_TICKET), prompt: JSON.parse(prompt), out }) + '\\n');
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done' }));
  process.exit(0);
});
`,
  );
  chmodSync(bin, 0o755);
  return bin;
}

export type Seen = { method: string; path: string; headers: IncomingHttpHeaders; body: string };

/**
 * A stand-in Mandate. `answer` returns [status, json] for a request, or nothing for a 404 unknown_command. Only calls under
 * `prefix` go in `seen`: Citadel also GETs an app's page 20 s after boot to read its manifest and icons, which broke exact
 * counts on a loaded box (#1660, #1666).
 */
export function standInMandate(prefix: string, answer: (req: { method: string; url: string }, body: string) => [number, unknown] | undefined): { server: Server; seen: Seen[] } {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.url!.startsWith(prefix)) seen.push({ method: req.method!, path: req.url!, headers: req.headers, body });
      const [status, data] = answer({ method: req.method!, url: req.url! }, body) ?? [404, { error: 'unknown_command' }];
      res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(data));
    });
  });
  return { server, seen };
}
