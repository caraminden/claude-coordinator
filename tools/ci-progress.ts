// CI's test counts for the Releases page (#1368). While a test step of .github/workflows/tests.yml runs, this sends the
// progress file tools/run-tests.sh keeps (tools/progress-reporter.ts's lines, or the reruns' with a 5th line, rerun)
// to Citadel's POST /api/ci-tests every 10 s, with the job's own GitHub run token (audience citadel-ci-store, as
// tools/ci-upload.sh asks for it: no secret). Unchanged counts are sent again, since Citadel drops counts 45 s old.
// It never fails or slows the step: each kind of error is one line on stderr, and the step kills it once the tests end.
//   node tools/ci-progress.ts <progress file>
import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

export interface CountsBody { done: number; total: number; file: string; failed: string[]; phase: 'suite' | 'rerun' }

/** POST /api/ci-tests's body from a progress file's text, or null while it holds no counts. */
export function countsBody(text: string): CountsBody | null {
  const [done, total, file = '', failed = '', phase = ''] = text.split('\n');
  if (!/^\d{1,9}$/.test(done) || !/^\d{1,9}$/.test(total) || +total === 0 || +done > +total) return null;
  // Citadel keeps 20 names of 200 characters at most; cut here too, so a long list never makes the body too big.
  const names = failed.split('\t').filter(Boolean).slice(0, 20).map((f) => f.slice(0, 200));
  return { done: +done, total: +total, file: file.slice(0, 200), failed: names, phase: phase === 'rerun' ? 'rerun' : 'suite' };
}

async function main(path: string) {
  const env = process.env;
  const store = env.CITADEL_STORE_URL || 'http://perigee.tail59477f.ts.net:8574';
  const every = Number(env.CI_PROGRESS_EVERY) * 1000 || 10_000;
  const said = new Set<string>();
  const warn = (why: string) => { if (!said.has(why)) { said.add(why); console.error(`ci-progress: ${why}; the tests go on`); } };
  // GitHub's hosted runners aren't on the tailnet, so they can't reach Citadel.
  if (env.RUNNER_ENVIRONMENT === 'github-hosted') return;
  if (!env.ACTIONS_ID_TOKEN_REQUEST_URL || !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) return warn("no run token (the job needs 'permissions: id-token: write'), so the Releases page shows no counts");
  let token = '', got = 0;
  for (;;) {
    await sleep(every);
    let text: string;
    try { text = readFileSync(path, 'utf8'); } catch { continue; } // no run going: between the full run and its reruns
    const body = countsBody(text);
    if (!body) continue;
    try {
      // A run token lasts minutes: a fresh one every 4, or after a refusal.
      if (!token || Date.now() - got > 240_000) {
        const r = await fetch(`${env.ACTIONS_ID_TOKEN_REQUEST_URL}&audience=citadel-ci-store`, { headers: { authorization: `Bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` }, signal: AbortSignal.timeout(15_000) });
        token = r.ok ? String((await r.json())?.value ?? '') : '';
        got = Date.now();
        if (!token) { warn(`GitHub didn't hand out a run token (HTTP ${r.status})`); continue; }
      }
      const r = await fetch(`${store}/api/ci-tests`, {
        method: 'POST', body: JSON.stringify(body), signal: AbortSignal.timeout(15_000),
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      });
      if (r.status === 401) token = '';
      if (r.status !== 202) warn(`Citadel at ${store} refused the counts (HTTP ${r.status}): ${(await r.text()).slice(0, 300)}`);
    } catch (err: any) {
      warn(`couldn't send the counts to ${store}: ${err?.cause?.code ?? err?.message ?? err}`);
    }
  }
}

if (import.meta.main) {
  if (!process.argv[2]) { console.error('usage: node tools/ci-progress.ts <progress file>'); process.exit(2); }
  main(process.argv[2]).catch((err) => console.error(`ci-progress: stopped: ${err?.message ?? err}`));
}
