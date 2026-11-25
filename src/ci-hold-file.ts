// What src/ci-hold.ts publishes after every look, beside citadel-heavy's long jobs (a folder every turn can read, in a
// container too): tools/heavy-ci.ts asks it before it starts a job. A file not rewritten for its HOLD_STALE_MS means the
// server is down or old, so it holds nothing: optional work fails open.
import { chmod, mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface HoldFile {
  at: number;
  off: boolean;
  why: string | null;
  /** The repos with runners on that PC; another repo's jobs are never held. */
  repos: string[];
  held: { run: number }[];
}

const holdPath = (heavyDir: string) => join(heavyDir, 'long', 'hold.json');

export async function writeHold(heavyDir: string, state: HoldFile) {
  const file = holdPath(heavyDir);
  const dir = join(heavyDir, 'long');
  // Every account's turns queue jobs in it (tools/heavy-ci.ts).
  if (await mkdir(dir, { recursive: true })) await chmod(dir, 0o777);
  await writeFile(`${file}.tmp`, JSON.stringify(state) + '\n', { mode: 0o644 });
  await rename(`${file}.tmp`, file);
}
