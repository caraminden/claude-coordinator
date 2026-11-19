// The hash log (#878): what each turn was launched with, as a short hash per part, kept on its row in `turns`
// (Store.promptHashes reads it back). A turn whose cache missed shows which part changed since the turn before.
import { createHash } from 'node:crypto';
import type { PromptSections } from './prompts.ts';

export interface PromptHashes {
  /** system-prompt.md's parts (promptParts().system). */
  system: Record<string, string>;
  /** The turn message's opening [System] note (promptParts().turn). */
  turn: Record<string, string>;
  /** The env vars that shape the thread MCP server's tool list or what its tools refuse (TOOL_INPUTS), as launched. */
  tools: Record<string, string>;
  model: string | null;
  effort: string | null;
  payer: number | null;
  /** Claude Code's version, from the turn's init event; absent on a Codex turn. */
  claude?: string;
}

/** The env vars src/mcp.ts reads to decide its tool list and refusals. */
export const TOOL_INPUTS = ['COORDINATOR_ROLE', 'COORDINATOR_APPROVALS', 'COORDINATOR_DEPLOYS', 'COORDINATOR_CONTAINER', 'COORDINATOR_APP_INSTRUCTIONS', 'COORDINATOR_HOME_CONTRAPTIONS', 'COORDINATOR_MACHINES', 'COORDINATOR_MEMORY', 'COORDINATOR_MEDIA', 'COORDINATOR_CODEX_IMAGES', 'COORDINATOR_APP_TURNS_RUN', 'COORDINATOR_MSG'];

export const shortHash = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 10);

/** A hash for each non-empty part, under its name. */
export const hashSections = (parts: PromptSections): Record<string, string> =>
  Object.fromEntries(Object.entries(parts).filter(([, lines]) => lines.length).map(([name, lines]) => [name, shortHash(lines.join('\n'))]));

/** A launch's hashes, from its prompt's two halves, its env and its settings. */
export function promptHashes(parts: { system: PromptSections; turn: PromptSections }, env: Record<string, string>, model: string | null, effort: string | null, payer: number | null): PromptHashes {
  const tools = Object.fromEntries(TOOL_INPUTS.filter((k) => env[k] !== undefined).map((k) => [k.replace(/^COORDINATOR_/, '').toLowerCase(), shortHash(env[k])]));
  return { system: hashSections(parts.system), turn: hashSections(parts.turn), tools, model, effort, payer };
}
