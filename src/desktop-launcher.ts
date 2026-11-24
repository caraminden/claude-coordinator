// The desktop launcher's exe (#1148): built from the kit's source (kit/desktop-launcher) with perigee's .NET SDK the
// first time a feed or install zip needs it, and kept by the source's hash, so a launcher change in the kit reaches
// every app's PCs through their feeds. Its version is the source's `Version = N`: the feed offers it to launchers older
// than that, which check it (--selftest) before it replaces them.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
export const LAUNCHER_SOURCES = ['Launcher.cs', 'Launcher.csproj', 'Trial.cs'];
/** After a failed build, the next try waits this long. */
const RETRY_MS = 10 * 60_000;

export interface LauncherBuild {
  path: string;
  version: number;
  sha256: string;
  size: number;
}

export interface LauncherOpts {
  /** kit/desktop-launcher. */
  src: string;
  /** Where builds are kept, one folder per source hash. */
  cache: string;
  dotnet: string;
  /** Builds the project in `dir` into `out`/launcher.exe; tests swap it. */
  build?: (dotnet: string, dir: string, out: string) => Promise<void>;
  log?: (msg: string) => void;
}

const dotnetBuild = async (dotnet: string, dir: string, out: string) => {
  await run(dotnet, ['build', join(dir, 'Launcher.csproj'), '-c', 'Release', '-o', out, '-nologo', '-v', 'q'], {
    cwd: dir,
    timeout: 5 * 60_000,
    maxBuffer: 4 << 20,
    env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1' },
  });
};

export class Launchers {
  private o: LauncherOpts;
  private building: Promise<LauncherBuild | null> | null = null;
  private failedAt = 0;
  private failedHash = '';
  constructor(o: LauncherOpts) {
    this.o = o;
  }

  /** The launcher built from the source as it is now; null when it can't be built (the feed then offers none). */
  async get(): Promise<LauncherBuild | null> {
    const source = await Promise.all(LAUNCHER_SOURCES.map((f) => readFile(join(this.o.src, f), 'utf8'))).catch(() => null);
    if (!source) return null;
    const version = Number(/\bVersion\s*=\s*(\d+)\s*;/.exec(source[0])?.[1]);
    if (!Number.isInteger(version)) return null;
    const hash = createHash('sha256').update(source.join('\0')).digest('hex').slice(0, 16);
    const dir = join(this.o.cache, `launcher-${hash}`);
    const exe = join(dir, 'launcher.exe');
    const have = await this.read(exe, version);
    if (have) return have;
    if (this.failedHash === hash && Date.now() - this.failedAt < RETRY_MS) return null;
    this.building ??= this.make(hash, dir, exe, version).finally(() => (this.building = null));
    return this.building;
  }

  private async make(hash: string, dir: string, exe: string, version: number): Promise<LauncherBuild | null> {
    await mkdir(this.o.cache, { recursive: true });
    const tmp = await mkdtemp(join(this.o.cache, '.build-'));
    try {
      // Built in a copy: the source folder (the live checkout's) gets no obj/ or bin/.
      for (const f of LAUNCHER_SOURCES) await copyFile(join(this.o.src, f), join(tmp, f));
      await (this.o.build ?? dotnetBuild)(this.o.dotnet, tmp, join(tmp, 'out'));
      await mkdir(dir, { recursive: true });
      await rename(join(tmp, 'out', 'launcher.exe'), exe);
      return await this.read(exe, version);
    } catch (err) {
      this.failedHash = hash;
      this.failedAt = Date.now();
      this.o.log?.(
        `desktop launcher: couldn't build it: ${String((err as { stderr?: string }).stderr || (err as Error).message)
          .trim()
          .slice(0, 500)}`,
      );
      return null;
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }

  private async read(path: string, version: number): Promise<LauncherBuild | null> {
    const buf = await readFile(path).catch(() => null);
    if (!buf) return null;
    return { path, version, sha256: createHash('sha256').update(buf).digest('hex'), size: (await stat(path)).size };
  }
}
