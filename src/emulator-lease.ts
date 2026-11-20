// The shared Android emulator's lease (#1128): tools/citadel-android writes "<until epoch s>\t<who>\t<what for>" to
// android.lease in citadel-heavy's folder. A lease past its time is nobody's, so a turn that died gives it back by itself.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface EmulatorLease { who: string; what: string; until: number }

/** The current lease (until in ms), or null when there is none or it has run out. */
export function readEmulatorLease(dir: string, now = Date.now()): EmulatorLease | null {
  let text: string;
  try {
    text = readFileSync(join(dir, 'android.lease'), 'utf8');
  } catch {
    return null;
  }
  const [until, who, what] = text.replace(/\n$/, '').split('\t');
  const ms = Number(until) * 1000;
  if (!who || !(ms > now)) return null;
  return { who, what: what ?? '', until: ms };
}

/** A turn ended: its lease goes with it. Only the turn's own (who is the turn's CITADEL_HEAVY_WHO). */
export function releaseEmulatorLease(dir: string, who: string, now = Date.now()): boolean {
  const lease = readEmulatorLease(dir, now);
  if (!lease || lease.who !== who) return false;
  try {
    writeFileSync(join(dir, 'android.lease'), '');
    // Its two-minute step lease too, or the next caller still waits behind it.
    const step = readFileSync(join(dir, 'android.who'), 'utf8').split('\t');
    if (step[1]?.replace(/\n$/, '') === who) writeFileSync(join(dir, 'android.who'), '');
  } catch {
    /* nothing to clear */
  }
  return true;
}
