// The pure text formatters for the MCP tools' answers, split out of mcp.ts: each turns data the server sent into the text a tool returns.
// They hold no state of their own (no env, no API calls).
import { pacificDay } from './pacific.ts';

interface Slice {
  name: string;
  usd: number;
  lastWeek: number;
  estimated: number;
}
interface UsageSplit {
  total: number;
  lastWeek: number;
  weekUsd: number | null;
  accounts?: number;
  models: Slice[];
  schemes: Slice[];
  kinds: Slice[];
  top: { id: number; number: number | null; title: string; scheme: string; usd: number }[];
}
/** usage_split's answer (#905): each slice as a share of the week (all accounts together) with its dollars, against last week. */
export function usageSplitText(w: UsageSplit): string {
  const usd = money;
  const pct = (n: number) => {
    const p = (n / w.weekUsd!) * 100;
    return p && p < 0.1 ? '<0.1' : p < 10 ? p.toFixed(1) : String(Math.round(p));
  };
  const amount = (n: number) => (w.weekUsd ? `${pct(n)}% (${usd(n)})` : usd(n));
  const line = (s: Slice) => `- ${s.name}: ${amount(s.usd)}, last week ${amount(s.lastWeek)}${s.estimated > 0.005 ? `, ${usd(s.estimated)} estimated` : ''}`;
  const fable = (k: 'usd' | 'lastWeek', all: number) => {
    const f = w.models.filter((m) => m.name.startsWith('Fable')).reduce((a: number, m) => a + m[k], 0);
    return all ? `${Math.round((f / all) * 100)}%` : '0%';
  };
  const estimated = w.models.reduce((a: number, m) => a + m.estimated, 0);
  return [
    `Last 7 days: ${amount(w.total)}; the 7 before: ${amount(w.lastWeek)}. ${w.weekUsd ? `100% is the weekly limit of ${w.accounts! > 1 ? `all ${w.accounts} Claude accounts together` : 'the Claude account'}, about ${usd(w.weekUsd)} at API prices.` : 'No weekly meter can price a share yet, so dollars at API prices only.'}`,
    `Fable's share of spend: ${fable('usd', w.total)} this week, ${fable('lastWeek', w.lastWeek)} last week.`,
    'By model:',
    ...w.models.map(line),
    'By scheme:',
    ...w.schemes.map(line),
    'By kind of work:',
    ...w.kinds.map(line),
    'Costliest minions this week:',
    ...w.top.map((m) => `- ${m.number === null ? `ticket ${m.id}` : `#${m.number}`} ${m.title} (${m.scheme}): ${amount(m.usd)}`),
    ...(estimated > 0.005 ? [`${usd(estimated)} of this week is from turns before the split was kept (2026-11-17), counted under each minion's own model.`] : []),
  ].join('\n');
}

export interface MemoryHit {
  kind: string;
  number?: number;
  title?: string;
  ts: number;
  source_kind: string;
  source_id: number | string;
  score: number;
  text: string;
}
export interface PastHit {
  kind?: string;
  name: string;
  mtime: number;
  snippet: string;
  files?: string;
  number: number;
  title: string;
  type?: string;
  closed_at: number;
  status: string;
}
/** search_memory's answer: each hit as a header line and its text, cut so a call stays small. */
export function memoryText(hits: MemoryHit[]): string {
  if (!hits.length) return 'Nothing indexed matches yet.';
  const day = (ms: number) => pacificDay(ms);
  return hits.map((h) => `${h.kind === 'coordinator' ? 'Taskmaster' : `#${h.number} ${h.title}`} · ${day(h.ts)} · ${h.source_kind === 'turn' ? `event ${h.source_id}` : 'title and note'} · score ${h.score}\n${h.text.length > 1200 ? `${h.text.slice(0, 1200)}…` : h.text}`).join('\n\n');
}

/** search_minions' answer: a header line per minion or handoff, then its matching text and the files it wrote. */
export function pastMinionsText(hits: PastHit[]): string {
  if (!hits.length) return 'No closed minion or handoff matches. Fewer words, or another word for it, may find one.';
  const day = pacificDay;
  return hits
    .map((h) => {
      if (h.kind === 'handoff') return `Handoff ${h.name}${h.name.startsWith('shipped/') ? ' (its minion shipped)' : h.name.startsWith('not-picked/') ? ' (not picked)' : ''} · changed ${day(h.mtime)}\n${h.snippet}`;
      const files = h.files ? h.files.split('\n') : [];
      return `#${h.number} ${h.title} · ${h.type || 'no type'} · closed ${day(h.closed_at)}${h.status === 'closed' ? '' : ' (reopened)'}\n${h.snippet.replace(/\s+/g, ' ')}${files.length ? `\nFiles: ${files.slice(0, 12).join(', ')}${files.length > 12 ? ` (+${files.length - 12})` : ''}` : ''}`;
    })
    .join('\n\n');
}

export interface IdeaRow {
  id: number | string;
  title?: string;
  card?: string | number;
  status: string;
  status_manual?: boolean;
  decided_by?: string;
  pick_label?: string;
  pick?: string;
  decided_at: number | null;
  words?: string;
  page_label?: string;
  page?: string;
  source_number?: number;
  handoff?: string;
  minion?: { number: number };
}
interface Place {
  label: string;
  file?: string;
  line?: number;
}
export interface DecisionRow {
  id: string;
  date: string;
  who: string;
  rule: string;
  quote?: string;
  places: Place[];
  reversed?: { by: string; byText: string; stale: Place[] } | null;
  reverses: string[];
}
/** The ideas tool's answer: a count line, then one line per row. */
export function ideasText(r: { ideas: IdeaRow[]; counts: Record<string, number>; total: number; waiting: number[] }, limit: number): string {
  const day = (ms: number | null) => (ms ? pacificDay(ms) : '');
  const head = `${r.total} ideas: ${
    Object.entries(r.counts)
      .filter(([, n]) => n)
      .map(([s, n]) => `${n} ${s}`)
      .join(', ') || 'none yet'
  }. Showing ${Math.min(limit, r.ideas.length)} of ${r.ideas.length}.${r.waiting.length ? ` ${r.waiting.length} at Later over two weeks.` : ''}`;
  const rows = r.ideas
    .slice(0, limit)
    .map((i) =>
      [
        `- [${i.id}] ${i.title || i.card} · ${i.status}${i.status_manual ? ' (by hand)' : ''}`,
        i.decided_by ? ` · ${i.pick_label ?? i.pick ?? 'noted'} (${i.decided_by}, ${day(i.decided_at)}${i.words ? `: "${i.words}"` : ''})` : '',
        i.page_label ? ` · page ${i.page_label}${i.page ? ` card ${i.card}` : ''}` : '',
        i.source_number ? ` · from #${i.source_number}` : '',
        i.handoff ? ` · handoff ${i.handoff}` : '',
        i.minion ? ` · #${i.minion.number}` : '',
      ].join(''),
    );
  return [head, ...rows].join('\n');
}

/** search_decisions' answer: one block per decision, newest or best first, then what each source holds. */
export function decisionsText(r: { decisions: DecisionRow[]; linked?: DecisionRow[]; counts: { label: string; count: number; files: number }[] }, limit: number): string {
  const where = (p: Place) => `${p.label}${p.file && p.file !== p.label ? ` ${p.file}` : ''}${p.line ? `:${p.line}` : ''}`;
  const byId = new Map([...(r.linked ?? []), ...r.decisions].map((d) => [d.id, d]));
  const rows = r.decisions.slice(0, limit).map((d) => {
    const head = `${d.date} · ${d.who} · ${d.rule}${d.quote ? `\n  "${d.quote}"` : ''}`;
    const at = d.places.length ? `\n  Written in: ${d.places.map(where).join('; ')}` : '';
    const by = d.reversed ? byId.get(d.reversed.by) : null;
    const rev = d.reversed ? `\n  REVERSED by ${by ? `${by.date} ${by.who}: ${by.rule}${by.quote ? ` "${by.quote}"` : ''}` : d.reversed.byText}${d.reversed.stale.length ? `. Still written in: ${d.reversed.stale.map(where).join('; ')}` : ''}` : '';
    const revs = d.reverses.length
      ? `\n  Reverses: ${d.reverses
          .map((id: string) => byId.get(id))
          .filter((o): o is DecisionRow => !!o)
          .map((o) => `${o.date} ${o.who} "${o.quote || o.rule}"`)
          .join('; ')}`
      : '';
    return head + at + rev + revs;
  });
  const counts = `Sources: ${r.counts.map((c) => `${c.label} ${c.count} in ${c.files} file${c.files === 1 ? '' : 's'}`).join(', ')}.`;
  return `${rows.length ? rows.join('\n\n') : 'No decision matches.'}${r.decisions.length > limit ? `\n\n(${r.decisions.length - limit} more: narrow the query or raise limit.)` : ''}\n\n${counts}`;
}

/** What contraption_read hands back: a list of read commands, or a command's answer. */
export function readText(app: string, command: string | undefined, r: { status: number; answer: unknown; truncated?: number }): string {
  const body = typeof r.answer === 'string' ? r.answer : JSON.stringify(r.answer);
  const cut = r.truncated ? `\n(Cut at ${r.truncated / 1024} KB: ask for less, if the command can narrow it.)` : '';
  if (command) return `${app} answered ${r.status}${r.status === 404 ? ' (no such read command)' : r.status === 403 ? ' (not a read command, or not allowed)' : ''}: ${body}${cut}`;
  if (r.status === 404) return `${app} offers no read commands: it has no /app-api/read.`;
  if (r.status !== 200 || !Array.isArray(r.answer)) return `${app} answered ${r.status} to the list of read commands: ${body}${cut}`;
  if (!r.answer.length) return `${app} lists no read commands.`;
  return r.answer.map((c: { name?: string; description?: string; input_schema?: unknown } | null) => `- ${c?.name}: ${c?.description ?? ''}${c?.input_schema ? `\n  input: ${JSON.stringify(c.input_schema)}` : ''}`).join('\n') + cut;
}

/** What register_contraption says when it has no icon (#418). */
export const NO_ICON = 'To do: it has no icon, so the rail shows its first letter. Every contraption ships one with a web manifest (the citadel:contraption-ui starter has both): set icon with update_contraption, like /icon.svg, or deploy it and an empty icon is filled from its manifest.';

export interface DeployInfo {
  name: string;
  state: string;
  finished_at?: number | null;
  started_at: number;
  repo: string;
  branch: string;
  by: string;
  from?: string | null;
  to?: string | null;
  todo?: string[];
  said: string[];
  log: string;
  tail?: string;
}
/** A deploy as the tools show it. */
export function deployText(d: DeployInfo | null | undefined): string {
  if (!d) return 'No deploy since the server started.';
  const head = `${d.name}: ${d.state}${d.state === 'running' ? '' : ` after ${Math.round(((d.finished_at ?? Date.now()) - d.started_at) / 1000)}s`} (${d.repo} ${d.branch}, asked by ${d.by}${d.from || d.to ? `; ${d.from?.slice(0, 9) ?? 'new'} → ${d.to?.slice(0, 9) ?? '?'}` : ''})`;
  // First, so they read as work left, not one log line among many (#418).
  const todo: string[] = d.todo ?? [];
  return [
    head,
    ...(todo.length ? ['To do: deployed, but it still lacks these. Get them done (a minion of its home scheme), then deploy again:', ...todo.map((t) => `- ${t}`), 'What it did:'] : []),
    ...d.said.filter((l: string) => !l.startsWith('To do: ')).map((l: string) => `- ${l}`),
    `Log: ${d.log}`,
    ...(d.state === 'running' ? [] : ['Last lines of the log:', d.tail ?? '']),
  ].join('\n');
}

/** Dollars as people read them: cents under $10, whole dollars above. The one formatter (#1715); it lives here because
 * the MCP server copies mcp.ts's local imports into each turn (src/turn-launch.ts), and minion-budget.ts would drag in db.ts. */
export const money = (n: number) => `$${n < 10 ? n.toFixed(2) : Math.round(n)}`;

export const RISKS = ['unassessed', 'safe', 'interrupts', 'loses_data'];
export const RISK_WORDS: Record<string, string> = { unassessed: 'not assessed', safe: 'safe', interrupts: 'interrupts users', loses_data: 'may lose data' };

export interface UnitState {
  unit: string;
  load?: string;
  active: string;
  sub?: string;
  enabled?: string;
}
export interface ServiceInfo {
  installed: boolean;
  service: UnitState;
  unit: string;
  timers: UnitState[];
  folder: string;
  restart_risk?: string;
  restart_note?: string;
  manifestError?: string;
  health?: string;
  hand: { path: string; active: string; enabled?: string; why: string }[];
}
/** A service's state as the tools show it. */
export function serviceText(s: ServiceInfo): string {
  const state = (u: UnitState) => `${u.unit}: ${u.load === 'not-found' ? 'not installed' : `${u.active}${u.sub ? ` (${u.sub})` : ''}, ${u.enabled || 'no unit file'}`}`;
  return [
    s.installed ? state(s.service) : `${s.unit}: not installed`,
    ...s.timers.map(state),
    `folder ${s.folder}`,
    ...(s.restart_risk ? [`restart and stop risk: ${RISK_WORDS[s.restart_risk] ?? s.restart_risk}${s.restart_note ? ` (${s.restart_note})` : ''}`] : []),
    s.manifestError ? `manifest problem: ${s.manifestError}` : `manifest OK${s.health ? `, health ${s.health}` : ''}`,
    ...s.hand.map((u) => `hand-installed: ${u.path}: ${u.active}, ${u.enabled || 'no file state'} (${u.why})`),
  ].join('\n');
}

export interface ContraptionInfo {
  name: string;
  title: string;
  port: number;
  icon?: string | null;
  default_model?: string | null;
  open_paths: string[];
  relay_paths: string[];
  home_scheme?: string | null;
  turn_cap?: number | null;
  logins: string[];
  keys_dir: string;
  restart_risk: string;
  restart_note?: string;
  repo?: string | null;
  branch?: string | null;
  folder?: string | null;
}
/** A contraption as the tools show it: never a key, only where its key files are. */
export function contraptionText(c: ContraptionInfo): string {
  return [
    `${c.name}: ${c.title}`,
    `port ${c.port}`,
    `icon ${c.icon ?? 'none'}`,
    `model ${c.default_model ?? 'default'}`,
    `open paths ${c.open_paths.length ? c.open_paths.join(', ') : 'none'}`,
    `relay paths ${c.relay_paths.length ? c.relay_paths.join(', ') : 'none'}`,
    `home scheme ${c.home_scheme ?? 'none'}`,
    `turn cap ${c.turn_cap ?? 'none'}`,
    `enabled for ${c.logins.length ? c.logins.join(', ') : 'nobody'}`,
    `key folder ${c.keys_dir} (identity.pub, contraption.key)`,
    `restart risk ${RISK_WORDS[c.restart_risk] ?? c.restart_risk}${c.restart_note ? ` (${c.restart_note})` : ''}`,
    `repo ${c.repo ? `${c.repo} ${c.branch ?? 'main'}` : 'none'}, folder ${c.folder ?? `~/apps/${c.name}`}`,
  ].join(' | ');
}

/** A contraption name for a path: the route checks the rest. */
export function contraptionPath(args: Record<string, unknown>): string {
  if (typeof args.name !== 'string' || !/^[a-z0-9-]+$/.test(args.name)) throw new Error("name is required: the contraption's slug, like mandate");
  return `/api/contraptions/${encodeURIComponent(args.name)}`;
}

/** How long ago a time was, for the machine tools. */
export function ago(ms: number | null): string {
  if (!ms) return 'never';
  const m = Math.round((Date.now() - ms) / 60_000);
  const when = new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  return `${when} (${m < 1 ? 'just now' : m < 120 ? `${m} min ago` : `${Math.round(m / 60)} h ago`})`;
}

export interface CheckResult {
  server: string;
  ok: boolean;
  ms: number;
  tools: string[];
  error?: string;
}
/** One check result line per server (#307). */
export function checkLines(results: CheckResult[]): string[] {
  return results.map((r) => `- ${r.server === 'ws' ? 'workspace tools' : 'MCP server'}: ${r.ok ? `PASS in ${r.ms} ms, ${r.tools.length} tools: ${r.tools.join(', ') || 'none'}` : `FAIL after ${r.ms} ms: ${r.error}`}`);
}

const STATUS_WORDS: Record<string, string> = { ready: 'READY', fix: 'NEEDS A FIX', down: 'DOWN', asleep: 'ASLEEP', checking: 'CHECKING' };

export interface MachineInfo {
  name: string;
  status: string;
  reason: string;
  when?: { label: string; at: number } | null;
  project_names: string[];
  owner_id: number | null;
  owner_name?: string | null;
  /** Its owner lent its tools to every turn in its schemes (Build 10 H1, access.ts lendsToEveryone). */
  tools_everyone?: boolean;
  workspaces: { name: string; path: string }[];
  online: boolean;
  connected_at: number | null;
  host?: string;
  sessions: number;
  last_seen_at: number | null;
  managed: boolean;
  found: { name: string }[];
  lend?: { server?: string | null; workspaces: string[] } | null;
  runners?: unknown;
  command?: string;
  servers: string[];
  workspace_tools: boolean;
  minions_get_it: boolean;
  checked?: { at: number; results: CheckResult[] } | null;
  problems: string[];
  notes?: string;
  page?: string;
  /** The computer it is a VM on (Build 10 H4), or null. */
  vm_on?: string | null;
}
/** A machine as list_machines shows it (#307), its status first as the Machines tab says it (#437). */
export function machineText(m: MachineInfo): string {
  const list = m.project_names.length ? m.project_names.join(', ') : 'no scheme';
  const whose = m.owner_name ?? 'a removed person';
  const lent = m.tools_everyone ? `${whose}'s, lent to every turn in ${list}` : `${whose}'s own: goes to the turns they ask for, in ${list}`;
  const ws = m.workspaces.map((w) => `${w.name} (${w.path})`).join(', ');
  return [
    `${m.name}${m.vm_on ? ` (a VM on ${m.vm_on})` : ''}: ${STATUS_WORDS[m.status] ?? m.status}: ${m.when ? `${m.reason} · ${m.when.label} ${ago(m.when.at)}` : m.reason}`,
    `  ${m.online ? `ONLINE, connected since ${ago(m.connected_at)}, host ${m.host || '?'}, ${m.sessions} session${m.sessions === 1 ? '' : 's'} open` : `OFFLINE, last seen ${ago(m.last_seen_at)}`}`,
    ...(m.managed
      ? [
          // Its agent reports what it found and a person ticks what to lend on the Machines page (#439).
          `  found on that computer: ${[m.found.length ? `MCP servers ${m.found.map((f) => f.name).join(', ')}` : '', ws ? `workspaces ${ws}` : ''].filter(Boolean).join('; ') || 'nothing'}`,
          `  ticked to lend: ${[m.lend?.server ? `MCP server ${m.lend.server}` : '', m.lend?.workspaces.length ? `workspaces ${m.lend.workspaces.join(', ')}` : ''].filter(Boolean).join('; ') || 'nothing'}`,
        ]
      : [
          m.online && !m.runners ? `  agent runs: ${m.command || '?'} (set on that computer); offers ${m.servers.length ? m.servers.map((s: string) => (s === 'ws' ? 'workspace tools' : 'its MCP server')).join(' and ') : 'nothing'}` : '',
          m.runners ? '' : `  workspace tools: ${m.workspace_tools ? 'on' : 'off'}${m.online && ws ? `; workspaces: ${ws}` : ''}`,
        ]),
    `  ${lent}; ${m.minions_get_it ? "this scheme's minions get it" : "this scheme's minions don't get it"}`,
    m.checked?.results.length ? [`  last check ${ago(m.checked.at)}:`, ...checkLines(m.checked.results).map((l) => `  ${l}`)].join('\n') : m.online && !m.runners ? '  tools: not checked yet (Citadel checks it shortly after it connects; check_machine checks now)' : '',
    m.problems.length ? `  agent reports problems: ${m.problems.join('; ')}` : '',
    m.notes ? `  notes: ${m.notes.replace(/\n+/g, ' ')}` : '',
    // #1638: a change goes through propose_machine_lend, and its page entry is a link.
    m.page ? `  change it: propose_machine_lend; on the page: [${m.vm_on ? `${m.vm_on}'s card` : m.name} on the Machines page](${m.page})` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export interface ScheduleInfo {
  id: number;
  name: string;
  category?: string | null;
  when: string;
  cron: string;
  type: string;
  model?: string | null;
  effort?: string | null;
  min_minions?: number | null;
  gate_scope?: string;
  trigger_count?: number | null;
  trigger_text?: string;
  trigger_so_far?: number | null;
  template?: string | null;
  notes?: string | null;
  once?: boolean;
  paused?: boolean;
  next_run_at: number;
  last_run_at?: number | null;
  last_number?: number | null;
  last_skip?: string | null;
  last_error?: string | null;
}
/** A schedule for list_schedules and its edits: when, how it runs, its gate and trigger (#1798), next and last run. */
export function scheduleLine(s: ScheduleInfo): string {
  const at = (ms: number) => new Date(ms).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
  const next = s.paused ? 'paused' : `next ${at(s.next_run_at)}`;
  const last = s.last_run_at ? `last run ${at(s.last_run_at)}${s.last_number != null ? ` (#${s.last_number})` : ''}` : 'no run yet';
  // A schedule from before #698 may name neither; its runs take the model table's pick for its type (src/schedules.ts runMinion).
  const runsAs = `model ${s.model ?? `the table's pick for a ${s.type}`}, effort ${s.effort ?? `the table's pick for a ${s.type}`}`;
  const gate = s.min_minions != null ? `; skips under ${s.min_minions} minions${s.gate_scope === 'all' ? ' across all schemes' : ''}` : '';
  const trigger = s.trigger_count != null ? `; ${s.trigger_text} (${s.trigger_so_far ?? 0} so far)` : '';
  const kind = s.template ? `; standard audit ${s.template}${s.notes ? ' with notes' : ''}` : '';
  return `[${s.id}] ${s.name}${s.category ? ` (${s.category})` : ''}: ${s.when} (\`${s.cron}\`), type ${s.type}, ${runsAs}${gate}${trigger}${kind}${s.once ? '; runs once' : ''}; ${next}; ${last}${s.last_skip ? `; ${s.last_skip}` : ''}${s.last_error ? `; last slot didn't start: ${s.last_error}` : ''}`;
}

/** What copy_app_data (src/app-copy.ts) hands back. */
export interface CopyResult {
  databases: { name: string; bytes: number }[];
  files: number;
  left_out: string[];
}
export function copyText(app: string, r: CopyResult & { dir: string }): string {
  const list = r.databases.map((d) => `${d.name} (${Math.max(0.1, d.bytes / 1024 ** 2).toFixed(1)} MB)`).join(', ');
  const out = r.left_out.slice(0, 20).join(', ') + (r.left_out.length > 20 ? ` and ${r.left_out.length - 20} more` : '');
  return `A private copy of ${app}'s live data is in ${r.dir}: ${list || 'no databases'}${r.files ? `, and ${r.files} other file${r.files > 1 ? 's' : ''}` : ''}.${out ? ` It left out ${out}.` : ''} Run your check on it (for the app's own code, DATA_DIR=${r.dir}), not on the live folder. It is deleted when this turn ends, so anything to keep goes in your reply; it holds everyone's rows, so print counts and checks, never the rows, and copy none of it elsewhere.`;
}
