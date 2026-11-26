// Armed hand-offs (#2046; Josh, 2026-11-25, picked "Start" on #2031's "Hand off once, ship when ready"): a minion hands
// off once, and the server ships it when its trigger comes, with no turn, through Ship It's guards (#1930, shipPrepared).
// The trigger here is the pipeline lane: a pipeline change from a minion that doesn't hold it joins the lane's queue by
// itself, marked ready (#1985), and ships when the lane passes to it or it is let in beside the holder (ShipLane). It
// fires once: a refusal wakes the minion and never re-arms.
// #2089 adds two triggers hand_off_land names with `when`: "proof" ships once the flake proof on the armed commit goes green
// (CI health's wake for a run the minion dispatched, fireProof), and {live} once another minion's work or a commit is live,
// as wake_when_live checks it (LiveWaiters' check, fireLive). Either one that meets the pipeline lane then waits there.
import { APP_NAME } from './appname.ts';
import { armedKey } from './db-keys.ts';
import type { Ticket } from './db.ts';
import type { ChangeBy } from './db/wait-records.ts';
import type { Run } from './ci-health.ts';
import { workflowFile } from './ci-problems.ts';
import { gitOut } from './git.ts';
import { HttpError, type App } from './http.ts';
import { laneRefusal, shipPrepared } from './ship-handoff.ts';
import { holdsLane, pipelineChanges, SHIP_LANE } from './ship-lane.ts';
import { thrown } from './thrown.ts';

const LANE = SHIP_LANE;

/** A hand-off kept for its trigger (settings, armedKey). */
export interface Armed {
  when: 'lane' | 'proof' | 'live';
  /** when 'live': the commit, or the minion (id and number, with follow()'s base and since), it waits on. */
  live?: { commit: string } | { after: number; number: number; base: string | null; since: number };
  /** hand_off_land's arguments, the go included. */
  args: Record<string, unknown>;
  /** The commit it was checked at: a branch that moved since doesn't ship. */
  head: string;
  /** Its chat line: nobody may write after it. */
  event: number;
  /** Whose login it ships on (a Ship It press); null: the minion's own. */
  person: number | null;
  at: number;
}

/** The minions list's note while it waits. */
export const ARMED_NOTE = 'armed: ships when the lane is yours';
export const PROOF_NOTE = 'armed: ships when the proof is green';
const liveNote = (what: string) => `armed: ships when ${what} is live`;
const isArmedNote = (note: string | null | undefined) => !!note?.startsWith('armed: ships when ');
const liveWhat = (on: NonNullable<Armed['live']>) => ('commit' in on ? `\`${on.commit.slice(0, 7)}\`` : `#${on.number}`);
/** The flake-proof workflow (#1120, src/flakes.ts), in any scheme that has one. */
const PROOF_WORKFLOW = 'flake-proof.yml';

const keeperMail = (app: App, ticket: Ticket, text: string) => {
  const keeper = app.store.getOverlord(ticket.project_id);
  if (keeper) app.runner.leaveMail(keeper.id, `#${ticket.number} ${ticket.title}`, text);
};

/** A free lane goes to a pipeline ship: with nobody waiting there is no order to keep. True when the minion holds it now. */
export function takeFreeLane(app: App, ticket: Ticket): boolean {
  const { claims } = app.store;
  if (claims.get(ticket.project_id, LANE)) return false;
  if (claims.take(ticket.project_id, LANE, ticket.id, APP_NAME, 'free, so taken to ship').held) return false;
  keeperMail(app, ticket, `(nothing to do) ${LANE} was free, so it went to #${ticket.number} ${ticket.title} to ship its pipeline change.`);
  app.broadcast({ type: 'claims', projectId: ticket.project_id });
  return true;
}

/** Arm a lane ship: the minion goes to the end of the lane's queue (or keeps its place) and its hand-off waits there. What to tell it. */
export function armForLane(app: App, ticket: Ticket, args: Record<string, unknown>, head: string, person: number | null, who: string, by: ChangeBy = { kind: 'server' }): string {
  const { store, runner } = app;
  const pid = ticket.project_id;
  const waiting = store.claims.waiting(pid, LANE);
  if (!waiting.includes(ticket.id)) store.claims.setQueue(pid, LANE, [...waiting, ticket.id], APP_NAME);
  // Ready (#1985): a holder slow to hand off is skipped for it, and it may be let in beside one it shares no file with.
  store.claims.setReady(pid, LANE, ticket.id);
  const place = store.claims.waiting(pid, LANE).indexOf(ticket.id) + 1;
  const holder = store.getTicket(store.claims.get(pid, LANE)?.holder ?? 0);
  const where = `number ${place} in the pipeline lane's queue${holder ? ` (#${holder.number} holds it)` : ''}`;
  const ev = runner.emit(ticket.id, 'note', { text: `${ARMED_NOTE}. ${who} handed it off; it is ${where}, and ${APP_NAME} ships it then with no turn, unless someone writes here, a turn runs or the branch moves first.` });
  store.setSetting(armedKey(ticket.id), { when: 'lane', args, head, event: ev.id, person, at: Date.now() } satisfies Armed);
  store.updateTicket(ticket.id, { state: 'outside', note: ARMED_NOTE }, by);
  runner.broadcastTicket(ticket.id);
  app.broadcast({ type: 'claims', projectId: pid });
  keeperMail(app, ticket, `(nothing to do unless the order should change) #${ticket.number} ${ticket.title} joined the ${LANE} queue by itself, ${where}: its hand-off is armed and ships when the lane passes to it. Reorder the queue to change that.`);
  return `It is ${where}; the server ships it when the lane passes to you, with no turn of yours. End your turn now and don't hand off again. If something rules the ship out then (someone wrote to you, a turn of yours runs, your branch moved, or a check refuses), you are woken with why.`;
}

/**
 * A person or Taskmaster sets a claim's queue (the page, the queue tool), and the page hears. One taken out of the pipeline lane's queue with
 * a hand-off armed for it would wait for a lane that never comes: it is disarmed and woken to say so.
 */
export function setClaimQueue(app: App, projectId: number, name: string, queue: number[], by: string) {
  const { store } = app;
  const before = name === LANE ? store.claims.waiting(projectId, LANE) : [];
  store.claims.setQueue(projectId, name, queue, by);
  app.broadcast({ type: 'claims', projectId });
  for (const id of before) {
    const t = store.getTicket(id);
    if (!t || queue.includes(id) || holdsLane(store.claims, t) || store.getSetting<Armed>(armedKey(id))?.when !== 'lane') continue;
    store.deleteSetting(armedKey(id));
    if (isArmedNote(t.note)) store.updateTicket(id, { state: null, note: null }, { kind: 'server' });
    app.runner.send(id, APP_NAME, `${by} took you out of the pipeline lane's queue, so your armed hand-off won't ship by itself. Ask the Taskmaster (message_coordinator) when you may ship: handing off again puts you at the end of the queue.`);
  }
}

/**
 * hand_off_land's lane (#2046): a plain ship to main that changes a pipeline file, from a minion that doesn't hold the
 * lane, is armed instead of started (a free lane is taken). Null: ship now. Else what to tell the minion. An outage fix
 * and a rolled-back deploy's fix jump the line, as the lane's rule says; a merge into a build isn't a ship to main (a
 * build's own ship to main is).
 */
export async function laneHandoff(app: App, ticket: Ticket, body: Record<string, unknown>): Promise<string | null> {
  if (body.into !== undefined || body.outage === true || body.fix === true) return null;
  const why = await laneRefusal(app, ticket);
  // None, or git can't tell (no main to diff against): it ships, as such a hand-off always did.
  if (!why || !(await pipelineChanges(ticket.cwd!))?.length) return null;
  const head = await gitOut(['rev-parse', 'HEAD'], ticket.cwd!);
  if (!head) throw new HttpError(409, "Not handed off: git couldn't read your worktree's commit");
  // Read again after the git calls: the lane may have passed to it meanwhile, with nothing armed to fire.
  if (holdsLane(app.store.claims, ticket) || takeFreeLane(app, ticket)) return null;
  return `Armed, not started: ${why}. ${armForLane(app, ticket, body, head, null, 'You', { kind: 'minion' })}`;
}

/**
 * `claim` passed to `ticketId` (Closing.claimPassed), or it was let in beside the holder (ShipLane.letIn): ship its
 * armed hand-off now, with no turn. True when it had one (the line that would wake it isn't sent); `fallback` sends
 * that line, with why, if the ship is ruled out.
 */
export function fireArmed(app: App, ticketId: number, claim: string, fallback: (why: string) => void, started = `The pipeline lane is yours, so ${APP_NAME} started your armed hand-off with no turn.`): boolean {
  if (claim !== LANE) return false;
  const armed = app.store.getSetting<Armed>(armedKey(ticketId));
  if (armed?.when !== 'lane') return false;
  return fire(app, ticketId, armed, started, fallback);
}

/**
 * Ship `armed` now, with no turn, through Ship It's guards. Once: the key goes first, a refusal calls `fallback` with why
 * and never re-arms. A proof or live trigger that meets the pipeline lane takes it when free, else waits in its queue
 * (armForLane): that is the next trigger, not a second try. False when the minion is gone.
 */
function fire(app: App, ticketId: number, armed: Armed, started: string, fallback: (why: string) => void): boolean {
  const ticket = app.store.getTicket(ticketId);
  if (!ticket) return false;
  app.store.deleteSetting(armedKey(ticketId)); // once: a refusal wakes it, and only its next hand-off arms again
  const failed = (why: string) => {
    if (isArmedNote(app.store.getTicket(ticketId)?.note)) app.store.updateTicket(ticketId, { state: null, note: null }, { kind: 'server' });
    fallback(why);
  };
  // Anyone at all, not only a person as for a Ship It press: a Taskmaster's "hold that" or a wake (a turn of its) counts.
  const wrote = () => {
    const e = app.store.eventsOfKinds(ticketId, ['user_message'], armed.event)[0];
    return e ? `${JSON.parse(e.data).author} wrote to you after you armed it` : null;
  };
  const ship = () => shipPrepared(app, ticket, armed, { since: armed.event, what: 'you armed it', person: armed.person, by: { kind: 'server' }, still: wrote });
  (async () => {
    let why = await ship();
    const toLane = armed.when !== 'lane' && why !== null && typeof why !== 'string';
    if (toLane && (holdsLane(app.store.claims, ticket) || takeFreeLane(app, ticket))) why = await ship();
    if (why === null) app.runner.emit(ticketId, 'note', { text: started });
    else if (typeof why === 'string') failed(why);
    else if (toLane) armForLane(app, ticket, armed.args, armed.head, armed.person, 'You', { kind: 'server' });
    else failed(why.lane);
  })().catch((err) => failed(thrown(err).message!));
  return true;
}

/** Arm a hand-off on its trigger (proof or live): it waits, with the chat line and the list's note naming the wait. What to tell the minion. */
function armFor(app: App, ticket: Ticket, armed: Omit<Armed, 'event' | 'at' | 'person'>, note: string, then: string): string {
  const ev = app.runner.emit(ticket.id, 'note', { text: `${note}. You handed it off; ${APP_NAME} ships it ${then} with no turn, unless someone writes here, a turn runs or the branch moves first.` });
  app.store.setSetting(armedKey(ticket.id), { ...armed, event: ev.id, person: null, at: Date.now() } satisfies Armed);
  app.store.updateTicket(ticket.id, { state: 'outside', note }, { kind: 'minion' });
  app.runner.broadcastTicket(ticket.id);
  return `Armed, not started: the server ships it ${then}, with no turn of yours (a pipeline change then waits for the pipeline lane by itself). End your turn now and don't hand off again. If something rules the ship out then (someone wrote to you, a turn of yours runs, your branch moved, or a check refuses), you are woken with why.`;
}

/**
 * hand_off_land's `when` (#2089): "proof" or {live: "#N" | "<commit>"} arms the hand-off on that trigger instead of
 * starting it. Null: no `when`, or what it waits on is live already, so it ships now. Else what to tell the minion.
 */
export async function triggerHandoff(app: App, ticket: Ticket, body: Record<string, unknown>): Promise<string | null> {
  const { when, ...args } = body;
  if (when === undefined) return null;
  const live = when && typeof when === 'object' && !Array.isArray(when) ? (when as { live?: unknown }).live : undefined;
  if (when !== 'proof' && typeof live !== 'string') throw new HttpError(400, 'Not handed off: when is "proof" or {"live": "#N" or a commit}');
  if (args.into !== undefined) throw new HttpError(400, 'Not handed off: a merge into a build goes at once, so leave out when');
  const head = await gitOut(['rev-parse', 'HEAD'], ticket.cwd!);
  if (!head) throw new HttpError(409, "Not handed off: git couldn't read your worktree's commit");
  if (when === 'proof') return armFor(app, ticket, { when: 'proof', args, head }, PROOF_NOTE, `once the ${PROOF_WORKFLOW} run on \`${head.slice(0, 7)}\` goes green`);
  const { store, waiters } = app;
  let on: NonNullable<Armed['live']>;
  const n = /^#?(\d+)$/.exec(String(live).trim());
  if (n) {
    const leader = store.getTicketByNumber(ticket.project_id, Number(n[1]));
    if (!leader || leader.kind === 'coordinator') throw new HttpError(404, `Not handed off: there is no minion #${n[1]} in this scheme`);
    if (leader.id === ticket.id) throw new HttpError(400, 'Not handed off: a hand-off waits on another minion, not your own');
    const f = await waiters.follow(leader.id, 'live');
    if (f.state === 'unshipped') throw new HttpError(409, `Not handed off: #${leader.number} was dismissed without shipping, so its work will never be live`);
    if (f.state === 'go') return null;
    on = { after: leader.id, number: leader.number ?? Number(n[1]), base: f.base, since: f.since };
  } else {
    const elsewhere = await waiters.elsewhere(ticket.id);
    const commit = await waiters.resolve(String(live).trim(), store.getProject(ticket.project_id)?.repo_dir ?? null, !!elsewhere);
    if (!commit) throw new HttpError(400, `Not handed off: no commit ${String(live).slice(0, 40)} in ${elsewhere ? '' : 'the live checkout or '}the scheme's repo`);
    on = { commit };
    if ((await waiters.liveState(ticket.id, on)) === 'go') return null;
  }
  return armFor(app, ticket, { when: 'live', args, head, live: on }, liveNote(liveWhat(on)), `once ${liveWhat(on)} is live`);
}

/** The newest live check (each deploy and dismissal, LiveWaiters.armed): ship each hand-off armed on what is live now. How many fired. */
export async function fireLive(app: App): Promise<number> {
  const { store, waiters } = app;
  let fired = 0;
  for (const { key, value } of store.settingsWithPrefix<Armed>(armedKey(0).replace(/0$/, ''))) {
    if (value.when !== 'live' || !value.live) continue;
    const id = Number(key.slice(key.lastIndexOf(':') + 1));
    const t = store.getTicket(id);
    if (!t || t.status === 'closed') continue;
    const state = await waiters.liveState(id, value.live);
    // Read again after git: a hand-off since, or a dismissal, replaced or dropped it.
    const now = store.getSetting<Armed>(armedKey(id));
    if (state === 'wait' || now?.event !== value.event) continue;
    const what = liveWhat(value.live);
    if (state === 'unshipped') {
      store.deleteSetting(armedKey(id));
      if (isArmedNote(store.getTicket(id)?.note)) store.updateTicket(id, { state: null, note: null }, { kind: 'server' });
      app.runner.send(id, APP_NAME, `${what} was dismissed without shipping, so the hand-off you armed on it being live won't ship by itself. Decide whether to ship without it.`);
      continue;
    }
    if (fire(app, id, now, `${what}'s work is live, so ${APP_NAME} started your armed hand-off with no turn.`, (why) => app.runner.send(id, APP_NAME, `${what} is live now.\n\nYour armed hand-off didn't ship by itself: ${why}. Hand it off again once it's ready.`))) fired++;
  }
  return fired;
}

/**
 * CI health's wake for a finished run the minion dispatched (#678), first offered here (#2089): a flake-proof run while a
 * hand-off is armed on its proof. Green on the armed commit ships it; any other end on that commit drops it and wakes the
 * minion with the run; a run on another commit is a chat note, since it proves nothing about what is armed (held mail would
 * count as someone writing, and rule the armed ship out). True when it
 * took the run, so CI health's own wake isn't sent.
 */
export function fireProof(app: App, ticketId: number, run: Pick<Run, 'path' | 'name' | 'head_sha' | 'conclusion'>, text: string): boolean {
  const armed = app.store.getSetting<Armed>(armedKey(ticketId));
  if (armed?.when !== 'proof' || workflowFile(run as Run) !== PROOF_WORKFLOW) return false;
  const short = armed.head.slice(0, 7);
  if (run.head_sha !== armed.head) {
    app.runner.emit(ticketId, 'note', { text: `${text}\n\n(It ran on \`${String(run.head_sha).slice(0, 7)}\`, not \`${short}\`, the commit your armed hand-off waits on, so it changes nothing there.)` });
    return true;
  }
  if (run.conclusion === 'success') return fire(app, ticketId, armed, `The flake proof on ${short} went green, so ${APP_NAME} started your armed hand-off with no turn.`, (why) => app.runner.send(ticketId, APP_NAME, `${text}\n\nYour armed hand-off didn't ship by itself: ${why}. Hand it off again once it's ready.`));
  app.store.deleteSetting(armedKey(ticketId));
  if (isArmedNote(app.store.getTicket(ticketId)?.note)) app.store.updateTicket(ticketId, { state: null, note: null }, { kind: 'server' });
  app.runner.send(ticketId, APP_NAME, `${text}\n\nYour armed hand-off is off: the proof wasn't green. Fix it, prove it again and hand off again.`);
  return true;
}
