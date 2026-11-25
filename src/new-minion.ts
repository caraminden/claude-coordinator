import type { Store, Project } from './db.ts';
import { afterAllWrites, HttpError } from './http.ts';
import { errorText } from './scheme-repo.ts';

export type NewMinionSpec = { title: string; props: Record<string, unknown>; model?: string | null; effort?: string | null; build?: number | null };

/**
 * A new minion's row, properties and folder, not started yet. Its properties are checked before the row is made, and
 * any failure after that deletes the row, so a refused property (an archived type) or a folder that can't be made
 * leaves nothing behind. The error that refused it is thrown as it was.
 */
export async function makeMinion(store: Store, project: Project, m: NewMinionSpec, by: string, makeDir: (id: number, number: number) => Promise<{ cwd: string; branch: string | null }>, afterWrites: () => Promise<unknown> = async () => {}) {
  store.props.check(project.id, m.props);
  // A value write: the queue empties off the event loop first, so creating it never waits there (#1877).
  const { id, number } = await afterAllWrites(() => store.createTicket({ project_id: project.id, title: m.title, permission_mode: 'bypassPermissions', created_by: by }));
  try {
    const { notes } = store.props.set('minion', id, project.id, m.props, by);
    store.props.startStage(id);
    if (m.model || m.effort) store.updateTicket(id, { model: m.model ?? null, effort: m.effort ?? null });
    // Its build before its worktree: a build with a branch is what it branches from (build branches).
    if (m.build) {
      store.updateTicket(id, { build: m.build });
      store.props.setBuild(id, m.build, by);
    }
    try {
      const dir = await makeDir(id, number!);
      store.setTicketDir(id, dir.cwd, dir.branch);
      await afterWrites();
      // The folder comes back from here: setTicketDir is a queued write (src/db-writer.ts), and a caller that reads the
      // row back can be served the row before it, whose cwd is '' — a relative path, which lands in the server's own
      // checkout (#1618: a test run's chore minion committed into the minion worktree the server was running from).
      return { id, number: number!, notes, cwd: dir.cwd };
    } catch (err: any) {
      throw new HttpError(500, `Could not create working directory: ${errorText(err)}`);
    }
  } catch (err) {
    store.deleteTicket(id);
    throw err;
  }
}
