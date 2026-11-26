// The tripwire's verdict on a call a minion asks an approval card for (POST /api/tickets/:id/approvals), worked out
// in a worker thread (#2151). The verdict resolves paths on the disk and runs git (up to 3 s a call), and on the
// server's one thread each of those held every request, stream and timer until it returned. It fails closed: a
// worker that breaks or runs past its time gives no verdict, and the route refuses the call.
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import { tripwire, type TripwireConfig, type Verdict } from './tripwire.ts';

/** The call as the hook sees it. */
export interface JudgedCall {
  tool_name: string;
  tool_input: object;
  cwd: string;
}

/** The tripwire's verdict (null: it lets the call through), or why there is none. */
export type Judged = { verdict: Verdict | null } | { failed: string };

/** Longer than the tripwire's own git waits (3 s each) put together on any one call seen; a card's ask waits on it. */
export const JUDGE_MS = 15_000;

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** The verdict `tripwire()` gives, from a worker thread, so nothing in it waits on the server's thread. */
export function judge(call: JudgedCall, cfg: TripwireConfig, ms = JUDGE_MS): Promise<Judged> {
  return new Promise((resolve) => {
    let worker: Worker;
    try {
      // Its own stdio: piped to the server's, a worker stopped mid-run left that pipe open for good.
      worker = new Worker(new URL(import.meta.url), { workerData: { citadelJudge: { call, cfg } }, stdout: true, stderr: true });
    } catch (err) {
      // A config that can't be copied to the worker, or no thread to be had.
      resolve({ failed: message(err) });
      return;
    }
    let done = false;
    const end = (j: Judged) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      void worker.terminate();
      resolve(j);
    };
    const timer = setTimeout(() => end({ failed: `no verdict in ${ms / 1000} s` }), ms);
    worker.once('message', (m: Judged) => end(m));
    worker.once('error', (err) => end({ failed: message(err) }));
    worker.once('exit', (code) => end({ failed: `the check stopped (exit ${code})` }));
  });
}

// In the worker: work the verdict out and send it back. A throwaway saves list, as Approvals.ask's: the hook already
// saved what a file checkout throws away (#1716).
if (!isMainThread && workerData?.citadelJudge) {
  const { call, cfg } = workerData.citadelJudge as { call: JudgedCall; cfg: TripwireConfig };
  let out: Judged;
  try {
    out = { verdict: tripwire(call, cfg, []) };
  } catch (err) {
    out = { failed: message(err) };
  }
  parentPort?.postMessage(out);
}
