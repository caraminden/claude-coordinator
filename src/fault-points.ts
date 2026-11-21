// Named kill points for the fault drills (test/drills/, #1326): a drill boots the server with CITADEL_FAULT_POINT set
// to one name, and the server SIGKILLs itself there, once the writes queued so far have landed, as a crash at that
// line would leave them. Unset (always, outside a drill) it does nothing.
import { writes } from './http.ts';

const POINT = process.env.CITADEL_FAULT_POINT || null;

export async function faultPoint(name: string) {
  if (name !== POINT) return;
  for (let p; (p = writes.landed?.(true));) await p;
  console.error(`Fault point ${name}: killing the server here (CITADEL_FAULT_POINT).`);
  process.kill(process.pid, 'SIGKILL');
  await new Promise(() => {}); // nothing after the point runs, even for the moment the signal takes
}
