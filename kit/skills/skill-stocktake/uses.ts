// Counts skill loads and agent starts in this account's Claude Code transcripts over the last N days
// (default 30): `node uses.ts [days]`. Each tool call is counted once by its id, since a transcript
// can log the same call more than once, and only calls whose own timestamp is in the window count.
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const days = Number(process.argv[2] ?? 30);
const cutoff = Date.now() - days * 86_400_000;
const seen = new Set<string>();
const counts = new Map<string, number>();

function walk(dir: string): void {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.jsonl') && statSync(p).mtimeMs >= cutoff) scan(p);
  }
}

function scan(file: string): void {
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.includes('"tool_use"')) continue;
    let ev: { timestamp: string; message?: { content?: ({ type?: string; id: string; name?: string; input?: { skill?: string; subagent_type?: string } } | null)[] } };
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (!(Date.parse(ev.timestamp) >= cutoff) || !Array.isArray(ev.message?.content)) continue;
    for (const c of ev.message.content) {
      if (c?.type !== 'tool_use' || seen.has(c.id)) continue;
      const name = c.name === 'Skill' ? c.input?.skill : c.name === 'Agent' ? `agent:${c.input?.subagent_type ?? 'general-purpose'}` : null;
      if (!name) continue;
      seen.add(c.id);
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
}

walk(join(homedir(), '.claude', 'projects'));
for (const [name, n] of [...counts].sort((a, b) => b[1] - a[1])) console.log(`${String(n).padStart(5)}  ${name}`);
