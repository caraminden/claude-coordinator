// Rootless podman containers that Citadel's server drives by name: each person's Claude container
// (src/claude-link.ts, #213), and later Citadel apps. Only the server calls this; the tripwire keeps
// turns away from `citadel-claude-*` containers, their volumes and podman's storage.
//
// A container runs `sleep infinity` under catatonit (--init) in a transient systemd user unit of its
// own name, so it stays up without a unit file to install, and work goes in with `podman exec`.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';

export interface Mount {
  /** A host path, or with `volume` a named volume. */
  src: string;
  dst: string;
  ro?: boolean;
  volume?: boolean;
}

export interface ContainerSpec {
  name: string;
  image: string;
  mounts: Mount[];
  env?: Record<string, string>;
  /**
   * Memory limits, set on the container's systemd unit (src/containers.ts start), e.g. { high: '6G', max: '8G', swap: '4G' }:
   * high throttles and reclaims, max OOM-kills inside the unit, swap bounds zram, whose pages cost RAM the cgroup isn't
   * charged for. Not podman's --memory: systemd-run gives podman no delegated controllers, so --cgroups=split's payload
   * cgroup has none and --memory never applied (#1214: a container started with --memory 6g peaked at 22.3G).
   */
  memory?: { high: string; max: string; swap: string };
  /** podman's --cpus. Like --memory it never applies today (no delegated cpu controller, #1214); kept so the spec stays as it was. */
  cpus?: number;
}

export interface CmdResult {
  code: number;
  stdout: string;
  stderr: string;
}
/** Runs a command to completion; swapped for a fake in tests. */
export type RunCmd = (cmd: string, args: string[], opts?: { timeout?: number }) => Promise<CmdResult>;

export const runCmd: RunCmd = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: opts.timeout ?? 60_000, maxBuffer: 16 << 20 }, (err: any, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout), stderr: String(stderr || err?.message || '') });
    });
  });

/** The label that records which spec a container was started from, so a changed spec restarts it. */
const SPEC_LABEL = 'citadel.spec';

/** A short hash of what a container is made of: image, mounts, env and limits. */
export function specHash(spec: ContainerSpec): string {
  return createHash('sha256').update(JSON.stringify([spec.image, spec.mounts, spec.env ?? {}, spec.memory ?? null, spec.cpus ?? null])).digest('hex').slice(0, 12);
}

/** systemd-run's -p properties for a spec's unit: its memory limits (ContainerSpec.memory). */
export function unitProps(spec: ContainerSpec): string[] {
  const m = spec.memory;
  return m ? ['-p', `MemoryHigh=${m.high}`, '-p', `MemoryMax=${m.max}`, '-p', `MemorySwapMax=${m.swap}`] : [];
}

/** podman run's arguments for a spec, after `run`. */
export function runArgs(spec: ContainerSpec): string[] {
  const args = ['--rm', '--replace', '--name', spec.name, '--init', '--userns=keep-id', '--network=host', '--cgroups=split', '--label', `${SPEC_LABEL}=${specHash(spec)}`];
  if (spec.cpus) args.push('--cpus', String(spec.cpus));
  for (const [k, v] of Object.entries(spec.env ?? {})) args.push('-e', `${k}=${v}`);
  for (const m of spec.mounts) {
    // A named volume is chowned to the user (:U), so keep-id's user owns its own home.
    args.push(m.volume ? '-v' : '--mount', m.volume ? `${m.src}:${m.dst}:U${m.ro ? ',ro' : ''}` : `type=bind,src=${m.src},dst=${m.dst}${m.ro ? ',ro' : ''}`);
  }
  args.push(spec.image, 'sleep', 'infinity');
  return args;
}

export class Containers {
  private run: RunCmd;
  private slice: string;

  constructor(run: RunCmd = runCmd, slice = 'citadel.slice') {
    this.run = run;
    this.slice = slice;
  }

  /** Whether podman works here at all (a box without it can't link anyone). */
  async available(): Promise<boolean> {
    return (await this.run('podman', ['--version'])).code === 0;
  }

  /** Running, stopped (exists but not running) or missing; with the spec hash it was started from. */
  async status(name: string): Promise<{ state: 'running' | 'stopped' | 'missing'; spec: string | null }> {
    const r = await this.run('podman', ['container', 'inspect', '--format', `{{.State.Running}} {{index .Config.Labels "${SPEC_LABEL}"}}`, name]);
    if (r.code !== 0) return { state: 'missing', spec: null };
    const [running, spec] = r.stdout.trim().split(' ');
    return { state: running === 'true' ? 'running' : 'stopped', spec: spec && spec !== '<no' ? spec : null };
  }

  /**
   * Start the container from `spec` in a transient user unit of the same name, and wait until it
   * runs. A container already running from the same spec is left alone; one from another spec is
   * replaced, so only call this with a different spec when nothing runs in it.
   */
  async start(spec: ContainerSpec, timeoutMs = 60_000): Promise<void> {
    const now = await this.status(spec.name);
    if (now.state === 'running' && now.spec === specHash(spec)) return;
    if (now.state !== 'missing') await this.stop(spec.name);
    // Every turn of the person runs in this one container, so an OOM kill must take only the process the
    // kernel picked: systemd's default OOMPolicy=stop would stop the unit and every turn with it. The memory limits sit
    // on this unit, whose cgroup holds conmon and the payload, so going past them OOM-kills inside the container only.
    const unit = await this.run('systemd-run', ['--user', '--collect', '--quiet', `--unit=${spec.name}`, `--slice=${this.slice}`, '-p', 'TimeoutStopSec=20', '-p', 'OOMPolicy=continue', ...unitProps(spec), 'podman', 'run', ...runArgs(spec)]);
    if (unit.code !== 0) throw new Error(`could not start ${spec.name}: ${unit.stderr.trim() || `systemd-run exited ${unit.code}`}`);
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      if ((await this.status(spec.name)).state === 'running') return;
      // Its unit ended (podman refused): say why now rather than at the timeout.
      if ((await this.run('systemctl', ['--user', 'is-active', spec.name])).stdout.trim() === 'inactive') break;
      await new Promise((r) => setTimeout(r, 300));
    }
    // podman's own error line, not the whole command systemd-run logs before it.
    const log = (await this.run('journalctl', ['--user', '-u', spec.name, '-n', '20', '--no-pager', '-o', 'cat'])).stdout.split('\n');
    const why = log.find((l) => /^Error: /.test(l.trim()))?.trim() ?? log.filter((l) => l.trim() && !/^Started /.test(l)).at(-1)?.trim();
    throw new Error(`${spec.name} didn't start${why ? `: ${why.slice(0, 300)}` : ''}`);
  }

  /** Stop and remove the container (its unit ends with it). */
  async stop(name: string): Promise<void> {
    await this.run('podman', ['stop', '-t', '10', name], { timeout: 30_000 });
    await this.run('podman', ['rm', '-f', '-t', '0', name]);
    await this.run('systemctl', ['--user', 'stop', name]);
  }

  /** Run a command in the container and wait for it. */
  exec(name: string, args: string[], opts: { timeout?: number; env?: Record<string, string> } = {}): Promise<CmdResult> {
    return this.run('podman', ['exec', ...envArgs(opts.env), name, ...args], { timeout: opts.timeout });
  }

  /** The argv that runs `args` in the container, detached: it carries on without the caller. */
  detachedArgv(name: string, args: string[]): string[] {
    return ['podman', 'exec', '-d', name, ...args];
  }

  /** Make a named volume if it doesn't exist. */
  async createVolume(name: string): Promise<void> {
    const r = await this.run('podman', ['volume', 'create', '--ignore', name]);
    if (r.code !== 0) throw new Error(`could not create volume ${name}: ${r.stderr.trim()}`);
  }

  /** Where a named volume's files are on the host, or null if it doesn't exist. */
  async volumePath(name: string): Promise<string | null> {
    const r = await this.run('podman', ['volume', 'inspect', '--format', '{{.Mountpoint}}', name]);
    return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : null;
  }

  async removeVolume(name: string): Promise<void> {
    await this.run('podman', ['volume', 'rm', '-f', name]);
  }

  /** Build `tag` from the folder holding a Containerfile, unless it exists already. Slow the first time (minutes). */
  async ensureImage(tag: string, dir: string): Promise<void> {
    if ((await this.run('podman', ['image', 'exists', tag])).code === 0) return;
    const r = await this.run('nice', ['-n', '10', 'podman', 'build', '--cpu-quota', '400000', '--cpu-period', '100000', '-t', tag, dir], { timeout: 30 * 60_000 });
    if (r.code !== 0) throw new Error(`could not build ${tag}: ${(r.stderr || r.stdout).trim().split('\n').slice(-5).join('\n')}`);
  }

  /** Remove other tags of `repo` (older builds), ignoring ones still in use. */
  async pruneImages(repo: string, keep: string): Promise<void> {
    const r = await this.run('podman', ['images', '--format', '{{.Repository}}:{{.Tag}}', repo]);
    for (const tag of r.stdout.split('\n').map((s) => s.trim()).filter((s) => s && s !== keep)) await this.run('podman', ['rmi', tag]);
  }
}

function envArgs(env: Record<string, string> = {}): string[] {
  return Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
}
