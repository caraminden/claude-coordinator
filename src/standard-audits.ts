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
    'monthly-retro': "Kit, tripwire and prompt fixes are Citadel's own: ship them here directly, no handoff relay.",
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
 * Add a scheme's row for one kit template, once per scheme (the setting `key`), so a row someone deletes stays deleted;
 * a scheme that already has one is left alone. Returns a line when it added one.
 */
function addOnce(store: Store, dataDir: string, projectId: number, slug: string, key: string, templates: Map<string, ScheduleTemplate>, now: number): string | null {
  const p = store.getProject(projectId);
  if (!p || store.getSetting(key)) return null;
  const t = templates.get(slug);
  // Not a throw: the caller has already saved what triggered it. The flag stays unset, so the next boot tries again.
  if (!t) {
    console.error(`kit/schedules/${slug}.md is missing: no "${slug}" schedule added`);
    return null;
  }
  const has = store.schedules.list(p.id).some((s) => s.template === slug);
  const owner = p.owner_id == null ? undefined : store.getUser(p.owner_id);
  const fields = templateFields(t, p, '', templateVars(store, dataDir, p.id));
  if (!has) store.schedules.create({ project_id: p.id, ...fields, created_by: owner?.name ?? 'Citadel' }, now);
  store.setSetting(key, now);
  if (has) return null;
  return `${p.name}: added "${t.name}" (${fields.cron})`;
}

/**
 * The weekly app turns check (kit/schedules/app-turns.md) for a scheme home to an app (Cara, 2026-11-16: "automatically
 * add this turn audit and the audit of the audit to new schemes when they add a contraption").
 */
export const addAppTurnsCheck = (store: Store, dataDir: string, projectId: number, templates: Map<string, ScheduleTemplate> = loadTemplates(), now = Date.now()) =>
  addOnce(store, dataDir, projectId, 'app-turns', `app_turns_check:${projectId}`, templates, now);

/** The weekly memory curator (kit/schedules/memory-curator.md, #1111) for a scheme: every scheme gets one (Josh, 2026-11-19, "Every scheme, quiet skip"). */
export const addMemoryCurator = (store: Store, dataDir: string, projectId: number, templates: Map<string, ScheduleTemplate> = loadTemplates(), now = Date.now()) =>
  addOnce(store, dataDir, projectId, 'memory-curator', `memory_curator:${projectId}`, templates, now);

/** At boot: every scheme gets its memory curator (once each, as above). */
export function addMemoryCurators(store: Store, dataDir: string): string[] {
  const templates = loadTemplates();
  return store.listProjects().map((p) => addMemoryCurator(store, dataDir, p.id, templates)).filter((l): l is string => !!l);
}

/** At boot: every scheme already home to an app gets its check (once each, as above). */
export function addAppTurnsChecks(store: Store, dataDir: string): string[] {
  const homes = new Set(store.listContraptions().map((c) => c.home_scheme).filter((id): id is number => id !== null));
  return [...homes].map((id) => addAppTurnsCheck(store, dataDir, id)).filter((l): l is string => !!l);
}

/** One template's state in a scheme (H1, #1057): rows that follow it or are hand-made copies of it, and whether it is missing or was left out on purpose. */
export interface AuditCheck { slug: string; name: string; rows: { id: number; name: string; template: boolean }[]; state: 'ok' | 'missing' | 'duplicate' | 'left-out' }

/**
 * The scheme's rows against the kit's templates. "Left out on purpose" is a template the scheme's entry in STANDARD_AUDITS
 * doesn't list; a scheme with no entry has left nothing out. Two rows for one template (a hand-made copy beside the
 * template row, matched by COPY_NAMES) is a duplicate.
 */
export function checkAudits(store: Store, projectId: number, templates: Map<string, ScheduleTemplate> = loadTemplates()): AuditCheck[] {
  const p = store.getProject(projectId);
  const picks = p ? STANDARD_AUDITS[p.name] : undefined;
  const rows = store.schedules.list(projectId);
  // The app turns check and the memory curator have their own rules (addOnce), so they are not part of this list.
  return [...templates.values()].filter((t) => t.slug in COPY_NAMES).map((t) => {
    const mine = rows
      .filter((s) => s.template === t.slug || (!s.template && COPY_NAMES[t.slug].includes(s.name)))
      .map((s) => ({ id: s.id, name: s.name, template: s.template === t.slug }));
    const state = mine.length > 1 ? 'duplicate' : mine.length ? 'ok' : picks && !(t.slug in picks) ? 'left-out' : 'missing';
    return { slug: t.slug, name: t.name, rows: mine, state };
  });
}
