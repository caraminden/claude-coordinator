// The review gate (#1938): a ship is handed off only once a reviewer has read it. Josh, 2026-11-25, on #1938's card,
// picked "Refuse every one": "It's ok for no human to review, but we should ALWAYS have at least minion reviews". Until
// then a hook only logged it, and 204 of 326 low ships over four days went out with no reviewer at all.
// Every scheme that ships with hand_off_land or the land tool; a pull-request ship never passes here.
import { isCodexModel } from './codex.ts';
import type { Store } from './db.ts';
import { parseShipNote } from './ship-risk.ts';
import { offSkills } from './skills.ts';

type Block = { type?: string; id?: string; name?: string; tool_use_id?: string; is_error?: boolean; input?: { subagent_type?: unknown; command?: unknown; run_in_background?: unknown } };
type ClaudeRow = { type?: string; parent_tool_use_id?: string | null; message?: { model?: string; content?: unknown } };

/**
 * Whether a call runs a review: the kit's reviewer as a Grunt, or on a Codex turn, which has no Grunts, citadel-codex-review.
 * Opening the self-review skill isn't one.
 */
function isReview(b: Block, model?: string): boolean {
  // A background call answers at once, before anything was read.
  if (b.type !== 'tool_use' || b.input?.run_in_background === true) return false;
  if (b.name === 'Agent' || b.name === 'Task') return /(?:^|:)reviewer$/.test(String(b.input?.subagent_type ?? ''));
  const cmd = String(b.input?.command ?? '');
  return b.name === 'Bash' && isCodexModel(model) && /\bcitadel-codex-review\b/.test(cmd) && !/--(?:check|help|image-gen)\b/.test(cmd);
}

/**
 * The reviews since the minion's last ship or merge into a build (any, when it has none): whether one came back, and
 * whether a Codex turn's failed (its plan is nearly used, or Codex reviews aren't set up), where nothing else can review.
 */
export function reviewsSinceShip(store: Store, ticketId: number): { done: boolean; codexFailed: boolean } {
  // shortcut: commits made after the review aren't compared with what it read; a fix of its findings is the usual one.
  let after = 0;
  for (const e of store.db.prepare("SELECT id, json_extract(data, '$.text') AS text FROM events WHERE ticket_id = ? AND kind = 'note' ORDER BY id DESC").iterate(ticketId) as Iterable<{ id: number; text: string | null }>) {
    if (!parseShipNote(e.text ?? '')) continue;
    after = e.id;
    break;
  }
  const rows = store.db.prepare("SELECT data FROM events WHERE ticket_id = ? AND id > ? AND kind = 'claude' AND (data LIKE '%reviewer%' OR data LIKE '%citadel-codex-review%' OR data LIKE '%\"tool_result\"%') ORDER BY id").iterate(ticketId, after) as Iterable<{ data: string }>;
  const open = new Map<string, boolean>();
  let codexFailed = false;
  for (const { data } of rows) {
    const e = JSON.parse(data) as ClaudeRow;
    for (const b of (Array.isArray(e.message?.content) ? e.message.content : []) as Block[]) {
      if (e.type === 'assistant' && b?.id && isReview(b, e.message?.model)) open.set(b.id, b.name === 'Bash');
      else if (e.type === 'user' && b?.type === 'tool_result' && b.tool_use_id && open.has(b.tool_use_id)) {
        if (!b.is_error) return { done: true, codexFailed };
        if (open.get(b.tool_use_id)) codexFailed = true;
      }
    }
  }
  return { done: false, codexFailed };
}

/** A ship's refusal for having no review, or null. Not a build's take-in of main, nor a scheme whose people switched the review off. */
export function reviewRefusal(store: Store, ticket: { id: number; project_id: number }, args: string[], go = false): string | null {
  if (args.includes('--full')) return null;
  const pre = store.reviews.kit(ticket.project_id, 'pre-ship-review');
  const project = store.getProject(ticket.project_id);
  if ((pre && !pre.enabled) || (project && offSkills(project).includes('self-review'))) return null;
  const { done, codexFailed } = reviewsSinceShip(store, ticket.id);
  // A Codex turn that tried and couldn't be reviewed has no other reviewer, so a person decides.
  if (done || (codexFailed && go)) return null;
  return 'Not handed off: no reviewer has read this change. Every ship is reviewed first, whatever its size or risk (Josh, 2026-11-25: "we should ALWAYS have at least minion reviews"). Run citadel:self-review: start its citadel:reviewer Grunt in the foreground (on a Codex turn, citadel-codex-review; when that fails, ask a person with a ship card and name their go), fix what is real, then hand off again. A review from before your last ship does not count, and opening the skill is not a review';
}
