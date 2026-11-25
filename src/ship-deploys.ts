// The apps a clean land on main deploys (#712) and how (#1838, out of server.ts): what LandHandoffs (src/land.ts) calls.
// In a file of its own, not land.ts, a pipeline file. It lists what it uses, as ADR 0002's background jobs do.
import { execFile } from 'node:child_process';
import { folderHolds, manifestOn, type AppServices } from './app-services.ts';
import type { AutoDeploy } from './auto-deploy.ts';
import type { ContraptionRow, Store } from './db.ts';
import { HttpError } from './http.ts';
import type { DeployOps } from './land.ts';

export interface ShipDeploysDeps {
  store: Pick<Store, 'getTicket' | 'getProject' | 'getContraption' | 'listContraptions' | 'turnAsker'>;
  services: Pick<AppServices, 'folder'> & { opts: Pick<AppServices['opts'], 'off'>; running(name: string): unknown; lastDeploy: DeployOps['last'] };
  autoDeploy: Pick<AutoDeploy, 'deployNow'>;
  /** Start an app's deploy as the land's minion. */
  startDeploy(row: ContraptionRow, by: string, uid: number | null): unknown;
}

export function shipDeploys({ store, services, autoDeploy, startDeploy }: ShipDeploysDeps): { apps(id: number): string[]; deployOps: DeployOps } {
  return {
    // A clean land on main deploys the scheme's home contraptions on main (#712), through auto-deploy's start, which marks the commit tried.
    apps: (id) => {
      const t = store.getTicket(id);
      if (!t || services.opts.off) return [];
      const dir = store.getProject(t.project_id)?.repo_dir;
      // An app make_app registered (#1136) waits for the ship that puts its folder on main.
      return store
        .listContraptions()
        .filter((c) => c.home_scheme === t.project_id && c.repo && (c.branch ?? 'main') === 'main' && (!c.subdir || (!!dir && manifestOn(dir, c.subdir))))
        .map((c) => c.name);
    },
    deployOps: {
      running: (name) => !!services.running(name),
      start: async (name, id) => {
        const t = store.getTicket(id);
        if (!t) throw new Error(`minion ${id} is gone`);
        const by = `#${t.number}`;
        const uid = store.turnAsker(id);
        try {
          return await autoDeploy.deployNow(t.project_id, `app:${name}`, by, uid);
        } catch (err) {
          if (!(err instanceof HttpError && err.status === 404)) throw err;
        }
        // Not among the release targets yet (a contraption added since their last scan, or a clone git can't read): straight to its deploy.
        const row = store.getContraption(name);
        if (!row) throw new Error(`no contraption ${name}`);
        return startDeploy(row, by, uid);
      },
      last: (name) => services.lastDeploy(name),
      has: async (name, landed, deployed) => {
        const row = store.getContraption(name);
        // An app in a folder of its scheme's repo (#1136) is held when the ship didn't touch its folder: it isn't redeployed.
        const dir = row?.subdir && row.home_scheme !== null ? store.getProject(row.home_scheme)?.repo_dir : null;
        if (dir && (await folderHolds(dir, row!.subdir!, landed, deployed))) return true;
        return new Promise((done) => (row ? execFile('git', ['merge-base', '--is-ancestor', landed, deployed], { cwd: services.folder(row), timeout: 30_000 }, (err) => done(!err)) : done(false)));
      },
    },
  };
}
