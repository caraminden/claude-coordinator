// The pure text formatters for the MCP tools' answers, split out of mcp.ts: each turns data the server sent into the text a tool returns.
// They hold no state of their own (no env, no API calls).
import { pacificDay } from './pacific.ts';

/** usage_split's answer (#905): each slice as a share of the week (all accounts together) with its dollars, against last week. */
export function usageSplitText(w: any): string {
  const usd = money;
  const pct = (n: number) => { const p = (n / w.weekUsd) * 100; return p && p < 0.1 ? '<0.1' : p < 10 ? p.toFixed(1) : String(Math.round(p)); };
  const amount = (n: number) => (w.weekUsd ? `${pct(n)}% (${usd(n)})` : usd(n));
  const line = (s: any) => `- ${s.name}: ${amount(s.usd)}, last week ${amount(s.lastWeek)}${s.estimated > 0.005 ? `, ${usd(s.estimated)} estimated` : ''}`;
  const fable = (k: 'usd' | 'lastWeek', all: number) => {
    const f = w.models.filter((m: any) => m.name.startsWith('Fable')).reduce((a: number, m: any) => a + m[k], 0);
    return all ? `${Math.round((f / all) * 100)}%` : '0%';
  };
  const estimated = w.models.reduce((a: number, m: any) => a + m.estimated, 0);
  return [
    `Last 7 days: ${amount(w.total)}; the 7 before: ${amount(w.lastWeek)}. ${w.weekUsd ? `100% is the weekly limit of ${w.accounts > 1 ? `all ${w.accounts} Claude accounts together` : 'the Claude account'}, about ${usd(w.weekUsd)} at API prices.` : 'No weekly meter can price a share yet, so dollars at API prices only.'}`,
    `Fable's share of spend: ${fable('usd', w.total)} this week, ${fable('lastWeek', w.lastWeek)} last week.`,
    'By model:', ...w.models.map(line),
    'By scheme:', ...w.schemes.map(line),
    'By kind of work:', ...w.kinds.map(line),
    'Costliest minions this week:', ...w.top.map((m: any) => `- ${m.number === null ? `ticket ${m.id}` : `#${m.number}`} ${m.title} (${m.scheme}): ${amount(m.usd)}`),
    ...(estimated > 0.005 ? [`${usd(estimated)} of this week is from turns before the split was kept (2026-11-17), counted under each minion's own model.`] : []),
  ].join('\n');
}

/** search_memory's answer: each hit as a header line and its text, cut so a call stays small. */
export function memoryText(hits: any[]): string {
  if (!hits.length) return 'Nothing indexed matches yet.';
  const day = (ms: number) => pacificDay(ms);
  return hits.map((h) => `${h.kind === 'coordinator' ? 'Taskmaster' : `#${h.number} ${h.title}`} · ${day(h.ts)} · ${h.source_kind === 'turn' ? `event ${h.source_id}` : 'title and note'} · score ${h.score}\n${h.text.length > 1200 ? `${h.text.slice(0, 1200)}…` : h.text}`).join('\n\n');
}

/** search_minions' answer: a header line per minion or handoff, then its matching text and the files it wrote. */
export function pastMinionsText(hits: any[]): string {
  if (!hits.length) return 'No closed minion or handoff matches. Fewer words, or another word for it, may find one.';
  const day = pacificDay;
  return hits.map((h) => {
    if (h.kind === 'handoff') return `Handoff ${h.name}${h.name.startsWith('shipped/') ? ' (its minion shipped)' : h.name.startsWith('not-picked/') ? ' (not picked)' : ''} · changed ${day(h.mtime)}\n${h.snippet}`;
    const files = h.files ? h.files.split('\n') : [];
    return `#${h.number} ${h.title} · ${h.type || 'no type'} · closed ${day(h.closed_at)}${h.status === 'closed' ? '' : ' (reopened)'}\n${h.snippet.replace(/\s+/g, ' ')}${files.length ? `\nFiles: ${files.slice(0, 12).join(', ')}${files.length > 12 ? ` (+${files.length - 12})` : ''}` : ''}`;
  }).join('\n\n');
}

/** The ideas tool's answer: a count line, then one line per row. */
export function ideasText(r: { ideas: any[]; counts: Record<string, number>; total: number; waiting: number[] }, limit: number): string {
  const day = (ms: number | null) => (ms ? pacificDay(ms) : '');
  const head = `${r.total} ideas: ${Object.entries(r.counts).filter(([, n]) => n).map(([s, n]) => `${n} ${s}`).join(', ') || 'none yet'}. Showing ${Math.min(limit, r.ideas.length)} of ${r.ideas.length}.${r.waiting.length ? ` ${r.waiting.length} at Later over two weeks.` : ''}`;
  const rows = r.ideas.slice(0, limit).map((i) => [
    `- [${i.id}] ${i.title || i.card} · ${i.status}${i.status_manual ? ' (by hand)' : ''}`,
    i.decided_by ? ` · ${i.pick_label ?? i.pick ?? 'noted'} (${i.decided_by}, ${day(i.decided_at)}${i.words ? `: "${i.words}"` : ''})` : '',
    i.page_label ? ` · page ${i.page_label}${i.page ? ` card ${i.card}` : ''}` : '',
    i.source_number ? ` · from #${i.source_number}` : '',
    i.handoff ? ` · handoff ${i.handoff}` : '',
    i.minion ? ` · #${i.minion.number}` : '',
  ].join(''));
  return [head, ...rows].join('\n');
}

/** search_decisions' answer: one block per decision, newest or best first, then what each source holds. */
export function decisionsText(r: { decisions: any[]; linked?: any[]; counts: { label: string; count: number; files: number }[] }, limit: number): string {
  const where = (p: any) => `${p.label}${p.file && p.file !== p.label ? ` ${p.file}` : ''}${p.line ? `:${p.line}` : ''}`;
  const byId = new Map([...(r.linked ?? []), ...r.decisions].map((d) => [d.id, d]));
  const rows = r.decisions.slice(0, limit).map((d) => {
    const head = `${d.date} · ${d.who} · ${d.rule}${d.quote ? `\n  "${d.quote}"` : ''}`;
    const at = d.places.length ? `\n  Written in: ${d.places.map(where).join('; ')}` : '';
    const by = d.reversed ? byId.get(d.reversed.by) : null;
    const rev = d.reversed ? `\n  REVERSED by ${by ? `${by.date} ${by.who}: ${by.rule}${by.quote ? ` "${by.quote}"` : ''}` : d.reversed.byText}${d.reversed.stale.length ? `. Still written in: ${d.reversed.stale.map(where).join('; ')}` : ''}` : '';
    const revs = d.reverses.length ? `\n  Reverses: ${d.reverses.map((id: string) => byId.get(id)).filter(Boolean).map((o: any) => `${o.date} ${o.who} "${o.quote || o.rule}"`).join('; ')}` : '';
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
  return r.answer.map((c: any) => `- ${c?.name}: ${c?.description ?? ''}${c?.input_schema ? `\n  input: ${JSON.stringify(c.input_schema)}` : ''}`).join('\n') + cut;
}

/** What register_contraption says when it has no icon (#418). */
export const NO_ICON = 'To do: it has no icon, so the rail shows its first letter. Every contraption ships one with a web manifest (the citadel:contraption-ui starter has both): set icon with update_contraption, like /icon.svg, or deploy it and an empty icon is filled from its manifest.';

/** A deploy as the tools show it. */
export function deployText(d: any): string {
  if (!d) return 'No deploy since the server started.';
  const head = `${d.name}: ${d.state}${d.state === 'running' ? '' : ` after ${Math.round(((d.finished_at ?? Date.now()) - d.started_at) / 1000)}s`} (${d.repo} ${d.branch}, asked by ${d.by}${d.from || d.to ? `; ${d.from?.slice(0, 9) ?? 'new'} → ${d.to?.slice(0, 9) ?? '?'}` : ''})`;
  // First, so they read as work left, not one log line among many (#418).
  const todo: string[] = d.todo ?? [];
  return [head, ...(todo.length ? ['To do: deployed, but it still lacks these. Get them done (a minion of its home scheme), then deploy again:', ...todo.map((t) => `- ${t}`), 'What it did:'] : []),
    ...d.said.filter((l: string) => !l.startsWith('To do: ')).map((l: string) => `- ${l}`), `Log: ${d.log}`, ...(d.state === 'running' ? [] : ['Last lines of the log:', d.tail ?? ''])].join('\n');
}

/** Dollars as people read them: cents under $10, whole dollars above. The one formatter (#1715); it lives here because
 * the MCP server copies mcp.ts's local imports into each turn (src/turn-launch.ts), and minion-budget.ts would drag in db.ts. */
export const money = (n: number) => `$${n < 10 ? n.toFixed(2) : Math.round(n)}`;

export const RISKS = ['unassessed', 'safe', 'interrupts', 'loses_data'];
export const RISK_WORDS: Record<string, string> = { unassessed: 'not assessed', safe: 'safe', interrupts: 'interrupts users', loses_data: 'may lose data' };

/** A service's state as the tools show it. */
export function serviceText(s: any): string {
  const state = (u: any) => `${u.unit}: ${u.load === 'not-found' ? 'not installed' : `${u.active}${u.sub ? ` (${u.sub})` : ''}, ${u.enabled || 'no unit file'}`}`;
  return [
    s.installed ? state(s.service) : `${s.unit}: not installed`,
    ...s.timers.map(state),
    `folder ${s.folder}`,
    ...(s.restart_risk ? [`restart and stop risk: ${RISK_WORDS[s.restart_risk] ?? s.restart_risk}${s.restart_note ? ` (${s.restart_note})` : ''}`] : []),
    s.manifestError ? `manifest problem: ${s.manifestError}` : `manifest OK${s.health ? `, health ${s.health}` : ''}`,
    ...s.hand.map((u: any) => `hand-installed: ${u.path}: ${u.active}, ${u.enabled || 'no file state'} (${u.why})`),
  ].join('\n');
}

/** A contraption as the tools show it: never a key, only where its key files are. */
export function contraptionText(c: any): string {
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
export function contraptionPath(args: any): string {
  if (typeof args.name !== 'string' || !/^[a-z0-9-]+$/.test(args.name)) throw new Error('name is required: the contraption\'s slug, like mandate');
  return `/api/contraptions/${encodeURIComponent(args.name)}`;
}

/** How long ago a time was, for the machine tools. */
export function ago(ms: number | null): string {
  if (!ms) return 'never';
  const m = Math.round((Date.now() - ms) / 60_000);
  const when = new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  return `${when} (${m < 1 ? 'just now' : m < 120 ? `${m} min ago` : `${Math.round(m / 60)} h ago`})`;
}

/** One check result line per server (#307). */
export function checkLines(results: any[]): string[] {
  return results.map((r) => `- ${r.server === 'ws' ? 'workspace tools' : 'MCP server'}: ${r.ok ? `PASS in ${r.ms} ms, ${r.tools.length} tools: ${r.tools.join(', ') || 'none'}` : `FAIL after ${r.ms} ms: ${r.error}`}`);
}

const STATUS_WORDS: Record<string, string> = { ready: 'READY', fix: 'NEEDS A FIX', down: 'DOWN', asleep: 'ASLEEP', checking: 'CHECKING' };

/** A machine as list_machines shows it (#307), its status first as the Machines tab says it (#437). */
export function machineText(m: any): string {
  const list = m.project_names.length ? m.project_names.join(', ') : 'no scheme';
  const lent = m.owner_id !== null ? `${m.owner_name ?? 'a removed person'}'s own: goes to the turns they ask for, in ${list}` : `lent to ${list}`;
  const ws = m.workspaces.map((w: any) => `${w.name} (${w.path})`).join(', ');
  return [
    `${m.name}: ${STATUS_WORDS[m.status] ?? m.status}: ${m.when ? `${m.reason} · ${m.when.label} ${ago(m.when.at)}` : m.reason}`,
    `  ${m.online ? `ONLINE, connected since ${ago(m.connected_at)}, host ${m.host || '?'}, ${m.sessions} session${m.sessions === 1 ? '' : 's'} open` : `OFFLINE, last seen ${ago(m.last_seen_at)}`}`,
    ...(m.managed ? [
      // Its agent reports what it found and a person ticks what to lend on the Machines page (#439).
      `  found on that computer: ${[m.found.length ? `MCP servers ${m.found.map((f: any) => f.name).join(', ')}` : '', ws ? `workspaces ${ws}` : ''].filter(Boolean).join('; ') || 'nothing'}`,
      `  ticked to lend: ${[m.lend?.server ? `MCP server ${m.lend.server}` : '', m.lend?.workspaces.length ? `workspaces ${m.lend.workspaces.join(', ')}` : ''].filter(Boolean).join('; ') || 'nothing'}`,
    ] : [
      m.online && !m.runners ? `  agent runs: ${m.command || '?'} (set on that computer); offers ${m.servers.length ? m.servers.map((s: string) => (s === 'ws' ? 'workspace tools' : 'its MCP server')).join(' and ') : 'nothing'}` : '',
      m.runners ? '' : `  workspace tools: ${m.workspace_tools ? 'on' : 'off'}${m.online && ws ? `; workspaces: ${ws}` : ''}`,
    ]),
    `  ${lent}; ${m.minions_get_it ? "this scheme's minions get it" : "this scheme's minions don't get it"}`,
    m.checked?.results.length ? [`  last check ${ago(m.checked.at)}:`, ...checkLines(m.checked.results).map((l) => `  ${l}`)].join('\n') : m.online && !m.runners ? '  tools: not checked yet (Citadel checks it shortly after it connects; check_machine checks now)' : '',
    m.problems.length ? `  agent reports problems: ${m.problems.join('; ')}` : '',
    m.notes ? `  notes: ${m.notes.replace(/\n+/g, ' ')}` : '',
    // #1638: a change goes through propose_machine_lend, and its page entry is a link.
    m.page ? `  change it: propose_machine_lend; on the page: [${m.name} on the Machines page](${m.page})` : '',
  ].filter(Boolean).join('\n');
}
