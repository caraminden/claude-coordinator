// citadel-codex-review (#330): one read-only review by Codex, a second opinion from another model
// family for the self-review skill. It runs in the turn's own container on the person's own ChatGPT
// login (~/.codex, which they sign in to themselves; nothing here reads it), drives `codex app-server`
// over stdio, and prints Codex's final message.
//
//   citadel-codex-review --check            exit 0 when a review can run here, else 3 and why
//   citadel-codex-review [--timeout s] [--image path]... < brief.md
//
// --image (#408) attaches a screenshot or art sheet for Codex to see, from the review's folder or the
// turn's shared folders only (images()).
//
//   citadel-codex-review --image-gen --out path.png [--transparent] [--overwrite] [--image ref]... < prompt
//
// --image-gen (#733) makes one picture with Codex's built-in image_gen (gpt-image) on the same login, lock,
// usage check (only the 80% ceiling, no pace line: #736) and container hop, for the generate_image_codex MCP tool: --image is then a reference or the
// image to edit, and --out a .png inside the worktree or the shared folders (outPath()).
//
// Exits 0 with the review on stdout, 3 when it can't run here, 4 when it's skipped to save the
// person's Codex usage (overPace), 1 when the turn fails, 124 on timeout.
// It refuses to start without the managed tripwire hook (deploy/claude-container/codex), so Codex
// never runs unguarded: on the host, or in a container built before it. A host turn (the server login's,
// #398) has no hook, so when the runner names the login's Codex container (#341) in the turn's Codex
// config, the review runs there instead (inContainer), and that copy checks the hook for itself.
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { saveGenerated } from './codex.ts';
import { codexLock } from './codex-lock.ts';

export const REQUIREMENTS = '/etc/codex/requirements.toml';
const HOOK = '/etc/codex/citadel-hook.mjs';

/** Whether Codex's managed tripwire hook is installed here, so Codex can't run without it. */
export function hooked(requirements = REQUIREMENTS): boolean {
  let req = '';
  try {
    req = readFileSync(requirements, 'utf8');
  } catch {}
  return req.includes(HOOK) && /^allow_managed_hooks_only\s*=\s*true/m.test(req);
}

/** Why a review can't run here, or null. Only checks that files exist: the login is never read. */
export function notReady(env: Record<string, string | undefined> = process.env, requirements = REQUIREMENTS): string | null {
  if (!hooked(requirements)) return `Codex's managed tripwire hook isn't installed here (${requirements}): Codex runs only in a person's container, built from deploy/claude-container (for the server login's host turns, in its Codex container once it has signed in to Codex in Settings → Your account).`;
  const cfg = env.CITADEL_CODEX_TRIPWIRE;
  if (!cfg || !existsSync(cfg)) return 'This turn has no Codex tripwire config (CITADEL_CODEX_TRIPWIRE): it started before Codex reviews existed.';
  const home = env.CODEX_HOME || join(env.HOME || homedir(), '.codex');
  if (!existsSync(join(home, 'auth.json'))) return "This person hasn't signed in to Codex in their container yet (they run `codex login --device-auth` there themselves).";
  return null;
}

export const DEVELOPER_INSTRUCTIONS =
  'You are a read-only reviewer for Citadel, of code or of the work in the images attached to the brief. Read the code with shell commands (git, rg, sed, cat); never edit, create or delete a file, and never run tests, builds, installs or network commands. A Citadel tripwire blocks some commands and says why: take that as final and carry on without it. Reply with the review only, in the format the brief asks for.';

export const IMAGE_INSTRUCTIONS =
  'You make one picture for Citadel with your built-in image_gen tool, on behalf of the person whose login this is. Call image_gen exactly once, with the prompt, transparent_background and referenced_image_paths the message gives, unchanged. Run no shell commands and write, copy or move no files yourself: Codex saves the picture in its own folder and Citadel copies it out. Then reply with one short line saying it is done, or why image_gen failed.';

/** The message an --image-gen run sends: the person's prompt and the image_gen arguments, spelled out. */
export function imageBrief(prompt: string, transparent: boolean, refs: string[]): string {
  return `Call image_gen once with:\n- transparent_background: ${transparent}\n- referenced_image_paths: ${refs.length ? JSON.stringify(refs) : 'none'}\n- prompt (between the lines, verbatim):\n-----\n${prompt}\n-----`;
}

export interface RateWindow {
  usedPercent: number;
  resetsAt?: number | null;
  windowDurationMins?: number | null;
}
export interface RateLimits {
  primary?: RateWindow | null;
  secondary?: RateWindow | null;
}

/** Past this much of a window, reviews leave the rest for the person's own Codex work. */
const FULL_PERCENT = 80;
/** How far ahead of an even pace a window may run before reviews stop (the start of a window is lumpy). */
const PACE_SLACK = 10;

function windowName(w: RateWindow): string {
  const mins = w.windowDurationMins ?? 0;
  return mins >= 1440 ? (mins === 10080 ? 'weekly' : `${Math.round(mins / 1440)}-day`) : mins ? `${Math.round(mins / 60)}-hour` : 'usage';
}

/**
 * Why a review should be skipped to save the person's Codex plan, or null. Josh (2026-11-05): "maybe
 * the codex reviewers only run if your codex usage is on track to not be maxed". A window (5-hour,
 * weekly) is over when it's FULL_PERCENT used, or used faster than an even pace to its reset. With pace
 * false (an image run) only FULL_PERCENT counts: Cara (2026-11-14), Codex for images "as long as we arent
 * hitting usage limits"; the pace rule was Josh's for reviewers.
 */
export function overPace(limits: RateLimits | null | undefined, now = Date.now(), pace = true): string | null {
  for (const w of [limits?.primary, limits?.secondary]) {
    if (!w || typeof w.usedPercent !== 'number') continue;
    const name = windowName(w);
    if (w.usedPercent >= FULL_PERCENT) return `the ${name} Codex limit is ${w.usedPercent}% used`;
    if (!pace || !w.resetsAt || !w.windowDurationMins) continue;
    const gone = Math.min(1, Math.max(0, 1 - (w.resetsAt * 1000 - now) / (w.windowDurationMins * 60_000)));
    if (w.usedPercent > gone * 100 + PACE_SLACK) return `the ${name} Codex limit is ${w.usedPercent}% used with ${Math.round(gone * 100)}% of the window gone, on track to run out before it resets`;
  }
  return null;
}

const IMAGE_TYPES = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);

/**
 * The `--image` paths in `args`, resolved, or why one can't go to Codex (#408): an image file (png, jpg,
 * gif, webp) inside `cwd` (the worktree) or the turn's shared folders, so a review can't attach a file
 * from anywhere else on the box.
 */
export function images(args: string[], cwd: string, env: Record<string, string | undefined> = process.env): { paths: string[] } | { error: string } {
  const roots = [cwd, env.COORDINATOR_SHARED_DIR, env.COORDINATOR_FILES_DIR].flatMap((d) => {
    try {
      return d ? [realpathSync(d)] : [];
    } catch {
      return [];
    }
  });
  const paths: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== '--image') continue;
    const p = args[++i];
    if (!p) return { error: '--image needs a path' };
    let real: string;
    try {
      real = realpathSync(resolve(cwd, p));
    } catch {
      return { error: `no image at ${p}` };
    }
    if (!IMAGE_TYPES.has(extname(real).toLowerCase())) return { error: `${p} isn't a png, jpg, gif or webp image` };
    if (
      !roots.some((r) => {
        const rel = relative(r, real);
        return rel && !rel.startsWith('..') && !isAbsolute(rel);
      })
    )
      return { error: `${p} is outside this worktree and the shared folders, so it can't go to Codex` };
    paths.push(real);
  }
  return { paths };
}

/**
 * Where an --image-gen run writes its .png, resolved, or why it can't (#733): inside `cwd` (the worktree) or
 * the turn's shared folders, as images() checks a reference, and not over a file unless `overwrite`.
 */
export function outPath(p: string | undefined, cwd: string, overwrite: boolean, env: Record<string, string | undefined> = process.env): { path: string } | { error: string } {
  if (!p) return { error: '--out needs a path' };
  if (extname(p).toLowerCase() !== '.png') return { error: `${p} must end in .png: Codex makes PNGs` };
  const path = resolve(cwd, p);
  const roots = [cwd, env.COORDINATOR_SHARED_DIR, env.COORDINATOR_FILES_DIR].flatMap((d) => (d ? [resolve(d)] : []));
  const within = (rs: string[], dir: string) =>
    rs.some((r) => {
      const rel = relative(r, dir);
      return !rel.startsWith('..') && !isAbsolute(rel);
    });
  const outside = `${p} is outside this worktree and the shared folders`;
  if (!within(roots, dirname(path))) return { error: outside };
  const there = lstatSync(path, { throwIfNoEntry: false });
  // A link, even one to nothing yet, could lead the write out of the roots.
  if (there?.isSymbolicLink()) return { error: `${p} is a link: write to a plain file` };
  if (there && !overwrite) return { error: `${p} already exists (pass overwrite to replace it)` };
  try {
    mkdirSync(dirname(path), { recursive: true });
    // A symlinked folder could lead out of the roots: check where it really is.
    if (
      !within(
        roots.flatMap((r) => (existsSync(r) ? [realpathSync(r)] : [])),
        realpathSync(dirname(path)),
      )
    )
      return { error: outside };
  } catch (err: any) {
    return { error: `can't make the folder for ${p}: ${err.message}` };
  }
  return { path };
}

/** "5-hour 12%, weekly 30%": the person's Codex usage, for the self-review report line. */
export function usageLine(limits: RateLimits | null | undefined): string {
  return [limits?.primary, limits?.secondary]
    .filter((w): w is RateWindow => !!w && typeof w.usedPercent === 'number')
    .map((w) => `${windowName(w)} ${w.usedPercent}%`)
    .join(', ');
}

/**
 * Run one review: start a read-only, ephemeral thread in `cwd`, send `brief`, and resolve with Codex's
 * last message, with `images` (absolute paths) attached after it. Approval requests are declined (the sandbox
 * already refuses writes). It first reads the person's Codex usage and skips (code 4) when overPace says so;
 * `usage` is the latest usage line.
 */
export async function review(brief: string, opts: ReviewOptions & { onWait?: () => void; onWaited?: (ms: number) => void }): Promise<{ code: number; text: string; usage: string }> {
  // The person's Codex login check, as their Codex turns do it (src/codex-lock.ts).
  const env = opts.env ?? process.env;
  const gate = await codexLock(env.CODEX_HOME || join(env.HOME || homedir(), '.codex'), opts.onWait ?? (() => {}), { env, bin: opts.bin, inTurn: true });
  opts.onWaited?.(gate.waitedMs);
  try {
    return await reviewNow(brief, opts);
  } finally {
    gate.unlock();
  }
}

interface ReviewOptions {
  cwd: string;
  timeoutMs: number;
  images?: string[];
  bin?: string;
  env?: Record<string, string | undefined>;
  now?: () => number;
  /** An --image-gen run (#733): the brief is the prompt, `images` its references, and the picture goes to `out`. */
  imageGen?: { out: string; transparent: boolean; overwrite?: boolean };
}

function reviewNow(brief: string, opts: ReviewOptions): Promise<{ code: number; text: string; usage: string }> {
  const bin = opts.bin ?? 'codex';
  // file: the login stays in ~/.codex/auth.json (there's no keyring in a container); no history: CODEX_HOME grows fast otherwise.
  const gen = opts.imageGen;
  const env = opts.env ?? process.env;
  // An image run needs no shell: off, so Codex can only call image_gen, and the hook runs in image mode (#738), which lets only image_gen through.
  let imageCfg: string | null = null;
  try {
    imageCfg = gen ? imageConfig(env) : null;
  } catch (err: any) {
    return Promise.resolve({ code: 1, text: `Couldn't write the image run's tripwire config: ${err.message}`, usage: '' });
  }
  const child = spawn(bin, ['app-server', '-c', 'cli_auth_credentials_store="file"', '-c', 'history.persistence="none"', ...(gen ? ['-c', 'features.shell_tool=false'] : [])], { cwd: opts.cwd, env: imageCfg ? { ...env, CITADEL_CODEX_TRIPWIRE: imageCfg } : env, stdio: ['pipe', 'pipe', 'pipe'] });
  let nextId = 1;
  const waiting = new Map<number, (msg: any) => void>();
  const send = (msg: object) => child.stdin.write(JSON.stringify(msg) + '\n');
  const call = (method: string, params: object) =>
    new Promise<any>((resolve, reject) => {
      const id = nextId++;
      waiting.set(id, (msg) => (msg.error ? reject(new Error(`${method}: ${msg.error.message ?? JSON.stringify(msg.error)}`)) : resolve(msg.result)));
      send({ id, method, params });
    });
  let stderr = '';
  child.stderr.on('data', (b) => (stderr = (stderr + b).slice(-4000)));
  return new Promise((resolve) => {
    let last = '';
    let saved = '';
    let limits: RateLimits | null = null;
    const errors: string[] = [];
    let done = false;
    const finish = (code: number, text: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (imageCfg) rmSync(dirname(imageCfg), { recursive: true, force: true });
      child.stdin.end();
      child.kill('SIGTERM');
      const hard = setTimeout(() => child.kill('SIGKILL'), 3000);
      child.once('exit', () => clearTimeout(hard));
      resolve({ code, text, usage: usageLine(limits) });
    };
    const timer = setTimeout(() => finish(124, `Codex didn't finish the ${gen ? 'image' : 'review'} within ${Math.round(opts.timeoutMs / 1000)} s.${last ? `\nIts last message:\n${last}` : ''}`), opts.timeoutMs);
    child.on('error', (err) => finish(3, `Couldn't start ${bin}: ${err.message}`));
    child.on('exit', (code) => finish(1, `codex app-server exited (${code}) before the ${gen ? 'image' : 'review'} finished.${tail(stderr)}`));
    let buf = '';
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id !== undefined && msg.method === undefined) {
          waiting.get(msg.id)?.(msg);
          waiting.delete(msg.id);
        } else if (msg.id !== undefined) {
          // A request from Codex: decline approvals, refuse the rest (no one is there to answer).
          if (/requestApproval$|^(applyPatch|execCommand)Approval$/.test(msg.method)) send({ id: msg.id, result: { decision: 'decline' } });
          else send({ id: msg.id, error: { code: -32601, message: `${msg.method} isn't available in a read-only review` } });
        } else if (msg.method === 'account/rateLimits/updated') {
          limits = msg.params?.rateLimits ?? limits;
        } else if (msg.method === 'item/completed' && msg.params?.item?.type === 'agentMessage') {
          last = String(msg.params.item.text ?? '');
        } else if (gen && msg.method === 'item/completed' && msg.params?.item?.type === 'imageGeneration') {
          try {
            saveGenerated(msg.params.item, gen.out, gen.overwrite === true);
            saved = gen.out;
          } catch (err: any) {
            errors.push(err.message);
          }
        } else if (msg.method === 'hook/completed' && msg.params?.run?.status === 'blocked') {
          // The hook's own deny reason, word for word, ahead of Codex's paraphrase of it (#738).
          for (const e of msg.params.run.entries ?? []) if (e?.text) errors.push(String(e.text));
        } else if (msg.method === 'error' && !msg.params?.willRetry) {
          errors.push(String(msg.params?.error?.message ?? 'unknown error'));
        } else if (msg.method === 'turn/completed') {
          const turn = msg.params?.turn ?? {};
          if (gen) {
            if (saved) finish(0, `Wrote ${saved}`);
            // The hook's deny reason and errors first, then Codex's own words (a refusal), then the status as a last resort (#738).
            else finish(1, `Codex made no image: ${[...new Set([...errors, turn.error?.message, last].filter(Boolean))].join('\n') || `the turn ended ${turn.status ?? 'without a status'}`}`);
          } else if (turn.status === 'completed' && last) finish(0, last);
          else finish(1, `The Codex turn ended ${turn.status ?? 'without a status'}: ${turn.error?.message ?? errors.join('; ')}${last ? `\nIts last message:\n${last}` : ''}`.trim());
        }
      }
    });
    (async () => {
      await call('initialize', { clientInfo: { name: 'citadel-codex-review', version: '1' }, capabilities: { experimentalApi: false, requestAttestation: false } });
      send({ method: 'initialized' });
      // An account without ChatGPT limits (or an older backend) can't answer: review anyway.
      const read = (await Promise.race([call('account/rateLimits/read', { excludeResetCreditDetails: true }), sleep(15_000, undefined, { ref: false })]).catch(() => null)) as any;
      limits = read?.rateLimitsByLimitId?.codex ?? read?.rateLimits ?? null;
      // shortcut: an image run also paces against any limit whose id names images (a failed generation carries its own limitId); the id isn't documented, so check it on a real read.
      const imageLimits = gen
        ? Object.entries(read?.rateLimitsByLimitId ?? {})
            .filter(([id]) => /image/i.test(id))
            .map(([, l]) => l as RateLimits)
        : [];
      const why = [limits, ...imageLimits].map((l) => overPace(l, opts.now?.(), !gen)).find(Boolean);
      if (why) return finish(4, `Skipped to save your Codex plan: ${why}.`);
      const { thread } = await call('thread/start', { cwd: opts.cwd, sandbox: 'read-only', approvalPolicy: 'never', ephemeral: true, developerInstructions: gen ? IMAGE_INSTRUCTIONS : DEVELOPER_INSTRUCTIONS });
      // An image run names its references for image_gen to read, rather than attaching them to the chat.
      const input = gen ? [{ type: 'text', text: imageBrief(brief, gen.transparent, opts.images ?? []), text_elements: [] }] : [{ type: 'text', text: brief, text_elements: [] }, ...(opts.images ?? []).map((path) => ({ type: 'localImage', path }))];
      await call('turn/start', { threadId: thread.id, input });
    })().catch((err) => finish(1, `${err.message}${tail(stderr)}`));
  });
}

/**
 * The turn's Codex config with mode "image" (#738), written to a fresh folder, for an --image-gen run's hook:
 * review mode (the turn's own config) allows the shell only, so it blocked image_gen.
 */
function imageConfig(env: Record<string, string | undefined>): string {
  const file = join(mkdtempSync(join(tmpdir(), 'citadel-codex-image-')), 'codex-tripwire.json');
  writeFileSync(file, JSON.stringify({ ...turnConfig(env), mode: 'image' }), { mode: 0o444 });
  return file;
}

/** Where a host turn's review runs instead (#398): the server login's Codex container, as the runner wrote it in the turn's Codex config. */
export interface ReviewContainer {
  /** The container's name (citadel-claude-<id>). */
  name: string;
  /** The person's turns folder, mounted in the container at the same path: the review's files go there. */
  turnsDir: string;
  /** The container turns' environment (HOME, PATH, ...), never the host turn's own. */
  env: Record<string, string>;
}
export interface CodexConfig {
  script: string;
  config: unknown;
  container?: ReviewContainer;
}

/** The turn's Codex config (CITADEL_CODEX_TRIPWIRE, written read-only by the runner), or null. */
export function turnConfig(env: Record<string, string | undefined> = process.env): CodexConfig | null {
  try {
    const cfg = JSON.parse(readFileSync(env.CITADEL_CODEX_TRIPWIRE!, 'utf8'));
    return typeof cfg?.script === 'string' ? cfg : null;
  } catch {
    return null;
  }
}

/**
 * The Codex config the runner wrote for this turn, or null: only the file in the turn's own folder (this
 * driver is pinned at <turn>/pin), never one CITADEL_CODEX_TRIPWIRE points elsewhere, since the turn sets
 * its own environment and the config names the container a review runs in.
 */
export function runnerConfig(env: Record<string, string | undefined> = process.env, driver = fileURLToPath(import.meta.url)): CodexConfig | null {
  try {
    const own = join(dirname(dirname(realpathSync(driver))), 'codex-tripwire.json');
    if (!env.CITADEL_CODEX_TRIPWIRE || realpathSync(env.CITADEL_CODEX_TRIPWIRE) !== own) return null;
  } catch {
    return null;
  }
  return turnConfig(env);
}

/** Copy a pinned file and the ./ files it imports into `to`, as src/turn-launch.ts pins them. */
export function copyPinned(file: string, to: string) {
  const dest = join(to, basename(file));
  if (existsSync(dest)) return;
  const source = readFileSync(file, 'utf8');
  writeFileSync(dest, source);
  for (const [, dep] of source.matchAll(/from '\.\/([^']+)'/g)) copyPinned(join(dirname(file), dep), to);
}

/** podman exec's own failures: 125 podman (no such container), 126 and 127 the command or its folder. */
const PODMAN_FAILED = new Set([125, 126, 127]);

/**
 * Run this review in the container `cfg.container` names (#398), for a host turn: its turn folder isn't
 * mounted there, so this driver and the turn's pinned tripwire are copied into the person's turns folder
 * with a review-mode Codex config (the container turns' one: Bash only, read-only), and `podman exec` runs
 * the copy in `cwd` (the worktree, mounted at the same path) with the same arguments and brief. The turn's
 * pinned kit is copied too, and the brief's paths into it point at the copy: its `Follow <kit>/agents/reviewer.md`
 * line would otherwise name a folder the container can't see. That copy checks the hook, the config and the sign-in itself, so the exit codes and the `Codex usage:` line are
 * the container's own; a container that isn't there is exit 3. The copy is removed once it ends.
 */
export function inContainer(args: string[], cfg: CodexConfig & { container: ReviewContainer }, cwd: string, podman = 'podman'): Promise<number> {
  const c = cfg.container;
  const check = args.includes('--check');
  let dir = '';
  const file = () => join(dir, 'codex-tripwire.json');
  const kit = join(dirname(fileURLToPath(import.meta.url)), 'kit');
  let brief = check ? null : readFileSync(0, 'utf8');
  try {
    mkdirSync(c.turnsDir, { recursive: true });
    dir = mkdtempSync(join(c.turnsDir, 'review-'));
    copyPinned(fileURLToPath(import.meta.url), dir);
    copyPinned(cfg.script, dir);
    writeFileSync(file(), JSON.stringify({ script: join(dir, basename(cfg.script)), config: cfg.config }), { mode: 0o444 });
    if (brief !== null && existsSync(kit)) {
      cpSync(kit, join(dir, 'kit'), { recursive: true });
      brief = brief.replaceAll(kit, join(dir, 'kit'));
    }
  } catch (err: any) {
    if (dir) rmSync(dir, { recursive: true, force: true });
    return Promise.resolve(fail(check, `Couldn't set up the review for Codex's container (${c.name}): ${err.message}`));
  }
  const driver = join(dir, basename(fileURLToPath(import.meta.url)));
  // The shared folders too, so the copy can check --image paths against them (the container mounts them at the same paths).
  const shared = Object.fromEntries((['COORDINATOR_SHARED_DIR', 'COORDINATOR_FILES_DIR'] as const).flatMap((k) => (process.env[k] ? [[k, process.env[k]!]] : [])));
  const env = { ...c.env, ...shared, CITADEL_CODEX_TRIPWIRE: file() };
  const argv = ['exec', '-i', '-w', cwd, ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]), c.name, 'node', driver, ...args];
  return new Promise((resolve) => {
    let stderr = '';
    let done = false;
    const end = (code: number) => {
      if (done) return;
      done = true;
      for (const s of SIGNALS) process.off(s, stop);
      rmSync(dir, { recursive: true, force: true });
      resolve(code);
    };
    // The Bash call was stopped: stop the copy too, so it doesn't go on spending the person's Codex plan.
    const stop = () => {
      spawnSync(podman, ['exec', c.name, 'pkill', '-f', '--', driver], { stdio: 'ignore', timeout: 10_000 });
      child.kill('SIGTERM');
      end(143);
    };
    const child = spawn(podman, argv, { stdio: [brief === null ? 'inherit' : 'pipe', 'inherit', 'pipe'] });
    if (brief !== null) {
      child.stdin!.on('error', () => {});
      child.stdin!.end(brief);
    }
    for (const s of SIGNALS) process.on(s, stop);
    child.stderr.on('data', (b) => {
      if (!check) process.stderr.write(b);
      stderr = (stderr + b).slice(-4000);
    });
    child.on('error', (err) => end(fail(check, `Couldn't run podman for Codex's container (${c.name}): ${err.message}`)));
    child.on('close', (code) => {
      if (code !== null && !PODMAN_FAILED.has(code)) return end(code);
      end(fail(check, `Couldn't run the review in Codex's container (${c.name}): it isn't running (a host turn starts it again), can't see this folder, or has no node.${check ? tail(stderr) : ''}`));
    });
  });
}

const SIGNALS = ['SIGTERM', 'SIGINT', 'SIGHUP'] as const;

/** Exit 3 with why: on stdout for --check, as the plain run prints it, else on stderr. */
function fail(check: boolean, why: string): number {
  (check ? process.stdout : process.stderr).write(`${check ? '' : 'citadel-codex-review: '}${why}\n`);
  return 3;
}

function tail(s: string): string {
  const t = s.trim().split('\n').slice(-5).join('\n');
  return t ? `\n${t}` : '';
}

// In a function, never awaited at the top level: a thread that loads this module would abort the process if it were terminated mid-start (test/worker-tla.test.ts).
if (process.argv[1] === fileURLToPath(import.meta.url))
  void (async () => {
    const args = process.argv.slice(2);
    const imgs = args.includes('--check') ? { paths: [] } : images(args, process.cwd());
    if ('error' in imgs) {
      process.stderr.write(`citadel-codex-review: ${imgs.error}\n`);
      process.exit(2);
    }
    // A host turn (#398): no hook here, so the review goes to the Codex container the runner named, never runs here.
    const cfg = hooked() ? null : runnerConfig();
    if (cfg?.container) process.exit(await inContainer(args, cfg as CodexConfig & { container: ReviewContainer }, process.cwd()));
    const why = notReady();
    if (args.includes('--check')) {
      process.stdout.write(why ? `${why}\n` : 'ready\n');
      process.exit(why ? 3 : 0);
    }
    if (why) {
      process.stderr.write(`citadel-codex-review: ${why}\n`);
      process.exit(3);
    }
    const t = args.indexOf('--timeout');
    const timeoutMs = (t >= 0 ? Number(args[t + 1]) : 900) * 1000;
    const brief = readFileSync(0, 'utf8').trim();
    if (!brief || !(timeoutMs > 0)) {
      process.stderr.write('usage: citadel-codex-review [--timeout seconds] [--image path]... < brief.md   (or --check, or --image-gen --out path.png [--transparent] [--overwrite] [--image ref]... < prompt)\n');
      process.exit(2);
    }
    let imageGen: ReviewOptions['imageGen'];
    if (args.includes('--image-gen')) {
      const o = args.indexOf('--out');
      const out = outPath(o >= 0 ? args[o + 1] : undefined, process.cwd(), args.includes('--overwrite'));
      if ('error' in out) {
        process.stderr.write(`citadel-codex-review: ${out.error}\n`);
        process.exit(2);
      }
      imageGen = { out: out.path, transparent: args.includes('--transparent'), overwrite: args.includes('--overwrite') };
    }
    // For the record of what the lock costs (#636): the tool result keeps this line.
    const onWaited = (ms: number) => ms >= 1000 && process.stderr.write(`citadel-codex-review: waited ${Math.round(ms / 1000)} s for this person's Codex lock.\n`);
    const onWait = () => process.stderr.write("citadel-codex-review: waiting for this person's other Codex run.\n");
    const r = await review(brief, { cwd: process.cwd(), timeoutMs, images: imgs.paths, bin: process.env.CITADEL_CODEX_BIN, onWait, onWaited, imageGen });
    (r.code ? process.stderr : process.stdout).write(r.text + '\n');
    if (r.usage) process.stderr.write(`Codex usage: ${r.usage}\n`);
    process.exit(r.code);
  })();
