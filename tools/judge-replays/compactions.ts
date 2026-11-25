// The compaction callout (src/compactions.ts, #1920) over the kept transcripts of minions' own sessions, with no database:
// CompactWatch itself reads each session's calls and compactions in order. A turn can't be told from the next in a
// transcript, so the count runs on over a session; the 15-minute rule splits the bursts. It never acted before #1920, so real is empty.
import { createReadStream, globSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { CompactWatch } from '../../src/compactions.ts';
import type { ClaudeEvent } from '../../src/claude-events.ts';
import type { Ticket } from '../../src/db.ts';
import type { Act, ReplayCtx, ReplayResult } from './types.ts';

interface Row {
  type?: string;
  subtype?: string;
  timestamp?: string;
  isSidechain?: boolean;
  compactMetadata?: { durationMs?: number };
  message?: ClaudeEvent['message'];
}

export async function replay(ctx: ReplayCtx): Promise<ReplayResult> {
  const since = ctx.now - ctx.days * 86_400_000;
  const root = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects');
  const files = globSync('*-tickets-*/*.jsonl', { cwd: root })
    .map((f) => join(root, f))
    .filter((f) => statSync(f).mtimeMs > since && (ctx.scheme === null || f.includes(`-projects-${ctx.scheme}-tickets-`)));
  const hits: Act[] = [];
  let compactions = 0;
  for (const file of files) {
    const id = Number(/-tickets-(\d+)$/.exec(dirname(file))?.[1]);
    if (!id) continue;
    let at = 0;
    const watch = new CompactWatch({
      ticket: () => ({ id, number: id, title: '', kind: 'ticket', status: 'running' }) as Ticket,
      tell: (_t, text, wake) => at > since && hits.push({ at, key: `${id}:${basename(file).slice(0, 8)}:${at}`, text: `${wake ? 'WAKES ' : 'mail '}${text.split('\n')[1]}` }),
      note: () => {},
      now: () => at,
    });
    for await (const line of createInterface({ input: createReadStream(file) })) {
      let e: Row;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      if (e.isSidechain) continue;
      if (e.timestamp) at = Date.parse(e.timestamp);
      const compacted = e.type === 'system' && e.subtype === 'compact_boundary';
      if (compacted && at > since) compactions++;
      watch.observe(id, { ...e, compact_metadata: { duration_ms: e.compactMetadata?.durationMs } } as ClaudeEvent);
    }
  }
  return {
    inputs: `${files.length} minion sessions, ${compactions} compactions`,
    hits,
    real: [],
    limits: ['a session is one count here, where live each turn starts its own', 'only transcripts this login can read', 'a Taskmaster or closed minion is not left out by its record, only by its folder'],
  };
}
