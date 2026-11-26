// Is each systemd unit, slice, timer and drop-in in the repo's deploy/ installed on this host (#1216)? Units are a by-hand
// install (symlinks into the live checkout), so a missed step goes unseen: on 2026-11-20 the watchdog had been missing for 16
// days and both slices for 23. This only reads; it installs nothing. Off the server's thread: a stalled disk held it 15.8 s (#2081).
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type UnitState = 'installed' | 'missing' | 'different';
export interface UnitRow {
  /** Where it goes under the install dir, e.g. `citadel.slice` or `claude-coordinator.service.d/watchdog.conf`. */
  name: string;
  state: UnitState;
  /** The exact fish command that installs it; null when installed. */
  fix: string | null;
}
const KINDS = /\.(service|timer|slice|socket|path|mount|target)$/;
/** The file marking units "not installed on purpose": one name per line, `#` starts a comment. */
export const SKIP_FILE = 'not-installed.txt';

/** deploy/'s units, relative to it: top-level unit files and the `.conf` drop-ins in `<unit>.d/`. */
export async function repoUnits(deployDir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(deployDir, { withFileTypes: true })) {
    if (e.isFile() && KINDS.test(e.name)) out.push(e.name);
    else if (e.isDirectory() && /\.(service|timer|slice|socket)\.d$/.test(e.name)) {
      for (const f of (await readdir(join(deployDir, e.name))).filter((n) => n.endsWith('.conf'))) out.push(`${e.name}/${f}`);
    }
  }
  return out.sort();
}

export async function skipped(deployDir: string): Promise<Set<string>> {
  try {
    return new Set(
      (await readFile(join(deployDir, SKIP_FILE), 'utf8'))
        .split('\n')
        .map((l) => l.replace(/#.*/, '').trim())
        .filter(Boolean),
    );
  } catch {
    return new Set();
  }
}

const tilde = (p: string, home: string) => (p === home || p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p);

/** Each unit's state against `installDir` (stat and readFile follow a symlink, so a link into any checkout with the same text counts). */
export async function checkUnits(deployDir: string, installDir = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'systemd', 'user'), home = homedir()): Promise<UnitRow[]> {
  const skip = await skipped(deployDir);
  const rows: UnitRow[] = [];
  for (const name of await repoUnits(deployDir)) {
    const unit = name.split('/')[0].replace(/\.d$/, '');
    if (skip.has(name) || skip.has(unit)) continue;
    const want = await readFile(join(deployDir, name), 'utf8');
    const target = join(installDir, name);
    let state: UnitState = 'missing';
    // A stat that fails reads as missing, as existsSync did.
    const there = await stat(target).catch(() => null);
    if (there?.isFile()) state = (await readFile(target, 'utf8')) === want ? 'installed' : 'different';
    let fix: string | null = null;
    if (state !== 'installed') {
      const src = tilde(join(deployDir, name), home);
      const dst = tilde(installDir, home);
      const steps = [name.includes('/') ? `mkdir -p ${dst}/${name.split('/')[0]}` : '', `ln -sf ${src} ${dst}/${name}`, 'systemctl --user daemon-reload'];
      if (name.endsWith('.timer') || name.endsWith('.socket')) steps.push(`systemctl --user enable --now ${name}`);
      fix = steps.filter(Boolean).join('; ');
    }
    rows.push({ name, state, fix });
  }
  return rows;
}

/** The units with something to say, as keys that change when the state does. */
export const problemKeys = (rows: UnitRow[]): string[] => rows.filter((r) => r.state !== 'installed').map((r) => `${r.name}:${r.state}`);

/** The one line people read: "Units: 9 installed, 2 missing (a, b), 1 different (c)". */
export function summary(rows: UnitRow[]): string {
  const by = (s: UnitState) => rows.filter((r) => r.state === s).map((r) => r.name);
  const parts = [`${by('installed').length} installed`];
  for (const s of ['missing', 'different'] as const) if (by(s).length) parts.push(`${by(s).length} ${s} (${by(s).join(', ')})`);
  return `Units: ${parts.join(', ')}`;
}
