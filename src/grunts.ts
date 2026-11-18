// A turn's Grunts (#948): Claude Code keeps each one's transcript and a small meta file under
// <config dir>/projects/<cwd slug>/<session>/subagents/, next to the session's own transcript. A container
// turn's config dir is its home volume, which the host sees too, so those read the same way.
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { usageCost } from './spend-alert.ts';
import { projectSlug, validSessionId } from './sessions.ts';

export interface GruntRow {
  agent_id: string;
  agent_type: string | null;
  model: string | null;
  effort: string | null;
  calls: number;
  cost_usd: number;
  request_shape: string | null;
  spawn_depth: number | null;
  description: string | null;
}

const text = (v: unknown, max = 200) => (typeof v === 'string' && v ? v.slice(0, max) : null);
const FIELDS = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'] as const;

/** One Grunt from its transcript's lines: usage counts once per message id (the blocks of a message repeat it, the largest wins). */
function oneGrunt(agentId: string, meta: any, transcript: string): GruntRow {
  const messages = new Map<string, { model: string; usage: any }>();
  let effort: string | null = null;
  for (const line of transcript.split('\n')) {
    if (!line.includes('"usage"')) continue;
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const m = o?.message;
    if (o?.type !== 'assistant' || !m?.usage || typeof m.id !== 'string') continue;
    effort ??= text(o.effort, 20);
    const was = messages.get(m.id);
    const usage: any = { ...(was?.usage ?? m.usage), ...m.usage };
    for (const f of FIELDS) usage[f] = Math.max(Number(was?.usage?.[f]) || 0, Number(m.usage[f]) || 0);
    if (m.usage.cache_creation || was?.usage?.cache_creation) {
      const a = was?.usage?.cache_creation ?? {}, b = m.usage.cache_creation ?? {};
      usage.cache_creation = { ephemeral_5m_input_tokens: Math.max(a.ephemeral_5m_input_tokens ?? 0, b.ephemeral_5m_input_tokens ?? 0), ephemeral_1h_input_tokens: Math.max(a.ephemeral_1h_input_tokens ?? 0, b.ephemeral_1h_input_tokens ?? 0) };
    }
    messages.set(m.id, { model: String(m.model ?? ''), usage });
  }
  let cost = 0;
  const byModel = new Map<string, number>();
  for (const { model, usage } of messages.values()) {
    cost += usageCost(model, usage);
    byModel.set(model, (byModel.get(model) ?? 0) + 1);
  }
  const model = [...byModel].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  return {
    agent_id: agentId, agent_type: text(meta?.agentType, 100), model, effort: text(meta?.effort, 20) ?? effort, calls: messages.size, cost_usd: cost,
    request_shape: text(meta?.requestShape, 40), spawn_depth: typeof meta?.spawnDepth === 'number' ? meta.spawnDepth : null, description: text(meta?.description),
  };
}

/** The folder holding a session's Grunt files: under the turn's working folder if it's there, else under whichever project folder has the session (a container's folders differ). */
async function subagentsDir(configDir: string, cwd: string, sessionId: string): Promise<string | null> {
  const projects = join(configDir, 'projects');
  const has = async (dir: string) => (await readdir(dir).then(() => true, () => false)) ? dir : null;
  const direct = await has(join(projects, projectSlug(cwd), sessionId, 'subagents'));
  if (direct) return direct;
  for (const slug of await readdir(projects).catch(() => [] as string[])) {
    const found = await has(join(projects, slug, sessionId, 'subagents'));
    if (found) return found;
  }
  return null;
}

/** The session's Grunts that were written to since `since` (ms; all by default), so a long session isn't re-read each turn. Empty when it started none or its files aren't under `configDir`. */
export async function readGrunts(configDir: string, cwd: string, sessionId: string, since = 0): Promise<GruntRow[]> {
  if (!validSessionId(sessionId)) return [];
  const dir = await subagentsDir(configDir, cwd, sessionId);
  if (!dir) return [];
  const rows: GruntRow[] = [];
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    const m = /^agent-(\w+)\.meta\.json$/.exec(name);
    if (!m) continue;
    try {
      if (since && (await stat(join(dir, `agent-${m[1]}.jsonl`))).mtimeMs < since) continue;
      const meta = JSON.parse(await readFile(join(dir, name), 'utf8'));
      rows.push(oneGrunt(m[1], meta, await readFile(join(dir, `agent-${m[1]}.jsonl`), 'utf8').catch(() => '')));
    } catch { /* an unreadable Grunt is skipped, not the turn */ }
  }
  return rows;
}
