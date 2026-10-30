// The link check: a Stop hook the runner adds to every turn (linkCheckHooks in runner.ts), for
// Taskmasters and minions alike. Before a turn ends it reads the reply's file links with the server's
// own linkedPaths and resolveFile (src/artifacts.ts), against the folders the chat serves them from
// (ticketRoots in routes/files.ts), and sends the reply back once if any link wouldn't open.
//
// Run as a hook: node link-check.ts '<config json>' < Stop hook input; prints a "block" decision or nothing.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fileType, linkedPaths, resolveFile } from './artifacts.ts';

export interface LinkCheckConfig {
  /** The turn's working directory, which relative links resolve against (not the hook's cwd, which follows a `cd`). */
  cwd: string;
  /** The folders the chat may show files from: the working directory and the shared folders. */
  roots: string[];
}

/** Text the chat renders as code, where a "[x](y)" is not a link. */
const CODE = /^ {0,3}(```|~~~)[^\n]*\n[\s\S]*?(?:\n {0,3}\1[^\n]*|$)|(`+)(?!`)[\s\S]*?[^`]\2(?!`)/gm;

/** The files `text` links that the chat would show as a card or preview but can't open, as absolute paths. */
export async function brokenLinks(text: string, cfg: LinkCheckConfig): Promise<string[]> {
  const broken: string[] = [];
  // Only servable file types: a link to source code or a folder is plain text in the chat, not a card.
  for (const abs of linkedPaths([text.replace(CODE, '')], cfg.cwd)) {
    if (fileType(abs) && !(await resolveFile(abs, cfg.cwd, cfg.roots))) broken.push(abs);
  }
  return broken;
}

/** The Stop hook's answer for this input: a block with the reason, or null to let the turn end. */
export async function check(input: { stop_hook_active?: boolean; last_assistant_message?: string }, cfg: LinkCheckConfig) {
  // Second try: the reply was sent back once already; let it end rather than loop.
  if (input.stop_hook_active || !input.last_assistant_message) return null;
  const broken = await brokenLinks(input.last_assistant_message, cfg);
  if (!broken.length) return null;
  const lines = broken.map((abs) => `- ${abs}: ${existsSync(abs) ? 'outside the folders the chat can show' : 'no such file'}`);
  return {
    decision: 'block',
    reason: `These file links in your reply won't open in the chat:\n${lines.join('\n')}\n`
      + `Relative links resolve against your working directory ${cfg.cwd}; absolute paths are safest. `
      + `Files must be inside ${cfg.roots.length > 1 ? `it or ${cfg.roots.slice(1).join(' or ')}` : 'it'}. `
      + 'Fix the paths (or drop links to files that are gone) and write the reply again in full.',
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const verdict = await check(JSON.parse(readFileSync(0, 'utf8')), JSON.parse(process.argv[2]));
    if (verdict) process.stdout.write(JSON.stringify(verdict));
  } catch {
    // A check that can't run never holds up the turn.
  }
}
