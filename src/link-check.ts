// The link check: a Stop hook the runner adds to every turn (linkCheckHooks in runner.ts), for
// Taskmasters and minions alike. Before a turn ends it reads the reply's file links with the server's
// own linkedPaths and resolveFile (src/artifacts.ts), against the folders the chat serves them from
// (ticketRoots in routes/files.ts), and sends the reply back once if any link wouldn't open. The
// same send-back carries the wording check's findings (src/wording.ts): a reserved word used in another sense,
// and the cross-scheme link check's (src/scheme-refs.ts): a bare #N that likely means another scheme's minion.
//
// Run as a hook: node link-check.ts '<config json>' < Stop hook input; prints a "block" decision or nothing.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fileType, findByName, linkedPaths, resolveFile } from './artifacts.ts';
import { explainStrays, readRefs, strayRefs } from './scheme-refs.ts';
import { CODE, explain, misusedWords } from './wording.ts';

export interface LinkCheckConfig {
  /** The turn's working directory, which relative links resolve against (not the hook's cwd, which follows a `cd`). */
  cwd: string;
  /** The folders the chat may show files from: the working directory and the shared folders. */
  roots: string[];
  /** A file in the turn's folder marking that this turn's reply was sent back once already. */
  nudged?: string;
  /** The scheme's minions and the other schemes' names (SchemeRefs in src/scheme-refs.ts), a file in the turn's folder. */
  refs?: string;
}

/** How a send-back starts, which the runner looks for to swap the reply for its rewrite (Runner.replaceSentBack). */
export const SENT_BACK = 'Your reply was sent back before people saw it.';

/** The files `text` links that the chat would show as a card or preview but can't open, as absolute paths. */
export async function brokenLinks(text: string, cfg: LinkCheckConfig): Promise<string[]> {
  const broken: string[] = [];
  // Only servable file types: a link to source code or a folder is plain text in the chat, not a card.
  for (const abs of linkedPaths([text.replace(CODE, '')], cfg.cwd)) {
    if (fileType(abs) && !(await resolveFile(abs, cfg.cwd, cfg.roots))) broken.push(abs);
  }
  return broken;
}

/** The prompt the marker says was nudged, or null if none was. */
function readMarker(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** The Stop hook's answer for this input: a block with the reason, or null to let the turn end. */
export async function check(input: { stop_hook_active?: boolean; last_assistant_message?: string; prompt_id?: string }, cfg: LinkCheckConfig) {
  // One nudge per prompt (a steered turn holds several), noted in the turn's own marker:
  // stop_hook_active is also set by any other Stop hook's block (the kit's job check), which once
  // let a broken link through (#243).
  const prompt = String(input.prompt_id ?? '');
  if (!input.last_assistant_message || (cfg.nudged ? readMarker(cfg.nudged) === prompt : input.stop_hook_active)) return null;
  const broken = await brokenLinks(input.last_assistant_message, cfg);
  const misused = misusedWords(input.last_assistant_message);
  const refs = readRefs(cfg.refs);
  const strays = refs ? strayRefs(input.last_assistant_message, refs) : [];
  if (!broken.length && !misused.length && !strays.length) return null;
  if (cfg.nudged) {
    try {
      writeFileSync(cfg.nudged, prompt);
    } catch {
      // No marker to stop the next try, so stop_hook_active has to.
      if (input.stop_hook_active) return null;
    }
  }
  const lines = await Promise.all(broken.map(async (abs) => {
    // The one file of its name the chat can show, which the rewrite most likely meant (#281).
    const match = await findByName(abs, cfg.roots);
    return `- ${abs}: ${existsSync(abs) ? 'outside the folders the chat can show' : 'no such file'}${match ? `. Did you mean ${match}?` : ''}`;
  }));
  const links = broken.length
    ? `These file links in your reply won't open in the chat:\n${lines.join('\n')}\n`
      + `Relative links resolve against your working directory ${cfg.cwd}; absolute paths are safest. `
      + `Files must be inside ${cfg.roots.length > 1 ? `it or ${cfg.roots.slice(1).join(' or ')}` : 'it'}. `
      + 'Fix the paths (or drop links to files that are gone).\n'
    : '';
  const wording = misused.length ? `${explain(misused)}\n` : '';
  const scheme = strays.length ? `${explainStrays(strays, refs!.scheme)}\n` : '';
  return { decision: 'block', reason: `${SENT_BACK}\n${links}${wording}${scheme}Write the reply again in full.` };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const verdict = await check(JSON.parse(readFileSync(0, 'utf8')), JSON.parse(process.argv[2]));
    if (verdict) process.stdout.write(JSON.stringify(verdict));
  } catch {
    // A check that can't run never holds up the turn.
  }
}
