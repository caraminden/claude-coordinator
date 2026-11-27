// A release APK's Gradle step on a lent machine's Builds role (H3, specs/heavy-jobs-across-machines.md in the shared
// folder; Josh, 2026-11-25: "we should load balance it across our other machiens"). src/apk-build.ts hands it the build
// checkout after cap sync: it snapshots it (no key file goes), asks place() for a machine, queues a priority container
// job there, and brings the unsigned APK back for perigee to sign. Anything that stops that (no machine, no room, a
// machine gone twice, a failed build) returns false, and perigee builds it on its priority slot as before.
import { mkdir, readFile, rename, rm, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import type { ContraptionRow, Store } from './db.ts';
import { execResult } from './exec.ts';
import { buildRecipe, type BuildPlacer, KIND_SIZE } from './heavy-builds.ts';
import { ENDED, jobInputs, type MachineJobs } from './machine-jobs.ts';
import { thrown } from './thrown.ts';

const PACK = fileURLToPath(new URL('../tools/heavy-builds.ts', import.meta.url));

export interface ApkMachineDeps {
  store: Pick<Store, 'getMachine' | 'getMachineJob' | 'machineJobs' | 'updateMachineJob'>;
  jobs: Pick<MachineJobs, 'queueBuild' | 'stopJob'>;
  placer: Pick<BuildPlacer, 'place'>;
  online: (machineId: number) => boolean;
  /** Where a contraption's job results are kept (server.ts's resultsDir). */
  resultsDir: (jobId: number) => string | null;
  /** The android build image this release ships, if published. */
  image: () => string | undefined;
  pollMs?: number;
  /** Offline this long while it runs: the machine went away. */
  awayMs?: number;
  /** Not started this long after it was queued: perigee takes it. */
  queuedMs?: number;
}

export interface ApkMachineAsk {
  row: ContraptionRow;
  /** The build checkout, and the Gradle project in it (from the checkout's top). */
  top: string;
  dir: string;
  /** The Gradle command, run in `dir`. */
  argv: string[];
  /** The unsigned APK and the merged manifest folder, from `top`: what comes back. */
  apk: string;
  manifest: string;
  /** The build's log, and a folder of its own for the snapshot. */
  log: string;
  scratch: string;
  minutes: number;
}

export class ApkMachine {
  private d: ApkMachineDeps;
  constructor(d: ApkMachineDeps) {
    this.d = d;
  }

  /** True once `a.apk` sits in the checkout, built on a machine; false: build it on perigee (the log says why). */
  async build(a: ApkMachineAsk): Promise<boolean> {
    const note = (line: string) => appendFile(a.log, `== ${line}\n`).catch(() => {});
    try {
      const projectId = a.row.home_scheme;
      const image = this.d.image();
      if (projectId == null || !image) return false;
      // A restart of Citadel mid-build leaves its job behind: stopped, so two builds of one app never run.
      for (const j of this.d.store.machineJobs({ contraption: a.row.id, states: ['queued', 'starting', 'running', 'uploading', 'paused'] })) if (j.go === 'builds') this.stop(j.id);
      // Twice at most: a machine that goes away mid-job has it placed once more (spec section 2, an unattended job).
      for (let tries = 0; tries < 2; tries++) {
        const spots = this.d.placer.place({ projectId, kind: 'apk' });
        if (!spots.length) return false;
        const r = await this.once(a, projectId, image, spots, note);
        if (r !== 'away') return r;
      }
      await note('the machines went away twice: building on perigee');
      return false;
    } catch (err) {
      await note(`couldn't build it on a machine (${thrown(err).message}): building on perigee`);
      return false;
    } finally {
      await rm(a.scratch, { recursive: true, force: true });
    }
  }

  private stop(id: number) {
    try {
      this.d.jobs.stopJob(id, { asker: true });
    } catch {
      /* it ended meanwhile */
    }
  }

  private async once(a: ApkMachineAsk, projectId: number, image: string, spots: { id: number; name: string }[], note: (line: string) => Promise<void>): Promise<boolean | 'away'> {
    await rm(a.scratch, { recursive: true, force: true });
    await mkdir(a.scratch, { recursive: true });
    // A child process: packing a checkout takes seconds of git, tar and gzip, which the server's thread can't give.
    const packed = await execResult(process.execPath, [PACK, '--pack', a.top, a.scratch, a.dir]);
    if (packed.code !== 0) throw new Error(`the checkout couldn't be packed: ${packed.err.trim().slice(-300)}`);
    const inputs = await jobInputs([join(a.scratch, 'snapshot.tgz')], [a.scratch]);
    const machine = this.d.store.getMachine(spots[0].id);
    if (!machine) return false;
    const job = this.d.jobs.queueBuild({
      machine,
      projectId,
      ticketId: null,
      contraptionId: a.row.id,
      askedBy: `${a.row.title} APK build`,
      kind: buildRecipe({ kind: 'apk', image, size: KIND_SIZE.apk, dir: a.dir, backs: [a.apk, a.manifest], argv: a.argv, minutes: a.minutes }),
      inputs,
      limitS: a.minutes * 60,
      reason: `${a.row.title}'s release APK`,
    });
    await note(`building on ${machine.name} (job #${job.id})`);
    const queuedAt = Date.now();
    let away: number | null = null;
    let now = job;
    while (!(ENDED as readonly string[]).includes(now.state)) {
      await sleep(this.d.pollMs ?? 5_000);
      const next = this.d.store.getMachineJob(job.id);
      if (!next) return false;
      now = next;
      away = this.d.online(machine.id) ? null : (away ?? Date.now());
      if (away !== null && Date.now() - away >= (this.d.awayMs ?? 90_000)) {
        this.stop(job.id);
        await note(`${machine.name} went away, so job #${job.id} was stopped`);
        return 'away';
      }
      if (now.state === 'queued' && Date.now() - queuedAt >= (this.d.queuedMs ?? 10 * 60_000)) {
        this.stop(job.id);
        await note(`job #${job.id} didn't start on ${machine.name} in time: building on perigee`);
        return false;
      }
    }
    const results = this.d.resultsDir(job.id);
    if (!results) return false;
    await appendFile(a.log, await readFile(join(results, '.job.log'), 'utf8').catch(() => '')).catch(() => {});
    const got = now.state === 'done' && now.exit_code === 0 && (await this.unpack(a, results));
    if (!got) {
      await note(`job #${job.id} on ${machine.name} ended ${now.state}${now.exit_code === null ? '' : ` (exit ${now.exit_code})`}${now.error ? `: ${now.error}` : ''}, with no APK: building on perigee`);
      return false;
    }
    await rm(results, { recursive: true, force: true });
    this.d.store.updateMachineJob(job.id, { swept_at: Date.now(), upload_bytes: 0 });
    return true;
  }

  /** The APK (and its manifest, for the release's warnings) out of what came back: only those paths are taken. */
  private async unpack(a: ApkMachineAsk, results: string): Promise<boolean> {
    // podman cp's tar holds back.tgz, the files relative to the checkout's top.
    if ((await execResult('tar', ['-xf', join(results, 'back.tar'), '-C', a.scratch, 'back.tgz'])).code !== 0) return false;
    const back = join(a.scratch, 'back.tgz');
    const out = join(a.scratch, 'out');
    await mkdir(out, { recursive: true });
    if ((await execResult('tar', ['-xzf', back, '-C', out, a.apk])).code !== 0) return false;
    await execResult('tar', ['-xzf', back, '-C', a.top, a.manifest]);
    const to = join(a.top, a.apk);
    await mkdir(join(to, '..'), { recursive: true });
    await rename(join(out, a.apk), to);
    return true;
  }
}
