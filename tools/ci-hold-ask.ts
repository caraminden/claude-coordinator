// Deploys first (#1902): the first step of an optional CI job asks Citadel whether it may start. Told to wait, Citadel stops
// this run and starts it again once the ship line is empty (src/ci-hold.ts), so the job says why and waits here to be
// stopped, never long on a runner. It fails open: no Citadel, no run token, an old server or no stop within 10 minutes
// and the job goes ahead. Run by the repo's own workflows only.
//   node tools/ci-hold-ask.ts
import { setTimeout as sleep } from 'node:timers/promises';

const STORE = 'http://perigee.tail59477f.ts.net:8574';

export async function askHold(env: NodeJS.ProcessEnv, o: { tries?: number; every?: number; log?: (line: string) => void } = {}): Promise<boolean> {
  const { tries = 40, every = 15_000, log = console.log } = o;
  const store = (env.CITADEL_STORE_URL || STORE).replace(/\/$/, '');
  for (let n = 0; n < tries; n++) {
    if (n) await sleep(every);
    try {
      const signal = AbortSignal.timeout(15_000);
      const t = await fetch(`${env.ACTIONS_ID_TOKEN_REQUEST_URL}&audience=citadel-ci-store`, { headers: { authorization: `Bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` }, signal });
      if (!t.ok) throw new Error(`GitHub handed out no run token (HTTP ${t.status})`);
      const r = await fetch(`${store}/api/ci-hold`, { method: 'POST', headers: { authorization: `Bearer ${((await t.json()) as { value?: string }).value ?? ''}` }, signal });
      if (!r.ok) throw new Error(`Citadel answered HTTP ${r.status}`);
      const { go, why } = (await r.json()) as { go?: boolean; why?: string };
      if (go !== false) {
        log('nothing is in the way: starting');
        return true;
      }
      log(`${why}: Citadel stops this run and starts it again by itself when it may go (a ship's own check only if its ship still waits)`);
    } catch (err) {
      const e = err as { message?: string; cause?: { code?: string } };
      log(`::warning::couldn't ask Citadel whether this may start (${e?.cause?.code ?? e?.message ?? err}): starting`);
      return true;
    }
  }
  log('::warning::Citadel said wait but never stopped this run: starting');
  return false;
}

if (import.meta.main) await askHold(process.env);
