// What the server does with each line of a running turn's stream: what it stores and shows, the turn's result, the
// commands it loaded, its status trailer, sent-back replies, the pushes it makes, and load errors.
// Reading the stream itself stays in runner.ts; one event's shape is src/stream-events.ts.
// Moved out of runner.ts (#1840): it takes what it needs from the Runner as `TurnEventsDeps`.
import type { EventRow, Store, TicketState, TurnResult } from './db.ts';
import type { CompactWatch } from './compactions.ts';
import { KEEP, SENT_BACK } from './link-check.ts';
import { validSessionId } from './sessions.ts';
import { thrown } from './thrown.ts';
import type { ClaudeEvent, ContentBlock, LoadError, ModelUsage } from './claude-events.ts';
import { turnOf } from './turn-row.ts';
import { cloudSpend, type CloudPool } from './cloud-pool.ts';
import { codexThreadKey, CODEX_WAITING, type CodexThread } from './codex.ts';
import type { Holds } from './prompt-hold.ts';
import { hideSecrets, hideSecretsIn } from './secrets.ts';
import { takeStatus, type StatusFields } from './status-trailer.ts';
import { losesPass, noteCalls, readsSteers, STEER_LAG_MS } from './card-wait.ts';
import { noteEvent } from './quiet.ts';
import { applyEvent, createProgress, progressLine } from '../public/progress.js';
import { describeActivity, DROPPED_TYPES, pushKind, slimEvent } from './stream-events.ts';
import type { LoadedCommands } from './turn-messages.ts';
import { contextKey, windowKey, turnKey, commandsKey, schemeCommandsKey } from './turn-keys.ts';
import type { Broadcast, LiveTurn, TurnState } from './runner.ts';

/** What handling a turn's events needs from the Runner. The maps stay the Runner's: it clears them with the turn. */
export interface TurnEventsDeps {
  store: Store;
  now: () => number;
  turns: Map<number, LiveTurn>;
  keepalives: ReadonlySet<number>;
  statuses: Map<number, StatusFields>;
  sentBack: Set<number>;
  contextSizes: Map<number, number>;
  contextShown: Map<number, { size: number; at: number }>;
  mainModels: Map<number, string>;
  pushCalls: Map<string, 'push' | 'pr'>;
  compactWatch: CompactWatch;
  promptHolds: () => Holds;
  emit: (ticketId: number, kind: string, data: unknown, reserved?: number) => EventRow;
  broadcast: Broadcast;
  broadcastTicket: (ticketId: number) => void;
  saveTurn: (ticketId: number, patch: Partial<TurnState>) => void;
  secretsOfTurn: (ticketId: number) => Map<string, string>;
  updateUsage: (info: unknown, ticketId?: number) => void;
  updateCodexUsage: (l: unknown, person: number | null) => void;
  lendWorker: (ticketId: number) => void;
  quietSince: (ticketId: number, live: LiveTurn, now?: number) => number | null;
  checkQuiet: (ticketId: number, live: LiveTurn, now?: number) => void;
  keepaliveResult: (ticketId: number, ev: ClaudeEvent) => Promise<void>;
  meterSpend: (ticketId: number, ev: ClaudeEvent) => unknown;
  progressFor: (ticketId: number) => ReturnType<typeof createProgress>;
  recordSteps: (ticketId: number, p: ReturnType<typeof createProgress>) => void;
  savePlan: (ticketId: number, p: ReturnType<typeof createProgress>, upTo: number) => void;
  carryReply: (ticketId: number) => void;
  keepTurn: (ticketId: number, state: TurnState | null | undefined, r: TurnResult) => void;
  /** The cloud's pool (#2153): a cloud turn's session is kept on its minion. */
  cloud: () => CloudPool;
  settleSpend: (ticketId: number) => void;
  setFailNote: (ticketId: number, fields: { note: string; state?: TicketState }) => void;
  onStatusTrailer: (ticketId: number, fields: StatusFields) => void;
  onStreamEvent: (ticketId: number, ev: ClaudeEvent) => void;
  onRawEvent: (ticketId: number, ev: ClaudeEvent) => void;
  onFilesMayChange: (ticketId: number, soon: boolean) => void;
  onTurnError: (ticketId: number, text: string, eventId?: number) => void;
}

export class TurnEvents {
  private d: TurnEventsDeps;
  constructor(d: TurnEventsDeps) {
    this.d = d;
  }

  /**
   * Keep the slash commands a turn loaded (Claude Code's init event lists them), for the composer's menu and its
   * check of what it sends (#937). Terminal-only ones and internal `__` ones are left out. Written only on a change.
   */
  saveCommands(ticketId: number, ev: ClaudeEvent) {
    const terminal = new Set(Array.isArray(ev.terminal_slash_commands) ? ev.terminal_slash_commands : []);
    const names = [...new Set<string>(ev.slash_commands!.filter((n: unknown) => typeof n === 'string' && n && !n.startsWith('__') && !terminal.has(n)))];
    const plugins = (Array.isArray(ev.plugins) ? ev.plugins : []).filter((p) => typeof p?.name === 'string' && typeof p.path === 'string' && p.path.startsWith('/')).map((p) => ({ name: p.name, path: p.path }));
    const loaded: LoadedCommands = { names, plugins, cwd: typeof ev.cwd === 'string' ? ev.cwd : '' };
    const ticket = this.d.store.getTicket(ticketId);
    if (JSON.stringify(this.d.store.getSetting(commandsKey(ticketId))) !== JSON.stringify(loaded)) this.d.store.setSetting(commandsKey(ticketId), loaded);
    if (ticket && JSON.stringify(this.d.store.getSetting(schemeCommandsKey(ticket.project_id))) !== JSON.stringify(loaded)) this.d.store.setSetting(schemeCommandsKey(ticket.project_id), loaded);
  }

  handleLine(ticketId: number, line: string, onResult: (isError: boolean, result: string | null) => void) {
    if (!line.trim()) return;
    let ev: ClaudeEvent;
    const secrets = this.d.secretsOfTurn(ticketId);
    try {
      ev = JSON.parse(line);
    } catch {
      this.d.emit(ticketId, 'note', { text: hideSecrets(line, secrets) });
      return;
    }
    if (!ev || typeof ev !== 'object') return;
    // A turn that prints a saved secret (#838) never puts it in the chat, its reply or its activity line.
    if (secrets.size) ev = hideSecretsIn(ev, secrets);
    if (ev.type === 'rate_limit_event') this.d.updateUsage(ev.rate_limit_info, ticketId);
    const live = this.d.turns.get(ticketId);
    if (live) {
      live.activity = noteEvent(live.activity, ev, Date.now());
      const pass = this.d.store.getSetting<TurnState>(turnKey(ticketId))?.pass;
      if (pass && losesPass(pass, live.calls, ev)) this.d.saveTurn(ticketId, { pass: undefined });
      noteCalls(live.calls, ev);
      if (live.unread && readsSteers(live.calls, ev) && this.d.now() - live.unread > STEER_LAG_MS) {
        live.unread = undefined;
        this.d.saveTurn(ticketId, { unread: undefined });
      }
      if (ev.type === 'system' && ev.subtype === 'background_tasks_changed') this.d.saveTurn(ticketId, { background: live.calls.background });
      this.d.lendWorker(ticketId);
      if (this.d.quietSince(ticketId, live) === null && this.d.store.getSetting<TurnState>(turnKey(ticketId))?.quiet) this.d.checkQuiet(ticketId, live);
    }
    // A keepalive (#862) shows nothing: only its session id and its cost are kept.
    if (this.d.keepalives.has(ticketId)) {
      if (validSessionId(ev.session_id) && ev.session_id !== this.d.store.getTicket(ticketId)?.session_id) this.d.store.updateTicket(ticketId, { session_id: ev.session_id });
      if (ev.type === 'result') onResult(!!ev.is_error, typeof ev.result === 'string' ? ev.result : null);
      if (ev.type === 'result' && typeof ev.total_cost_usd === 'number') void this.d.keepaliveResult(ticketId, ev).catch((e) => console.error(`[keepalive] minion ${ticketId}: ${(e as Error).message}`));
      return;
    }
    if (ev.type === 'codex_waiting') return this.d.emit(ticketId, 'note', { text: CODEX_WAITING });
    if (ev.type === 'codex_gate') return console.log(`[codex] minion ${ticketId}: login check waited ${Number(ev.waited_ms) || 0} ms${ev.refreshed ? ', refreshed the login' : ''}${ev.serial ? ', runs serial' : ''}`);
    if (ev.type === 'codex_rate_limits') return this.d.updateCodexUsage(ev.rate_limits, this.d.store.getSetting<TurnState>(turnKey(ticketId))?.person ?? null);
    if (ev.type === 'system' && ev.subtype === 'init' && typeof ev.codex_thread === 'string') {
      const t = this.d.store.getSetting<CodexThread>(codexThreadKey(ticketId));
      if (t && t.thread !== ev.codex_thread) this.d.store.setSetting(codexThreadKey(ticketId), { ...t, thread: ev.codex_thread });
      if (ev.codex_resume_failed) this.d.emit(ticketId, 'note', { text: `Codex couldn't pick up its thread ${ev.codex_resume_failed}, so this turn starts a new one from the hand-over log.` });
    }
    if (ev.type === 'assistant' && !ev.parent_tool_use_id && Array.isArray(ev.message?.content)) this.countUse(ev.message.content);
    // Each main-thread API call re-reads the whole context: its input is the context's size.
    const u = ev.type === 'assistant' && !ev.parent_tool_use_id ? ev.message?.usage : null;
    if (u) {
      const size = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
      const shown = this.d.contextShown.get(ticketId);
      this.d.contextSizes.set(ticketId, size);
      // The meter follows the turn (#1193), but a view() per API call is too many: a change of 1k or more, at most every 2 s.
      if (!shown || (Math.abs(size - shown.size) >= 1000 && Date.now() - shown.at >= 2000)) {
        this.d.contextShown.set(ticketId, { size, at: Date.now() });
        this.d.broadcastTicket(ticketId);
      }
    }
    if (ev.type === 'system' && ev.subtype === 'init' && typeof ev.model === 'string') this.d.mainModels.set(ticketId, ev.model);
    if (ev.type === 'result' && ev.modelUsage && typeof ev.modelUsage === 'object') {
      // Grunts' models are in modelUsage too: the window is the main model's.
      const main = this.d.mainModels.get(ticketId);
      const mu: ModelUsage | null = main ? (ev.modelUsage[main] ?? ev.modelUsage[main.replace(/\[1m\]$/i, '')]) : null;
      if (mu && Number(mu.contextWindow) > 0) this.d.store.setSetting(windowKey(ticketId), Number(mu.contextWindow));
    }
    if (ev.type === 'result') this.d.contextShown.delete(ticketId);
    if (ev.type === 'result' && this.d.contextSizes.has(ticketId)) {
      this.d.store.setSetting(contextKey(ticketId), this.d.contextSizes.get(ticketId));
      this.d.contextSizes.delete(ticketId);
    }
    if (ev.type === 'assistant') {
      // An alert is extra: a failure in it must not cost the line its place in the chat.
      try {
        this.d.meterSpend(ticketId, ev);
      } catch (err) {
        console.error(`[spend] minion ${ticketId}: metering failed:`, thrown(err).message);
      }
    }
    if (DROPPED_TYPES.has(ev.type)) return;
    // Joined into paths and passed to --resume later, and a container can write its stream: only what looks like an id.
    if (validSessionId(ev.session_id) && ev.session_id !== this.d.store.getTicket(ticketId)?.session_id) {
      this.d.store.updateTicket(ticketId, { session_id: ev.session_id });
    }
    if (this.d.compactWatch.observe(ticketId, ev)) this.d.broadcastTicket(ticketId);
    // A cloud turn's session and the last result it read (#2153), kept on the minion for its follow-ups.
    if (ev.type === 'system' && ev.subtype === 'cloud') {
      const state = this.d.store.getSetting<TurnState>(turnKey(ticketId));
      if (state?.person != null) this.d.cloud().heard(ticketId, state.person, state.account ?? null, ev, this.d.now());
    }
    // The held prompt (#1276): a compaction summarises its note away, and a turn that ran has read the note it carried.
    if (ev.type === 'system' && ev.subtype === 'compact_boundary') this.d.promptHolds().compacted(ticketId);
    // Only a turn that ran has read its note: after an error the next turn carries it again.
    if (ev.type === 'result' && !ev.is_error) this.d.promptHolds().ran(ticketId, this.d.store.getTicket(ticketId)?.session_id ?? null);
    if (ev.type === 'result') onResult(!!ev.is_error, typeof ev.result === 'string' ? ev.result : null);
    if (ev.type === 'assistant' && !ev.parent_tool_use_id && Array.isArray(ev.message?.content)) ev = this.stripStatus(ticketId, ev);
    if (ev.type === 'result') {
      const status = this.d.statuses.get(ticketId);
      this.d.statuses.delete(ticketId);
      if (status && !ev.is_error && !(this.d.store.getCabal(ticketId) && this.d.store.getSetting<TurnState>(turnKey(ticketId))?.fresh)) this.d.onStatusTrailer(ticketId, status);
      if (status) this.d.saveTurn(ticketId, { status: undefined });
    }
    // Likewise the model: remembered from turns that ran without one chosen.
    const t = ev.type === 'system' && ev.subtype === 'init' && typeof ev.model === 'string' ? this.d.store.getTicket(ticketId) : null;
    if (t && !t.model && ev.model !== t.last_model) {
      this.d.store.updateTicketQuietly(ticketId, { last_model: ev.model });
      this.d.broadcastTicket(ticketId);
    }
    if (ev.type === 'system' && ev.subtype === 'init' && Array.isArray(ev.mcp_servers)) this.checkMcp(ticketId, ev.mcp_servers);
    if (ev.type === 'system' && ev.subtype === 'init') this.checkLoadErrors(ticketId, ev);
    if (ev.type === 'system' && ev.subtype === 'init' && Array.isArray(ev.slash_commands)) this.saveCommands(ticketId, ev);
    if (ev.type === 'system' && ev.subtype === 'init' && typeof ev.claude_code_version === 'string') {
      const hashes = this.d.store.getSetting<TurnState>(turnKey(ticketId))?.hashes;
      if (hashes) this.d.saveTurn(ticketId, { hashes: { ...hashes, claude: ev.claude_code_version } });
    }
    // A process ended for its card says the call was rejected and the turn failed; the chat shows it still waiting.
    if (live?.card && ev.type === 'user') return;
    if (live?.card && ev.type === 'result') ev = { ...ev, is_error: false, result: '' };
    this.d.onRawEvent(ticketId, ev);
    const slim = slimEvent(ev);
    if (!slim) return;
    const progress = this.d.progressFor(ticketId);
    const row = this.d.emit(ticketId, 'claude', slim);
    try {
      this.d.onStreamEvent(ticketId, slim);
    } catch (err) {
      console.error(`[stall] minion ${ticketId}: counting failed:`, thrown(err).message);
    }
    // The stored event's own time, so a step's start matches what a replay of the events (history, the backfill) finds.
    applyEvent(progress, 'claude', slim, row.created_at);
    this.d.recordSteps(ticketId, progress);
    // A bare KEEP answering a send-back is no activity: the first reply stands (replaceSentBack).
    const keep =
      this.d.sentBack.has(ticketId) &&
      ev.type === 'assistant' &&
      !ev.parent_tool_use_id &&
      describeActivity(ev)
        ?.replace(/[*_.!]/g, '')
        .toUpperCase() === KEEP;
    const activity = progress.tasks.length ? progressLine(progress, ev.type !== 'result') : keep ? null : describeActivity(ev);
    if (activity && activity !== this.d.store.getTicket(ticketId)?.last_activity) {
      this.d.store.updateTicket(ticketId, { last_activity: activity });
      // Keep the board's progress line live, not just on status changes.
      this.d.broadcastTicket(ticketId);
    }
    if (ev.type === 'result') this.d.savePlan(ticketId, progress, row.id);
    if (ev.type === 'user' && ((ev.message?.content ?? []) as ContentBlock[]).some?.((b) => typeof b?.text === 'string' && b.text.includes(SENT_BACK)) && !this.d.sentBack.has(ticketId)) {
      this.d.sentBack.add(ticketId);
      this.d.saveTurn(ticketId, { sentBack: true });
    }
    // shortcut: a turn stopped, or cut off and resumed, before the result keeps both versions (a re-attached one doesn't, #1452); rare, so left.
    if (ev.type === 'result' && this.d.sentBack.delete(ticketId)) {
      const stood = this.replaceSentBack(ticketId, row.id);
      // The turn's result is the reply that stands, not the KEEP that answered the send-back.
      if (stood != null) onResult(!!ev.is_error, stood);
    }
    if (ev.type === 'result' && !ev.is_error) this.d.carryReply(ticketId);
    if (ev.type === 'result' && typeof ev.total_cost_usd === 'number') {
      const state = this.d.store.getSetting<TurnState>(turnKey(ticketId));
      // A cloud turn's cost is this turn's estimate, not a session's running total (#2153): kept as one, like a killed turn's,
      // on the minion's Claude session so that session's running total carries across it.
      const cloudUsd = cloudSpend(ev);
      this.d.keepTurn(ticketId, state, cloudUsd === null ? { event_id: row.id, ...turnOf(ev), ended_at: row.created_at } : { event_id: row.id, session_id: this.d.store.getTicket(ticketId)?.session_id, session_cost_usd: 0, ended_at: row.created_at, estimate: { cloud: cloudUsd } });
      this.d.settleSpend(ticketId);
      if (state?.spend?.open) this.d.saveTurn(ticketId, { spend: { ...state.spend, open: {} } });
    }
    if (ev.type === 'user' && Array.isArray(ev.message?.content) && (ev.message!.content as ContentBlock[]).some((b) => b?.type === 'tool_result')) {
      this.d.onFilesMayChange(ticketId, false);
    }
    // A reply that links a file shows it in the artifacts list as it lands (the scan's own test: replyTexts).
    if (ev.type === 'assistant' && Array.isArray(ev.message?.content) && (ev.message!.content as ContentBlock[]).some((b) => b?.type === 'text' && typeof b.text === 'string' && b.text.includes(']('))) {
      this.d.onFilesMayChange(ticketId, true);
    }
    this.notePushes(ticketId, ev);
  }

  /** A main-thread message without its status trailer, remembering the last good one for the turn's end; a bad one is noted once. */
  private stripStatus(ticketId: number, ev: ClaudeEvent): ClaudeEvent {
    let changed = false;
    let state = '';
    const content = (ev.message!.content as ContentBlock[]).flatMap((b): ContentBlock[] => {
      if (b?.type !== 'text' || typeof b.text !== 'string') return [b];
      const { text, status, bad } = takeStatus(b.text);
      if (text === b.text) return [b];
      changed = true;
      if (status) {
        this.d.statuses.set(ticketId, status);
        this.d.saveTurn(ticketId, { status });
        state = typeof status.state === 'string' ? status.state : '';
      }
      if (bad) {
        // A later reply's bad line (a sent-back reply's rewrite) doesn't let an earlier reply's line stand.
        if (this.d.statuses.delete(ticketId)) this.d.saveTurn(ticketId, { status: undefined });
        console.log(`[status] minion ${ticketId}: ignored a status trailer, ${bad}`);
        this.d.emit(ticketId, 'note', { text: `The reply's status line was ignored (${bad}), so the state stays as it was.` });
      }
      return text ? [{ ...b, text }] : [];
    });
    if (!changed) return ev;
    // The end it named stays on the stored event: the plan's last step is ticked by it, in every replay (progress.js, #1923).
    return { ...ev, message: { ...ev.message, content }, ...(state ? { turn_state: state } : {}) };
  }

  /** Swaps each sent-back reply for its rewrite; returns the words of the reply that stood when the last answer was a bare KEEP. */
  private replaceSentBack(ticketId: number, resultId: number): string | null {
    let stood: string | null = null;
    // A Grunt's words aren't the reply.
    const words = (data: ClaudeEvent) => data.type === 'assistant' && !data.parent_tool_use_id && ((data.message?.content ?? []) as ContentBlock[]).some((b) => b?.type === 'text' && b.text?.trim());
    const sentBack = (data: ClaudeEvent) => data.type === 'user' && Array.isArray(data.message?.content) && data.message.content.some((b) => b?.type === 'text' && typeof b.text === 'string' && b.text.includes(SENT_BACK));
    const swaps: { original: EventRow; rewrite?: EventRow }[] = [];
    let last: EventRow | null = null;
    for (const e of this.d.store.eventsPage(ticketId, resultId, 1).events) {
      if (e.kind !== 'claude') continue;
      const data: ClaudeEvent = JSON.parse(e.data);
      if (sentBack(data)) {
        if (last) swaps.push({ original: last });
      } else if (words(data)) {
        last = e;
        const open = swaps.at(-1);
        if (open && open.original !== e) open.rewrite = e;
      }
    }
    const text = (data: ClaudeEvent) =>
      (data.message!.content as ContentBlock[])
        .filter((b) => b?.type === 'text')
        .map((b) => b.text)
        .join('')
        .trim();
    for (const { original, rewrite } of swaps) {
      if (!rewrite) continue;
      // A bare KEEP stands by the first version (#404): the KEEP is what gives way.
      const [gone, by] =
        text(JSON.parse(rewrite.data))
          .replace(/[*_.!]/g, '')
          .toUpperCase() === KEEP
          ? [rewrite, original]
          : [original, rewrite];
      const data: ClaudeEvent & { replaced?: number } = JSON.parse(gone.data);
      if (data.replaced) continue;
      if (gone === rewrite) stood = text(JSON.parse(by.data));
      this.d.store.setEventData(gone.id, { ...data, replaced: by.id });
      this.d.emit(ticketId, 'replaced', { event: gone.id, by: by.id });
    }
    return stood;
  }

  /** The usage ledger (#1306): each tool, skill and Grunt type a main-thread message calls. Never throws. */
  private countUse(blocks: ContentBlock[]) {
    try {
      for (const b of blocks) {
        if (b?.type !== 'tool_use' || typeof b.name !== 'string') continue;
        const m = /^mcp__(?:thread|coordinator)__(.+)$/.exec(b.name);
        if (m) this.d.store.usage.used('tool', m[1]);
        else if (b.name === 'Skill' && typeof b.input?.skill === 'string') this.d.store.usage.used('skill', b.input.skill);
        else if ((b.name === 'Agent' || b.name === 'Task') && typeof b.input?.subagent_type === 'string') this.d.store.usage.used('grunt', b.input.subagent_type);
      }
    } catch {
      /* counting never fails a turn */
    }
  }

  /** A note in the chat for each push or pull request, saying whose GitHub it went out as (Cara's pick: "only a chat note"). */
  private notePushes(ticketId: number, ev: ClaudeEvent) {
    const blocks: ContentBlock[] = Array.isArray(ev.message?.content) ? ev.message.content : [];
    for (const b of blocks) {
      if (ev.type === 'assistant' && b?.type === 'tool_use' && b.name === 'Bash' && typeof b.input?.command === 'string' && typeof b.id === 'string') {
        const kind = pushKind(b.input.command);
        if (kind) this.d.pushCalls.set(b.id, kind);
      }
      if (ev.type !== 'user' || b?.type !== 'tool_result' || !this.d.pushCalls.has(b.tool_use_id!)) continue;
      const kind = this.d.pushCalls.get(b.tool_use_id!)!;
      this.d.pushCalls.delete(b.tool_use_id!);
      const turn = this.d.store.getSetting<TurnState>(turnKey(ticketId));
      // Absent: GitHub linking isn't set up, and the box's own login pushes as before. On a machine, that worker's own login pushes (#2318).
      if (turn?.github === undefined || turn.machine) continue;
      const who = turn.person ? (this.d.store.getUser(turn.person)?.name ?? 'Its person') : 'Nobody';
      if (turn.github && !b.is_error) this.d.emit(ticketId, 'note', { text: kind === 'pr' ? `Opened a pull request as @${turn.github} (${who}'s GitHub)` : `Pushed as @${turn.github} (${who}'s GitHub)` });
      else if (!turn.github && b.is_error) this.d.emit(ticketId, 'note', { text: `Couldn't ${kind === 'pr' ? 'open a pull request' : 'push'}: this turn runs for ${who}, who hasn't linked GitHub. Link it in Settings → Your account.` });
    }
  }

  /**
   * Say so in the chat (as an error, which pushes) when the turn's own MCP server didn't connect:
   * without it a minion can't set its status or ask questions, and a Taskmaster can't manage minions.
   */
  private checkMcp(ticketId: number, servers: NonNullable<ClaudeEvent['mcp_servers']>) {
    const role = this.d.store.getTicket(ticketId)?.kind === 'coordinator' ? 'coordinator' : 'thread';
    const status = servers.find((s) => s?.name === role)?.status;
    // Pending: still starting after Claude Code's startup wait; it may yet connect.
    if (status === 'connected' || status === 'pending') return;
    const text = `The ${role} MCP server is ${typeof status === 'string' ? status : 'missing'} in this turn, so its mcp__${role} tools are unavailable. Check the server log.`;
    console.error(`Ticket ${ticketId}: ${text}`);
    const event = this.d.emit(ticketId, 'error', { text });
    this.d.onTurnError(ticketId, text, event.id);
  }

  /**
   * A plugin or MCP server that fails to load is skipped and the turn still exits 0 (AG-03): say so in the chat as an error
   * and on the minion's note. It warns and doesn't end the turn: a missing thread/coordinator server already has checkMcp's error.
   */
  private checkLoadErrors(ticketId: number, ev: ClaudeEvent) {
    const line = (e: LoadError, kind: string) => {
      const name = typeof e === 'object' ? (e?.plugin ?? e?.name ?? e?.server) : null;
      const why = typeof e === 'string' ? e : (e?.error ?? e?.message ?? JSON.stringify(e));
      return `${name ? `${name} ` : ''}${kind}: ${why}`;
    };
    const role = this.d.store.getTicket(ticketId)?.kind === 'coordinator' ? 'coordinator' : 'thread';
    // The turn's own server already got checkMcp's error.
    const lines = [...(Array.isArray(ev.plugin_errors) ? ev.plugin_errors.map((e) => line(e, 'plugin')) : []), ...(Array.isArray(ev.mcp_server_errors) ? ev.mcp_server_errors.filter((e) => (typeof e === 'string' ? undefined : e?.name) !== role).map((e) => line(e, 'MCP server')) : [])];
    if (!lines.length) return;
    const text = `This turn started with load errors, so some of its skills, hooks or tools are missing: ${lines.join('; ')}`.slice(0, 1500);
    console.error(`Ticket ${ticketId}: ${text}`);
    const event = this.d.emit(ticketId, 'error', { text });
    this.d.setFailNote(ticketId, { note: `Load errors: ${lines.length} in this turn's init`.slice(0, 60) });
    this.d.onTurnError(ticketId, text, event.id);
  }
}
