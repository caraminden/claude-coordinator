// CI's test counts for the Releases page (#1368). While a test step of .github/workflows/tests.yml runs, this sends the
// progress file tools/run-tests.sh keeps (tools/progress-reporter.ts's lines, or the reruns' with a 5th line, rerun)
// to Citadel's POST /api/ci-tests every 2 s, with the job's own GitHub run token (audience citadel-ci-store, as
// tools/ci-upload.sh asks for it: no secret). Unchanged counts are sent again, since Citadel drops counts 45 s old.
// It never fails or slows the step: each kind of error is one line on stderr. The step stops it with a TERM once the
// tests end and waits: it sends the newest counts it saw first (#1667), as run-tests.sh has removed the file by then.
//   node tools/ci-progress.ts <progress file>
import { readFileSync, watch } from 'node:fs';
import { basename, dirname } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { thrown } from '../src/thrown.ts';

export interface CountsBody {
  done: number;
  total: number;
  file: string;
  failed: string[];
  phase: 'suite' | 'rerun';
}

/** POST /api/ci-tests's body from a progress file's text, or null while it holds no counts. */
export function countsBody(text: string): CountsBody | null {
  const [done, total, file = '', failed = '', phase = ''] = text.split('\n');
  if (!/^\d{1,9}$/.test(done) || !/^\d{1,9}$/.test(total) || +total === 0 || +done > +total) return null;
  // Citadel keeps 20 names of 200 characters at most; cut here too, so a long list never makes the body too big.
  const names = failed
    .split('\t')
    .filter(Boolean)
    .slice(0, 20)
    .map((f) => f.slice(0, 200));
  return { done: +done, total: +total, file: file.slice(0, 200), failed: names, phase: phase === 'rerun' ? 'rerun' : 'suite' };
}

async function main(path: string) {
  const env = process.env;
  const store = env.CITADEL_STORE_URL || 'http://perigee.tail59477f.ts.net:8574';
  const every = Number(env.CI_PROGRESS_EVERY) * 1000 || 2_000;
  const said = new Set<string>();
  const warn = (why: string) => {
    if (!said.has(why)) {
      said.add(why);
      console.error(`ci-progress: ${why}; the tests go on`);
    }
  };
  // GitHub's hosted runners aren't on the tailnet, so they can't reach Citadel.
  if (env.RUNNER_ENVIRONMENT === 'github-hosted') return;
  if (!env.ACTIONS_ID_TOKEN_REQUEST_URL || !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) return warn("no run token (the job needs 'permissions: id-token: write'), so the Releases page shows no counts");
  // The newest counts seen, kept for the last send: the suite's last files end in a burst just before run-tests.sh
  // removes the file, so each write is read as it lands (a rename into the folder), not only at the next send.
  let latest: CountsBody | null = null;
  const look = () => {
    let body: CountsBody | null = null;
    try {
      body = countsBody(readFileSync(path, 'utf8'));
    } catch {
      /* no run going: between the full run and its reruns */
    }
    if (body) latest = body;
    return body;
  };
  try {
    watch(dirname(path), { persistent: false }, (_, name) => {
      if (name === basename(path)) look();
    }).on('error', () => {});
  } catch {
    /* the sends still read it */
  }
  let token = '',
    got = 0;
  const send = async (body: CountsBody) => {
    try {
      // A run token lasts minutes: a fresh one every 4, or after a refusal.
      if (!token || Date.now() - got > 240_000) {
        const r = await fetch(`${env.ACTIONS_ID_TOKEN_REQUEST_URL}&audience=citadel-ci-store`, { headers: { authorization: `Bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` }, signal: AbortSignal.timeout(15_000) });
        token = r.ok ? String(((await r.json()) as { value?: string } | null)?.value ?? '') : '';
        got = Date.now();
        if (!token) return warn(`GitHub didn't hand out a run token (HTTP ${r.status})`);
      }
      const r = await fetch(`${store}/api/ci-tests`, {
        method: 'POST',
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      });
      if (r.status === 401) token = '';
      if (r.status !== 202) warn(`Citadel at ${store} refused the counts (HTTP ${r.status}): ${(await r.text()).slice(0, 300)}`);
    } catch (err) {
      warn(`couldn't send the counts to ${store}: ${(thrown(err).cause as NodeJS.ErrnoException | undefined)?.code ?? thrown(err).message ?? err}`);
    }
  };
  // One send at a time, in order, so an older count never lands after the last one.
  let sending: Promise<unknown> = Promise.resolve();
  process.once('SIGTERM', () => {
    setTimeout(() => process.exit(0), 5_000).unref(); // a Citadel that doesn't answer holds the step 5 s at most
    look();
    const last = latest;
    if (last) sending = sending.then(() => send(last));
    void sending.then(() => process.exit(0));
  });
  for (;;) {
    await sleep(every);
    const body = look();
    if (body) await (sending = sending.then(() => send(body)));
  }
}

if (import.meta.main) {
  if (!process.argv[2]) {
    console.error('usage: node tools/ci-progress.ts <progress file>');
    process.exit(2);
  }
  main(process.argv[2]).catch((err) => console.error(`ci-progress: stopped: ${err?.message ?? err}`));
}
