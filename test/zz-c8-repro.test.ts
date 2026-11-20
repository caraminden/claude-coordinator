// [DEBUG-c8] Temporary repro for #1197 (previews C8 flake): runs the hung-health-check boot many times, instrumented. Never ships.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import { Previews } from '../src/previews.ts';

const root = mkdtempSync(join(tmpdir(), 'c8-repro-'));
after(() => rmSync(root, { recursive: true, force: true }));

// Every fetch, by port: when it started, when and how it ended.
const calls: { port: string; t0: number; t1?: number; how?: string }[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const port = new URL(String(input)).port;
  const c: (typeof calls)[number] = { port, t0: Date.now() };
  calls.push(c);
  try {
    const res = await realFetch(input, init);
    c.t1 = Date.now();
    c.how = `status ${res.status}`;
    return res;
  } catch (e: any) {
    c.t1 = Date.now();
    c.how = `${e.name}:${e.cause?.code ?? e.cause?.message ?? e.message}`;
    throw e;
  }
}) as typeof fetch;

let n = 0;
async function scenario(): Promise<string | null> {
  const id = ++n;
  const d = join(root, `d${id}`);
  mkdirSync(d);
  const s = new Store(join(d, 'coordinator.db'));
  const t = s.createTicket({ project_id: s.createProject('P', null).id, title: 'Hung', permission_mode: 'default', created_by: 'Cara' });
  const wt = join(root, `hung${id}`);
  mkdirSync(wt);
  const ev = join(wt, 'events');
  writeFileSync(join(wt, 'server.ts'), `import { appendFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
writeFileSync(${JSON.stringify(join(wt, 'pid'))}, String(process.pid));
const log = (s: string) => appendFileSync(${JSON.stringify(ev)}, Date.now() + ' ' + s + '\\n');
let n = 0;
const srv = createServer((req, res) => {
  log('req from ' + req.socket.remotePort + ' #' + n);
  if (n++) res.end(JSON.stringify({ ok: true, preview: true }));
});
srv.on('connection', (sock) => { const p = sock.remotePort; log('conn ' + p); sock.on('close', () => log('close ' + p)); });
srv.listen(Number(process.env.PORT), '127.0.0.1', () => log('listening ' + process.env.PORT));
`);
  s.setTicketDir(t.id, wt, `ticket/${id}`);
  const previews = new Previews(s, d);
  const h = monitorEventLoopDelay({ resolution: 10 });
  h.enable();
  const t0 = Date.now();
  let booted = 0;
  let failed: any;
  const boot = previews.start(s.getTicket(t.id)!).then(() => void (booted = Date.now()), (e) => void (failed = e));
  const deadline = Date.now() + 15_000;
  while (!booted && !failed && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  h.disable();
  let report: string | null = null;
  if (!booted || booted - t0 > 6000) {
    const events = existsSync(ev) ? readFileSync(ev, 'utf8').trim().split('\n').map((l) => { const [ts, ...rest] = l.split(' '); return `+${Number(ts) - t0} ${rest.join(' ')}`; }) : [];
    const port = events.find((e) => e.includes('listening'))?.split(' ').pop();
    const fetches = calls.filter((c) => c.port === port).map((c) => `+${c.t0 - t0}..${c.t1 ? `+${c.t1 - t0}` : 'pending'} ${c.how ?? ''}`);
    report = `[DEBUG-c8] scenario ${id}: ${booted ? `booted late at +${booted - t0}` : failed ? `failed: ${failed.message?.slice(0, 200)}` : 'not booted in 15 s'}; loop delay max ${Math.round(h.max / 1e6)} ms p99 ${Math.round(h.percentile(99) / 1e6)} ms\n  server: ${events.join(' | ')}\n  fetches: ${fetches.join(' | ')}`;
  }
  if (!booted && !failed && existsSync(join(wt, 'pid'))) process.kill(Number(readFileSync(join(wt, 'pid'), 'utf8')));
  await boot;
  await previews.stop(t.id, true);
  s.db.close();
  return report;
}

test('[DEBUG-c8] the hung-health-check boot, 8 at once, 12 rounds', async () => {
  const bad: string[] = [];
  for (let round = 0; round < 12; round++) {
    for (const r of await Promise.all(Array.from({ length: 8 }, scenario))) if (r) bad.push(r);
  }
  for (const b of bad) console.log(b);
  assert.equal(bad.length, 0, bad.join('\n'));
});
