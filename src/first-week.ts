// The first-week check (#1101): when a scheme's setup reaches done, one run in that scheme seven days later looks at
// what its minions did that week and writes down any setup follow-ups. Every scheme gets it; it rides the schedules
// system as a once-only row, not a new mechanism.
import type { Store } from './db.ts';

export const FIRST_WEEK_NAME = 'First-week check';

export const FIRST_WEEK_BRIEF = `This scheme's setup finished a week ago. Look at what its first week of work left behind, and write it down. One turn, no cards unless you find something a person must decide.

1. List the minions made since setup finished (list_tickets, this scheme only). Pick out those whose work only added setup-type things: an icon or manifest, a deploy, CI, land.sh or the push guard, Project facts, skills, rules, agents, or keys.
2. Open $COORDINATOR_SHARED_DIR/onboarding.md and append a "## First week" section (add it once; if one is there, add a dated sub-heading under it instead). List each such minion as "#N title: what it added", then one line on what that says: setup missed it, or it was new work.
3. If the same follow-up is one a kit or prompt change would have prevented (the interview didn't ask, the setup skill skipped a step, a kit file went stale), send Citadel's Taskmaster ONE message with relay_when_live (to: "Citadel", commit: the hash `git rev-parse main` prints, so it goes out at once), naming those gaps and citing the minions by #N. If nothing looks kit-level, send nothing.
4. If there are no setup-type minions at all, append a one-line "## First week: nothing needed fixing" and stop.

Change no repo files and start no minions.`;

/** Schedule the check for a scheme whose setup just reached done; once only, and not twice for one scheme. */
export function scheduleFirstWeek(store: Store, projectId: number, now = Date.now()) {
  if (store.schedules.list(projectId).some((s) => s.name === FIRST_WEEK_NAME)) return null;
  const project = store.getProject(projectId);
  if (!project) return null;
  const when = new Date(now + 7 * 86_400_000);
  // Minute hour day-of-month month *: the server's local time, 09:00 on the seventh day; `once` removes it after the run.
  const cron = `0 9 ${when.getDate()} ${when.getMonth() + 1} *`;
  const owner = project.owner_id ? store.getUser(project.owner_id) : null;
  return store.schedules.create(
    { project_id: projectId, name: FIRST_WEEK_NAME, cron, brief: FIRST_WEEK_BRIEF, type: 'chore', model: 'claude-sonnet-5-5', effort: 'medium', created_by: owner?.name ?? 'Citadel', once: true },
    now,
  );
}
