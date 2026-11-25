// What server.ts takes from its environment, read once here with each setting named, typed and defaulted (#1790). Only
// server.ts imports it: `import` runs before server.ts takes the secrets out of process.env. What a child process
// inherits (turnEnv, the handover's, app services') is the environment itself, not these.
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_DATA_DIR = join(homedir(), '.local/share/claude-coordinator');

/** `0` or `1` turns it on or off; unset or empty takes `otherwise`. */
const flag = (value: string | undefined, otherwise: boolean) => (value ? value === '1' : otherwise);

export function readConfig(env: NodeJS.ProcessEnv) {
  const preview = env.PREVIEW === '1';
  // systemd sets INVOCATION_ID: this is the service, not a test or a dev copy.
  const service = !!env.INVOCATION_ID;
  const turnUnits = flag(env.TURN_UNITS, service);
  return {
    host: env.HOST ?? '127.0.0.1',
    /** 0 (tests, boot checks) lets the kernel pick one. */
    port: Number(env.PORT ?? 8573),
    /** Contraptions each on their own host, <name>.<appsDomain> (src/apps.ts); null serves them at /apps/<name>/. */
    appsDomain: env.APPS_DOMAIN?.trim().toLowerCase() || null,
    /** Where machines' agents connect, if not the app's own address: a URL on a private network (the tailnet). */
    machinesUrl: env.MACHINES_URL ? new URL(env.MACHINES_URL) : null,
    /** Build 7, until placement (T4) is built: every ordinary minion turn of this machine's owner runs on it, when its Minion turns switch is on and its worker agent is connected. For trying the worker; unset on perigee. */
    workerForce: env.CITADEL_WORKER_FORCE?.trim() || null,
    dataDir: env.DATA_DIR ?? DEFAULT_DATA_DIR,
    /** Where contraptions' keys live; null picks by the data folder. */
    contraptionsDir: env.CITADEL_CONTRAPTIONS_DIR || null,

    /** A preview: a minion's branch on a copy of the data, no turns. */
    preview,
    /** A boot check, or a preview: no probes, schedules or listeners of the live server's. */
    bootCheck: env.BOOT_CHECK === '1' || preview,
    /** A preview stops after this long unused; 0 never. */
    idleExitMs: preview ? Number(env.IDLE_EXIT_MS) || 0 : 0,

    /** Moves the database off copy-on-write though this isn't the default data folder. */
    noCowDb: env.NOCOW_DB === '1',
    /** A test's delay on every queued write, at most 1 s. */
    dbWriteDelayMs: Math.min(Number(env.CITADEL_DB_WRITE_DELAY_MS) || 0, 1000),

    password: env.COORDINATOR_PASSWORD ?? '',
    sessionSecret: env.SESSION_SECRET ?? '',
    /** The first admin's name, on a server with none. */
    adminName: env.COORDINATOR_ADMIN?.trim() || 'Cara',
    githubClientId: env.GITHUB_CLIENT_ID ?? '',
    githubClientSecret: env.GITHUB_CLIENT_SECRET ?? '',
    githubApp: { clientId: env.GITHUB_APP_CLIENT_ID ?? '', clientSecret: env.GITHUB_APP_CLIENT_SECRET ?? '', slug: env.GITHUB_APP_SLUG ?? '' },

    claudeBin: env.CLAUDE_BIN ?? 'claude',
    turnUnits,
    turnPool: flag(env.TURN_POOL, service),
    turnSupervisor: flag(env.TURN_SUPERVISOR, turnUnits),
    /** Minions' GitHub credential helpers; `GH_HELPER=0` turns them off. */
    ghHelper: env.GH_HELPER !== '0',

    embedModel: env.CITADEL_EMBED_MODEL || 'Qwen3-Embedding-0.6B-Q8_0',
    embedUrl: env.CITADEL_EMBED_URL || 'http://127.0.0.1:21434',
    /** The schemes whose minions' memory is indexed; unset, the setting decides. */
    memorySchemes: env.CITADEL_MEMORY_SCHEMES?.split(',').map(Number),
    memoryEveryMs: Number(env.CITADEL_MEMORY_EVERY_MS) || 60_000,

    /** Web push's contact; unset, the stored setting or the pusher's own. */
    pushSubject: env.PUSH_SUBJECT,
    /** Firebase's address, for tests. */
    fcmApi: env.CITADEL_FCM_API || undefined,
    cacheDir: env.XDG_CACHE_HOME || join(homedir(), '.cache'),
    /** Bytes of free disk an upload must leave; null is the chunked uploads' own floor. */
    uploadFloor: env.UPLOAD_FLOOR_GB ? Number(env.UPLOAD_FLOOR_GB) * 1024 ** 3 : null,
    staticBackfillMs: Number(env.STATIC_BACKFILL_MS ?? 20_000),
    staticBackfillEveryMs: Number(env.STATIC_BACKFILL_EVERY_MS ?? 15 * 60_000),
    /** A copy told where to deploy to (a deploy test), so it may roll back. */
    deployLive: !!env.DEPLOY_LIVE,

    /** Under socket activation, systemd holds the listening socket as fd 3 for this process. */
    heldSocket: env.LISTEN_FDS === '1' && env.LISTEN_PID === String(process.pid),
    /** The front thread owns the port; `CITADEL_FRONT=0` has the main thread listen itself. */
    front: env.CITADEL_FRONT !== '0',
    /** Tests only: the settled route, and the readers' timings it brings. */
    testSettled: env.CITADEL_TEST_SETTLED === '1',
    readerAnswerMs: Number(env.CITADEL_READER_ANSWER_MS) || undefined,
    readerStuckMs: Number(env.CITADEL_READER_STUCK_MS) || undefined,
    readerSweepMs: Number(env.CITADEL_READER_SWEEP_MS) || undefined,
    readerBootWait: env.CITADEL_READER_BOOT_WAIT,
  };
}

export const config = readConfig(process.env);
