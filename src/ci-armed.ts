// Armed for CI (#715): a minion leaves a card or a Taskmaster message to go out once CI passes on the commit it pushed,
// so "CI passed" starts no turn just to relay it. CI failing, CI on another head or a turn still running falls back to
// today's wake, with a line saying what wasn't sent. Schemes that land with land.sh run no PR CI, so they can't arm.
import { createHash, randomBytes } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cardHref } from './card-links.ts';
import { gitOut } from './git.ts';
import type { Store, Ticket, TicketState } from './db.ts';
import type { Delivery, NewDelivery } from './db/deliveries.ts';
import type { Outbox, Outcome } from './outbox.ts';
import { runsOnPullRequest, type PrSnapshot } from './github.ts';
import { HttpError, type App } from './http.ts';
import { NOTIFY_STATES } from './push.ts';
import { ensureCoordinator } from './routes/projects.ts';

export interface Card { questions: unknown[]; kind?: 'merge'; /** Set on a feeder's go card: the build it merges into (Merge, not Ship It). */ into?: number; /** A machine job's go card (#857): only its machine's owner or an admin answers it. */ job?: number; /** A kit sync's ship card (#1100): the kit commit; the server answers it, with no turn. */ kitSync?: string; /** Its recipe laid out on the card (#859): what runs, what it reads, inputs, why now. */ recipe?: object; to?: string; /** A plain ask_question card: later questions of the same turn join it (mergeCard). */ mergeable?: true; notice?: string; doc?: { path: string; title: string }; secret?: { name: string; scope: string; why?: string }; asker?: number; /** A minion's budget card past 10x (#1672): its Stop stops the turn. */ budget?: true; /** A start card (#1674): the brief's expected cost; the server acts on its answer. */ startCost?: number }
export interface Armed { sha: string; at: number; /** Set once the card is posted, so a retry of the message doesn't post it again. */ cardPosted?: true; note?: string; card?: Card; coordinator?: { text: string; urgent: boolean; wake?: boolean; need?: string } }

/** The one line the waits readout shows for an armed row. */
const armNote = (p: Pick<Armed, 'sha' | 'card' | 'coordinator'>) => `armed ${[p.card && 'card', p.coordinator && 'Taskmaster message'].filter(Boolean).join(' and ')} for CI on ${short(p.sha)}`;
export const armedKey = (ticketId: number) => `ci-armed:${ticketId}`;
const short = (sha: string) => sha.slice(0, 7);

/** Post a question card in a minion's chat, as ask_question does; returns its id and link. */
export function postCard(app: App, ticket: Ticket, card: Card): { id: string; href: string } {
  const { runner } = app;
  const { questions, kind, into, to, notice, doc, secret, asker, job, recipe, mergeable, kitSync, budget, startCost } = card;
  const id = randomBytes(6).toString('hex');
  const event = runner.emit(ticket.id, 'question', {
    id, questions, ...(kind ? { kind } : {}), ...(into ? { into } : {}), ...(job ? { job, ...(recipe ? { recipe } : {}) } : {}), ...(kitSync ? { kitSync } : {}), ...(budget ? { budget } : {}), ...(startCost ? { startCost } : {}), ...(to ? { to } : {}), ...(mergeable ? { mergeable } : {}), ...(notice ? { notice } : {}), ...(doc ? { doc } : {}), ...(secret ? { secret } : {}), ...(asker ? { asker } : {}),
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

/**
 * Send the minion's Taskmaster a message, as message_coordinator does; returns runner.relay's answer. `notice`: the server's
 * own word about the minion (its budget, #1114), which goes to the owner's and leaves the minion's reply routing for its reply.
 */
export async function tellTaskmaster(app: App, ticket: Ticket, text: string, urgent: boolean, wake = true, need?: string, notice = false) {
  const { store, runner } = app;
  await ensureCoordinator(app, store.getProject(ticket.project_id)!);
  // A reply goes to the Taskmaster that asked, else its owner's gets it as sent (#919); every other touched person's own gets held mail.
  const asked = notice ? undefined : store.getTicket(store.getSetting<number>(replyToKey(ticket.id)) ?? 0);
  if (!notice) store.deleteSetting(replyToKey(ticket.id));
  const owner = store.ownerCoordinator(ticket)!;
  // Not to a Taskmaster whose person has since left the scheme or been disabled (#1449).
  const live = asked?.coordinator_of == null || store.hearsScheme(asked.coordinator_of, ticket.project_id);
  const coordinator = asked?.kind === 'coordinator' && asked.project_id === ticket.project_id && live ? asked : owner;
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
  // A row already met is on its way for an earlier commit (a retry): a new arm is a new wait, not a change to that one.
  for (const r of store.listDeliveries({ kind: 'ci_armed', dedupe: String(ticket.id), states: ['waiting'] })) if (r.met_at != null) app.outbox!.cancel(r.id, 're-armed');
  app.outbox!.add({ project_id: ticket.project_id, kind: 'ci_armed', to_kind: 'minion', to_id: ticket.id, when_kind: 'ci', when_arg: sha, payload: { sha, at: Date.now(), ...part, note: armNote({ sha, ...part }) }, set_by: `minion:${ticket.id}`, dedupe_key: String(ticket.id) });
  const pushed = await git(ticket.cwd, ['rev-parse', `origin/${ticket.branch}`]);
  const what = part.card ? 'the card' : 'the message';
  const push = pushed === sha ? '' : ` origin/${ticket.branch} isn't at ${short(sha)} yet: push it, or CI never runs on it and ${what} never goes out.`;
  return `Armed: ${what} goes out by itself when CI passes on ${short(sha)}, with no turn for you. If CI fails or you push again first, you're woken as usual and it's dropped.${push}`;
}

/**
 * The ci_armed outbox kind (ADR 0021, step 5, #1391): a row waits on a minion for CI to pass on its sha, and goes out as the
 * armed card and/or Taskmaster message. `getApp` is a thunk: the outbox boots before the app exists, and a send that runs
 * first throws and is retried.
 */
export function registerCiArmed(getApp: () => App, store: Store, outbox: Outbox): void {
  const newRow = (ticketId: number, a: Armed, origin: string): NewDelivery => {
    const { sha, ...payload } = a;
    return { project_id: store.getTicket(ticketId)?.project_id ?? 0, kind: 'ci_armed', to_kind: 'minion', to_id: ticketId, when_kind: 'ci', when_arg: sha, payload: { sha, ...payload, note: armNote(a) }, set_by: `minion:${ticketId}`, dedupe_key: String(ticketId), origin };
  };
  outbox.register({
    kind: 'ci_armed',
    // The dual read: each old `ci-armed:<id>` key moves into the table in its own transaction that empties it: none dropped.
    // Then rows whose CI went red on their sha (no green re-run) are dropped: the watcher marks a result seen before it calls on, so a crash between leaves them.
    migrate: () => {
      for (const { key, value } of store.settingsWithPrefix<Armed>('ci-armed:')) {
        const id = Number(key.slice('ci-armed:'.length));
        if (!Number.isInteger(id) || !value?.sha) { store.deleteSetting(key); continue; }
        try {
          store.importDeliveries(key, [newRow(id, value, `${key}:${createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16)}`)], outbox.clock());
        } catch (err) {
          console.error(`ci-armed: moving ${key} failed, tried again next pass: ${(err as Error)?.message}`); // one bad key must not hold the rest
        }
      }
      for (const r of store.listDeliveries({ kind: 'ci_armed', states: ['waiting'] })) {
        const seen = store.githubSeen(r.to_id, 'pr');
        if (!seen.some((k) => k.endsWith(`:ci:${r.when_arg}:passed`)) && seen.some((k) => k.endsWith(`:ci:${r.when_arg}:failed`))) outbox.cancel(r.id, 'CI failed');
      }
    },
    // At boot only (ciFinished meets a row itself, with its checks): CI already passed on the sha while the server was down.
    ready: (r, event) => event.type === 'boot' && store.githubSeen(r.to_id, 'pr').some((k) => k.endsWith(`:ci:${r.when_arg}:passed`)),
    // A second arm on the same commit adds to it; on a new commit it replaces.
    merge: (row, incoming) => {
      const p = row.when_arg === incoming.when_arg ? { ...row.payload, ...(incoming.payload as object) } : (incoming.payload as Armed);
      return { ...p, note: armNote(p) };
    },
    describe: (r) => r.payload.note,
    deliver: async (rows) => {
      const out: Outcome[] = [];
      for (const r of rows) out.push(await sendArmed(r).catch((err): Outcome => ({ state: 'retry', reason: String(err?.message ?? err) })));
      return out;
    },
  });
  async function sendArmed(r: Delivery): Promise<Outcome> {
    const app = getApp();
    const ticket = app.store.getTicket(r.to_id);
    if (!ticket) return { state: 'drop', reason: 'minion deleted' };
    const armed = r.payload as Armed;
    if (armed.card && !armed.cardPosted) {
      postCard(app, ticket, armed.card);
      if (armed.coordinator) store.updateDelivery(r.id, { payload: { ...r.payload, cardPosted: true } }, ['sending']); // a retry of the message must not post the card again
    }
    // A message the loop guard holds is saved by it, and a person's Continue sends it: accepted, not retried (each retry would queue a copy).
    if (armed.coordinator) {
      const { text, urgent, wake, need } = armed.coordinator;
      await tellTaskmaster(app, ticket, text, urgent, wake !== false, need);
    }
    // A card is people's turn to answer, which the list shows by itself; a message alone leaves the merge to a person.
    const state: TicketState | null = armed.card ? null : 'ready';
    const note = `CI passed on ${short(armed.sha)}: ${armed.card ? 'card posted' : 'told the Taskmaster'}`;
    app.store.updateTicket(ticket.id, { state, note });
    app.runner.broadcastTicket(ticket.id);
    // The note just written, never read back (#1634): a read that gives up on the write queue answers from the row before it.
    if (state && NOTIFY_STATES[state]) app.notify(ticket.id, { kind: 'state', state, note });
    return { state: 'accepted' };
  }
}

/**
 * The GitHub watcher saw CI finish on a minion's PR head. With nothing armed: null. Otherwise the armed row is used up:
 * `fired` when it was handed to the outbox to go out (the CI line then goes to held mail), or a `note` on why it was dropped, for the wake.
 */
export async function ciFinished(app: App, ticket: Ticket, pr: PrSnapshot, result: 'passed' | 'failed'): Promise<{ fired: boolean; note: string } | null> {
  const { store, runner, outbox } = app;
  const [row] = store.listDeliveries({ kind: 'ci_armed', dedupe: String(ticket.id), states: ['waiting'] });
  if (!row || !outbox) return null;
  const armed = row.payload as Armed;
  const what = [armed.card && 'card', armed.coordinator && 'Taskmaster message'].filter(Boolean).join(' and ');
  const dropped = (why: string) => (outbox.cancel(row.id, why), { fired: false, note: `The ${what} you armed for CI on ${short(armed.sha)} wasn't sent: ${why}. Post it yourself if it still holds.` });
  if (armed.sha !== pr.headSha) return dropped(`the PR's head is now ${short(pr.headSha)}`);
  if (result === 'failed') return dropped('CI failed');
  if (runner.isRunning(ticket.id) || runner.queued(ticket.id)) return dropped('a turn was running');
  if (!outbox.meet(row.id)) return null;
  return { fired: true, note: `Your armed ${what} is going out.` };
}
