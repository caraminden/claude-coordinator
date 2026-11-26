// A warm handover's copy (src/handover.ts) warms what its first requests would wait on before it says "ready" (#2119),
// while the old server still serves: Home's ship notes (a cold events.db read, 1.5-30 s) and every scheme's newest card
// rows (Runner.warmCards). On a read-only connection: the copy mustn't write, or keep rows the old server may still
// change. The notes move to the server's own Store after "go" (HomeBucketCache.adopt); the card rows stay behind, and
// what they leave is a page cache that makes the server's own warmCards quick.
import { existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { Store } from './db.ts';
import { warmHome } from './inbox.ts';

/** Null with no database yet (a first boot) or when it fails; else the read-only Store Home's notes were filled from. */
export async function warmUp(dbPath: string, log = console.log): Promise<Store | null> {
  if (!existsSync(dbPath)) return null;
  const start = performance.now();
  const reader = new Store(dbPath, { reader: true });
  try {
    await warmHome(reader);
    // The same steps as Runner.warmCards, with its pauses, so the copy never holds a core the old server needs.
    for (const p of reader.listProjects()) while (reader.warmCardRows(p.id, 500, 25) > 0) await sleep(5);
    log(`Handover: warmed up in ${Math.round(performance.now() - start)} ms (Home's ship notes, ${reader.cardRows.size} card rows).`);
    return reader;
  } catch (err) {
    reader.db.close();
    throw err;
  }
}
