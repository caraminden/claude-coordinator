// A schedule's request and reply for the /schedules routes (moved out of projects.ts, #1798): its fields from a body, a
// standard audit's part of one, and the view a page or tool reads.
import { APP_NAME } from '../appname.ts';
import { EFFORTS, MODELS, type Project } from '../db.ts';
import { HttpError, oneOf, str, type App } from '../http.ts';
import { describeCron, describeTrigger, loadTemplates, renderTemplate, templateFields, templateVars, type Schedule, type TriggerKind } from '../schedules.ts';
import { pickFor } from '../../public/model-table.js';

/** The refusal when a Taskmaster's create names no model or effort (#698). */
export const MODEL_REQUIRED = (tool: string) => `${tool} needs a model and an effort, picked on purpose from the model table in your prompt by the kind of work (e.g. model: "claude-opus-5-5", effort: "medium"); there is no default.`;

/** A schedule's name, cron, brief and type from a request body: all of them (`all`) or those given. */
export function scheduleFields(app: App, projectId: number, body: any, all: boolean, taskmaster = false, row: Schedule | null = null) {
  const out: { name?: string; cron?: string; brief?: string; type?: string; model?: string | null; effort?: string | null; min_minions?: number | null; gate_scope?: 'scheme' | 'all'; once?: boolean; category?: string; trigger_kind?: TriggerKind | null; trigger_count?: number | null; trigger_gap_hours?: number | null } = {};
  if (all || body.name !== undefined) out.name = str(body.name, 'Name', 80);
  if (all || body.cron !== undefined) out.cron = str(body.cron, 'cron', 100);
  if (all || body.brief !== undefined) out.brief = str(body.brief, 'Brief', 100_000);
  // Each run's minion gets this type; checked against the registry now so a run can't fail on it later.
  if (all || body.type !== undefined) out.type = app.store.props.check(projectId, { type: body.type ?? 'chore' }).type?.[0] ?? 'chore';
  // What each run starts with (#698): always named. The Taskmaster gives both; a person's create without them gets the table's pick for the type.
  if (taskmaster && all && (body.model == null || body.effort == null)) throw new HttpError(400, MODEL_REQUIRED('schedule_minion'));
  if (!all && (body.model === null || body.effort === null)) throw new HttpError(400, 'A schedule always names its model and effort: pass one from the model table instead of null');
  const table = all ? pickFor(out.type) : null;
  if (all || body.model !== undefined) out.model = oneOf(body.model ?? table!.model, MODELS, 'Model');
  if (all || body.effort !== undefined) out.effort = oneOf(body.effort ?? table!.effort, EFFORTS, 'Effort');
  // The activity gate and one-offs (#745); left out, a new schedule always runs, in its own scheme, every time.
  if (body.min_minions !== undefined) {
    if (body.min_minions !== null && !(Number.isInteger(body.min_minions) && body.min_minions >= 1 && body.min_minions <= 10_000)) throw new HttpError(400, 'min_minions must be a whole number from 1 to 10000, or null to always run');
    out.min_minions = body.min_minions;
  }
  if (body.gate_scope !== undefined) out.gate_scope = (oneOf(body.gate_scope, ['scheme', 'all'], 'gate_scope') ?? 'scheme') as 'scheme' | 'all';
  if (body.once !== undefined) {
    if (typeof body.once !== 'boolean') throw new HttpError(400, 'once must be true or false');
    out.once = body.once;
  }
  // The activity trigger (#1798): run early after N ships or minions; a null count clears it, kind and gap with it.
  if (body.trigger_kind !== undefined) out.trigger_kind = oneOf(body.trigger_kind, ['ships', 'minions'], 'trigger_kind') as TriggerKind | null;
  if (body.trigger_count !== undefined) {
    if (body.trigger_count !== null && !(Number.isInteger(body.trigger_count) && body.trigger_count >= 1 && body.trigger_count <= 100_000)) throw new HttpError(400, 'trigger_count must be a whole number from 1 to 100000, or null for no trigger');
    out.trigger_count = body.trigger_count;
  }
  if (body.trigger_gap_hours !== undefined) {
    if (body.trigger_gap_hours !== null && !(Number.isInteger(body.trigger_gap_hours) && body.trigger_gap_hours >= 1 && body.trigger_gap_hours <= 720)) throw new HttpError(400, 'trigger_gap_hours must be a whole number of hours from 1 to 720, or null for a day');
    out.trigger_gap_hours = body.trigger_gap_hours;
  }
  const count = out.trigger_count !== undefined ? out.trigger_count : row?.trigger_count ?? null;
  if (count != null && !(out.trigger_kind !== undefined ? out.trigger_kind : row?.trigger_kind)) throw new HttpError(400, 'A trigger needs trigger_kind: ships (to main) or minions (made)');
  // Its group on the Schedules page (#1083); '' is Other, and left out of a create it is guessed from the name.
  if (body.category !== undefined && body.category !== null) {
    if (typeof body.category !== 'string') throw new HttpError(400, 'category must be text');
    out.category = body.category.trim().replace(/\s+/g, ' ');
    if (out.category.length > 40) throw new HttpError(400, `category is too long: ${out.category.length} characters, at most 40`);
  }
  return out;
}

/**
 * A standard audit's part of a schedule request (#799). `template` (a kit/schedules slug) attaches the row to it: its name,
 * time, type, model, effort and gate fill whatever the body leaves out, and its brief is the template plus `notes`. Notes
 * alone re-render a templated row's brief. Returns the body to read with scheduleFields, and the template and notes to store.
 */
export function scheduleTemplate(app: App, project: Pick<Project, 'id' | 'name'>, body: any, row: Schedule | null): { body: any; extra: { template?: string; notes?: string; brief?: string } } {
  if (body.template === undefined && body.notes === undefined) return { body, extra: {} };
  if (body.template === null) throw new HttpError(400, 'To make a standard audit a custom copy, send its whole brief instead');
  if (body.brief !== undefined) throw new HttpError(400, "A standard audit's brief is its kit template plus the scheme's notes: send notes, or a brief alone to make it a custom copy");
  if (body.notes !== undefined && body.notes !== null && typeof body.notes !== 'string') throw new HttpError(400, 'notes must be text');
  const notes = body.notes == null ? undefined : String(body.notes).trim();
  if (notes !== undefined && notes.length > 10_000) throw new HttpError(400, `notes are too long: ${notes.length.toLocaleString('en')} characters, at most 10,000`);
  const slug = body.template === undefined ? row?.template : body.template;
  if (!slug) throw new HttpError(400, 'notes go with a standard audit: pass template too');
  const all = loadTemplates();
  const t = typeof slug === 'string' ? all.get(slug) : undefined;
  if (!t) throw new HttpError(400, `There is no standard audit "${String(slug).slice(0, 40)}": the kit has ${[...all.keys()].join(', ')}`);
  const twin = app.store.schedules.list(project.id).find((x) => x.template === t.slug && x.id !== row?.id);
  if (twin) throw new HttpError(409, `${project.name} already has the standard ${t.name} (kit/schedules/${t.slug}.md): schedule ${twin.id} ("${twin.name}"). Update that one instead.`);
  const vars = templateVars(app.store, app.dataDir, project.id);
  const kept = notes ?? (row?.template === t.slug ? row.notes : '');
  if (body.template === undefined) return { body, extra: { notes: kept, brief: renderTemplate(t, kept, vars) } };
  const { template, notes: n, brief, ...fields } = templateFields(t, project, kept, vars);
  // Attaching an existing row keeps its pause and last run; the template's fields replace its own unless the body names them.
  return { body: { ...fields, brief, ...Object.fromEntries(Object.entries(body).filter(([k]) => k !== 'template' && k !== 'notes')) }, extra: { template, notes: n } };
}

/** A schedule for the API: its cron in words and its last run's minion number. */
export function scheduleView(app: App, s: Schedule) {
  // What each run found and cost is read from the minion and the turns by id, never copied (H1, #1057).
  const run = (id: number | null) => {
    const t = id ? app.store.getTicket(id) : null;
    return t ? { number: t.number, state: t.state, status: t.status, note: t.note, cost: app.store.ticketCost(t.id) } : null;
  };
  const last = run(s.last_ticket_id);
  // A standard audit's run renders its kit template fresh, so its page shows that text, not the copy from its last run (#1083).
  const t = s.template ? loadTemplates().get(s.template) : null;
  const brief = t ? renderTemplate(t, s.notes, templateVars(app.store, app.dataDir, s.project_id)) : s.brief;
  const runs = app.store.schedules.runs(s.id).map((r) => ({ at: r.at, skip: r.skip, ...(run(r.ticket_id) ?? {}) }));
  return {
    ...s, brief, when: describeCron(s.cron), last_number: last?.number ?? null, last_state: last?.state ?? null, last_status: last?.status ?? null,
    last_note: last?.note ?? null, last_cost: last?.cost ?? null, runs, skips14: app.store.schedules.skipsSince(s.id, Date.now() - 14 * 864e5),
    // Its trigger's count since the last real run (#1798), what the hourly check compares with trigger_count.
    trigger_text: describeTrigger(s), trigger_so_far: s.trigger_count == null ? null : s.trigger_kind === 'ships' ? app.store.schedules.shipsSince(s) : app.store.schedules.minionsSince(s, APP_NAME),
  };
}
