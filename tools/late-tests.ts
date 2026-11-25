// The load-sensitive test files for a CI run (#1898): asks Citadel for this scheme's list (GET /api/late-tests, with the
// job's own GitHub run token as tools/ci-progress.ts does) and writes it, a file a line, for tools/suite-runner.ts to run
// after the main wave (CITADEL_LATE_TESTS). It never fails the step: with no list every file runs in the main wave.
// shortcut: none on perigee's fallback suite, which has no run token; upgrade if that suite's flakes matter.
//   node tools/late-tests.ts <out>
import { writeFileSync } from 'node:fs';

async function main(out: string) {
  const env = process.env;
  // GitHub's hosted runners aren't on the tailnet, and share their machine with no other suite.
  if (env.RUNNER_ENVIRONMENT === 'github-hosted') return;
  if (!env.ACTIONS_ID_TOKEN_REQUEST_URL || !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) throw new Error("no run token (the job needs 'permissions: id-token: write')");
  const get = async (url: string, token: string) => {
    const r = await fetch(url, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
    if (!r.ok) throw new Error(`HTTP ${r.status} from ${new URL(url).host}: ${(await r.text()).slice(0, 200)}`);
    return r.json() as Promise<{ value?: unknown; files?: unknown }>;
  };
  const token = String((await get(`${env.ACTIONS_ID_TOKEN_REQUEST_URL}&audience=citadel-ci-store`, env.ACTIONS_ID_TOKEN_REQUEST_TOKEN)).value ?? '');
  const { files } = await get(`${env.CITADEL_STORE_URL || 'http://perigee.tail59477f.ts.net:8574'}/api/late-tests`, token);
  if (!Array.isArray(files)) throw new Error('no list in the answer');
  const named = files.filter((f): f is string => typeof f === 'string' && /^test\/[\w./-]+$/.test(f));
  writeFileSync(out, named.map((f) => `${f}\n`).join(''));
  console.log(`late-tests: ${named.length} load-sensitive test file(s) run after the main wave${named.length ? `: ${named.join(' ')}` : ''}`);
}

if (!process.argv[2]) {
  console.error('usage: node tools/late-tests.ts <out>');
  process.exit(2);
}
main(process.argv[2]).catch((err) => console.error(`late-tests: no list (${err?.cause?.code ?? err?.message ?? err}), so every test file runs in the main wave`));
