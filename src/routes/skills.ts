// The Skills page's data (#1062): the skills and Grunt types a scheme's turns have, what each is for, and how they ran in
// the last two weeks. Turning a kit skill off is the scheme settings' PATCH (skills_off), like the other Minion rules.
import { KIT_DIR, listSkills, OFF_WARNINGS, offSkills, cachedUsage, refreshUsage, USAGE_DAYS } from '../skills.ts';
import { GLOBAL_OWNER } from '../properties.ts';
import { HttpError, json, type Route } from '../http.ts';

// The list answers at once: usage is whatever report is cached (any age; an old one starts a refresh behind it) or null before
// the first scan has finished, and the page then asks /skills/usage, which waits for that scan. Nothing here waits on a scan
// when a report exists.
function scope(url: URL, app: any, session: any, project: { id: number }) {
  const citadel = !!session && app.store.canSee(session, GLOBAL_OWNER);
  const all = url.searchParams.get('all') === '1';
  if (all && !citadel) throw new HttpError(403, 'Every scheme\'s counts are for the Citadel scheme\'s members');
  return { citadel, all, id: all ? null : project.id };
}
const usageBody = (u: { since: number; skills: object; agents: object } | null) => (u ? { since: u.since, usage: { skills: u.skills, agents: u.agents } } : { since: null, usage: null });

export const skillRoutes: Route[] = [
  {
    // ?all=1: usage across every scheme, for the Citadel scheme's members (the kit's own view).
    method: 'GET', path: '/api/projects/:project/skills', who: ['person', 'taskmaster'],
    async handler({ res, url, app, session, project }) {
      const { citadel, all, id } = scope(url, app, session, project);
      return json(res, 200, {
        items: listSkills(KIT_DIR, project.repo_dir),
        off: offSkills(project),
        warnings: OFF_WARNINGS,
        days: USAGE_DAYS,
        ...usageBody(cachedUsage(app.store, id)),
        all,
        // Who may start a new kit skill (Josh, 2026-11-19: Citadel members only, and the start is the go).
        canKit: citadel,
        kitScheme: GLOBAL_OWNER,
      });
    },
  },
  {
    method: 'GET', path: '/api/projects/:project/skills/usage', who: ['person', 'taskmaster'],
    async handler({ res, url, app, session, project }) {
      const { all, id } = scope(url, app, session, project);
      return json(res, 200, { ...usageBody(cachedUsage(app.store, id) ?? (await refreshUsage(app.store, id))), all });
    },
  },
];
