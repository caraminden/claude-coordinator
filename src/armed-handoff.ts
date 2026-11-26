// Armed hand-offs (#2046; Josh, 2026-11-25, picked "Start" on #2031's "Hand off once, ship when ready"): a minion hands
// off once, and the server ships it when its trigger comes, with no turn, through Ship It's guards (#1930, shipPrepared).
// The trigger here is the pipeline lane: a pipeline change from a minion that doesn't hold it joins the lane's queue by
// itself, marked ready (#1985), and ships when the lane passes to it or it is let in beside the holder (ShipLane). It
// fires once: a refusal wakes the minion and never re-arms.
import { APP_NAME } from './appname.ts';
import { armedKey } from './db-keys.ts';
import type { Ticket } from './db.ts';
import type { ChangeBy } from './db/wait-records.ts';
import { gitOut } from './git.ts';
import { HttpError, type App } from './http.ts';
import { laneRefusal, shipPrepared } from './ship-handoff.ts';
import { pipelineChanges, SHIP_LANE } from './ship-lane.ts';
import { thrown } from './thrown.ts';

const LANE = SHIP_LANE;

/** A hand-off kept for its trigger (settings, armedKey). */
export interface Armed {
  when: 'lane';
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
 * hand_off_land's lane (#2046): a plain ship to main that changes a pipeline file, from a minion that doesn't hold the
 * lane, is armed instead of started (a free lane is taken). Null: ship now. Else what to tell the minion. An outage fix
 * and a rolled-back deploy's fix jump the line, as the lane's rule says; a merge into a build isn't a ship to main.
 */
export async function laneHandoff(app: App, ticket: Ticket, body: Record<string, unknown>): Promise<string | null> {
  if (body.into !== undefined || body.build === true || body.outage === true || body.fix === true) return null;
  const why = await laneRefusal(app, ticket);
  // None, or git can't tell (no main to diff against): it ships, as such a hand-off always did.
  if (!why || !(await pipelineChanges(ticket.cwd!))?.length) return null;
  if (takeFreeLane(app, ticket)) return null;
  const head = await gitOut(['rev-parse', 'HEAD'], ticket.cwd!);
  if (!head) throw new HttpError(409, "Not handed off: git couldn't read your worktree's commit");
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
  const ticket = app.store.getTicket(ticketId);
  if (armed?.when !== 'lane' || !ticket) return false;
  app.store.deleteSetting(armedKey(ticketId)); // once: a refusal wakes it, and only its next hand-off arms again
  const failed = (why: string) => {
    if (app.store.getTicket(ticketId)?.note === ARMED_NOTE) app.store.updateTicket(ticketId, { state: null, note: null }, { kind: 'server' });
    fallback(why);
  };
  shipPrepared(app, ticket, armed, { since: armed.event, what: 'you armed it', person: armed.person, by: { kind: 'server' } }).then(
    (why) => {
      if (why === null) app.runner.emit(ticketId, 'note', { text: started });
      else failed(typeof why === 'string' ? why : why.lane);
    },
    (err) => failed(thrown(err).message!),
  );
  return true;
}
