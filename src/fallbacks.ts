// Jobs that systemd-run couldn't start in a unit of their own (#519). Turns, landings and ultra reviews
// still run then, as the server's child or in its cgroup, since one that runs beats one that doesn't; but
// such a job escapes freezing and the turns' limits, and holds up a restart. On 2026-11-10 a broken
// citadel-turns.slice did that to every turn for 13 minutes with only the journal noticing, so each
// fallback counts toward /api/health's `fallbacks`, and the first of each cause each day raises an alert.
import { createHash } from 'node:crypto';
import type { Project, Store, User } from './db.ts';

export class Fallbacks {
  /** Jobs that fell back since the server started. */
  count = 0;
  /** Causes already alerted, so nine turns failing the same way raise one alert. */
  private raised = new Set<string>();
  /** Tell people about a new cause; false (or a throw) when it didn't reach everyone, so the next fallback tries again. */
  alert: (cause: string, job: string, error: string, ticketId: number) => Promise<boolean> = async () => false;

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
    return sent.every(Boolean);
  };
}
