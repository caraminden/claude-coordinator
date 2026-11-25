// An Android app's release step (#629) for auto-deploy and the Releases card (#1838, out of server.ts): a bumped version
// starts its release workflow, and a signed run is published. The GitHub and APK work itself is src/apk-release.ts.
import { join } from 'node:path';
import type { Deployer } from './auto-deploy.ts';
import type { CiStore } from './ci-store.ts';
import type { Run } from './ci-view.ts';
import type { Store } from './db.ts';
import { HttpError } from './http.ts';
import { dispatch, OldApk, OtherKey, publish } from './apk-release.ts';
import { repoSlug } from './prlinks.ts';
import { ROLLBACK_BRANCH, type ApkReader } from './release-readers.ts';
import type { Found } from './release-targets.ts';
import type { GithubEnv } from './scheme-repo.ts';

type PublishRun = (t: Found, run: Run, current: number, main: { code: number; name: string | null }, by: string, uid: number | null) => Promise<number>;

export interface PublishRunDeps {
  store: Pick<Store, 'getProject' | 'getUser' | 'publishCiFile' | 'recordApkPublish'>;
  ciStore: Pick<CiStore, 'releaseApk' | 'plain'>;
  /** Where the apps' data folders are. */
  home: string;
  githubOf(repoDir: string): GithubEnv;
  tellHome(projectId: number, text: string): void;
  publish?: typeof publish;
}

/**
 * Publish release run `run`'s signed APK into `t`'s feed (src/apk-release.ts): the CI store's copy when it has one,
 * recorded (#663) and told to the scheme's Taskmaster. Throws publish()'s refusals (OldApk, OtherKey). Returns the code.
 */
export function publisher(d: PublishRunDeps): PublishRun {
  const { store, ciStore, tellHome } = d;
  return async (t, run, current, main, by, uid) => {
    const p = store.getProject(t.projectId);
    const slug = p && repoSlug(p.repo_url);
    if (!p?.repo_dir || !slug || !t.contraption) throw new Error(`${t.name} has no repo or app to publish into`);
    const feedFile = join(d.home, '.local/share', t.contraption, 'android', 'latest.json');
    // The signed APK the run put in the CI store (#658), when it did; else its GitHub artifact.
    const stored = ciStore.releaseApk(p.id, run.id);
    const code = await (d.publish ?? publish)({ slug, runId: run.id, feedFile, current, main, as: d.githubOf(p.repo_dir), stored: (stored && (await ciStore.plain(stored))) ?? undefined });
    if (stored) store.publishCiFile(stored.id, `${t.contraption}/android`);
    // Who published what (#663): kept, and told to the scheme's Taskmaster.
    store.recordApkPublish({ projectId: p.id, contraption: t.contraption, versionCode: code, runId: run.id, by, uid });
    const who = uid != null && by.startsWith('#') ? `${by} (for ${store.getUser(uid)?.name ?? 'someone'})` : by;
    tellHome(p.id, `${who} published ${t.contraption}'s Android build ${code} from ${t.workflow!.replace(/^.*\//, '')} run ${run.id}${run.head_branch === ROLLBACK_BRANCH ? ` (last green, rolled back on ${ROLLBACK_BRANCH})` : ''}.`);
    return code;
  };
}

export interface ApkDeployerDeps {
  store: Pick<Store, 'getProject'>;
  apkReader: Pick<ApkReader, 'pending' | 'started' | 'tooOld'>;
  githubOf(repoDir: string): GithubEnv;
  publishRun: PublishRun;
  /** Read the releases again. */
  refresh(): void;
  dispatch?: typeof dispatch;
}

export function apkDeployer(d: ApkDeployerDeps): Deployer {
  const { store, apkReader } = d;
  return {
    waits: (t) => !!apkReader.pending(t),
    head: async (t) => {
      const w = apkReader.pending(t);
      return !w ? null : w.step === 'dispatch' ? `dispatch:${w.head}` : `publish:${w.run.id}`;
    },
    start: async (t, by, uid) => {
      const w = apkReader.pending(t);
      const p = store.getProject(t.projectId);
      const slug = p && repoSlug(p.repo_url);
      if (!w || !p?.repo_dir || !slug || !t.workflow || !t.contraption) throw new HttpError(409, `${t.name} has nothing to release: no signed APK newer than the published build is waiting, or a release run is still going. The Releases page reads CI every few minutes, so a run that just finished shows a little later.`);
      const as = d.githubOf(p.repo_dir);
      const release = async () => {
        await (d.dispatch ?? dispatch)(slug, t.workflow!.replace(/^.*\//, ''), t.branch, as);
        apkReader.started(t);
      };
      const started = `No signed APK newer than the published build yet: started a release run of ${t.branch} (${t.workflow}). Once it has signed one, publish again.`;
      let said = started;
      if (w.step === 'dispatch') await release();
      else {
        try {
          const code = await d.publishRun(t, w.run, w.current, w.main, by, uid);
          said = `Published ${t.contraption}'s Android build ${code} from ${t.workflow!.replace(/^.*\//, '')} run ${w.run.id}: installed phones see the update now.`;
        } catch (err) {
          // A key the published APK wasn't signed with: refused, with nothing changed.
          if (err instanceof OtherKey) throw new HttpError(409, err.message);
          if (!(err instanceof OldApk)) throw err;
          // Signed before main's version bump: sign main instead.
          apkReader.tooOld(w.run.id);
          await release();
        }
      }
      d.refresh();
      return said;
    },
  };
}
