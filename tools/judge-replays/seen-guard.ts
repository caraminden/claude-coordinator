// The seen guard (kit/hooks/seen.ts, #1920) over the kept transcripts of minions' own sessions, with no database: the hook
// itself runs on every finished Bash and Read call in order, on the scheme's repo as main held it when the call ran.
import { execFileSync } from 'node:child_process';
import { createReadStream, globSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { finished } from 'node:stream/promises';
import { afterCompact, seenHook } from '../../kit/hooks/seen.ts';
import { jsonLines } from '../../src/json-lines.ts';
import type { HookInput } from '../../kit/hooks/hook-input.ts';
import type { Act, ReplayCtx, ReplayResult } from './types.ts';

interface Row {
  type?: string;
  subtype?: string;
  timestamp?: string;
  cwd?: string;
  isSidechain?: boolean;
  toolUseResult?: HookInput['tool_response'];
  message?: { content?: string | { type?: string; id?: string; name?: string; input?: Record<string, unknown>; tool_use_id?: string; is_error?: boolean }[] };
}

/** A file of a minion's worktree as its scheme's main held it at a time (the minion's own edits are not in it). */
export function mainAt(): (path: string, at: number) => string | null {
  const revs = new Map<string, string>();
  const texts = new Map<string, string | null>();
  const git = (repo: string, ...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 26 });
  return (path, at) => {
    const m = /^(.*\/projects\/\d+)\/tickets\/\d+\/(.+)$/.exec(path);
    if (!m) return null;
    const repo = join(m[1], 'repo');
    const slot = Math.floor(at / 1_800_000);
    const key = `${repo} ${slot}`;
    try {
      if (!revs.has(key)) revs.set(key, git(repo, 'rev-list', '-1', `--before=${new Date(slot * 1_800_000).toISOString()}`, 'main').trim());
      const id = `${revs.get(key)}:${m[2]}`;
      if (!texts.has(id)) {
        let text: string | null = null;
        try {
          if (git(repo, 'cat-file', '-t', id).trim() === 'blob') text = git(repo, 'show', id);
        } catch {
          // not a file then
        }
        texts.set(id, text && text.length < 2_000_000 && !text.slice(0, 8000).includes('\0') ? text : null);
      }
      return texts.get(id) ?? null;
    } catch {
      return null;
    }
  };
}

export interface Step {
  at: number;
  win: number;
  tool: string;
  what: string;
  /** Chars the call printed, and chars it prints with the guard. */
  was: number;
  is: number;
  lines: string[];
}

/** One session's calls through the guard. */
export async function session(file: string, mainText: (path: string, at: number) => string | null): Promise<{ steps: Step[]; compacts: { at: number; text: string }[] }> {
  const stateDir = mkdtempSync(join(tmpdir(), 'seen-replay-'));
  const steps: Step[] = [];
  const compacts: { at: number; text: string }[] = [];
  const uses = new Map<string, { name: string; input: Record<string, unknown> }>();
  try {
    const stream = createReadStream(file);
    jsonLines<Row>(stream, (e) => {
      if (e.isSidechain) return;
      const at = Date.parse(e.timestamp ?? '') || steps.at(-1)?.at || 0;
      const files = { read: (p: string) => mainText(p, at), stateDir, now: at };
      const cwd = dirname(file).replace(/.*-(projects)-(\d+)-tickets-(\d+)$/, `${join(homedir(), '.local/share/claude-coordinator')}/$1/$2/tickets/$3`);
      const base = { session_id: basename(file, '.jsonl'), cwd: e.cwd ?? cwd };
      if (e.type === 'system' && e.subtype === 'compact_boundary') compacts.push({ at, text: afterCompact(base, files, stateDir) });
      if (!Array.isArray(e.message?.content)) return;
      for (const b of e.message.content) {
        if (b.type === 'tool_use' && b.id && (b.name === 'Bash' || b.name === 'Read')) uses.set(b.id, { name: b.name, input: b.input ?? {} });
        const use = b.type === 'tool_result' ? uses.get(b.tool_use_id ?? '') : undefined;
        if (!use || b.is_error || typeof e.toolUseResult !== 'object') continue;
        const r = e.toolUseResult as { stdout?: string; file?: { content?: string } };
        const text = r.file?.content ?? r.stdout ?? '';
        const out = seenHook({ ...base, hook_event_name: 'PostToolUse', tool_name: use.name, tool_input: use.input, tool_response: e.toolUseResult }, files);
        const o = out ? JSON.parse(out).hookSpecificOutput : {};
        const after: string = o.updatedToolOutput ? (o.updatedToolOutput.file?.content ?? o.updatedToolOutput.stdout) : text;
        const said = (o.updatedToolOutput ? after : '').split('\n').filter((l: string) => l.startsWith('[seen] '));
        if (o.additionalContext) said.push(o.additionalContext);
        steps.push({ at, win: compacts.length, tool: use.name, what: String(use.input.command ?? use.input.file_path ?? '').slice(0, 200), was: text.length, is: after.length + (o.additionalContext?.length ?? 0), lines: said });
      }
    });
    await finished(stream);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
  return { steps, compacts };
}

export async function replay(ctx: ReplayCtx): Promise<ReplayResult> {
  process.env.COORDINATOR_SHARED_DIR = ''; // a replay writes no retro log
  const since = ctx.now - ctx.days * 86_400_000;
  const root = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects');
  const files = globSync('*-tickets-*/*.jsonl', { cwd: root })
    .map((f) => join(root, f))
    .filter((f) => statSync(f).mtimeMs > since && (ctx.scheme === null || f.includes(`-projects-${ctx.scheme}-tickets-`)));
  const text = mainAt();
  const hits: Act[] = [];
  let calls = 0;
  let was = 0;
  let is = 0;
  for (const file of files) {
    const id = Number(/-tickets-(\d+)$/.exec(dirname(file))?.[1]);
    if (!id) continue;
    for (const s of (await session(file, text)).steps) {
      if (s.at <= since) continue;
      calls++;
      was += s.was;
      is += s.is;
      if (s.lines.length) hits.push({ at: s.at, key: `${id}:${basename(file).slice(0, 8)}:${s.at}`, text: `${s.tool} ${s.what.slice(0, 80)}: ${s.was} → ${s.is} chars. ${s.lines[0].slice(0, 160)}` });
    }
  }
  return {
    inputs: `${files.length} minion sessions, ${calls} Bash and Read calls, ${Math.round(was / 1000)}k chars printed, ${Math.round(is / 1000)}k with the guard`,
    hits,
    real: [],
    limits: ["files are main's at the time: lines the minion had edited, and files outside its worktree, never match, so this undercounts", 'only transcripts this login can read', 'a model that is refused a repeat may do something else; the transcript goes on as it did'],
  };
}
