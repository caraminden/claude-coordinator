// One Codex app-server at a time per person: their ChatGPT login's refresh token is single-use, and two
// app-servers refreshing at once sign them out. Taken by a Codex turn (src/codex-turn.ts) and by
// citadel-codex-review (src/codex-review.ts); no local imports, so it pins on its own.
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Set in a Codex turn's app-server, so its shell's commands, a review among them, know the lock is their own turn's: what the lock's pid file says. */
export const LOCK_ENV = 'CITADEL_CODEX_LOCK';

/** A process's start time in clock ticks since boot (/proc/<pid>/stat field 22), or null off Linux or once it is gone. */
export function startTime(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // Fields from the third on follow the command name, which may hold spaces and parentheses.
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? null;
  } catch {
    return null;
  }
}

/**
 * Take the person's Codex lock in `home` (CODEX_HOME), waiting while another live process holds it
 * (`onWait` once); resolves with the release. When `env[LOCK_ENV]` names the holder, the caller runs
 * inside that holder's turn (a review from a Codex turn's shell): it goes ahead, and the lock stays the
 * turn's, since waiting would wait on itself (#468 S04-6).
 */
export async function codexLock(home: string, onWait: () => void, env: Record<string, string | undefined> = process.env): Promise<() => void> {
  mkdirSync(home, { recursive: true });
  const dir = join(home, 'citadel-turn.lock');
  for (let waited = false; ; ) {
    try {
      mkdirSync(dir);
      // With its start time: a pid alone can be reused by an unrelated process once the holder died without unlocking (#468 S04-7).
      writeFileSync(join(dir, 'pid'), `${process.pid} ${startTime(process.pid) ?? ''}`.trim());
      return () => rmSync(dir, { recursive: true, force: true });
    } catch (err: any) {
      if (err.code !== 'EEXIST') throw err;
      let held = '';
      try {
        held = readFileSync(join(dir, 'pid'), 'utf8').trim();
      } catch {}
      if (held && held === env[LOCK_ENV]) return () => {};
      const [p, started] = held.split(/\s+/);
      const pid = Number(p) || 0;
      let alive = false;
      try {
        if (pid) process.kill(pid, 0), (alive = true);
      } catch (e: any) {
        alive = e.code === 'EPERM';
      }
      if (alive && started && startTime(pid) !== started) alive = false;
      let age = 0;
      try {
        age = Date.now() - statSync(dir).mtimeMs;
      } catch {
        continue; // its holder just unlocked: try again
      }
      // No pid yet: its holder is between mkdir and write, unless that was a while ago.
      if (!alive && (pid || age > 10_000)) rmSync(dir, { recursive: true, force: true });
      else {
        if (!waited) (waited = true), onWait();
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }
}
