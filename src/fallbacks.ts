// Jobs that systemd-run couldn't start in a unit of their own (#519). Turns, landings and ultra reviews
// still run then, as the server's child or in its cgroup, since one that runs beats one that doesn't; but
// such a job escapes freezing and the turns' limits, and holds up a restart. On 2026-11-10 a broken
// citadel-turns.slice did that to every turn for 13 minutes with only the journal noticing, so each
// fallback counts toward /api/health's `fallbacks`, and the first of each cause each day raises an alert, which
// clears once a job gets a unit of its own again (#532: an alert goes when its problem does).
import { createHash } from 'node:crypto';
import type { Project, Store, User } from './db.ts';

export class Fallbacks {
  /** Jobs that fell back since the server started. */
  count = 0;
  /** Causes already alerted, so nine turns failing the same way raise one alert. */
  private raised = new Set<string>();
  /** Tell people about a new cause; false (or a throw) when it didn't reach everyone, so the next fallback tries again. */
  alert: (cause: string, job: string, error: string, ticketId: number) => Promise<boolean> = async () => false;
  /** Take down every fallback alert that is out. */
  clear: () => Promise<void> = async () => {};

  /**
   * A job got a unit of its own: systemd-run works again, so the alerts go. Causes stay raised for the day, so
   * trouble that comes and goes alarms once a day at most, not on every flap.
   */
  started() {
    this.clear().catch((err) => console.error(`Clearing fallback alerts failed: ${err?.message ?? err}`));
  }

  /** `job` (as people read it) of minion `ticketId` runs in the server because systemd-run said `error`. */
  record(ticketId: number, job: string, error: string, now = Date.now()) {
    this.count++;
    console.error(`${job}: systemd-run failed (${error}), so it runs in the server's cgroup.`);
    // Unit names carry the minion's id and a time: the same trouble for another job is the same cause. A new
    // day makes it a new cause, so trouble that lasts alerts again even if yesterday's item was ticked.
    const cause = `${new Date(now).toISOString().slice(0, 10)} ${error.replace(/\d+/g, '#')}`;
    if (this.raised.has(cause)) return;
    this.raised.add(cause);
    const retry = () => this.raised.delete(cause);
    this.alert(cause, job, error, ticketId).then((ok) => ok || retry(), (err) => (console.error(`Alerting a fallback failed: ${err?.message ?? err}`), retry()));
  }
}

export const fallbacks = new Fallbacks();

/** Puts one Mandate alert item for `person` from `project`; true once Mandate has it. */
export type PutAlert = (project: Project, person: User, key: string, title: string, link: string) => Promise<boolean>;
/** Clears one; true once Mandate has it gone. */
export type ClearAlert = (project: Project, person: User, key: string) => Promise<boolean>;

/** Settings key for the fallback alerts out: item key → its scheme and the users who have it. */
const OUT = 'fallback-alerts';
type Out = Record<string, { project: number; users: number[] }>;

/** The alert that tells every admin with Mandate on, from the job's scheme and linking its minion; true once each has it. */
export function adminAlert(store: Store, put: PutAlert): Fallbacks['alert'] {
  return async (cause, job, error, ticketId) => {
    const ticket = store.getTicket(ticketId);
    const project = ticket && store.getProject(ticket.project_id);
    if (!ticket || !project) return false;
    const admins = store.listUsers().filter((u) => u.admin && !u.disabled_at && store.contraptionEnabled('mandate', u.id));
    const key = `fallback.${createHash('sha256').update(cause).digest('hex').slice(0, 16)}`;
    const who = ticket.number === null ? 'the Taskmaster' : `#${ticket.number}`;
    const title = `${job} for ${who} ran inside the server, without freezing or turn limits: systemd-run failed (${error.slice(0, 200)})`;
    const link = `/c/#/p/${project.id}${ticket.number === null ? '' : `/t/${ticket.number}`}`;
    // Everyone again on a retry: a put of the same key on an item someone already has changes nothing.
    const sent = await Promise.all(admins.map((u) => put(project, u, key, title, link)));
    const out = store.getSetting<Out>(OUT) ?? {};
    const had = out[key]?.users ?? [];
    const users = [...new Set([...had, ...admins.filter((_, i) => sent[i]).map((u) => u.id)])];
    if (users.length) store.setSetting(OUT, { ...out, [key]: { project: project.id, users } });
    return sent.every(Boolean);
  };
}

/** Clears every fallback alert out; what Mandate didn't take is tried again on the next clear. */
export function adminClear(store: Store, del: ClearAlert): Fallbacks['clear'] {
  return async () => {
    const out = store.getSetting<Out>(OUT);
    if (!out || !Object.keys(out).length) return;
    const gone: [string, number][] = [];
    for (const [key, { project: id, users }] of Object.entries(out)) {
      const project = store.getProject(id);
      for (const uid of users) {
        const user = store.getUser(uid);
        if (!project || !user || (await del(project, user, key))) gone.push([key, uid]);
      }
    }
    // Read again: an alert may have gone out meanwhile.
    const now = store.getSetting<Out>(OUT) ?? {};
    for (const [key, uid] of gone) {
      if (!now[key]) continue;
      now[key].users = now[key].users.filter((u) => u !== uid);
      if (!now[key].users.length) delete now[key];
    }
    store.setSetting(OUT, now);
  };
}
