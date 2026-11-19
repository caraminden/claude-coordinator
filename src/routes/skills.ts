// The Skills page's data (#1062): the skills and Grunt types a scheme's turns have, what each is for, and how they ran in
// the last two weeks. Turning a kit skill off is the scheme settings' PATCH (skills_off), like the other Minion rules.
import { KIT_DIR, listSkills, OFF_WARNINGS, offSkills, skillUsage, USAGE_DAYS } from '../skills.ts';
import { GLOBAL_OWNER } from '../properties.ts';
import { HttpError, json, type Route } from '../http.ts';

export const skillRoutes: Route[] = [
  {
    // ?all=1: usage across every scheme, for the Citadel scheme's members (the kit's own view).
    method: 'GET', path: '/api/projects/:project/skills', who: ['person', 'taskmaster'],
    handler({ res, url, app, session, project }) {
      const citadel = !!session && app.store.canSee(session, GLOBAL_OWNER);
      const all = url.searchParams.get('all') === '1';
      if (all && !citadel) throw new HttpError(403, 'Every scheme\'s counts are for the Citadel scheme\'s members');
      const usage = skillUsage(app.store, all ? null : project.id);
      return json(res, 200, {
        items: listSkills(KIT_DIR, project.repo_dir),
        off: offSkills(project),
        warnings: OFF_WARNINGS,
        days: USAGE_DAYS,
        since: usage.since,
        usage: { skills: usage.skills, agents: usage.agents },
        all,
        // Who may start a new kit skill (Josh, 2026-11-19: Citadel members only, and the start is the go).
        canKit: citadel,
        kitScheme: GLOBAL_OWNER,
      });
    },
  },
];
