// The ways back (Roll back to last green, src/rollback.ts): what each kind of release target does when its button is
// pressed, whether that still runs, and which app an APK follows. server.ts hands in the readers and the job runner.
import { rmSync } from 'node:fs';
import { rollBackApk, type RollbackApk } from './apk-release.ts';
import { ServiceError } from './app-services.ts';
import type { ContraptionRow, Project } from './db.ts';
import { HttpError } from './http.ts';
import type { HostJobs } from './host-job.ts';
import type { LastGreen } from './last-green.ts';
import type { ApkReader, CiPackageReader } from './release-readers.ts';
import { ROLLBACK_BRANCH } from './release-readers.ts';
import type { TargetFinder } from './release-targets.ts';
import { CITADEL_TARGET } from './releases.ts';
import type { RollbackDeps } from './rollback.ts';
import { repoSlug } from './prlinks.ts';
import { turnEnv } from './turn-launch.ts';

export interface RollbackStarterDeps {
  store: { getContraption(name: string): ContraptionRow | undefined; getProject(id: number): Project | undefined };
  lastGreen: Pick<LastGreen, 'pinned'>;
  finder: Pick<TargetFinder, 'list'>;
  ciPackages: Pick<CiPackageReader, 'greenBuild'>;
  apk: Pick<ApkReader, 'published' | 'rollingBack' | 'started'>;
  services: { running(name: string): unknown };
  jobs: Pick<HostJobs, 'state' | 'start'>;
  /** Where Citadel's own roll back keeps its job. */
  dir: string;
  /** A copy of Citadel (a preview, a dev copy): another DATA_DIR, or one that doesn't deploy. */
  copy: boolean;
  /** This server was given a checkout to deploy (DEPLOY_LIVE), so even a copy may roll it back. */
  deployLive: boolean;
  env: NodeJS.ProcessEnv;
  ownScheme: () => Project | null | undefined;
  githubOf: (repoDir: string) => RollbackApk['as'];
  startDeploy: (row: ContraptionRow, by: string, uid: number | null, to: string) => void;
  /** Read the releases again. */
  refresh: () => void;
  /** A roll back that ended without going live (Rollback.failed). */
  failed: (projectId: number, target: string, sha: string, why: string) => void;
  rollBackApk?: typeof rollBackApk;
}

// deploy.sh's paths, only where this server was given them (a dev copy rolling back a scratch checkout): the live
// server's defaults otherwise. Any other copy (another DATA_DIR, or one that doesn't deploy) without them can't roll
// back, so it never touches the live checkout.
const deployEnv = (env: NodeJS.ProcessEnv) => Object.fromEntries(Object.entries(env).filter(([k, v]) => /^DEPLOY_(LIVE|SOURCE|URL|DB|SERVICE|UNIT)$/.test(k) && v)) as Record<string, string>;

export function rollbackStarters(d: RollbackStarterDeps): Required<Pick<RollbackDeps, 'follows' | 'published' | 'running' | 'starters'>> {
  /** Whether Citadel's own roll back still runs; once its job ended, say why if it didn't go live, and clear it for the next one. */
  function citadelRollingBack(current: string | null): boolean {
    const job = d.jobs.state(d.dir, 2000);
    if (!job) return false;
    if (job.code === null) return true;
    const p = d.ownScheme();
    const pin = p && d.lastGreen.pinned(p.id, CITADEL_TARGET);
    if (p && pin && job.code !== 0 && current !== pin.sha) d.failed(p.id, CITADEL_TARGET, pin.sha, `tools/deploy.sh --to said: ${job.output.trim().split('\n').slice(-3).join(' ') || `exit ${job.code}`}`);
    rmSync(d.dir, { recursive: true, force: true });
    return false;
  }

  return {
    // An APK Citadel builds after each deploy (#837: a feed, no release workflow) rolls back with its app (ADR 0012).
    follows: (tv) => {
      const t = tv.target.kind === 'apk' ? d.finder.list('apk').find((f) => f.projectId === tv.target.projectId && f.id === tv.target.id) : null;
      return t?.contraption && !t.workflow ? `app:${t.contraption}` : null;
    },
    published: (tv) => (tv.target.kind === 'apk' ? d.apk.published(tv.target.projectId, tv.target.id) : null),
    running: (tv) => (tv.target.kind === CITADEL_TARGET ? citadelRollingBack(tv.current?.version ?? null) : tv.target.kind === 'apk' ? d.apk.rollingBack(tv.target.projectId, tv.target.id) : !!d.services.running(/^app:(.+)$/.exec(tv.target.id)?.[1] ?? '')),
    starters: {
      contraption: (tv, to, by, uid) => {
        const row = d.store.getContraption(/^app:(.+)$/.exec(tv.target.id)?.[1] ?? '');
        if (!row || row.home_scheme !== tv.target.projectId) throw new HttpError(404, `${tv.target.name} isn't one of this scheme's apps`);
        try {
          d.startDeploy(row, by, uid, to);
        } catch (err) {
          if (err instanceof ServiceError) throw new HttpError(err.status, err.message);
          throw err;
        }
      },
      // A CI package (ADR 0012, "Feed, no rebuild"): held at last green's existing build in the CI store, which its card
      // shows as current and the CI store's pins hand to its app's updater. Nothing deploys.
      ci: (tv) => {
        const build = d.ciPackages.greenBuild(tv.target.projectId, tv.target.id);
        if (!build) throw new HttpError(409, `${tv.target.name} has no build from last green or before it in Citadel's CI store, so there's nothing to hand out.`);
        return { build };
      },
      // A CI-signed APK (ADR 0012, Q4 "Yes, now"): point citadel/rollback at last green and start its release workflow
      // there numbered one past the published build; the APK reader publishes the run once it has signed.
      apk: async (tv, to) => {
        const t = d.finder.list('apk').find((f) => f.projectId === tv.target.projectId && f.id === tv.target.id);
        const p = d.store.getProject(tv.target.projectId);
        if (!t?.contraption || !p?.repo_dir) throw new HttpError(409, `${tv.target.name} has no app or repo to roll back with`);
        const code = await (d.rollBackApk ?? rollBackApk)({ name: tv.target.name, workflow: t.workflow ?? null, slug: repoSlug(p.repo_url), current: tv.current?.number, copy: d.copy, as: d.githubOf(p.repo_dir), branch: ROLLBACK_BRANCH }, to);
        d.apk.started(t);
        d.refresh();
        return { code };
      },
      // Citadel's server (the every-scheme skill's §1: only the scheme whose repo this server runs has it): deploy.sh
      // --to in a unit of its own, as a landing runs, since its restart ends this server. The next one reads how it went.
      [CITADEL_TARGET]: (tv, to) => {
        const p = d.store.getProject(tv.target.projectId);
        if (!p?.repo_dir || p.id !== d.ownScheme()?.id) throw new HttpError(404, 'Only the scheme this server runs can roll it back');
        if (d.copy && !d.deployLive) throw new HttpError(409, "This copy of Citadel doesn't deploy, so it can't roll the server back");
        d.jobs.start({
          dir: d.dir,
          cwd: p.repo_dir,
          argv: ['bash', 'tools/deploy.sh', '--to', to],
          env: { ...turnEnv(d.env), ...deployEnv(d.env) },
          unit: `citadel-rollback-${Date.now()}`,
          description: `tools/deploy.sh --to ${to.slice(0, 9)} (Roll back to last green)`,
          ticketId: 0,
        });
      },
    },
  };
}
