// A scheme's review set (src/review-set.ts, Build 4): the page's reads and saves, and the MCP tool's.
// Everyone in the scheme reads it; people and the Taskmaster change anything. A minion saves only an entry's body,
// for the critic loop's learning step (citadel:critique step 9): the switches stay a person's call (Q10, Q12).
import { HttpError, json, readJson, type App, type Route } from '../http.ts';
import { BUILT_INS, calibratedText, isKit, loadStarters, nameFor, parseWhen, renderEntry, ReviewError, stageFor, whenText, type EntryFields, type ReviewEntry } from '../review-set.ts';
import { describeCron, loadTemplates, templateFields, templateVars } from '../schedules.ts';
import type { Project } from '../db.ts';

/** An entry for the page: a kit built-in's `when` and `what` are the kit's, and its text is only the scheme's additions. */
const view = (e: ReviewEntry) => {
  const kit = isKit(e) ? BUILT_INS.find((b) => b.slug === e.slug) : undefined;
  return {
    ...e, kit: !!kit, what: kit?.what ?? null, when: kit?.when ?? (whenText(e.triggers) || 'ask'), text: kit ? e.body : renderEntry(e),
    calibrated: e.calibration ? calibratedText(e.calibration) : null,
  };
};

/** The kit's standard audits (kit/schedules/) as the page shows them: switched by the scheme's schedule row, its one source of truth. */
function audits(app: App, project: Project) {
  const rows = app.store.schedules.list(project.id);
  return [...loadTemplates().values()].map((t) => {
    const row = rows.find((s) => s.template === t.slug);
    return { slug: t.slug, name: t.name, applies: t.applies, schedule: row?.id ?? null, on: !!row && !row.paused, when: describeCron(row?.cron ?? t.cron) };
  });
}

/** A ReviewError is the request's fault: 409 for a stale save or a taken slug, 404 for a missing entry, 400 for the rest. */
function run<T>(f: () => T): T {
  try {
    return f();
  } catch (err) {
    if (err instanceof ReviewError) throw new HttpError(/^stale:|already has/.test(err.message) ? 409 : /^No entry|has no version/.test(err.message) ? 404 : 400, err.message.replace(/^stale: /, ''));
    throw err;
  }
}

/** The fields a request may set, from its body: `when` as the rubric format writes it, or `triggers` whole. */
function fieldsFrom(body: Record<string, any>): Partial<EntryFields> {
  const f: Partial<EntryFields> = {};
  for (const k of ['slug', 'name', 'kind', 'body', 'stage', 'gate', 'extends', 'model', 'effort'] as const) {
    if (body[k] === undefined) continue;
    if (body[k] !== null && typeof body[k] !== 'string') throw new HttpError(400, `${k} is text`);
    (f as any)[k] = ['gate', 'extends', 'model', 'effort'].includes(k) ? body[k] || null : body[k];
  }
  for (const k of ['enabled', 'trial', 'gives_label'] as const) {
    if (body[k] === undefined) continue;
    if (typeof body[k] !== 'boolean') throw new HttpError(400, `${k} is true or false`);
    f[k] = body[k];
  }
  if (body.position !== undefined) f.position = body.position;
  if (body.context !== undefined) f.context = body.context;
  if (body.triggers !== undefined) f.triggers = body.triggers;
  else if (body.when !== undefined) {
    if (typeof body.when !== 'string') throw new HttpError(400, 'when is text, like "diff: public/**"');
    f.triggers = run(() => parseWhen(body.when));
  }
  return f;
}

const broadcast = (app: App, project: Project) => app.broadcast({ type: 'reviews', projectId: project.id });

/** What a save changed, for History: "Turned off", "Edited by hand". */
function noteFor(f: Partial<EntryFields>): string {
  const keys = Object.keys(f);
  if (keys.length === 1 && f.enabled !== undefined) return f.enabled ? 'Turned on' : 'Turned off';
  if (f.trial !== undefined && keys.every((k) => k === 'trial' || k === 'calibration')) return f.trial ? 'Put on trial' : 'Marked good';
  if (keys.length === 1 && f.gate !== undefined) return f.gate === 'block' ? 'Set to block the ship' : 'Set to advise';
  if (keys.length === 1 && f.gives_label !== undefined) return f.gives_label ? 'Gives the risk label' : 'No longer gives the risk label';
  return 'Edited by hand';
}

export const reviewRoutes: Route[] = [
  {
    method: 'GET', path: '/api/projects/:project/reviews', who: ['person', 'taskmaster', 'minion'],
    handler({ res, app, project }) {
      app.store.reviews.ensureBuiltIns(project.id);
      return json(res, 200, { entries: app.store.reviews.list(project.id).map(view), starters: loadStarters(), audits: audits(app, project), label: app.store.reviews.labelGiver(project.id) });
    },
  },
  {
    // A standard audit's switch: pauses or resumes the scheme's schedule for it, adding one from the kit template the first time.
    method: 'POST', path: '/api/projects/:project/reviews/audits/:template', who: ['person', 'taskmaster'], refuse: 'Only people and Taskmasters switch audits',
    async handler({ req, res, app, session, project, params }) {
      const { enabled } = (await readJson(req)) ?? {};
      if (typeof enabled !== 'boolean') throw new HttpError(400, 'enabled is true or false');
      const t = loadTemplates().get(params.template);
      if (!t) throw new HttpError(404, `The kit has no standard audit named ${params.template}`);
      const row = app.store.schedules.list(project.id).find((s) => s.template === t.slug);
      if (row) app.store.schedules.update(row.id, { paused: !enabled });
      else if (enabled) app.store.schedules.create({ project_id: project.id, ...templateFields(t, project, '', templateVars(app.store, app.dataDir, project.id)), created_by: session.name });
      app.broadcast({ type: 'schedules', projectId: project.id });
      broadcast(app, project);
      return json(res, 200, audits(app, project).find((a) => a.slug === t.slug));
    },
  },
  {
    // New: blank, or on top of a kit starter (`extends`), and always on trial first (Q12).
    method: 'POST', path: '/api/projects/:project/reviews', who: ['person', 'taskmaster'], refuse: 'Only people and Taskmasters add reviewers and critics; ask your Taskmaster',
    async handler({ req, res, app, session, project }) {
      const body = await readJson(req);
      const f = fieldsFrom(body);
      const starter = f.extends ? loadStarters().find((s) => s.slug === f.extends) : null;
      if (f.extends && !starter) throw new HttpError(400, `The kit has no starter named ${f.extends}`);
      const slug = f.slug ?? starter?.slug;
      if (!slug) throw new HttpError(400, 'Give it a slug, the name its file goes by (kebab-case, like ui-screenshots)');
      let triggers = f.triggers;
      const starterWhen = starter?.text.match(/^when:\s*"?([^"\n]*)"?$/m)?.[1];
      if (!triggers && starterWhen && starterWhen !== 'set by the extending rubric') triggers = run(() => parseWhen(starterWhen));
      const e = run(() => app.store.reviews.create(project.id, { ...f, slug, name: f.name ?? nameFor(slug), triggers: triggers ?? {}, stage: f.stage ?? stageFor(triggers ?? {}), trial: true }, session.name));
      broadcast(app, project);
      return json(res, 201, view(e));
    },
  },
  {
    // A save, as a new version. `version` is the one the editor started from; a save over a newer one is a 409.
    method: 'PATCH', path: '/api/projects/:project/reviews/:slug', who: ['person', 'taskmaster', 'minion'],
    async handler({ req, res, app, session, caller, project, params }) {
      const body = await readJson(req);
      const f = fieldsFrom(body);
      const slug = decodeURIComponent(params.slug);
      if (caller && caller.kind !== 'coordinator' && Object.keys(f).some((k) => k !== 'body')) {
        throw new HttpError(403, "A minion saves only an entry's body (what it learned) and a calibration run's counts; switches, triggers and names are for people and the Taskmaster");
      }
      if (body.version !== undefined && !Number.isInteger(body.version)) throw new HttpError(400, 'version is the whole number you started from');
      app.store.reviews.ensureBuiltIns(project.id);
      if (body.calibration !== undefined) {
        // A calibration run's counts (citadel:critique, references/calibrate.md); the store decides whether it comes off trial.
        if (Object.keys(f).length) throw new HttpError(400, 'Send a calibration on its own, not with other changes');
        const c = body.calibration;
        if (!c || typeof c !== 'object') throw new HttpError(400, 'calibration is {hits, notes, false_alarms, controls, model}');
        const e = run(() => app.store.reviews.calibrate(project.id, slug, c, session.name));
        broadcast(app, project);
        return json(res, 200, view(e));
      }
      const was = app.store.reviews.get(project.id, slug);
      // A person taking an entry off trial marks it good (Q12): the record says who vouched for it instead of a run's counts.
      if (f.trial === false && was?.trial) f.calibration = { at: Date.now(), by: session.name, good: true };
      const note = typeof body.note === 'string' && body.note.trim() ? body.note.trim().slice(0, 200) : noteFor(f);
      const e = run(() => app.store.reviews.save(project.id, slug, f, session.name, note, body.version));
      broadcast(app, project);
      return json(res, 200, view(e));
    },
  },
  {
    method: 'GET', path: '/api/projects/:project/reviews/:slug/versions', who: ['person', 'taskmaster', 'minion'],
    handler: ({ res, app, project, params }) => json(res, 200, { versions: run(() => app.store.reviews.versions(project.id, decodeURIComponent(params.slug))) }),
  },
  {
    method: 'POST', path: '/api/projects/:project/reviews/:slug/restore', who: ['person', 'taskmaster'], refuse: 'Only people and Taskmasters restore a version',
    async handler({ req, res, app, session, project, params }) {
      const { version } = await readJson(req);
      if (!Number.isInteger(version)) throw new HttpError(400, 'Name the version to restore');
      const e = run(() => app.store.reviews.restore(project.id, decodeURIComponent(params.slug), version, session.name));
      broadcast(app, project);
      return json(res, 200, view(e));
    },
  },
];
