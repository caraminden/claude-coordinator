// Jobs that systemd-run couldn't start in a unit of their own (#519). Turns, landings and ultra reviews
// still run then, as the server's child or in its cgroup, since one that runs beats one that doesn't; but
// such a job escapes freezing and the turns' limits, and holds up a restart. On 2026-11-10 a broken
// citadel-turns.slice did that to every turn for 13 minutes with only the journal noticing, so each
// fallback counts toward /api/health's `fallbacks`, and the first of each cause raises an alert.

export class Fallbacks {
  /** Jobs that fell back since the server started. */
  count = 0;
  /** Causes already alerted, so nine turns failing the same way raise one alert. */
  private raised = new Set<string>();
  /** Tell people about a new cause; false (or a throw) when it reached no one, so the next fallback tries again. */
  alert: (cause: string, job: string, error: string, ticketId: number) => Promise<boolean> = async () => true;

  /** `job` (as people read it) of minion `ticketId` runs in the server because systemd-run said `error`. */
  record(ticketId: number, job: string, error: string) {
    this.count++;
    console.error(`${job}: systemd-run failed (${error}), so it runs in the server's cgroup.`);
    // Unit names carry the minion's id and a time: the same trouble for another job is the same cause.
    const cause = error.replace(/\d+/g, '#');
    if (this.raised.has(cause)) return;
    this.raised.add(cause);
    const retry = () => this.raised.delete(cause);
    this.alert(cause, job, error, ticketId).then((ok) => ok || retry(), (err) => (console.error(`Alerting a fallback failed: ${err?.message ?? err}`), retry()));
  }
}

export const fallbacks = new Fallbacks();
