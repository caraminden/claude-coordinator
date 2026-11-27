// The shared Android emulator's lease (#1128): tools/citadel-android writes "<until epoch s>\t<who>\t<what for>" to
// android.lease in citadel-heavy's folder. A lease past its time is nobody's, so a turn that died gives it back by itself.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface EmulatorLease {
  who: string;
  what: string;
  until: number;
}

/** The current lease (until in ms), or null when there is none or it has run out. */
export async function readEmulatorLease(dir: string, now = Date.now()): Promise<EmulatorLease | null> {
  try {
    return leaseIn(await readFile(join(dir, 'android.lease'), 'utf8'), now);
  } catch {
    return null;
  }
}

function leaseIn(text: string | null, now: number): EmulatorLease | null {
  if (text === null) return null;
  const [until, who, what] = text.replace(/\n$/, '').split('\t');
  const ms = Number(until) * 1000;
  if (!who || !(ms > now)) return null;
  return { who, what: what ?? '', until: ms };
}

/** A turn ended: its lease goes with it. Only the turn's own (who is the turn's CITADEL_HEAVY_WHO). */
export async function releaseEmulatorLease(dir: string, who: string, now = Date.now()): Promise<boolean> {
  const lease = leaseIn(await readFile(join(dir, 'android.lease'), 'utf8').catch(() => null), now);
  if (!lease || lease.who !== who) return false;
  try {
    await writeFile(join(dir, 'android.lease'), '');
    // Its two-minute step lease too, or the next caller still waits behind it.
    const step = (await readFile(join(dir, 'android.who'), 'utf8')).split('\t');
    if (step[1]?.replace(/\n$/, '') === who) await writeFile(join(dir, 'android.who'), '');
  } catch {
    /* nothing to clear */
  }
  return true;
}
