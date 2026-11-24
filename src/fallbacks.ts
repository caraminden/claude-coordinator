// Jobs that systemd-run couldn't start in a unit of their own (#519). Turns, landings and ultra reviews
// still run then, as the server's child or in its cgroup, since one that runs beats one that doesn't; but
// such a job escapes freezing and the turns' limits, and holds up a restart. On 2026-11-10 a broken
// citadel-turns.slice did that to every turn for 13 minutes with only the journal noticing, so each
// fallback counts toward /api/health's `fallbacks`, and the first of each cause each day raises an alert, which
// clears once a job gets a unit of its own again (#532: an alert goes when its problem does).
import { createHash } from 'node:crypto';
import type { Project, Store, User } from './db.ts';

/** How a job asked for its own unit: a unit of its own (turns, landings, ultra reviews), or a scope around `podman exec` (container turns). */
export type Kind = 'unit' | 'scope';

export class Fallbacks {
  /** Jobs that fell back since the server started. */
  count = 0;
  /** Causes already alerted, so nine turns failing the same way raise one alert. */
  private raised = new Set<string>();
  /** Tell people about a new cause; false (or a throw) when it didn't reach everyone, so the next fallback tries again. */
  alert: (cause: string, job: string, error: string, ticketId: number, kind: Kind) => Promise<boolean> = async () => false;
  /** Hears every fallback, for the post-deploy watch's readings (#724). */
  observe: (job: string, error: string) => void = () => {};
  /** Take down the fallback alerts out for jobs of `kind`. */
  clear: (kind: Kind) => Promise<void> = async () => {};
  /** Alerts and clears run one at a time, in order, so a clear never misses an alert still on its way. */
  private chain: Promise<unknown> = Promise.resolve();
  private clearing = new Set<Kind>();

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.chain.then(fn);
    this.chain = p.catch(() => {});
    return p;
  }

  /**
   * A job of `kind` got a unit of its own: systemd-run works for those again, so their alerts go. Causes stay
   * raised for the day, so trouble that comes and goes alarms once a day at most, not on every flap.
   */
  started(kind: Kind = 'unit') {
    // One clear waiting per kind covers every job that starts meanwhile.
    if (this.clearing.has(kind)) return;
    this.clearing.add(kind);
    this.serial(() => (this.clearing.delete(kind), this.clear(kind))).catch((err) => console.error(`Clearing fallback alerts failed: ${err?.message ?? err}`));
  }

  /** `job` (as people read it) of minion `ticketId` runs in the server because systemd-run said `error`. */
  record(ticketId: number, job: string, error: string, now = Date.now(), kind: Kind = 'unit') {
    this.count++;
    this.observe(job, error);
    console.error(`${job}: systemd-run failed (${error}), so it runs in the server's cgroup.`);
    // Unit names carry the minion's id and a time: the same trouble for another job is the same cause. A new
    // day makes it a new cause, so trouble that lasts alerts again even if yesterday's item was ticked.
    const cause = `${new Date(now).toISOString().slice(0, 10)} ${error.replace(/\d+/g, '#')}`;
    if (this.raised.has(cause)) return;
    this.raised.add(cause);
    const retry = () => this.raised.delete(cause);
    this.serial(() => this.alert(cause, job, error, ticketId, kind)).then(
      (ok) => ok || retry(),
      (err) => (console.error(`Alerting a fallback failed: ${err?.message ?? err}`), retry()),
    );
  }
}

export const fallbacks = new Fallbacks();

/** Puts one Mandate alert item for `person` from `project`; true once Mandate has it. */
export type PutAlert = (project: Project, person: User, key: string, title: string, link: string) => Promise<boolean>;
/** Clears one; true once Mandate has it gone. */
export type ClearAlert = (project: Project, person: User, key: string) => Promise<boolean>;

/** Settings key for the fallback alerts out: `<scheme id>:<item key>` → the item, its kind of job and who has it. */
const OUT = 'fallback-alerts';
type Out = Record<string, { project: number; key: string; kind: Kind; users: number[] }>;

/** The alert that tells every admin with Mandate on, from the job's scheme and linking its minion; true once each has it. */
export function adminAlert(store: Store, put: PutAlert): Fallbacks['alert'] {
  return async (cause, job, error, ticketId, kind) => {
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
    const id = `${project.id}:${key}`;
    const users = [...new Set([...(out[id]?.users ?? []), ...admins.filter((_, i) => sent[i]).map((u) => u.id)])];
    if (users.length) store.setSetting(OUT, { ...out, [id]: { project: project.id, key, kind, users } });
    return sent.every(Boolean);
  };
}

/** Clears the fallback alerts out for jobs of a kind; what Mandate didn't take is tried again on the next clear. */
export function adminClear(store: Store, del: ClearAlert): Fallbacks['clear'] {
  return async (kind) => {
    const out = store.getSetting<Out>(OUT) ?? {};
    const mine = Object.entries(out).filter(([, o]) => o.kind === kind);
    if (!mine.length) return;
    for (const [id, o] of mine) {
      const project = store.getProject(o.project);
      const left: number[] = [];
      for (const uid of o.users) {
        const user = store.getUser(uid);
        if (project && user && !(await del(project, user, o.key))) left.push(uid);
      }
      if (left.length) out[id] = { ...o, users: left };
      else delete out[id];
    }
    store.setSetting(OUT, out);
  };
}
