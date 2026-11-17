// The standard audits' one-off backfill (#799): the schemes' hand-made copies of the four audits become rows that
// follow kit/schedules/, and each scheme gets the audits its repo has evidence for (code, tests, copies). Runs once.
import type { Store } from './db.ts';
import { loadTemplates, templateFields, templateVars, type ScheduleTemplate } from './schedules.ts';

/** The setting that says the backfill ran, so a row someone deletes later is never added back. */
export const BACKFILL_KEY = 'standard_audits_backfill';

/** Names the hand-made copies went by, per template. */
const COPY_NAMES: Record<string, string[]> = {
  'code-health': ['Code health'],
  'test-audit': ['Test audit'],
  'monthly-retro': ['Monthly retro'],
  'upstream-check': ['Upstream skills check', 'Monthly upstream check', 'Upstream check', 'Upstream check of copied skills'],
};

const DELVE_GO = "In Delve every merge into main waits for a person's go.";
const THREADSPACE_ROUTE = "Threadspace's landing route for scheme files: branch from `origin/main` after a fetch, one PR, self-reviewed, and the merge waits for Josh's Allow card. Never push to `vault-sync`.";
const PEEK_KEEP = 'Never cut tools/compliance-check.sh or its tests. Windows-only crates are judged by reading, not by a build here.';

/**
 * Which audits each scheme gets and its notes, by the evidence in its repo (16 Nov 2026): Threadspace is a notes vault
 * with no code or tests; TWIReader, VoiceAnalyzer and TripPresenter are fresh scaffolds still in setup, so their setup
 * plans pick theirs. Each scheme's notes keep what its hand-made copy said beyond the template.
 */
export const STANDARD_AUDITS: Record<string, Partial<Record<string, string>>> = {
  Delve: {
    'code-health': DELVE_GO,
    'test-audit': DELVE_GO,
    'monthly-retro': DELVE_GO,
    'upstream-check': `${DELVE_GO} So with only ignores, open no PR just for Checked bumps: note them in the run's last message, and the next PR that lands a take bumps the Checked column for every row. Tell Delve's Taskmaster about any take or alarm in one line, with the handoff's path.`,
  },
  Citadel: {
    'code-health': 'Split the Grunts by server (src/), front end (public/) and tests (test/). The long files are src/runner.ts, src/db.ts, src/mcp.ts and public/thread.js: judge them by what a split would buy, not their length alone.',
    'test-audit': 'Name the report reports/test-audit-citadel-<YYYY-MM>.md.',
    'monthly-retro': "Kit, tripwire and prompt fixes are Citadel's own: land them here directly, no handoff relay.",
    'upstream-check': "Quarterly, on the runs in January, April, July and October: also run citadel:skills-survey as a light, stack-agnostic re-survey of skills.sh's top 50, scoped to entries new since the newest reports/skills-survey-*.md in the shared folder. Only new entries worth using or mining count as something to report; write them up as that skill says.",
  },
  'Peek Auras': {
    'code-health': PEEK_KEEP,
    'test-audit': PEEK_KEEP,
    'monthly-retro': '',
    'upstream-check': '',
  },
  Threadspace: {
    'monthly-retro': THREADSPACE_ROUTE,
    'upstream-check': `${THREADSPACE_ROUTE} If THIRD_PARTY.md isn't on origin/main yet, say so in one line and stop.`,
  },
  Mandate: {
    'code-health': '',
    'test-audit': '',
    'monthly-retro': '',
    'upstream-check': 'Report only, and take nothing, Checked bumps included: for a change worth taking, write a short handoff and tell the Taskmaster its path.',
  },
  'Theory of Crafting': {
    'code-health': '',
    'test-audit': "The suites are vitest and pytest; take per-file times from the desktop CI's logs or a `gh workflow run`, never a full run on perigee. Hold new tests to the scheme's testing skill's habit rules.",
    'monthly-retro': '',
    'upstream-check': 'Also say whether the TypeScript (7.0.2) and pyright (1.1.414) versions pinned in tools/plugins/lsp have newer releases worth taking. Report only: change nothing, Checked bumps included.',
  },
  'The Trans Agenda': {
    'code-health': '',
    'test-audit': '',
    'monthly-retro': '',
    'upstream-check': "Wait for Cara's pick before changing anything, Checked bumps included.",
  },
  FuckSpamTexts: { 'code-health': '', 'test-audit': '', 'monthly-retro': '', 'upstream-check': '' },
  'Genesis Tree': {
    'code-health': 'Never push.',
    'test-audit': 'Never push.',
    'monthly-retro': 'Never push.',
    'upstream-check': 'The pins are in `.claude/THIRD_PARTY.md` and the "## Copies" table in onboarding.md. Report only what is worth taking, and change nothing, Checked bumps included. Never push.',
  },
};

/**
 * Once per database: rewire each listed scheme's hand-made copy (matched by name, still custom) to its template, keeping
 * its last run and pause, or add the row when the scheme has none. A scheme not on this database is skipped. Returns
 * one line per change, for the deploy's notes.
 */
export function backfillStandardAudits(store: Store, dataDir: string, templates: Map<string, ScheduleTemplate> = loadTemplates(), now = Date.now()): string[] {
  if (store.getSetting(BACKFILL_KEY)) return [];
  const done: string[] = [];
  for (const p of store.listProjects()) {
    const picks = STANDARD_AUDITS[p.name];
    if (!picks) continue;
    const rows = store.schedules.list(p.id);
    const vars = templateVars(store, dataDir, p.id);
    for (const [slug, notes = ''] of Object.entries(picks)) {
      const t = templates.get(slug);
      if (!t) throw new Error(`kit/schedules/${slug}.md is missing`);
      if (rows.some((s) => s.template === slug)) continue;
      const fields = templateFields(t, p, notes, vars);
      const copy = rows.find((s) => !s.template && COPY_NAMES[slug].includes(s.name));
      if (copy) {
        store.schedules.update(copy.id, fields, now);
        done.push(`${p.name}: "${copy.name}" now follows kit/schedules/${slug}.md (${fields.cron})`);
      } else {
        const owner = p.owner_id == null ? undefined : store.getUser(p.owner_id);
        store.schedules.create({ project_id: p.id, ...fields, created_by: owner?.name ?? 'Citadel' }, now);
        done.push(`${p.name}: added "${t.name}" (${fields.cron})`);
      }
    }
  }
  store.setSetting(BACKFILL_KEY, now);
  return done;
}

/**
 * The weekly app turns check (kit/schedules/app-turns.md) for a scheme home to an app (Cara, 2026-11-16: "automatically
 * add this turn audit and the audit of the audit to new schemes when they add a contraption"). Once per scheme, so a
 * check someone deletes stays deleted; a scheme that already has one is left alone. Returns a line when it added one.
 */
export function addAppTurnsCheck(store: Store, dataDir: string, projectId: number, templates: Map<string, ScheduleTemplate> = loadTemplates(), now = Date.now()): string | null {
  const key = `app_turns_check:${projectId}`;
  const p = store.getProject(projectId);
  if (!p || store.getSetting(key)) return null;
  store.setSetting(key, now);
  if (store.schedules.list(p.id).some((s) => s.template === 'app-turns')) return null;
  const t = templates.get('app-turns');
  if (!t) throw new Error('kit/schedules/app-turns.md is missing');
  const owner = p.owner_id == null ? undefined : store.getUser(p.owner_id);
  const fields = templateFields(t, p, '', templateVars(store, dataDir, p.id));
  store.schedules.create({ project_id: p.id, ...fields, created_by: owner?.name ?? 'Citadel' }, now);
  return `${p.name}: added "${t.name}" (${fields.cron})`;
}

/** At boot: every scheme already home to an app gets its check (once each, as above). */
export function addAppTurnsChecks(store: Store, dataDir: string): string[] {
  const homes = new Set(store.listContraptions().map((c) => c.home_scheme).filter((id): id is number => id !== null));
  return [...homes].map((id) => addAppTurnsCheck(store, dataDir, id)).filter((l): l is string => !!l);
}
