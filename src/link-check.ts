// The link check: a Stop hook the runner adds to every turn (linkCheckHooks in turn-launch.ts), for
// Taskmasters and minions alike. Before a turn ends it reads the reply's file links with the server's
// own linkedPaths and resolveFile (src/artifacts.ts), against the folders the chat serves them from
// (ticketRoots in routes/files.ts), and sends the reply back once if any link wouldn't open. The
// same send-back carries the wording check's findings (src/wording.ts): a reserved word used in another sense,
// the cross-scheme link check's (src/scheme-refs.ts): a bare #N that likely means another scheme's minion,
// the card link check's (src/card-links.ts): a card waiting on people mentioned without its link, or
// linked as "above" or "below" when it sits the other way, or one already answered linked as still waiting, the page check: a linked HTML page with an
// answer button of its own instead of the mock kit's Send dock (#417), the choices check: a linked page with pick bars that no card opens (#804),
// and the card check: a choice asked in prose when the turn posted no card and the status line has no reply button (#806).
//
// Run as a hook: node link-check.ts '<config json>' < Stop hook input; prints a "block" decision or nothing.
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { choicesPage, fileType, findByName, linkedPaths, resolveFile } from './artifacts.ts';
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

/** The page's text and that of the local scripts it loads, less the kit's own mockkit.js. */
function pageText(file: string): string {
  if (statSync(file).size > MAX_PAGE_BYTES) return '';
  const html = readFileSync(file, 'utf8');
  let text = html;
  for (const [, src] of html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"':?#]+)["']/gi)) {
    if (basename(src) === 'mockkit.js') continue;
    try {
      const js = join(dirname(file), src);
      if (statSync(js).size <= MAX_PAGE_BYTES) text += `\n${readFileSync(js, 'utf8')}`;
    } catch {
      // A missing script is the page's own problem.
    }
  }
  return text;
}

// A copy with nothing a person does to start it (#1086): Windows Defender's ClickFix check flags a page that fills the
// clipboard on its own, and Chrome lets a framed page with clipboard rights do it with no click.
// shortcut: any click or key handler on the page counts as the copy's, so a page that has both a button and a copy on
// load passes; parse the script if a page like that turns up.
const COPY = /navigator\.clipboard\.write|execCommand\(\s*['"]copy['"]/;
const CLICK = /\bon(click|keydown|keyup|pointerup|mouseup)\b|addEventListener\(\s*['"](click|keydown|keyup|pointerup|mouseup)['"]/i;

export async function handRolledPages(text: string, cfg: LinkCheckConfig): Promise<string[]> {
  const pages: string[] = [];
  for (const abs of linkedPaths([text.replace(CODE, '')], cfg.cwd)) {
    if (fileType(abs)?.kind !== 'html') continue;
    const found = await resolveFile(abs, cfg.cwd, cfg.roots);
    try {
      const text = found ? pageText(found.file) : '';
      if (HAND_ROLLED.test(text)) pages.push(COPY.test(text) && !CLICK.test(text) ? `${abs}: copies with no click or key press to start it` : abs);
    } catch {
      // Unreadable: the broken-link check speaks for it.
    }
  }
  return pages;
}

/** The choices pages (#804) `text` links whose path no card in `docs` opens, as absolute paths. */
export async function cardlessChoices(text: string, cfg: LinkCheckConfig, docs: Set<string>): Promise<string[]> {
  const pages: string[] = [];
  for (const abs of linkedPaths([text.replace(CODE, '')], cfg.cwd)) {
    if (fileType(abs)?.kind !== 'html') continue;
    const found = await resolveFile(abs, cfg.cwd, cfg.roots);
    if (!found || docs.has(found.abs) || found.size > MAX_PAGE_BYTES) continue;
    try {
      if (choicesPage(readFileSync(found.file, 'utf8'))) pages.push(abs);
    } catch {
      // Unreadable: the broken-link check speaks for it.
    }
  }
  return pages;
}

// The sentences that ask a choice (measured on 14 days of replies in #803's audit: precision about 0.8). Named limit: "I can build a fresh one if you want to play them" slips through.
const DIRECT = /(^should\b[^?]*\?|\bwant me to|\bshould I|\bshall I|\bdo you want|would you like|which (one|of these|do you|would you|should)|ok(ay)? to (merge|land|ship|start|close|delete|go)|(want|like) (a|the|that|me)\b[^.?!\n]{0,90}\?|or (should|do|would|shall) (I|we)|(go|merge|land|ship|start) (it|them|now)\?)/i;
const OFFER = /(?<!(\b(it|they|he|she|will|'ll|would|and)\s))\b((just )?say (the word|go|so|which)|let me know (which|if|whether)|tell me (which|if|whether)|if you('d| would)? (want|like|prefer)\b[^.\n]{0,80}(say|tell|I('ll| can| will))|(it's|is|that's) your call\b)/i;
const QUOTED = /"[^"\n]*"|“[^”\n]*”/g;
const CARD_TOOLS = /^mcp__[a-z-]+__(ask_question|propose_plan|propose_machine_notes|propose_host_tool|make_release_key)$/;

/** Whether this turn (the transcript after its last real prompt) called a card tool; null if the transcript can't be read. */
function postedCard(transcript?: string): boolean | null {
  if (!transcript) return null;
  try {
    let posted = false;
    for (const l of readFileSync(transcript, 'utf8').split('\n')) {
      if (!l) continue;
      const e = JSON.parse(l);
      const content = e.message?.content;
      if (e.type === 'user' && !e.isMeta && !(Array.isArray(content) && content.some((c: any) => c?.type === 'tool_result'))) posted = false;
      else if (e.type === 'assistant' && Array.isArray(content) && content.some((c: any) => c?.type === 'tool_use' && CARD_TOOLS.test(c.name))) posted = true;
    }
    return posted;
  } catch {
    return null;
  }
}

/** The sentence in the reply's last two paragraphs that asks a choice, when no card, link to one or reply button answers it; else null. */
export function proseChoice(text: string, status: { replies?: unknown } | null, transcript?: string): string | null {
  const tail = text.replace(CODE, '').replace(QUOTED, '').trim().split(/\n\s*\n/).slice(-2).join('\n\n');
  if (/\]\(#\/p\/\d+\/t\/\d+\?e=\d+\)|nothing needed from you/i.test(tail)) return null;
  if (Array.isArray(status?.replies) && status.replies.length) return null;
  const hit = tail.split(/(?<=[.?!])\s+|\n/).find((s) => DIRECT.test(s) || OFFER.test(s));
  return hit && postedCard(transcript) === false ? hit.trim() : null;
}

const CLOSING = /\b(closing (this|the) minion|closing (it |this minion )?(out|down) (this minion|myself)|i(?:'ll| will| am|'m) (?:now )?(?:close|dismiss) (?:this minion|myself)|dismissing (this minion|myself)|(?:ready|about) to close (?:this minion|myself)|done, ready to close)\b/i;

/** Whether this turn's close_self call was answered without an error: true, false (called, refused), null (not called), or undefined (unreadable). */
function closeSelfOk(transcript?: string): boolean | null | undefined {
  if (!transcript) return undefined;
  try {
    let called: boolean | null = false;
    const ids = new Map<string, boolean>();
    for (const l of readFileSync(transcript, 'utf8').split('\n')) {
      if (!l) continue;
      const e = JSON.parse(l);
      const content = e.message?.content;
      if (!Array.isArray(content)) { if (e.type === 'user' && !e.isMeta) { called = false; ids.clear(); } continue; }
      if (e.type === 'user' && !e.isMeta && !content.some((c: any) => c?.type === 'tool_result')) { called = false; ids.clear(); continue; }
      for (const c of content) {
        if (c?.type === 'tool_use' && /^mcp__[a-z-]+__close_self$/.test(c.name)) { ids.set(c.id, false); called = true; }
        else if (c?.type === 'tool_result' && ids.has(c.tool_use_id)) ids.set(c.tool_use_id, !c.is_error);
      }
    }
    return [...ids.values()].some(Boolean) || (called ? false : null);
  } catch {
    return undefined;
  }
}

/** Why a reply that says the minion is closing is false (no working close_self, or a status line that cancels it), or null (#809). */
export function closingClaim(text: string, status: { state?: unknown } | null, transcript?: string, self?: number | null): string | null {
  if (!transcript || self === null) return null; // a Taskmaster has no close_self
  const tail = text.replace(CODE, '').replace(QUOTED, '').trim().split(/\n\s*\n/).slice(-2).join('\n\n');
  const m = tail.match(CLOSING);
  const hit = m?.[0];
  if (!m || !hit || /\b(not|never|no longer)\b|n't/i.test(tail.slice(Math.max(0, m.index! - 40), m.index!).split(/[.!?\n]/).pop()!)) return null;
  const ok = closeSelfOk(transcript);
  const state = typeof status?.state === 'string' ? status.state : null;
  if (ok && state && ['complete', 'try', 'ready'].includes(state)) return `its status line sets state ${state}, which cancels the close, so it stays open`;
  if (ok === undefined || state === 'pending-deploy') return null;
  if (!ok) return `close_self was ${ok === false ? 'refused' : 'not called'} this turn, so it stays open`;
  return null;
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
export async function check(input: { stop_hook_active?: boolean; last_assistant_message?: string; prompt_id?: string; transcript_path?: string }, cfg: LinkCheckConfig) {
  // One nudge per prompt (a steered turn holds several), noted in the turn's own marker:
  // stop_hook_active is also set by any other Stop hook's block (the kit's job check), which once
  // let a broken link through (#243).
  const prompt = String(input.prompt_id ?? '');
  // The status line (#711) is hidden from the chat, and its note can't hold a link: only what people read is checked.
  const { text: reply, status } = takeStatus(input.last_assistant_message ?? '');
  if (!reply || (cfg.nudged ? readMarker(cfg.nudged) === prompt : input.stop_hook_active)) return null;
  const broken = await brokenLinks(reply, cfg);
  const misused = misusedWords(reply);
  const refs = readRefs(cfg.refs);
  const strays = refs ? strayRefs(reply, refs) : [];
  const cards = refs?.cards ? unlinkedCards(reply, refs.cards, refs.self ?? null) : [];
  const misplaced = refs?.cards ? misplacedCards(reply, refs.cards, refs.self ?? null) : [];
  const stale = refs?.settled ? staleCards(reply, refs.settled) : [];
  const rolled = await handRolledPages(reply, cfg);
  const docs = new Set([...(refs?.cards ?? []), ...(refs?.settled ?? [])].flatMap((c) => (c.doc ? [c.doc] : [])));
  const choices = refs?.cards ? await cardlessChoices(reply, cfg, docs) : [];
  const asked = proseChoice(reply, status, input.transcript_path);
  const closing = closingClaim(reply, status, input.transcript_path, refs ? (refs.self ?? null) : undefined);
  if (!asked && !broken.length && !misused.length && !strays.length && !cards.length && !misplaced.length && !stale.length && !rolled.length && !choices.length && !closing) return null;
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
      + '(citadel:docs-and-mocks skill, mockkit.md), fix the pages, then rewrite the reply. A clipboard use that is no answer button can stay, '
      + 'if a click or key press starts it: a page that fills the clipboard on its own trips Windows Defender\'s ClickFix check.\n'
    : '';
  const choice = choices.length
    ? `These pages ask with pick bars, but no card in the chat opens them:\n${choices.map((p) => `- ${p}`).join('\n')}\n`
      + 'A choices page always comes with its card: call ask_question with doc set to the page\'s path (and no questions), so it waits on people '
      + 'like any card and its Send settles it, then rewrite the reply with the card\'s link. A page linked only to show picks already made can stay.\n'
    : '';
  const ask = asked
    ? `Your reply asks a choice in prose ("${asked.slice(0, 120)}") and no card was posted this turn. Post it as an ask_question card (or a status-line reply button for a lone go), `
      + `or answer ${KEEP} if nobody has a choice to make.\n`
    : '';
  const close = closing
    ? `Your reply says this minion is closing, but ${closing}. Words don't close it: call close_self (state null in the status line, no card open), or rewrite the line to say plainly why it stays open `
      + '(for example "Staying open in state ready for you to do X").\n'
    : '';
  const wording = misused.length ? `${explain(misused)}\n` : '';
  const scheme = strays.length ? `${explainStrays(strays, refs!.scheme)}\n` : '';
  const card = (cards.length ? `${explainCards(cards, refs!.self ?? null)}\n` : '') + (misplaced.length ? `${explainMisplaced(misplaced)}\n` : '')
    + (stale.length ? `${explainStale(stale, refs!.self ?? null)}\n` : '');
  return { decision: 'block', reason: `${SENT_BACK}\n${links}${pages}${choice}${ask}${close}${wording}${scheme}${card}Write the reply again in full, or, if nothing above needs changing, answer with just ${KEEP}: your first reply then stands as written.` };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const verdict = await check(JSON.parse(readFileSync(0, 'utf8')), JSON.parse(process.argv[2]));
    if (verdict) process.stdout.write(JSON.stringify(verdict));
  } catch {
    // A check that can't run never holds up the turn.
  }
}
