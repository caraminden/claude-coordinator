// The link check: a Stop hook the runner adds to every turn (linkCheckHooks in turn-launch.ts), for
// Taskmasters and minions alike. Before a turn ends it reads the reply's file links with the server's
// own linkedPaths and resolveFile (src/artifacts.ts), against the folders the chat serves them from
// (ticketRoots in routes/files.ts), and sends the reply back once if any link wouldn't open. The
// same send-back carries the wording check's findings (src/wording.ts): a reserved word used in another sense,
// the cross-scheme link check's (src/scheme-refs.ts): a bare #N that likely means another scheme's minion,
// the card link check's (src/card-links.ts): a card waiting on people mentioned without its link, or
// linked as "above" or "below" when it sits the other way, or one already answered linked as still waiting, and the page check: a linked HTML page with an
// answer button of its own instead of the mock kit's Send dock (#417).
//
// Run as a hook: node link-check.ts '<config json>' < Stop hook input; prints a "block" decision or nothing.
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fileType, findByName, linkedPaths, resolveFile } from './artifacts.ts';
import { explainCards, explainMisplaced, explainStale, misplacedCards, staleCards, unlinkedCards } from './card-links.ts';
import { explainStrays, readRefs, strayRefs } from './scheme-refs.ts';
import { takeStatus } from './status-trailer.ts';
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
/** The whole answer that keeps a sent-back reply as it was, so a false alarm costs a word, not a rewrite (#404). */
export const KEEP = 'KEEP';

/** The files `text` links that the chat would show as a card or preview but can't open, as absolute paths. */
export async function brokenLinks(text: string, cfg: LinkCheckConfig): Promise<string[]> {
  const broken: string[] = [];
  // Only servable file types: a link to source code or a folder is plain text in the chat, not a card.
  for (const abs of linkedPaths([text.replace(CODE, '')], cfg.cwd)) {
    if (fileType(abs) && !(await resolveFile(abs, cfg.cwd, cfg.roots))) broken.push(abs);
  }
  return broken;
}

// Clipboard use or a send of the page's own: the kit's dock (mockkit.js, a file beside the page) is the only answer button.
const HAND_ROLLED = /navigator\.clipboard|execCommand\(\s*['"]copy['"]|citadel\.send\s*\(/;
const MAX_PAGE_BYTES = 2 * 1024 * 1024;

/** The HTML pages `text` links that hand-roll an answer or copy button, as absolute paths. */
/** Whether the page, or a local script it loads other than the kit's own mockkit.js, has an answer or copy button of its own. */
function rolledOwn(file: string): boolean {
  if (statSync(file).size > MAX_PAGE_BYTES) return false;
  const html = readFileSync(file, 'utf8');
  if (HAND_ROLLED.test(html)) return true;
  for (const [, src] of html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"':?#]+)["']/gi)) {
    if (basename(src) === 'mockkit.js') continue;
    try {
      const js = join(dirname(file), src);
      if (statSync(js).size <= MAX_PAGE_BYTES && HAND_ROLLED.test(readFileSync(js, 'utf8'))) return true;
    } catch {
      // A missing script is the page's own problem.
    }
  }
  return false;
}

export async function handRolledPages(text: string, cfg: LinkCheckConfig): Promise<string[]> {
  const pages: string[] = [];
  for (const abs of linkedPaths([text.replace(CODE, '')], cfg.cwd)) {
    if (fileType(abs)?.kind !== 'html') continue;
    const found = await resolveFile(abs, cfg.cwd, cfg.roots);
    try {
      if (found && rolledOwn(found.file)) pages.push(abs);
    } catch {
      // Unreadable: the broken-link check speaks for it.
    }
  }
  return pages;
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
  // The status line (#711) is hidden from the chat, and its note can't hold a link: only what people read is checked.
  const reply = takeStatus(input.last_assistant_message ?? '').text;
  if (!reply || (cfg.nudged ? readMarker(cfg.nudged) === prompt : input.stop_hook_active)) return null;
  const broken = await brokenLinks(reply, cfg);
  const misused = misusedWords(reply);
  const refs = readRefs(cfg.refs);
  const strays = refs ? strayRefs(reply, refs) : [];
  const cards = refs?.cards ? unlinkedCards(reply, refs.cards, refs.self ?? null) : [];
  const misplaced = refs?.cards ? misplacedCards(reply, refs.cards, refs.self ?? null) : [];
  const stale = refs?.settled ? staleCards(reply, refs.settled) : [];
  const rolled = await handRolledPages(reply, cfg);
  if (!broken.length && !misused.length && !strays.length && !cards.length && !misplaced.length && !stale.length && !rolled.length) return null;
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
  const pages = rolled.length
    ? `These pages have an answer or copy button of their own (navigator.clipboard, execCommand('copy') or citadel.send):\n${rolled.map((p) => `- ${p}`).join('\n')}\n`
      + 'People answer a page only through the mock kit\'s Send dock, which posts straight into your chat: ask with mock.picks instead '
      + '(citadel:docs-and-mocks skill, mockkit.md), fix the pages, then rewrite the reply. A clipboard use that is no answer button can stay.\n'
    : '';
  const wording = misused.length ? `${explain(misused)}\n` : '';
  const scheme = strays.length ? `${explainStrays(strays, refs!.scheme)}\n` : '';
  const card = (cards.length ? `${explainCards(cards, refs!.self ?? null)}\n` : '') + (misplaced.length ? `${explainMisplaced(misplaced)}\n` : '')
    + (stale.length ? `${explainStale(stale, refs!.self ?? null)}\n` : '');
  return { decision: 'block', reason: `${SENT_BACK}\n${links}${pages}${wording}${scheme}${card}Write the reply again in full, or, if nothing above needs changing, answer with just ${KEEP}: your first reply then stands as written.` };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const verdict = await check(JSON.parse(readFileSync(0, 'utf8')), JSON.parse(process.argv[2]));
    if (verdict) process.stdout.write(JSON.stringify(verdict));
  } catch {
    // A check that can't run never holds up the turn.
  }
}
