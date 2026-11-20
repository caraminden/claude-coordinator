// A scheme's review set (src/review-set.ts, Build 4): the page's reads and saves, and the MCP tool's.
// Everyone in the scheme reads it; people and the Taskmaster change anything. A minion saves only an entry's body,
// for the critic loop's learning step (citadel:critique step 9): the switches stay a person's call (Q10, Q12).
import { HttpError, json, readJson, type App, type Route } from '../http.ts';
import { BUILT_INS, calibratedText, isKit, loadStarters, nameFor, parseWhen, renderEntry, ReviewError, stageFor, whenText, type EntryFields, type ReviewEntry, type ReviewSet, type Verdict } from '../review-set.ts';
import { describeCron, loadTemplates, templateFields, templateVars } from '../schedules.ts';
import { describePrompt, readProposals, runDescribe } from '../review-describe.ts';
import { turnEnv } from '../turn-launch.ts';
import { join } from 'node:path';
import type { Project, Ticket } from '../db.ts';

/** An entry for the page: a kit built-in's `when` and `what` are the kit's, and its text is only the scheme's additions. */
const view = (e: ReviewEntry, more: { record?: Record_ ; verdicts?: Verdict[] } = {}) => {
  const kit = isKit(e) ? BUILT_INS.find((b) => b.slug === e.slug) : undefined;
  return {
    ...e, kit: !!kit, what: kit?.what ?? null, when: kit?.when ?? (whenText(e.triggers) || 'ask'), text: kit ? e.body : renderEntry(e, { verdicts: more.verdicts }),
    calibrated: e.calibration ? calibratedText(e.calibration) : null,
    // The record (Q4) and people's verdicts (Q13), read-only here: only a minion adds to them.
    runs: more.record?.runs ?? [], rate: more.record?.rate ?? null, firsts: more.record?.firsts ?? 0, stuck: more.record?.stuck ?? null, verdicts: more.verdicts ?? [],
  };
};
type Record_ = ReturnType<ReviewSet['record']> extends Map<number, infer R> ? R : never;
/** One entry as the page shows it, with its record and verdicts. */
function viewOne(app: App, project: Project, e: ReviewEntry) {
  return view(e, { record: app.store.reviews.record(project.id).get(e.id), verdicts: app.store.reviews.verdicts(project.id).get(e.id) });
}
/** The minion as the record names it: #N, or the Taskmaster. */
const minionName = (caller: Ticket) => (caller.kind === 'coordinator' ? 'Taskmaster' : caller.number != null ? `#${caller.number}` : caller.title);

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
    if (err instanceof ReviewError) throw new HttpError(/^stale:|already has/.test(err.message) ? 409 : /^No (entry|verdict)|has no version/.test(err.message) ? 404 : 400, err.message.replace(/^stale: /, ''));
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
  if (body.panel !== undefined) {
    if (body.panel !== null && typeof body.panel !== 'string') throw new HttpError(400, 'panel is text, or empty for none');
    f.panel = body.panel?.trim() || null;
  }
  if (body.on_fail !== undefined) f.on_fail = Array.isArray(body.on_fail) && !body.on_fail.length ? null : body.on_fail;
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
  if (keys.length === 1 && f.panel !== undefined) return f.panel ? `On panel ${f.panel}` : 'Off its panel';
  if (keys.length === 1 && f.on_fail !== undefined) return 'Hand-offs on a fail set';
  return 'Edited by hand';
}

export const reviewRoutes: Route[] = [
  {
    method: 'GET', path: '/api/projects/:project/reviews', who: ['person', 'taskmaster', 'minion'],
    handler({ res, app, project }) {
      app.store.reviews.ensureBuiltIns(project.id);
      const record = app.store.reviews.record(project.id);
      const verdicts = app.store.reviews.verdicts(project.id);
      return json(res, 200, { entries: app.store.reviews.list(project.id).map((e) => view(e, { record: record.get(e.id), verdicts: verdicts.get(e.id) })), starters: loadStarters(), audits: audits(app, project), label: app.store.reviews.labelGiver(project.id) });
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
      app.store.reviews.ensureBuiltIns(project.id);
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
      return json(res, 201, viewOne(app, project, e));
    },
  },
  {
    // Describe a change (Q11): a one-shot agent on the asker's own Claude login proposes edits; Apply is an ordinary save.
    method: 'POST', path: '/api/projects/:project/reviews/describe', who: ['person'], refuse: 'Only a person describes a change here, on their own Claude login',
    async handler({ req, res, app, session, project }) {
      const { text } = (await readJson(req)) ?? {};
      if (typeof text !== 'string' || !text.trim() || text.length > 2000) throw new HttpError(400, 'Describe the change in 1 to 2,000 characters');
      const place = app.claude.place(session.uid);
      if (!place) throw new HttpError(409, "Your Claude plan isn't linked (Settings → Your account), so there's no login of yours to run the agent on");
      app.store.reviews.ensureBuiltIns(project.id);
      const entries = app.store.reviews.list(project.id);
      let reply: string;
      try {
        reply = await runDescribe(place, describePrompt(text.trim(), entries), { claudeBin: process.env.CLAUDE_BIN ?? 'claude', hostEnv: turnEnv(process.env), cwd: join(app.claude.turnsDir(session.uid), 'review-describe') });
        return json(res, 200, readProposals(reply, entries));
      } catch (err: any) {
        throw new HttpError(502, err.message);
      }
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
        return json(res, 200, viewOne(app, project, e));
      }
      const was = app.store.reviews.get(project.id, slug);
      // A person taking an entry off trial marks it good (Q12): the record says who vouched for it instead of a run's counts.
      if (f.trial === false && was?.trial) f.calibration = { at: Date.now(), by: session.name, good: true };
      const note = typeof body.note === 'string' && body.note.trim() ? body.note.trim().slice(0, 200) : noteFor(f);
      const e = run(() => app.store.reviews.save(project.id, slug, f, session.name, note, body.version));
      broadcast(app, project);
      return json(res, 200, viewOne(app, project, e));
    },
  },
  {
    // Run order (Q7): one place up or down within its column.
    method: 'POST', path: '/api/projects/:project/reviews/:slug/move', who: ['person', 'taskmaster'], refuse: 'Only people and Taskmasters set the run order',
    async handler({ req, res, app, session, project, params }) {
      const { dir } = (await readJson(req)) ?? {};
      if (dir !== 'up' && dir !== 'down') throw new HttpError(400, 'dir is up or down');
      app.store.reviews.ensureBuiltIns(project.id);
      const e = run(() => app.store.reviews.move(project.id, decodeURIComponent(params.slug), dir, session.name));
      broadcast(app, project);
      return json(res, 200, viewOne(app, project, e));
    },
  },
  {
    // The run record (Q4): a minion records each round of a critic or reviewer it ran, with its verdict.
    method: 'POST', path: '/api/projects/:project/reviews/:slug/runs', who: ['minion', 'taskmaster'], refuse: 'Only the minion that ran it records a run',
    async handler({ req, res, app, caller, project, params }) {
      const { round, verdict } = (await readJson(req)) ?? {};
      app.store.reviews.ensureBuiltIns(project.id);
      const r = run(() => app.store.reviews.recordRun(project.id, decodeURIComponent(params.slug), { ticketId: caller!.kind === 'coordinator' ? null : caller!.id, minion: minionName(caller!), round, verdict }));
      broadcast(app, project);
      return json(res, 201, r);
    },
  },
  {
    // A person's disagreement with a verdict (Q13, Josh: "Only the minion records it"): no button or Add box for people.
    method: 'POST', path: '/api/projects/:project/reviews/:slug/verdicts', who: ['minion', 'taskmaster'], refuse: "Only a minion records a verdict, when a person disagrees with a critic in its chat",
    async handler({ req, res, app, caller, project, params }) {
      const { person, words } = (await readJson(req)) ?? {};
      app.store.reviews.ensureBuiltIns(project.id);
      const v = run(() => app.store.reviews.recordVerdict(project.id, decodeURIComponent(params.slug), { person, words, ticketId: caller!.kind === 'coordinator' ? null : caller!.id, minion: minionName(caller!) }));
      broadcast(app, project);
      return json(res, 201, v);
    },
  },
  {
    // Edit by hand can remove a recorded verdict.
    method: 'DELETE', path: '/api/projects/:project/reviews/:slug/verdicts/:id', who: ['person', 'taskmaster'], refuse: 'Only people and Taskmasters remove a recorded verdict',
    handler({ res, app, project, params }) {
      const id = Number(params.id);
      if (!Number.isInteger(id)) throw new HttpError(400, 'Name the verdict by its number');
      run(() => app.store.reviews.removeVerdict(project.id, decodeURIComponent(params.slug), id));
      broadcast(app, project);
      return json(res, 200, { ok: true });
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
      return json(res, 200, viewOne(app, project, e));
    },
  },
];
