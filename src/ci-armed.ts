// Armed for CI (#715): a minion leaves a card or a Taskmaster message to go out once CI passes on the commit it pushed,
// so "CI passed" starts no turn just to relay it. CI failing, CI on another head or a turn still running falls back to
// today's wake, with a line saying what wasn't sent. Schemes that land with land.sh run no PR CI, so they can't arm.
import { randomBytes } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cardHref } from './card-links.ts';
import { gitOut } from './git.ts';
import type { Ticket, TicketState } from './db.ts';
import { runsOnPullRequest, type PrSnapshot } from './github.ts';
import { HttpError, type App } from './http.ts';
import { NOTIFY_STATES } from './push.ts';
import { ensureCoordinator } from './routes/projects.ts';

export interface Card { questions: unknown[]; kind?: 'merge'; /** Set on a feeder's go card: the build it merges into (Merge, not Ship It). */ into?: number; /** A machine job's go card (#857): only its machine's owner or an admin answers it. */ job?: number; /** Its recipe laid out on the card (#859): what runs, what it reads, inputs, why now. */ recipe?: object; to?: string; /** A plain ask_question card: later questions of the same turn join it (mergeCard). */ mergeable?: true; notice?: string; doc?: { path: string; title: string }; secret?: { name: string; scope: string; why?: string }; asker?: number }
export interface Armed { sha: string; at: number; card?: Card; coordinator?: { text: string; urgent: boolean; wake?: boolean; need?: string } }

export const armedKey = (ticketId: number) => `ci-armed:${ticketId}`;
const short = (sha: string) => sha.slice(0, 7);

/** Post a question card in a minion's chat, as ask_question does; returns its id and link. */
export function postCard(app: App, ticket: Ticket, card: Card): { id: string; href: string } {
  const { runner } = app;
  const { questions, kind, into, to, notice, doc, secret, asker, job, recipe, mergeable } = card;
  const id = randomBytes(6).toString('hex');
  const event = runner.emit(ticket.id, 'question', {
    id, questions, ...(kind ? { kind } : {}), ...(into ? { into } : {}), ...(job ? { job, ...(recipe ? { recipe } : {}) } : {}), ...(to ? { to } : {}), ...(mergeable ? { mergeable } : {}), ...(notice ? { notice } : {}), ...(doc ? { doc } : {}), ...(secret ? { secret } : {}), ...(asker ? { asker } : {}),
  });
  runner.broadcastTicket(ticket.id);
  app.notify(ticket.id, { kind: 'question', questions: notice ? [{ question: notice }] : doc ? [{ question: `Make your picks on “${doc.title}”` }] : secret ? [{ question: `Save a secret as ${secret.name}` }] : questions, eventId: event.id, ...(to ? { to } : {}) });
  return { id, href: cardHref(ticket, event.id) };
}

/** Most questions one merged card holds (Cara, 2026-11-18: "Raise cap to 8"); a call still takes 4. */
export const CARD_MAX = 8;

/**
 * A question card a turn asks while its own earlier plain card is still unanswered joins that card instead of posting a
 * second one (Cara, 2026-11-18: "Merge a turn's cards"; Taskmasters too, for_everyone cards included). `chat` is where
 * the card lives, `asker` the thread whose turn asks. Returns the first card's id and link, or null when nothing merges:
 * only a card marked mergeable, with the same `to` and asker, posted in this turn, not answered, settled or full.
 */
export function mergeCard(app: App, chat: Ticket, asker: Ticket, card: Card): { id: string; href: string; merged: true } | null {
  const { store, runner } = app;
  const started = runner.turnStartedAt(asker.id);
  if (started == null || !card.mergeable) return null;
  const from = asker.id === chat.id ? undefined : asker.id;
  const open = store.eventsOfKinds(chat.id, ['question']).reverse().find((e) => {
    const d = JSON.parse(e.data);
    return d.mergeable && d.asker === from && d.to === card.to && e.created_at >= started;
  });
  if (!open) return null;
  const data = JSON.parse(open.data);
  if (data.settled || data.questions.length + card.questions.length > CARD_MAX) return null;
  if (store.eventsOfKinds(chat.id, ['user_message'], open.id).some((e) => JSON.parse(e.data).answer?.questionId === data.id)) return null;
  const questions = [...data.questions, ...card.questions];
  store.setEventData(open.id, { ...data, questions });
  // The full list rides along, so a page that replays both the card and this event adds only what it lacks.
  runner.emit(chat.id, 'question_more', { id: data.id, questions });
  runner.broadcastTicket(chat.id);
  return { id: data.id, href: cardHref(chat, open.id), merged: true };
}

/** The Taskmaster that last wrote to a minion (#919): its next message_coordinator goes there, once. */
export const replyToKey = (ticketId: number) => `minion_reply_to:${ticketId}`;

/** Send the minion's Taskmaster a message, as message_coordinator does; returns runner.relay's answer. */
export async function tellTaskmaster(app: App, ticket: Ticket, text: string, urgent: boolean, wake = true, need?: string) {
  const { store, runner } = app;
  await ensureCoordinator(app, store.getProject(ticket.project_id)!);
  // A reply goes to the Taskmaster that asked, else its owner's gets it as sent (#919); every other touched person's own gets held mail.
  const asked = store.getTicket(store.getSetting<number>(replyToKey(ticket.id)) ?? 0);
  store.deleteSetting(replyToKey(ticket.id));
  const owner = store.ownerCoordinator(ticket)!;
  const coordinator = asked?.kind === 'coordinator' && asked.project_id === ticket.project_id ? asked : owner;
  const author = `#${ticket.number} ${ticket.title}`;
  const held = runner.relay(ticket.id, coordinator.id, author, text, urgent, wake, need);
  if (held !== true) {
    for (const tm of new Map([owner, ...store.touchedBy(ticket).map((uid) => store.coordinatorFor(ticket.project_id, uid))].map((t) => [t?.id, t])).values()) {
      if (tm && (tm.coordinator_of != null || tm.id === owner.id) && tm.id !== coordinator.id) runner.leaveMail(tm.id, author, text);
    }
  }
  if (held !== true) runner.emit(ticket.id, 'note', { ...(need ? { need } : {}), text: `${held ? 'Left held mail for' : 'Sent'} the Taskmaster: ${text.length > 200 ? text.slice(0, 200) + '…' : text}` });
  return held;
}

const git = (cwd: string, args: string[]) => gitOut(args, cwd);

async function prCi(cwd: string): Promise<boolean> {
  const dir = join(cwd, '.github', 'workflows');
  const files = await readdir(dir).catch(() => [] as string[]);
  for (const f of files.filter((f) => /\.ya?ml$/.test(f))) if (runsOnPullRequest(await readFile(join(dir, f), 'utf8').catch(() => ''))) return true;
  return false;
}

/**
 * Arm a card or a Taskmaster message for when CI passes on the worktree's HEAD. Returns what to tell the minion, or null
 * when CI already passed on HEAD, so the caller posts it now. A second arm on the same commit replaces that part only.
 */
export async function armForCi(app: App, ticket: Ticket, part: Pick<Armed, 'card' | 'coordinator'>): Promise<string | null> {
  const { store } = app;
  if (!ticket.cwd || !ticket.branch) throw new HttpError(400, 'when_ci_passes needs a minion on a branch');
  if (!(await prCi(ticket.cwd))) throw new HttpError(400, "when_ci_passes: this repo's CI doesn't run on pull requests, so no PR CI result will come. Post it now without when_ci_passes");
  const sha = await git(ticket.cwd, ['rev-parse', 'HEAD']);
  if (!sha) throw new HttpError(500, "when_ci_passes: couldn't read the worktree's HEAD");
  const seen = store.githubSeen(ticket.id, 'pr');
  // Passed wins over failed: a re-run that went green after a red one.
  if (seen.some((k) => k.endsWith(`:ci:${sha}:passed`))) return null;
  if (seen.some((k) => k.endsWith(`:ci:${sha}:failed`))) throw new HttpError(409, `when_ci_passes: CI already failed on ${short(sha)}. Fix it and push, then arm again`);
  const prev = store.getSetting<Armed>(armedKey(ticket.id));
  store.setSetting(armedKey(ticket.id), { ...(prev?.sha === sha ? prev : {}), sha, at: Date.now(), ...part });
  const pushed = await git(ticket.cwd, ['rev-parse', `origin/${ticket.branch}`]);
  const what = part.card ? 'the card' : 'the message';
  const push = pushed === sha ? '' : ` origin/${ticket.branch} isn't at ${short(sha)} yet: push it, or CI never runs on it and ${what} never goes out.`;
  return `Armed: ${what} goes out by itself when CI passes on ${short(sha)}, with no turn for you. If CI fails or you push again first, you're woken as usual and it's dropped.${push}`;
}

/**
 * The GitHub watcher saw CI finish on a minion's PR head. With nothing armed: null. Otherwise the armed record is used up:
 * `fired` when its card or message went out (the CI line then goes to held mail), or a `note` on why it didn't, for the wake.
 */
export async function ciFinished(app: App, ticket: Ticket, pr: PrSnapshot, result: 'passed' | 'failed'): Promise<{ fired: boolean; note: string } | null> {
  const { store, runner } = app;
  const armed = store.getSetting<Armed>(armedKey(ticket.id));
  if (!armed) return null;
  store.deleteSetting(armedKey(ticket.id));
  const what = [armed.card && 'card', armed.coordinator && 'Taskmaster message'].filter(Boolean).join(' and ');
  const dropped = (why: string) => ({ fired: false, note: `The ${what} you armed for CI on ${short(armed.sha)} wasn't sent: ${why}. Post it yourself if it still holds.` });
  if (armed.sha !== pr.headSha) return dropped(`the PR's head is now ${short(pr.headSha)}`);
  if (result === 'failed') return dropped('CI failed');
  if (runner.isRunning(ticket.id) || runner.queued(ticket.id)) return dropped('a turn was running');
  // All of it out is a firing; anything that didn't go out wakes the minion, saying what did.
  const sent: string[] = [];
  const failed: string[] = [];
  if (armed.card) {
    try {
      sent.push(`The card you armed is posted: ${postCard(app, ticket, armed.card).href}`);
    } catch (err: any) {
      failed.push(`the card (${err.message})`);
    }
  }
  if (armed.coordinator) {
    const { text, urgent, wake, need } = armed.coordinator;
    try {
      if ((await tellTaskmaster(app, ticket, text, urgent, wake !== false, need)) === true) failed.push('the Taskmaster message (held by the 6-in-10-minutes guard)');
      else sent.push('Your armed message went to the Taskmaster.');
    } catch (err: any) {
      failed.push(`the Taskmaster message (${err.message})`);
    }
  }
  if (failed.length) return { fired: false, note: `CI passed on ${short(armed.sha)}. ${sent.join(' ')}${sent.length ? ' ' : ''}Not sent: ${failed.join(', ')}. Post it yourself if it still holds.` };
  // A card is people's turn to answer, which the list shows by itself; a message alone leaves the merge to a person.
  const state: TicketState | null = armed.card ? null : 'ready';
  store.updateTicket(ticket.id, { state, note: `CI passed on ${short(armed.sha)}: ${armed.card ? 'card posted' : 'told the Taskmaster'}` });
  runner.broadcastTicket(ticket.id);
  if (state && NOTIFY_STATES[state]) app.notify(ticket.id, { kind: 'state', state, note: store.getTicket(ticket.id)!.note });
  return { fired: true, note: sent.join(' ') };
}
// shortcut: a record armed on a PR that then merges or closes, or on a minion that's dismissed, stays in settings until the
// next arm or CI result on that minion; fine while records are a few hundred bytes each. Clear them on close if that grows.
