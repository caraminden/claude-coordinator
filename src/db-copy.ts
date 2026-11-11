// A consistent copy of a database another process keeps writing (the live server, in WAL mode).
import { DatabaseSync, backup } from 'node:sqlite';

/**
 * Copy `src` to `dest` in one backup step, so one read transaction. SQLite restarts a backup whenever
 * another connection writes the source between steps, so the default (100 pages a step) never ends
 * while busy turns keep writing a large database (#497). In WAL mode the one step blocks no writer.
 */
export async function copyDb(src: string, dest: string): Promise<void> {
  const live = new DatabaseSync(src, { readOnly: true });
  try {
    await backup(live, dest, { rate: 2 ** 31 - 1 });
  } finally {
    live.close();
  }
}
