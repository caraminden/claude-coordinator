// Claude Coordinator: a shared web UI over headless Claude Code sessions.
import './src/host-signals.ts'; // first: a test server's fixed zone (TZ) is set before any module reads the clock (#1485)
import { flagUnbacked, FLAG_KEY } from './src/backup-flag.ts';
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readdir, mkdir, writeFile, stat } from 'node:fs/promises';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { thrown } from './src/thrown.ts';
import { createConnection, Server as NetServer, type AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { basename, extname, join } from 'node:path';
import { homedir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { isArtifact } from './src/artifacts.ts';
import { APP_NAME } from './src/appname.ts';
import { versionIcons } from './src/icons.ts';
import { shellWorker } from './src/shell.ts';
import { lendsMachine, machinesFor, mayReceive, ownerAsked, messagePerson, messageScope, turnPlace, turnRefusal } from './src/access.ts';
import { ClaudeLink } from './src/claude-link.ts';
import { ensureGradleInit, GRADLE_CACHE_CAP, gradleCacheDir, trimCache } from './src/build-cache.ts';
import { diskUsage, low, size } from './src/build-output.ts';
import { CodexLink } from './src/codex-link.ts';
import { LandHandoffs, Landings } from './src/land.ts';
import { everyLine, ShipTrail } from './src/ship-trail.ts';
import { LiveProbes, probeLog, runProbe } from './src/live-probe.ts';
import { watchLoopLag } from './src/loop-lag.ts';
import { AnswerProbe } from './src/answer-time.ts';
import { StatusPage, recordBoot, recordLive } from './src/status-page.ts';
import { citadelSliceDir, MemoryStorms, stormDetail, stormPeople } from './src/memory-storms.ts';
import { startContainerRelief, victimText } from './src/container-relief.ts';
import { readGrowth } from './src/growth-alarm.ts';
import type { Delivery } from './src/db/deliveries.ts';
import { Reaper, shownCommand, type ReaperStore } from './src/reaper.ts';
import { StandingChecks } from './src/standing-checks.ts';
import { startRealtime } from './src/realtime.ts';
import { markStop, restartDetail, startWatchdog, takeMark, readStop } from './src/sd-watchdog.ts';
import { ClientErrors, DeployWatch, countsAsServerFault, gitCommits } from './src/deploy-watch.ts';
import { judge, judged, noteWould } from './src/judges.ts';
import { UltraReviews } from './src/ultrareview.ts';
import { SideAsks } from './src/side-ask.ts';
import { installing as hostToolInstalls } from './src/host-tools.ts';
import { asData } from './src/quote.ts';
import { AGENT_NAME, Auth, type Nonces, type Session } from './src/auth.ts';
import { GITHUB_NAME, GithubWatcher, githubRepo, originRepo } from './src/github.ts';
import { ciFinished, postCard, registerCiArmed, tellTaskmaster } from './src/ci-armed.ts';
import { claudeConfigDir, lastEffort } from './src/sessions.ts';
import { buildOwnerKey, SCHEMA_VERSION, Store, type Artifact, type CiNumberStep, type Project, type User } from './src/db.ts';
import { moveEventsOffThread } from './src/events-db.ts';
import { MachineRelay } from './src/machines.ts';
import { CiHold, withoutHeld } from './src/ci-hold.ts';
import { writeHold } from './src/ci-hold-file.ts';
import { shipsOn, ShipWatch } from './src/ci-ships.ts';
import { DEFAULT_SETTINGS, MachineJobs, storedSettings } from './src/machine-jobs.ts';
import { LongJobs } from './src/long-jobs.ts';
import { gruntAtWork } from './src/live-state.ts';
import { MinionJobs } from './src/minion-jobs.ts';
import { CutOffs, jobCutOff } from './src/cut-offs.ts';
import { CACHE_TTL_MS } from './src/keepalive.ts';
import { tmpDirFor } from './src/turn-tmp.ts';
import { Pusher, loadVapidKeys, type PushTrigger } from './src/push.ts';
import { Runner, slimEvent } from './src/runner.ts';
import { describesIn } from './src/review-describe.ts';
import { pinTurnFiles, turnEnv } from './src/turn-launch.ts';
import { probeThp } from './src/unit-thp.ts';
import { fillPinSpares } from './src/pin-spares.ts';
import { exitWithParent, killNaming } from './src/exit-with-parent.ts';
import { buildPreviewPath, Previews, previewPath } from './src/previews.ts';
import { AppProxy } from './src/apps.ts';
import { ChunkedUploads, DISK_FLOOR } from './src/chunked-uploads.ts';
import { Fcm, fcmKeyPath } from './src/fcm.ts';
import { isBackupPath, serveBackup } from './src/backup.ts';
import { type Chain, chainedStep, fixShipped, githubPrs, touchedSince, LiveWaiters, missingCommits, pacificTime, relayDests, runsRepo, startChained, TimedWakes } from './src/wake.ts';
import { Outbox } from './src/outbox.ts';
import { waitsFor } from './src/waits-readout.ts';
import { followOrigins } from './src/scheme-repo.ts';
import { makeMinion, type NewMinionSpec } from './src/new-minion.ts';
import { createTicketDir, mainSync, projectDir, projectSharedDir, syncMain } from './src/workspace.ts';
import { depsNote, installDeps, installsRunning, NPM_CACHE_CAP, npmCacheDir } from './src/worktree-deps.ts';
import { ScheduledRuns } from './src/schedules.ts';
import { EffortRetros, TroubleRetros } from './src/effort-retros.ts';
import { HeldStarts } from './src/held-starts.ts';
import { curatorTarget } from './src/memory-curator.ts';
import { addAppTurnsChecks, addAreaReviews, addArchitectureChecks, addGlossaryDrifts, addMemoryCurators, backfillStandardAudits } from './src/standard-audits.ts';
import { queueLesson } from './src/ship-lessons.ts';
import { backfillRuns, importAllRubrics } from './src/review-set.ts';
import { serverWorkWatch } from './src/server-work.ts';
import { every, stopAll, type Job } from './src/every.ts';
import { handOver, standby } from './src/handover.ts';
import { guardPipes, keepServing, safely } from './src/safely.ts';
import { acceptsGzip, connection, framedWithApps, front, HttpError, isSecure, json, ownPath, ownWrites, requestUrl, router, SECURITY_HEADERS, send, writes, type App } from './src/http.ts';
import { publishLive } from './src/reader-live.ts';
import { KIT_FILE, listenThroughFront, readyFile, staticAnswer, stampServerTime, upgrades, type Statics } from './src/front.ts';
import { agentRoutes } from './src/routes/machines.ts';
import { CiNumbers } from './src/ci-numbers.ts';
import { CodeCounts, countApart } from './src/code-counts.ts';
import { ciPublisher, DesktopFeeds } from './src/desktop-feed.ts';
import { Launchers } from './src/desktop-launcher.ts';
import { CiStore } from './src/ci-store.ts';
import { CiMirror, ghDownload } from './src/ci-mirror.ts';
import { DEPLOY_DIR } from './src/routes/units.ts';
import { checkUnits, problemKeys, summary as unitSummary } from './src/unit-drift.ts';
import { Credentials, sealKey } from './src/credentials.ts';
import { Secrets } from './src/secrets.ts';
import { OpenRouter } from './src/openrouter.ts';
import { OutsideSpend } from './src/outside-spend.ts';
import { config, DEFAULT_DATA_DIR } from './src/config.ts';
import { Contraptions, DEFAULT_CONTRAPTIONS_DIR } from './src/contraptions.ts';
import { AlertWakes, type AlertPart } from './src/alert-wakes.ts';
import { AppServices, serviceOptions, ServiceError } from './src/app-services.ts';
import { startDeploy } from './src/routes/contraptions.ts';
import { AUDIT_DAYS, ContraptionTurns } from './src/contraption-turns.ts';
import { sweepMedia } from './src/contraption-media.ts';
import { sweepOrphanTmp } from './src/tmp-sweep.ts';
import { sweepKept } from './src/replay-keep.ts';
import { loadDecisions, memoryLogins } from './src/decisions-load.ts';
import { GithubLink, schemeGithub } from './src/github-link.ts';
import { RepoAccess } from './src/repo-access.ts';
import { RunnerCap, runnersBeside } from './src/runner-cap.ts';
import { RunnerJobs, RunnerTokens, runnerLabel } from './src/ci-runner.ts';
import { POOL } from './src/turn-line.ts';
import { pressure } from './src/pressure.ts';
import { MemoryEase } from './src/memory-ease.ts';
import { publishRooms, ROOM_EVERY_MS } from './src/container-room.ts';
import { GrowthStop } from './src/growth-stop.ts';
import { ArtifactSweep } from './src/artifact-sweep.ts';
import { addRunnerWaiter, CiHealth, taskmastersFor, registerRunnersBack, runnerWaiters, type Run } from './src/ci-health.ts';
import { repoSlug } from './src/prlinks.ts';
import { Incidents, readCiRuns, readDeploys, readJournal } from './src/incidents.ts';
import { ghGet, ghHelpers, ghTally } from './src/gh-api.ts';
import { ciEvidence } from './src/flake-evidence.ts';
import { CiLoad } from './src/ci-load.ts';
import { callMandate } from './src/mandate-items.ts';
import { adminAlert, adminClear, fallbacks } from './src/fallbacks.ts';
import { TimerAlerts } from './src/timer-alerts.ts';
import { FrozenShips } from './src/frozen-ships.ts';
import { AppShots, killRun, runAlive, startRun } from './src/app-shots.ts';
import { ErrorDigest, RESTART_WINDOW_MS } from './src/contraption-errors.ts';
import { ensureCoordinatorFor } from './src/routes/projects.ts';
import { KitSync, type KitSyncState } from './src/kit-sync.ts';
import { llamaEmbed, MemoryIndexer } from './src/memory.ts';
import { MinionIndexer } from './src/minion-index.ts';
import { setLabels } from './src/routes/tickets.ts';
import { redFixes, UrgentFixes } from './src/urgent-fixes.ts';
import { usageName } from './src/usage-ledger.ts';
import { ArtifactScanner } from './src/artifact-scan.ts';
import { ShipStatus } from './src/ship-status.ts';
import { Builds } from './src/builds.ts';
import { HeavySnapshot, Waits, labelTicket, readHeavyA, readQueue, readQueueA } from './src/waits.ts';
import { lineFor } from './src/ship-stop.ts';
import { CITADEL_TARGET, CitadelServer, git, previewCopies, Releases } from './src/releases.ts';
import { attachFailures, recordFailure } from './src/ship-failures.ts';
import { earlyCi, earlyDroppedWhy, landNews, readTail } from './src/land-news.ts';
import { AUTO_BY, AutoDeploy } from './src/auto-deploy.ts';
import { gitContains, LastGreen } from './src/last-green.ts';
import { Rollback } from './src/rollback.ts';
import { HostJobs, jobLost } from './src/host-job.ts';
import { FastMode, type FastState } from './src/fast-mode.ts';
import { parseFlakes } from './src/flakes.ts';
import { FlakeFixes, type FlakeFixDeps } from './src/flake-fixes.ts';
import { shipFirst } from './src/ship-line.ts';
import { shipDeploys } from './src/ship-deploys.ts';
import { StallWatch } from './src/stall-signals.ts';
import { rollBackApk } from './src/apk-release.ts';
import { apkDeployer, publisher } from './src/apk-deploy.ts';
import { ApkBuilds } from './src/apk-build.ts';
import { ApkReader, CiPackageReader, ContraptionReader, FileReader, LandsInFlight, landQueue, MainReader, PrsInFlight, ROLLBACK_BRANCH, TestCopyReader } from './src/release-readers.ts';
import type { PrSnapshot } from './src/github.ts';
import { TargetFinder } from './src/release-targets.ts';
import { CiRuns } from './src/ci-wait.ts';
import { apiRoutes } from './src/routes/all.ts';
import { KIT_DIR, listSkills, warmUsage } from './src/skills.ts';
import { themeCss } from './src/theme.ts';
import { checkpointOffThread } from './src/checkpoint.ts';
import { warmDatabase } from './src/db-warmer.ts';
import { writeOffThread } from './src/db-writer.ts';
import { busySource, settled } from './src/settled.ts';
import { moveToNoCow } from './src/db-nocow.ts';
import { Presence } from './src/presence.ts';

const HOST = config.host;
const PORT = config.port;
// The port actually bound: PORT=0 (tests, boot checks) lets the kernel pick one, reported on stdout.
let boundPort = PORT;
// Where machines' agents connect, if not the app's own address: a URL on a private network (the
// tailnet), served by a second listener that takes nothing but agents. The main listener then
// refuses agents, so a leaked token is no use from the public internet.
/** Contraptions each on their own host, <name>.<APPS_DOMAIN> (src/apps.ts); unset serves them at /apps/<name>/ here. */
const APPS_DOMAIN = config.appsDomain;
// Before the front end's files load: their headers are built once, with the policy as it is then (#1628).
if (APPS_DOMAIN) framedWithApps(APPS_DOMAIN);
const MACHINES_URL = config.machinesUrl;
const DATA_DIR = config.dataDir;
const PUBLIC_DIR = join(import.meta.dirname, 'public');
// Headless turns can't ask for approval, so anything short of full access refuses most shell commands;
// every thread gets full access.
const LOCAL_HOST = HOST === '0.0.0.0' || HOST === '::' ? '127.0.0.1' : HOST;

// A deploy's warm handover (#1170, src/handover.ts): a copy the running server started has loaded its code by here,
// and waits for the old one to let go before it does anything else. Null in a server started any other way.
const handover = await standby(SCHEMA_VERSION);
// The environment as this server got it, for the next one's handover: secrets and systemd's variables leave process.env below.
const bootEnv = { ...process.env };
await mkdir(DATA_DIR, { recursive: true });
// The copies of the server files turns run (src/turn-launch.ts): taken first, before a later deploy can move the
// checkout under a server that is still starting, and before any turn starts or is picked up again.
pinTurnFiles(DATA_DIR);
// The commit those pins came from: a SIGHUP deploy that changed kit/ or tools/ since re-pins (#1416).
let pinnedAt: string | null = checkoutHead();
// Spare turn copies of them, made off the loop so a turn's start doesn't copy ~370 files there (#1414).
void fillPinSpares();
// The front end as it was when this server started, or last reloaded on SIGHUP. Serving this copy,
// not the files on disk, keeps pages in step with the running server: a deploy that changes the
// server swaps both at the restart, so a tab never gets a new front end that calls API routes the old
// server doesn't have yet. A deploy that changes only public/ or light paths sends SIGHUP instead (tools/deploy.sh).
let ASSETS = new Map<string, Buffer>();
// Fingerprint of the front end, so open tabs can tell they are stale after a deploy.
let ASSET_VERSION = '';
// Each file's content hash as served (X-Front-Hash): the service worker re-fetches only the files whose hash changed (#1331).
let ASSET_HASHES = new Map<string, string>();
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.mjs': 'text/javascript; charset=utf-8',
  '.ts': 'text/plain; charset=utf-8', // public/ui/*.d.ts, the types apps read
};
// Asked of browsers for the manifest's dark variant (darkManifest, below).
const COLOR_SCHEME_HINT = 'Sec-CH-Prefers-Color-Scheme';
// The files as sent, headers and gzipped bodies made once (#1628): the front thread serves them, and serveStatic here.
let STATICS: Statics | null = null;
// Set once the front thread owns the port (below); declared here because loadAssets posts to it.
let throughFront: ReturnType<typeof listenThroughFront> | null = null;
async function loadAssets() {
  const assets = new Map<string, Buffer>();
  // public/ and its ui/ folder (Citadel UI, the modules apps import from /apps/_citadel/ui/).
  const files = async (sub: string) => (await readdir(join(PUBLIC_DIR, sub), { withFileTypes: true })).filter((e) => e.isFile()).map((e) => sub + e.name);
  for (const f of [...(await files('')), ...(await files('ui/'))].sort()) {
    const body = await readFile(join(PUBLIC_DIR, f));
    assets.set(f, /\.(html|js|webmanifest)$/.test(f) ? Buffer.from(body.toString('utf8').replaceAll('%APP_NAME%', SHOWN_NAME)) : body);
  }
  versionIcons(assets);
  // Contraptions' copy of Citadel's colours, built from style.css (src/theme.ts).
  assets.set('theme.css', Buffer.from(themeCss(assets.get('style.css')!.toString('utf8'))));
  // Built before anything is swapped, so a bad manifest leaves the old front end whole.
  const dark = darkManifest(assets);
  const version = createHash('sha256')
    .update([...assets.values()].join('\0'))
    .digest('hex')
    .slice(0, 12);
  // The page knows its own version (#1144): one the service worker kept from before a ship reloads into the new one.
  assets.set('index.html', Buffer.from(assets.get('index.html')!.toString('utf8').replace('%ASSET_VERSION%', version)));
  const hashes = new Map([...assets].map(([name, body]) => [name, createHash('sha256').update(body).digest('hex').slice(0, 16)]));
  const statics = await staticTable(assets, version, hashes, dark);
  // Swapped together after the last await: SIGHUP's caller sets liveCommit in the same tick, so /api/health never pairs the new version with the old commit (#1628).
  ASSETS = assets;
  ASSET_VERSION = version;
  ASSET_HASHES = hashes;
  STATICS = statics;
  throughFront?.statics(STATICS);
}
// The commit this server's code came from, so a deploy can tell whether the change it ships is
// front end only. null outside a git checkout.
function checkoutHead(): string | null {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: import.meta.dirname, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}
const BOOT_COMMIT = checkoutHead();
// Set by tools/deploy.sh when it boots new code on a copy of the database: serve and answer, but
// don't resume interrupted turns or watch GitHub, which would act on the copy's minions for real.
// A preview (src/previews.ts): a minion's branch served on a copy of the database for people to try.
// Everything BOOT_CHECK skips, and more: no turns at all, no new minions or schemes (git in the real
// repos), no pushes, no machines, no startup sweeps.
const PREVIEW = config.preview;
const BOOT_CHECK = config.bootCheck;
// The tab title tells a preview from the live app.
const SHOWN_NAME = PREVIEW ? `${APP_NAME} preview` : APP_NAME;
// A preview goes with the server that started it, however that one goes (it is reparented then).
const PARENT = process.ppid;
if (PREVIEW) every('preview parent check', 2000, () => process.ppid !== PARENT && process.exit(0));
// A server a test started goes with the test too, and takes its turns and supervisors along (#1546); never the live data folder's.
const leaveWithTest = DATA_DIR !== DEFAULT_DATA_DIR ? exitWithParent(DATA_DIR, every, PARENT) : undefined;
// A dead stdout/stderr (#1965): a test server goes the same way it goes when its parent does; the live server, dev copies, previews and containers keep serving, silently.
guardPipes(() => {
  if (DATA_DIR !== DEFAULT_DATA_DIR && config.exitsWithTest) void killNaming(DATA_DIR).finally(() => process.exit(0));
});
// Stalls of the event loop are named in the journal (#526), the start's own synchronous work included, with the code that ran (#609).
// A long one names who else has the databases open: a lock they hold, or a copy loading the disk (#622).
// The post-deploy watch (#724), made once the store and waiters are: stalls before then are the boot's own.
let deployWatch: DeployWatch | null = null;
// Once, at the first start with it, before anything opens the database: the live file into a no-COW file (#761).
// Not a dev copy's, a preview's or a boot check's: each would keep a second 1 GB file. NOCOW_DB=1 runs it anywhere, to try it.
if (config.noCowDb || (!BOOT_CHECK && DATA_DIR === DEFAULT_DATA_DIR)) {
  // events.db too (#1169): before the move below fills it, it is the empty file the last release made.
  for (const file of ['coordinator.db', 'events.db']) {
    const { moved, note } = moveToNoCow(join(DATA_DIR, file));
    if (note !== 'already no-COW' && note !== 'no database yet') (moved ? console.log : console.warn)(`${file}: ${note}`);
  }
}
const BOOT_AT = Date.now();
let writerQueued: () => number = () => 0;
if (!BOOT_CHECK) watchLoopLag((line) => (console.warn(line), deployWatch?.record('loop-lag', line.slice(0, 700))), 100, 500, { profile: true, backlog: () => writerQueued(), files: ['coordinator.db', 'state.db', 'events.db'].map((f) => join(DATA_DIR, f)) });
// systemd restarts a hung server once these pings stop (#1135, deploy/claude-coordinator.service.d/watchdog.conf).
const watchdog = startWatchdog();
// Before any unit starts: whether systemd-run takes MemoryTHP= (src/unit-thp.ts).
await Promise.all([loadAssets(), probeThp()]);
// The chat log's move into events.db (#1169), off the event loop so the watchdog's pings go on; the Store finds it done.
const eventsMove = await moveEventsOffThread(join(DATA_DIR, 'coordinator.db'));
if (eventsMove) console.log(eventsMove);
const store = new Store(join(DATA_DIR, 'coordinator.db'));
// First in line for a core (#1561): on live by default, off in dev copies and tests unless the realtime_priority setting is true.
if (!BOOT_CHECK) startRealtime({ enabled: () => store.getSetting<boolean>('realtime_priority') ?? DATA_DIR === DEFAULT_DATA_DIR });
// Writes on a worker of their own: the first after a checkpoint fsyncs the WAL's header, held up to 14.3 s (#795).
// Before the checkpoint worker, so its autoCheckpoint(false) reaches both connections.
// CITADEL_DB_WRITE_DELAY_MS is for tests (#1239): every write waits that long on the worker, as on a starved box, so a test
// that reads the database itself right after a response, without waiting for the row, goes red every run. At most 1 s.
const writer = writeOffThread(store, { delayMs: config.dbWriteDelayMs });
// Off the event loop: a checkpoint fsyncs, and a stalled disk made one hold every request for seconds (#680).
if (writer) writerQueued = writer.queued;
checkpointOffThread(store);
// Reads the database into memory every 5 s on a worker, so the box can't evict it (#1560); the `db-warmer` setting turns it off.
const dbWarmer = warmDatabase(store);
// A thread's turn-token nonces live in settings, so turns that run through a restart keep theirs; a closed one's are dead.
const auth = new Auth(
  config.password,
  config.sessionSecret,
  {
    get: (id) => {
      const ticket = store.getTicket(id);
      return ticket ? { ...(store.getSetting<Nonces>(`agent-nonce:${id}`) ?? { current: null, previous: null }), closed: ticket.status === 'closed' } : null;
    },
    set: (id, nonces) => store.setSetting(`agent-nonce:${id}`, nonces),
  },
  store,
);
// The first start with per-person logins (or any with no admin) makes the admin, whom COORDINATOR_PASSWORD
// signs in until they set a password, and every scheme from before owners becomes theirs.
if (!store.listUsers().some((u) => u.admin)) {
  const name = config.adminName;
  store.createUser({ name, login: name.toLowerCase().replace(/[^a-z0-9._-]/g, ''), admin: true, server_login: true });
}
store.adoptOwnerless(store.listUsers().find((u) => u.admin)!.id);
// Before anything reads repo_url: a scheme whose repo moved on GitHub follows its checkout's origin (#456).
await safely('follow repo moves', () => followOrigins(store));
const credentials = new Credentials(store, config.sessionSecret);
// Seals machine tokens for their owner's Show (#1355): read here, before SESSION_SECRET leaves the environment below.
const machineTokenKey = sealKey(config.sessionSecret, 'citadel machine tokens v1');
// People's own OpenRouter keys (#717). OPENROUTER_BASE_URL points a dev copy or test at a fake.
const openrouter = new OpenRouter(store, credentials);
// Outside-API spend and its optional per-scheme cap (#839): crossing the cap tells the scheme's Taskmaster chat and pushes; nothing stops.
const outsideSpend = new OutsideSpend(store);
// Passwords and keys people save from a secret card or Settings (#838).
const secrets = new Secrets(store, config.sessionSecret);
// Only the live data dir writes the real key folders: a dev copy registering "mandate" mustn't overwrite the live one's files.
const contraptions = new Contraptions(store, config.sessionSecret, config.contraptionsDir ?? (DATA_DIR === DEFAULT_DATA_DIR ? DEFAULT_CONTRAPTIONS_DIR : join(DATA_DIR, 'contraptions')));
// Contraptions' systemd user services (#266): only the live server touches systemd, never a boot check or preview.
const services = new AppServices(
  serviceOptions(process.env, DATA_DIR === DEFAULT_DATA_DIR, BOOT_CHECK, {
    keysDir: (name) => contraptions.folder(name),
    citadelUrl: () => `http://${LOCAL_HOST.includes(':') ? `[${LOCAL_HOST}]` : LOCAL_HOST}:${boundPort}`,
    logDir: join(DATA_DIR, 'contraption-deploys'),
  }),
);
const githubLink = new GithubLink(store, credentials, config.githubClientId, config.githubClientSecret, undefined, {
  clientId: config.githubApp.clientId,
  clientSecret: config.githubApp.clientSecret,
  slug: config.githubApp.slug,
});
// A boot check or preview runs on a copy of the data: it leaves GitHub alone.
const repoAccess = new RepoAccess(store, githubLink, !BOOT_CHECK);
const runnerTokens = new RunnerTokens(store, githubLink, !BOOT_CHECK);
// People's own Claude plans (#213). A dev copy tags its containers so it never shares the live server's.
const claudeLink = new ClaudeLink(store, credentials, DATA_DIR, config.claudeBin, undefined, DATA_DIR === DEFAULT_DATA_DIR ? 'citadel-claude-' : `citadel-claude-${createHash('sha256').update(DATA_DIR).digest('hex').slice(0, 6)}-`);
// Keep secrets out of the environment that claude and its tools inherit; the reader threads get the sign-in keys in their start data.
const signInKeys = { password: config.password, secret: config.sessionSecret };
delete process.env.COORDINATOR_PASSWORD;
delete process.env.SESSION_SECRET;
delete process.env.GITHUB_CLIENT_SECRET;
delete process.env.GITHUB_APP_CLIENT_SECRET;

const MAX_CLIENT_BACKLOG = 4 * 1024 * 1024;
const clients = new Map<ServerResponse, Session>();
function broadcast(msg: object) {
  const data = `data: ${JSON.stringify(msg)}\n\n`;
  const scope = messageScope(store, msg);
  // The machines list goes to everyone, each person's cut to the machines they manage (#306).
  const machineList = (msg as { type?: string }).type === 'machines' ? (msg as { machines: ReturnType<MachineRelay['list']> }).machines : null;
  for (const [res, who] of clients) {
    // Drop clients that stopped reading rather than buffering for them forever.
    if (res.writableLength > MAX_CLIENT_BACKLOG) {
      clients.delete(res);
      res.destroy();
    } else if (mayReceive(store, who, scope) && (!('payer' in msg) || runner.payerOf(who.uid) === (msg as { payer: number | null }).payer) && (!('to' in msg) || who.uid === (msg as { to: number }).to)) {
      res.write(machineList && !who.admin ? `data: ${JSON.stringify({ ...msg, machines: machinesFor(who, machineList) })}\n\n` : data);
    }
  }
}

const runner = new Runner(
  store,
  broadcast,
  (ticket, token) => ({
    COORDINATOR_API: `http://${LOCAL_HOST.includes(':') ? `[${LOCAL_HOST}]` : LOCAL_HOST}:${boundPort}`,
    COORDINATOR_TOKEN: token ?? auth.turnToken(ticket.id),
    COORDINATOR_PROJECT: String(ticket.project_id),
  }),
  config.claudeBin,
);
// Turns run in units of their own when this is the systemd service (systemd sets INVOCATION_ID), so a
// restart doesn't stop them; TURN_UNITS=0 or 1 overrides that.
runner.units = config.turnUnits;
// Turns share their place's tool server (#1259) in the service too, not in tests or dev copies; TURN_POOL=0 or 1 overrides that
// (0: every turn runs its own helpers again).
runner.pool = config.turnPool;
// Host turns start in the shared turn supervisor (#1343) wherever they get units; TURN_SUPERVISOR=0 or 1 overrides that
// (0: each turn gets its own wrapper unit again).
runner.supervisor = config.turnSupervisor;
runner.noTurns = PREVIEW;
runner.contraptionKeys = contraptions.dir;
// The line of kill resumes (#1364) holds while the box is starved; nothing else in the runner waits on it.
runner.killStarved = () => pressure.read();
/** Whether the box is short of CPU or memory: a wait (#1890) or an approval card (#1916) then gives back what it holds at once. */
const boxShort = (r: { starved: boolean }) => r.starved || memoryEase.get().level !== 'ok';
// The worker pool sizes itself to the box (#1868), unless a person set a number.
setInterval(
  () =>
    void pressure
      .read()
      .then((r) => {
        const free = memoryEase.free();
        const { level } = memoryEase.get();
        runner.startNow.sweep();
        runner.turnLine.tick(r, stormPeople(memoryStorms.current()), Date.now(), { freeGb: free === null ? null : free / 1024 ** 3, level });
        runner.endCardWaits(boxShort(r));
      })
      .catch((e) => console.error('worker pool:', e)),
  POOL.everyMs,
).unref();
// The server notices a stall (#1139): counts each minion's red tests, file churn and failed ships, and suggests a step-up to its Taskmaster.
const stallWatch = new StallWatch({
  store,
  tell: (t, text) => {
    const tm = store.ownerCoordinator(t);
    if (!tm) return false;
    // A loop-held relay still reaches the Taskmaster once a person continues it, so it counts as told.
    runner.relay(t.id, tm.id, APP_NAME, text, false, true, 'decision');
    return true;
  },
  note: (id, text) => runner.emit(id, 'note', { text }),
});
if (!PREVIEW) runner.onStreamEvent = (id, ev) => stallWatch.observe(id, ev);
const cutOffs = new CutOffs((id, cut) => store.addWaitRecord(id, 'cut', cut));
runner.onRawEvent = (id, ev) => {
  try {
    cutOffs.observe(id, ev);
  } catch (err) {
    console.error(`[cut-offs] minion ${id}: ${thrown(err).message}`);
  }
};
// Minions' branches served for people to try (src/previews.ts); a preview serves none of its own.
const previews = PREVIEW ? null : new Previews(store, DATA_DIR);
if (previews) {
  previews.onChange = (ticketId) => runner.broadcastTicket(ticketId);
  runner.onClose = (ticketId) => previews.stop(ticketId, true);
  // Builds' previews are of this server's own code, so only its own scheme has them.
  previews.buildScheme = ownScheme;
}
if (BOOT_CHECK) {
  runner.turnLine.clear();
  runner.startNow.clear();
}
if (!BOOT_CHECK) {
  // Before any recover() below, so a job lost across the restart is recorded too (#1325).
  jobLost.hear = (_dir, detail) => store.addHealthEvent('job-killed', Date.now(), null, detail);
  void runner.warmCards();
  runner.recover();
}
if (runner.units && !BOOT_CHECK) {
  execFile('systemctl', ['--user', 'show', '-p', 'MemoryMax', '--value', 'citadel.slice'], (err, out) => {
    if (err || out.trim() === 'infinity') console.warn('citadel.slice has no MemoryMax, so turns run uncapped: install deploy/citadel.slice (see README).');
  });
}
// Units in deploy/ not installed here, or different (#1216): checked at boot and every 6 h; Citadel's members get one push when a
// unit newly goes missing or different, and one again if it is fixed and then breaks again. Read-only: it installs nothing.
async function checkUnitDrift() {
  const rows = checkUnits(DEPLOY_DIR);
  const now = problemKeys(rows);
  const seen = new Set(store.getSetting<string[]>('unit_drift_seen') ?? []);
  const fresh = now.filter((k) => !seen.has(k));
  if (fresh.length) {
    const home = ownScheme();
    const bad = rows.filter((r) => fresh.includes(`${r.name}:${r.state}`));
    if (home) await pusher.broadcast(home.id, { title: 'Units not installed on perigee', body: `${bad.map((r) => `${r.name} (${r.state})`).join(', ')}. Install commands: Settings > Units.`.slice(0, 280), tag: 'unit-drift', url: '/c/#/p/' + home.id + '/units' });
    else return; // no scheme to tell yet: ask again next time
  }
  store.setSetting('unit_drift_seen', now);
  if (now.length) console.warn(`${unitSummary(rows)}; Settings > Units has the install commands.`);
}
if (!BOOT_CHECK && !PREVIEW && runner.units) {
  every('unit drift', 6 * 3600_000, checkUnitDrift, 90_000);
}
// The one outbox (src/outbox.ts, ADR 0021): saved "send this later" rows. wake_at (#722) and wake_when_live are its kinds; boot moves the
// old timed-wakes key in, resends what a killed server left mid-send, and sends what came due while it was down.
const outbox = new Outbox(store, runner, { author: APP_NAME, log: (msg) => console.error(msg) });
const timedWakes = new TimedWakes(store, outbox);
registerRunnersBack(store, outbox);
registerCiArmed(() => app, store, outbox); // armed for CI (#715, ADR 0021 step 5)
// News of a minion's test-box job (#1425, machines.watchBoxes below): its start, its end with the exit code and last lines.
outbox.register({ kind: 'box_job', describe: (r) => `test box news: ${String(r.payload.text).slice(0, 120)}`, deliver: (rows, ctx) => rows.map((r) => ctx.send(r, String(r.payload.text))) });
// Jobs that outlive a minion's turn (#1890): citadel-job starts them here, and their end wakes the minion.
const minionJobs = new MinionJobs({
  store,
  cutOff: (job) => store.addWaitRecord(job.ticket, 'cut', jobCutOff(job)),
  tmp: (id) => {
    const t = store.getTicket(id);
    return t && t.status !== 'closed' ? tmpDirFor(runner.tmpRoot(t.project_id), id) : null;
  },
  turn: (id) => runner.jobTurn(id),
  live: (id) => runner.turnStartedAt(id) !== null,
  hold: async (id) => {
    const turn = runner.jobTurn(id);
    if (!('refuse' in turn) && turn.person !== null && runner.turnLine.stalledFor(turn.person)) return 0;
    return runner.turnLine.starved || boxShort(await pressure.read()) ? 0 : runner.turnLine.limits().waitHold * 1000;
  },
  grunts: (id) => gruntAtWork(store.listEvents(id, store.eventIdAt(runner.turnStartedAt(id) ?? Date.now()) - 1)),
  units: () => runner.units,
  wake: (id, text) => void runner.send(id, APP_NAME, text),
  changed: (id) => runner.broadcastTicket(id),
  lastTurnEnd: (id) => store.lastTurnEnd(id),
  cacheMs: CACHE_TTL_MS,
});
runner.jobs = minionJobs;
if (!BOOT_CHECK && !PREVIEW) every('minion jobs', 3_000, () => minionJobs.pump());
// Minions that called wake_when_live hear from "Citadel" once the deploy they wait on is live. Sent
// with runner.send, not relay, so the loop guard neither counts nor holds them.
const waiters = new LiveWaiters(store, import.meta.dirname, BOOT_COMMIT, (ticketId, text, light) => runner.send(ticketId, APP_NAME, text, [], light ? { light } : {}), outbox);
if (!BOOT_CHECK && DATA_DIR === DEFAULT_DATA_DIR) waiters.proven = null; // until liveOn knows whether this boot can still be rolled back
// A reopened minion's held waits go back to waiting (the outbox), and one whose deploy came live meanwhile is found now.
runner.onStop = (ticketId, eventIds) => outbox.stoppedMessages(ticketId, eventIds);
runner.onTurnStart = (ticketId, eventIds) => {
  const held = store.listDeliveries({ to: ticketId, states: ['held'] }).some((r) => r.kind === 'wake_when_live' || r.kind === 'chain');
  outbox.turnStarted(ticketId, eventIds);
  minionJobs.turnStarted(ticketId);
  if (held)
    void outbox
      .poke({ type: 'reopened', ticket: ticketId })
      .then(() => waiters.check())
      .catch((err) => console.error('Checking waiters after a reopen failed:', err));
};
if (!BOOT_CHECK) void outbox.boot();
// The scheme whose code this server runs (its repo has the live commit); checked again once a deploy moves the live commit.
// A repo found without that commit is asked again only after a minute (it may fetch it), and one made or cloned since is
// asked on the next call. Asking every repo on every call held a loaded server's loop for seconds when no scheme has the
// commit (a test's or dev copy's server): one scheme-sources run made 1,159 git calls and timed a test out (#1469).
let own: { head: string | null; id: number | null; lacks: Map<string, number> } | null = null;
function ownScheme(): Project | null {
  if (own?.head !== waiters.head) own = { head: waiters.head, id: null, lacks: new Map() };
  if (own.id === null && own.head) {
    const now = Date.now();
    for (const p of store.listProjects()) {
      if (!p.repo_dir || now - (own.lacks.get(p.repo_dir) ?? -Infinity) < 60_000) continue;
      if (runsRepo(p.repo_dir, own.head)) {
        own.id = p.id;
        break;
      }
      own.lacks.set(p.repo_dir, now);
    }
  }
  return own.id === null ? null : (store.getProject(own.id) ?? null);
}
// The server reads a scheme's GitHub (PRs, merges, fetches) as its owner (#321): a private repo may let no one else in.
const githubOf = (repoDir: string) => schemeGithub(store, githubLink, repoDir, DATA_DIR);
// GitHub reads go through a helper per login that stays up, not a `gh` per read (#1542). A test server keeps `gh`.
if (config.ghHelper) ghHelpers.dir = join(DATA_DIR, 'run', 'gh');
waiters.prs = githubPrs(githubOf, missingCommits(store));
mainSync.as = githubOf;
// A contraption's deploy clones and fetches its repo the same way, as its home scheme's owner (#915).
services.githubAs = (c) => {
  const p = c.home_scheme != null ? store.getProject(c.home_scheme) : undefined;
  return p?.repo_dir ? githubOf(p.repo_dir) : undefined;
};
runner.liveHead = () => waiters.head;
/** Where a log-only judge (#1503, src/judges.ts) notes what it would have done: the retro log of the scheme its act was for, else the home scheme's. */
const judgeNote =
  <A extends unknown[]>(schemeOf: (...a: A) => number | null | undefined) =>
  (line: string, ...a: A) => {
    const id = schemeOf(...a) ?? ownScheme()?.id;
    noteWould(id != null ? projectSharedDir(DATA_DIR, id) : null, line);
  };
// After each deploy, compare health before and after it and wake the minions that shipped a regression (#724). No model.
deployWatch = new DeployWatch({
  store,
  dbPath: join(DATA_DIR, 'coordinator.db'),
  bootAt: BOOT_AT,
  head: () => waiters.head,
  scheme: ownScheme,
  commits: gitCommits(import.meta.dirname),
  wake: judged<[number, string], unknown>(
    'deploy-watch',
    'wake',
    (id, text) => runner.send(id, APP_NAME, text),
    () => {},
    judgeNote((id) => store.getTicket(id)?.project_id),
  ),
  mail: judged<[number, string], unknown>(
    'deploy-watch',
    'mail',
    (id, text) => runner.leaveMail(id, APP_NAME, text),
    () => {},
    judgeNote((id) => store.getTicket(id)?.project_id),
  ),
});
// The last run was stopped by systemd's watchdog: a health event, with the last stall it recorded before (#1135).
const watchdogAt = takeMark(DATA_DIR);
if (watchdogAt) {
  const text = restartDetail(watchdogAt, store.lastHealthEvent('loop-lag', watchdogAt));
  console.warn(text);
  deployWatch.record('watchdog', text);
}
const clientErrors = new ClientErrors();
// Semantic memory (#331): llama-server on this box embeds the chats (deploy/citadel-embed.service).
const EMBED_MODEL = config.embedModel;
const EMBED_URL = config.embedUrl;
const embed = llamaEmbed(EMBED_URL);
const MEMORY_SCHEMES = config.memorySchemes;
// Every scheme is indexed (#488); CITADEL_MEMORY_SCHEMES narrows it to some, for tests or a box that can't keep up.
const memoryScheme = (id: number) => !MEMORY_SCHEMES || MEMORY_SCHEMES.includes(id);
runner.memoryScheme = memoryScheme;
/** Fetch a scheme's origin and fast-forward its main if it can (#208), then look at the waiters again: a merge on GitHub can be what they wait on (#229). */
function catchUp(repoDir: string) {
  void syncMain(repoDir)
    .catch((err) => console.error(`Catching up main in ${repoDir} failed:`, err))
    .then(() => {
      waiters.prs.forget?.();
      return waiters.check();
    })
    .catch((err) => console.error('Checking waiters after a merge failed:', err));
}
/** Pass on each claim whose holder's change is live (#1985). */
const passLiveClaims = () => runner.holdersLive((id, commit) => waiters.isLive(id, commit)).catch((err) => console.error('Passing on the claims of live ships failed:', err));
/** The server now runs `head`: wake its waiters, and dismiss pending-deploy minions it ships. */
function liveOn(head: string | null, booted = false) {
  // Not waited for (#526): its git and gh calls take seconds, and the server answers meanwhile.
  deployWatch?.live(head);
  void (async () => {
    // A restart that settles badly is rolled back: nothing is closed or told "live" before deploy.sh stands by it.
    if (booted && !(await waiters.prove())) return;
    waiters.proven = head;
    await waiters.check(head);
    for (const id of await waiters.pendingLive()) runner.deployLive(id);
    await passLiveClaims();
    void liveProbes.sweep().catch((err) => console.error(`The live probe sweep failed: ${err?.message ?? err}`)); // #1741: a kept probe whose ship this head has; never holds up what follows
    // Last, so nothing above waits on it; after waiters.check, which moves the head that says whose code is live.
    await citadelServer.live(head);
    await releases.pollA();
  })().catch((err) => console.error('Checking waiters after a deploy failed:', err));
}
const machines = new MachineRelay(store, () => broadcast({ type: 'machines', machines: machines.list() }));
machines.tokenKey = machineTokenKey;
const runnerJobs = new RunnerJobs(store, runnerTokens, machines);
/** Take a card out of people's way with a line saying why (a machine job's go, a superseded kit sync); an answered or settled one stays. */
function settleCard(card: { ticket: number; question: string }, by: string, line: string) {
  const e = store.eventsOfKinds(card.ticket, ['question']).find((q) => JSON.parse(q.data).id === card.question);
  const q = e && JSON.parse(e.data);
  if (!e || q.settled) return;
  const settled = { at: Date.now(), by };
  store.setEventData(e.id, { ...q, settled });
  runner.emit(card.ticket, 'question_result', { id: q.id, settled });
  runner.emit(card.ticket, 'note', { text: line });
  runner.broadcastTicket(card.ticket);
}
// Jobs on a person's own machine (#857): the queue of record, its go cards in the asking minion's chat (a
// contraption's in its home scheme's Taskmaster chat), and results in the scheme's shared folder or the app's DATA_DIR.
const jobs = new MachineJobs({
  store,
  broadcast,
  send: (id, msg) => machines.sendJob(id, msg),
  online: (id) => machines.isOnline(id),
  postCard: (job, card) => {
    const ticket = job.ticket_id !== null ? store.getTicket(job.ticket_id) : store.getCoordinator(job.project_id);
    return ticket ? { ticket: ticket.id, question: postCard(app, ticket, { ...card, job: job.id }).id } : null;
  },
  settleCard: (card, by, line) => settleCard(card, by, line),
  wake: (id, text, light) => runner.send(id, APP_NAME, text, [], light ? { light } : {}),
  note: (id, text) => {
    runner.emit(id, 'note', { text });
    runner.broadcastTicket(id);
  },
  // The view rides along so the card draws at once, sized as it will stay; machine_job events keep it live after.
  placed: (job, stage, view) => {
    runner.emit(job.ticket_id!, 'job', { job: job.id, stage, view });
    runner.broadcastTicket(job.ticket_id!);
  },
  resultsDir: (job) => {
    if (job.contraption_id === null) return join(projectSharedDir(DATA_DIR, job.project_id), 'jobs', String(job.id));
    const c = store.listContraptions().find((r) => r.id === job.contraption_id);
    return c ? join(services.dataDir(c), 'jobs', String(job.id)) : null;
  },
});
machines.jobHooks = { info: (m, known, since) => jobs.reconcile(m, known, since), offline: (id) => jobs.offline(id) };
// A minion whose test-box job waits for the screen can end its turn: Citadel follows the job and messages its chat through the outbox (#1425).
if (!BOOT_CHECK)
  machines.watchBoxes((id, text) => {
    const now = outbox.clock();
    outbox.add({ project_id: store.getTicket(id)?.project_id ?? 0, kind: 'box_job', to_kind: 'minion', to_id: id, when_kind: 'at', when_arg: now, due: now, payload: { text }, set_by: 'server' });
  });
if (!BOOT_CHECK && !PREVIEW) jobs.start();
const ciStore = new CiStore(store, DATA_DIR);
const ciNumbers = new CiNumbers(store);
const codeCounts = new CodeCounts(store, { dir: join(DATA_DIR, 'code-counts'), count: countApart });
// One scheme's git a tick, each once a day, after the boot's rush (#1988).
if (!BOOT_CHECK && !PREVIEW) every('code counts', 5 * 60_000, () => codeCounts.tick(), 10 * 60_000);
runner.machines = (project, askers) => machines.online().filter((m) => lendsMachine(store, m, project, askers));
runner.refuseTurn = (ticket, author, from, asker) => turnRefusal(store, ticket, author, (uid) => claudeLink.linked(uid), from, asker);
runner.placeFor = (person, warm, taskmaster) => turnPlace(store, claudeLink, person, warm, taskmaster);
runner.accountFor = (person, warm) => claudeLink.accountFor(person, warm);
runner.onAuthFailure = (person, account) => claudeLink.expire(person, account);
// Several Claude accounts per person (#779): which one turns run on, and moving on from one at its limit.
runner.claudeAccounts = (person) => claudeLink.accountList(person);
runner.onLimit = (person, account, until) => claudeLink.limitedView(person, account, until);
claudeLink.turnOn = (configDir) => runner.turnIn(configDir);
runner.onCleared = (person, account) => claudeLink.cleared(person, account);
runner.onRan = (person, key, account) => claudeLink.ran(person, key, account);
const codexLink = new CodexLink(claudeLink);
// Codex turns (#337) run only in a person's own container, once they've signed in to Codex there (the server login's: #341).
const codexReady = (uid: number) => {
  const state = codexLink.status(uid).state;
  return state === 'linked' ? null : state === 'no container' ? 'Codex runs in your own Claude container, so link your Claude in Settings first' : 'you are not signed in to Codex (Settings → Your account)';
};
runner.codexReady = codexReady;
// The server login's owner signs in to Codex in a container of its own, and its Codex turns run there (#341).
runner.codexPlaceFor = (uid) => claudeLink.codexPlace(uid);
// Its host turns' Codex reviews run in that container too (#398), so a host turn starts it if it isn't running.
runner.wakeCodex = (uid) => void claudeLink.wakeCodex(uid).catch((err) => console.error(`Starting the Codex container for a review failed: ${err.message}`));
// Contraptions' turns (the turn API): on the same Claude a person's minion turns use, never anyone else's.
const contraptionTurns = new ContraptionTurns(store, contraptions, claudeLink, { dataDir: DATA_DIR, claudeBin: config.claudeBin });
contraptionTurns.noTurns = PREVIEW;
contraptionTurns.codexWhy = (uid) => runner.codexWhy(uid);
contraptionTurns.onCodexUsage = (uid, limits) => runner.updateCodexUsage(limits, uid);
contraptionTurns.onUsage = (info, payer, person, account) => runner.recordUsage(info, payer, person, account);
services.drain = (row) => contraptionTurns.drain(row.id);
// A contraption turn gets its person's own machines that are online (#306), never a shared one.
contraptionTurns.machines = (person) => machines.online().filter((m) => m.owner_id !== null && m.servers.includes('mcp') && ownerAsked(store, m.owner_id, [person], null));
contraptionTurns.apiUrl = () => `http://${LOCAL_HOST.includes(':') ? `[${LOCAL_HOST}]` : LOCAL_HOST}:${boundPort}`;
const ultrareviews = new UltraReviews({
  claudeBin: config.claudeBin,
  place: (uid) => claudeLink.place(uid),
  scratch: (uid) => claudeLink.turnsDir(uid),
  emit: (ticketId, kind, data) => runner.emit(ticketId, kind, data),
  getSetting: <T>(k: string) => store.getSetting<T>(k) as T | undefined,
  setSetting: (k, v) => store.setSetting(k, v),
  hostEnv: turnEnv(process.env),
  jobsDir: join(DATA_DIR, 'run', 'ultrareviews'),
  units: () => runner.units,
  // Draft PRs for ultra reviews (#1399) go out only as the person who asked, never the box's login or anyone else's.
  github: (uid) => {
    const person = store.getUser(uid);
    const t = person ? githubLink.token(person) : null;
    return t ? { token: t.secret, login: t.login } : null;
  },
});
// A boot check's or preview's copy names the live reviews' folders: only the live server may clear them.
if (!BOOT_CHECK) ultrareviews.recover();
// Side questions (#932): forks of minions' sessions on the asker's login; a restart ends them and deletes the forks.
const sideAsks = new SideAsks(store, runner, broadcast as (msg: unknown) => void);
if (!BOOT_CHECK) sideAsks.recover();
// Who is in which chat (#695): in memory, swept for late heartbeats and old writes.
const presence = new Presence({ projectOf: (id) => store.getTicket(id)?.project_id, broadcast });
every('presence sweep', 15_000, () => presence.sweep());
// The usage ledger (#1306) writes its counts once a minute, and prunes once a day; a stop writes what is left.
if (!BOOT_CHECK && !PREVIEW) {
  every('usage ledger flush', 60_000, () => store.usage.flush());
  every('usage ledger prune', 24 * 3600_000, () => store.usage.prune());
}
claudeLink.busy = (container) => runner.inContainer(container) + contraptionTurns.inContainer(container) + minionJobs.inContainer(container) + ultrareviews.inContainer(container) + sideAsks.inContainer(container) + describesIn(container);
// Landings run in units of their own when turns do (src/land.ts); only ones that fell back to the server's child count here.
const landings = new Landings(DATA_DIR, () => runner.units);
runner.onMessage = (id) => landings.talked(id);
// Long heavy jobs (#1363): `citadel-heavy --long` queues them in the heavy folder; this starts each on its scheme's CI in
// the night: from 2am until the job hours (of the PC whose runners serve that repo, from their load samples) end.
const longJobPc = new Map<string, number>();
const longJobs = new LongJobs({
  dir: join(DATA_DIR, 'projects', '.heavy'),
  scheme: (id) => {
    const t = store.getTicket(id);
    const p = t && store.getProject(t.project_id);
    return p ? { projectId: p.id, slug: repoSlug(p.repo_url) } : null;
  },
  hours: (slug) => {
    const lower = slug.toLowerCase();
    const sample = store
      .runnerLoadSince(Date.now() - 10 * 60_000)
      .reverse()
      .find((r) => {
        try {
          return (JSON.parse(r.data).runners ?? []).some((x: { repo?: string }) => x.repo?.toLowerCase() === lower);
        } catch {
          return false;
        }
      });
    // Remembered, so a PC that went quiet or off overnight keeps its own hours rather than the defaults.
    if (sample) longJobPc.set(lower, sample.machine_id);
    const m = longJobPc.has(lower) ? store.getMachine(longJobPc.get(lower)!) : null;
    return m ? storedSettings(m) : DEFAULT_SETTINGS;
  },
  gh: (projectId, args) => {
    ghTally.add(args.find((a) => !a.startsWith('-')) ?? '', 0); // its polls are plain reads: each one counts (#1722)
    const p = store.getProject(projectId);
    const env = { ...process.env, ...(p?.repo_dir ? githubOf(p.repo_dir) : {}) };
    return new Promise((done, fail) =>
      execFile('gh', ['api', ...args], { env, timeout: 120_000, maxBuffer: 256 << 20 }, (err, out, errOut) =>
        err
          ? fail(
              new Error(
                String(errOut || err.message)
                  .trim()
                  .split('\n')
                  .pop(),
              ),
            )
          : done(String(out)),
      ),
    );
  },
  wake: (id, text, light) => runner.send(id, APP_NAME, text, [], light ? { light } : {}),
  note: (id, text) => {
    runner.emit(id, 'note', { text });
    runner.broadcastTicket(id);
  },
  hold: (slug, since) => ciHold.why(slug, since),
  heldRun: (run) => ciHold.isHeld(run),
});
// The pump's and CI's lookups read this, not the folder (#1980).
if (!BOOT_CHECK) every('long jobs folder', 3_000, () => longJobs.refresh());
if (!BOOT_CHECK && !PREVIEW) every('long heavy jobs', 60_000, () => longJobs.pump(), 30_000);
// Contraption turns and app deploys run as the server's children: a restart waits for them. Ultra reviews
// run in units of their own as landings do; only ones that fell back to a child count.
// Kit files sync themselves (#1100): a change to the scheme-setup templates schemes copy is merged into each scheme
// that is behind, checked there, and shipped on one go from Citadel's Taskmaster chat, pushed as whoever said go.
const kitSyncJobs = new HostJobs(() => runner.units);
const kitSync = new KitSync({
  kitDir: import.meta.dirname,
  projectsDir: join(DATA_DIR, 'projects'),
  runDir: join(DATA_DIR, 'run', 'kit-sync'),
  jobs: kitSyncJobs,
  load: () => store.getSetting<KitSyncState>('kit-sync') ?? undefined,
  save: (state) => store.setSetting('kit-sync', state),
  projects: () => store.listProjects(),
  home: () => ownScheme()?.id ?? null,
  chat: async (id) => {
    const project = store.getProject(id);
    return project ? (store.getCoordinator(id) ?? (await ensureCoordinatorFor(app, project, null))).id : null;
  },
  // Pushes and gh calls go out as the person who said go, with their own GitHub link (as a minion's land does, #911).
  env: (person) => ({
    ...turnEnv(process.env),
    CITADEL_HEAVY_DIR: join(DATA_DIR, 'projects', '.heavy'),
    CITADEL_HEAVY_WHO: 'kit sync',
    ...(person === null ? {} : runner.githubFor?.(person, join(DATA_DIR, 'people', String(person)))?.env),
  }),
  canPush: async (repoDir, env) => {
    const origin = await new Promise<string>((done) => execFile('git', ['remote', 'get-url', 'origin'], { cwd: repoDir, timeout: 15_000 }, (_e, out) => done(String(out ?? '').trim())));
    const slug = githubRepo(origin);
    // An origin that isn't GitHub's can't be asked: land.sh's push decides.
    if (!slug) return !!origin;
    return new Promise((done) => execFile('gh', ['api', `repos/${slug}`, '--jq', '.permissions.push'], { env: { ...process.env, ...env }, timeout: 30_000 }, (err, out) => done(!err && String(out).trim() === 'true')));
  },
  postCard: (ticket, card) => postCard(app, store.getTicket(ticket)!, card).id,
  settle: (card, line) => settleCard(card, APP_NAME, line),
  note: (ticket, text) => {
    runner.emit(ticket, 'note', { text });
    runner.broadcastTicket(ticket);
  },
  mail: (ticket, text) => runner.leaveMail(ticket, APP_NAME, text),
});
if (!BOOT_CHECK && !PREVIEW) {
  // The templates are looked at every 10 minutes (a kit-only deploy may not restart the server), and a running round every 20 s.
  let lastLook = 0;
  every('kit sync', 20_000, async () => {
    if (!kitSync.active() && Date.now() - lastLook < 10 * 60_000) return;
    // A running round goes on; only the idle template look waits while the box is starved (#1301).
    if (!kitSync.active() && !(await pressure.gate('kit-sync template look'))) return;
    lastLook = Date.now();
    await kitSync.poll();
  });
}
runner.hostJobs = () => landings.running() + contraptionTurns.running() + services.jobs() + ultrareviews.running() + sideAsks.running() + kitSyncJobs.running() + hostToolInstalls();
// Whose turn a message starts: a person by name, or for a relay the person of the turn that sent it.
runner.personOf = messagePerson(store);
runner.mediaFor = (person) => openrouter.connected(person);
runner.githubFor = (person, dir, later) => githubLink.forTurn(person ? (store.getUser(person) ?? null) : null, dir, later);
runner.secretsFor = (project, person) => secrets.forTurn(project, person);

// ---------- push notifications ----------

const pusher = new Pusher(store, loadVapidKeys(DATA_DIR));
// Push services may contact the sender at this address; set from the first subscribe if not given.
pusher.subject = config.pushSubject ?? store.getSetting<string>('push_subject') ?? pusher.subject;
// A desktop app's ping (#1186) goes to its person's open pages; the page whose device it names shows it.
pusher.local = (sub, msg) => {
  const data = `data: ${JSON.stringify({ type: 'notify', endpoint: sub.endpoint, msg })}\n\n`;
  for (const [res, who] of clients) if (who.name === sub.name && res.writableLength <= MAX_CLIENT_BACKLOG) res.write(data);
};

/** Ping everyone subscribed to the ticket's project (but `except`) if the trigger warrants it. */
function notify(ticketId: number, trigger: PushTrigger, except: string | null = null) {
  // A boot check's turns and a preview's copy are nobody's news.
  if (BOOT_CHECK) return;
  const ticket = store.getTicket(ticketId);
  if (ticket) pusher.notify(ticket, trigger, except).catch((err) => console.error(`Push for ticket ${ticketId} failed:`, err));
}

outsideSpend.onCap = (projectId, total, cap) => {
  const coordinator = store.getOverlord(projectId);
  if (!coordinator) return;
  const text = `Spend on outside APIs is $${total.toFixed(2)} this month, past the scheme's $${cap.toFixed(2)} cap. Nothing has stopped; raise the cap or cut back.`;
  runner.emit(coordinator.id, 'note', { everyone: true, text });
  runner.broadcastTicket(coordinator.id);
  notify(coordinator.id, { kind: 'state', state: 'blocked', note: text });
};
runner.onTurnError = (ticketId, text, eventId) => notify(ticketId, { kind: 'error', text, eventId });
runner.onSpendAlert = (ticketId, text, eventId, person) => notify(ticketId, { kind: 'spend', text, eventId, also: person ? store.getUser(person)?.name : undefined });

// Chained minions (create_ticket's start_after): one starts with its held brief once its leader's work is in (src/wake.ts startChained).
const startChain = (c: Chain, why: string) => startChained(c, why, { store, runner, waiters });
waiters.start = (c, why) => void startChain(c, why).catch((err) => console.error(`Starting chained #${c.ticket} failed:`, err));
// A chain row's start (ADR 0021 step 3): the outbox runs it on the minion's lane and settles the row by the brief's event.
waiters.sendBrief = (c, why, repeat) => chainedStep(c, why, { store, runner }, repeat);
// relay_when_live: a note goes out as held mail once its commit is live; the sender's Taskmaster gets a one-line "went out".
waiters.deliver = (r) => {
  const from = store.getTicket(r.ticket);
  if (!from) return;
  const who = `#${from.number} ${from.title}`;
  if (r.repeat) r = { ...r, text: `${r.text}\n\n(The server restarted while sending this, so it may repeat.)` };
  if ('scheme' in r.to) {
    const own = store.getProject(from.project_id)!;
    const author = `${own.name} #${from.number} (relayed once live)`;
    runner.leaveMail(r.to.taskmaster, author, asData(author, r.text));
  } else runner.leaveMail(r.to.minion, `${who} (relayed once live)`, r.text);
};
waiters.sent = (rs) => {
  const from = store.getTicket(rs[0].ticket);
  const taskmaster = from && store.ownerCoordinator(from);
  if (from && taskmaster) runner.leaveMail(taskmaster.id, `#${from.number} ${from.title}`, `(for your tracking; nothing to do) #${from.number}'s relay to ${relayDests(rs)} went out`);
};
runner.heldFor = (id) => waiters.heldFor(id);
runner.heldBrief = (id) => waiters.heldBrief(id);
runner.chains = () => waiters.chains();
runner.wakesOn = (id) => {
  const timed = timedWakes.next(id);
  return waiters.wakesOn(id) ?? heldStarts.wakesOn(id) ?? runnerWaiters(store).find((w) => w.ticket === id)?.reason ?? store.listDeliveries({ kind: 'runners_back', to: id, states: ['waiting'] })[0]?.payload.reason ?? (timed ? `wake ${pacificTime(timed.at)}: ${timed.note}` : null);
};
// The list chip's waits (src/waits-readout.ts): the outbox's rows, plus what the old keys still hold until their steps move.
// A row added or changed re-sends its minion's view, so the chip never shows a wait that already went (a Taskmaster's waits have no chip).
for (const fn of ['addDelivery', 'updateDelivery'] as const) {
  const orig = (store[fn] as (...a: unknown[]) => unknown).bind(store);
  Object.assign(store, {
    [fn]: (...a: unknown[]) => {
      const r = orig(...a);
      const row = (fn === 'addDelivery' ? r : store.getDelivery(a[0] as number)) as Delivery | undefined;
      if (row?.to_kind === 'minion') queueMicrotask(() => runner.broadcastTicket(row.to_id));
      return r;
    },
  });
}
runner.outboxWaits = (t) =>
  waitsFor(store, t, (id) => [
    ...waiters
      .chains()
      .filter((c) => c.ticket === id && c.id == null && !c.held)
      .map((c) => {
        const lead = store.getTicket(c.after),
          n = `#${lead?.number ?? c.after}`;
        return { kind: 'chain', chip: `⇢ ${n}`, headline: `Starts when ${n} ${c.when === 'merged' ? 'ships' : 'is live'}`, link: lead ? { project: lead.project_id, number: lead.number! } : null, what: waiters.heldFor(id) ?? 'its leader', set_by: c.from, since: c.since ? c.since * 1000 : null };
      }),
    ...waiters
      .legacy()
      .filter((w) => w.ticket === id)
      .map((w) => ({ kind: 'wake_when_live', chip: '⇢ live', headline: w.commit ? `Wakes when ${w.commit.slice(0, 7)} is live` : 'Wakes after the next deploy', what: w.reason, set_by: `minion:${id}`, since: null })),
    ...runnerWaiters(store)
      .filter((w) => w.ticket === id)
      .map((w) => ({ kind: 'runners_back', chip: '⇢ CI', what: w.reason, set_by: `minion:${id}`, since: null })),
  ]);
// Its leader was dismissed without shipping: it stays parked, and people and the Taskmaster hear once.
waiters.hold = (c, why) => {
  const t = store.getTicket(c.ticket);
  if (!t) return;
  const leader = store.getTicket(c.after);
  store.updateTicket(c.ticket, { state: 'blocked', note: `#${leader?.number ?? c.after} didn't ship: Start now, or dismiss` });
  runner.emit(c.ticket, 'note', { text: `${why}, so this minion hasn't started. Start now starts it with its brief; or dismiss it.` });
  runner.broadcastTicket(c.ticket);
  notify(c.ticket, { kind: 'state', state: 'blocked', note: `${why}, so this one is held` });
  const coordinator = store.ownerCoordinator(t);
  if (coordinator) runner.send(coordinator.id, APP_NAME, `${why}, so #${t.number} ${t.title}, chained on it, is held and hasn't started. Ask people whether to start it (message_ticket with start_now starts it with its brief) or dismiss it.`);
};
// A closed minion's processes (#1365): its close and an hourly sweep stop them; the host-load page lists them by minion.
const reaper = new Reaper({ store: store as ReaperStore, dataDir: DATA_DIR, commit: BOOT_COMMIT ?? null });
if (!BOOT_CHECK) {
  // A dismissal can be what a chained minion waits for.
  const stopPreview = runner.onClose;
  runner.onClose = (ticketId) => {
    const stopped = stopPreview(ticketId);
    minionJobs.stop(ticketId);
    void outbox.poke({ type: 'closed', ticket: ticketId });
    // Asked afresh (#321): a minion that merged its PR and dismissed itself may have read "not merged" a moment ago.
    waiters.prs.forget?.();
    void waiters.check().catch((err) => console.error('Checking waiters after a dismissal failed:', err));
    // Its PR may have merged on GitHub with the watcher never seeing it (it watches open minions only).
    const repoDir = store.getProject(store.getTicket(ticketId)?.project_id ?? -1)?.repo_dir;
    if (repoDir) catchUp(repoDir);
    // What it left running stops too (#1365), once its preview has: by folder and pid, never by name (src/reaper.ts).
    return Promise.resolve(stopped)
      .then(() => reaper.reap(ticketId))
      .then(
        () => {},
        (err) => console.error(`Ticket ${ticketId}: reaping its processes failed:`, err),
      );
  };
  // Anything a close missed (a restart mid-close, a container turn's job re-parented to the container's init), hourly;
  // and test servers' turn supervisors left in their units once their folder or their ship is gone (#1758).
  every('reap closed minions', 3600_000, () => reaper.reap().finally(() => reaper.reapSupervisors()), 10 * 60_000);
  liveOn(BOOT_COMMIT, true);
}
// Citadel's recovery promises, checked at boot and hourly, report only (#1415, src/standing-checks.ts): reads in a worker.
const standingChecks = new StandingChecks({
  store,
  dataDir: DATA_DIR,
  commit: BOOT_COMMIT ?? null,
  queued: (ids) => runner.queuedIds(ids),
  appTurns: () => contraptionTurns.liveIds(),
  procs: async () => (await reaper.owned()).map((x) => ({ pid: x.proc.pid, ticketId: x.ticketId, projectId: x.projectId, command: shownCommand(x.proc.argv) })),
});
if (!BOOT_CHECK && !PREVIEW) every('standing checks', 3600_000, () => standingChecks.run(), 3 * 60_000);

/**
 * A new minion with its properties and its own worktree in the scheme's repo, not started yet: the
 * caller sends its first message. Properties must be checked already. Throws HttpError 500, leaving
 * nothing behind, when the worktree can't be made.
 */
async function newMinion(project: Project, m: NewMinionSpec, by: string) {
  const made = await makeMinion(store, project, m, by, (id, number) => createTicketDir(DATA_DIR, project.id, project.repo_dir, id, number, m.title, m.build ?? null), ownWrites); // a request's reply shows its folder and branch (#1244)
  // Its npm dependencies from the lockfile (#1649), on its lane: the brief sent next waits behind it, and the creation doesn't.
  if (project.repo_dir && !PREVIEW) {
    void runner.onLane(made.id, 'dependency install', async () => {
      const note = depsNote(await installDeps(made.cwd, npmCacheDir(DATA_DIR)));
      if (note) runner.leaveMail(made.id, APP_NAME, note);
    });
  }
  return made;
}

// Scheduled minions (src/schedules.ts): each due schedule starts a fresh minion with its brief. Checked
// every half minute; a schedule that came due while the server was down runs once when it is back.
const heldStarts = new HeldStarts({ store, runner, read: () => pressure.read(), broadcast, broadcastTicket: (id) => runner.broadcastTicket(id) });
const scheduledRuns = new ScheduledRuns({
  held: heldStarts,
  store,
  newMinion,
  runner,
  broadcast,
  by: APP_NAME,
  dataDir: DATA_DIR,
  memoryTarget: (id) => {
    const t = curatorTarget(store.getProject(id)?.repo_dir ?? null, memoryLogins({ store, claude: claudeLink }));
    return t && { dir: t.folder.dir, notes: t.notes };
  },
});
// Once per database (#799): the hand-made audits follow kit/schedules/, and each scheme gets the ones its repo fits.
try {
  for (const line of backfillStandardAudits(store, DATA_DIR)) console.log(`Standard audits (#799): ${line}`);
  for (const line of addAppTurnsChecks(store, DATA_DIR)) console.log(`App turns check (#844): ${line}`);
  for (const line of addMemoryCurators(store, DATA_DIR)) console.log(`Memory curator (#1111): ${line}`);
  for (const line of addGlossaryDrifts(store, DATA_DIR)) console.log(`Glossary drift check (#1774): ${line}`);
  for (const line of addAreaReviews(store, DATA_DIR)) console.log(`Area review (#1784): ${line}`);
  for (const line of addArchitectureChecks(store, DATA_DIR)) console.log(`Architecture check (#1797): ${line}`);
} catch (err) {
  console.error('Standard audits (#799) backfill failed; it tries again at the next start:', err);
}
// Once per database (#1051): every scheme's repo rubric files move into its review set (Cara, 2026-11-19, "Citadel stores them").
try {
  for (const line of importAllRubrics(store)) console.log(`Review set import (#1051): ${line}`);
} catch (err) {
  console.error('Review set import (#1051) failed; it tries again at the next start:', err);
}
// Once per database (#1095): the run record's history, read from every scheme's critic.md logs into src/review-backfill.json.
try {
  const logs = JSON.parse(readFileSync(join(import.meta.dirname, 'src', 'review-backfill.json'), 'utf8'));
  for (const line of backfillRuns(store, logs)) console.log(`Review run backfill (#1095): ${line}`);
} catch (err) {
  console.error('Review run backfill (#1095) failed; it tries again at the next start:', err);
}
if (!BOOT_CHECK) every('schedules', 30_000, () => scheduledRuns.runDue());
if (!BOOT_CHECK) every('held starts', 30_000, () => heldStarts.tick());
// A finished multi-minion effort starts its retro, in every scheme (#1751, src/effort-retros.ts).
const effortRetros = new EffortRetros({ store, newMinion, runner, by: APP_NAME, note: (line, p) => judgeNote(() => p.id)(line) });
if (!BOOT_CHECK && !PREVIEW) every('effort retros', 10 * 60_000, () => effortRetros.tick());
// A closed minion that went past twice its budget or had its model stepped up gets one post-mortem, in every scheme (#1796).
const troubleRetros = new TroubleRetros({ store, newMinion, runner, by: APP_NAME, note: (line, p) => judgeNote(() => p.id)(line) });
if (!BOOT_CHECK && !PREVIEW) every('trouble post-mortems', 10 * 60_000, () => troubleRetros.tick());
// Memory easing (#1748): as the box's free memory runs low, held starts, background passes, heavy jobs and nested
// Claude sessions wait, and while it's tight the fastest-growing big turn is held at its size. Nothing is killed. Only the
// real server reads it: a preview or dev copy would otherwise hold the live turns too.
const growthStop = new GrowthStop();
// The heavy folder is read off the thread every few seconds; memory easing and the release readers take its last answer.
const heavySnapshot = new HeavySnapshot(join(DATA_DIR, 'projects', '.heavy'));
if (!BOOT_CHECK) every('heavy folder', 3_000, () => heavySnapshot.refresh(), 0);
const memoryEase = new MemoryEase({
  heavyDir: join(DATA_DIR, 'projects', '.heavy'),
  record: (at, episode) => store.addHealthEvent('memory-easing', at, BOOT_COMMIT ?? null, JSON.stringify(episode)),
  waiting: () => {
    const { waiters } = heavySnapshot.get();
    return { starts: heldStarts.list().length, heavy: waiters.filter((w) => w.reason === 'memory').length, nested: waiters.filter((w) => w.reason === 'ease').length };
  },
  slowed: () => growthStop.slowed(),
  after: (level) => growthStop.tick(level),
});
pressure.useEase(() => memoryEase.get());
if (!BOOT_CHECK) memoryEase.start();
// Idle Taskmasters with a long context start fresh sessions while their prompt cache is still warm (#406).
if (!BOOT_CHECK && !PREVIEW) warmUsage(store);
if (!BOOT_CHECK && !PREVIEW) every('fresh sessions', 60_000, () => runner.freshSweep());
// Waiting minions' prompt caches stay warm in working hours (#862, src/keepalive.ts).
if (!BOOT_CHECK && !PREVIEW) every('keepalives', 60_000, () => runner.keepaliveSweep());
if (!BOOT_CHECK && !PREVIEW) every('cold mail', 60_000, () => runner.coldSweep());
// Dismissed minions' build output (#336) and worktrees (#660): those dismissed before clearing on dismissal, or whose clearing
// failed. Off the boot's hot path, then daily. A preview's rows point at the live worktrees, so never there.
if (!BOOT_CHECK && !PREVIEW) {
  // The init script that points host turns' Gradle builds at the shared build cache (#1153); containers get theirs at start.
  try {
    ensureGradleInit(homedir());
  } catch (err) {
    console.error('Could not write the Gradle build cache init script (#1153):', err);
  }
  // Then dismissed minions' whole worktrees past their grace, and leftover Grunt worktrees (#660).
  const sweepBuild: Job = every(
    'build output sweep',
    24 * 60 * 60_000,
    async () => {
      // Daily, so a skipped pass tries again in a minute; the gate lets it through after 10 minutes of skips.
      if (!(await pressure.gate('worktree sweep'))) {
        setTimeout(() => void sweepBuild.run(), 60_000).unref();
        return;
      }
      await runner.sweepBuildOutput();
      await runner.sweepWorktrees();
      // Scratch a killed ship, lint or heavy command left in perigee's RAM-backed /tmp (#1339).
      const orphans = await sweepOrphanTmp(['/tmp', join(config.cacheDir, 'citadel-heavy-tmp')]);
      if (orphans.length) console.log(`Removed ${orphans.length} orphaned scratch folder${orphans.length === 1 ? '' : 's'} (${orphans.map((d) => basename(d)).join(', ')}).`);
      // The shared Gradle build cache (#1153) under its cap.
      const t = await trimCache(gradleCacheDir(DATA_DIR), GRADLE_CACHE_CAP);
      if (t.removed) console.log(`Gradle build cache: removed ${t.removed} least recently used entries (${size(t.freed)}), ${size(t.left)} left.`);
      // The shared npm cache (#1649): emptied once over its cap, when no install is reading it; the next install fills it again.
      // shortcut: all or nothing, as npm's content store has no oldest-first trim; trim it by its index if refills start to cost.
      const npmCache = npmCacheDir(DATA_DIR);
      const npmSize = await diskUsage([npmCache]); // 0 before the first install made it
      if (npmSize > NPM_CACHE_CAP && !installsRunning()) {
        await low(['rm', '-rf', '--one-file-system', '--', npmCache]);
        console.log(`npm cache: emptied it at ${size(npmSize)}, over its ${size(NPM_CACHE_CAP)} cap.`);
      }
    },
    10 * 60_000,
  );
  // Contraption turns' media files past 30 days (#732); first soon after boot, as deploys restart the server more often than daily.
  every('contraption media sweep', 24 * 60 * 60_000, async () => void sweepMedia(join(DATA_DIR, 'contraption-media')), 10 * 60_000);
  // Kept chats for replay past 30 days (#836), apps that stopped keeping included.
  every('kept chats sweep', 24 * 60 * 60_000, async () => sweepKept(DATA_DIR), 10 * 60_000);
}
// Contraption turns' audit rows past AUDIT_DAYS (#844), soon after boot and then daily. Previews and dev copies (BOOT_CHECK) don't sweep: they live hours and are deleted when stopped.
if (!BOOT_CHECK) {
  every('turn audit sweep', 24 * 60 * 60_000, () => store.sweepTurnAudit(Date.now() - AUDIT_DAYS * 24 * 60 * 60_000), 5 * 60_000);
}

// The ideas ledger (#1150): each scheme's pages, handoffs and starts re-read hourly, and the weekly held note to its
// Taskmaster of Later ideas waiting over two weeks (never a wake). Not in previews or dev copies: their Taskmasters aren't real.
if (!BOOT_CHECK && !PREVIEW) {
  every(
    'ideas ledger',
    60 * 60_000,
    async () => {
      if (!(await pressure.gate('ideas pass'))) return;
      for (const p of store.listProjects()) {
        await store.ideas.now(p.id, projectSharedDir(DATA_DIR, p.id));
        const tm = store.getOverlord(p.id);
        const note = tm && store.ideas.laterNote(p.id);
        if (note) runner.leaveMail(tm.id, 'Ideas', note);
      }
    },
    15 * 60_000,
  );
}

// Steps' times from before step_times (#571), once, a minute after boot.
if (!BOOT_CHECK) setTimeout(() => void safely('step times backfill', () => runner.backfillStepTimes()), 60_000).unref();

// Embed what was said since the last pass, a little at a time, never in a request (src/memory.ts).
const memoryIndexer = new MemoryIndexer(store, embed, EMBED_MODEL, memoryScheme);
if (!BOOT_CHECK)
  every('memory', config.memoryEveryMs, async () => {
    if (await pressure.gate('memory index')) await memoryIndexer.run();
  });
// Closed minions and handoffs into the full-text index search_minions reads (src/minion-index.ts, #1156).
const minionIndexer = new MinionIndexer(store, DATA_DIR);
if (!BOOT_CHECK)
  every('minion index', config.memoryEveryMs, async () => {
    if (await pressure.gate('minion index')) await minionIndexer.run();
  });

// ---------- artifacts, branch and ship status (src/artifact-scan.ts, src/ship-status.ts) ----------

const artifacts = new ArtifactScanner(store, DATA_DIR, broadcast);
const sharedDir = artifacts.sharedDir;
const ships = new ShipStatus({ store, runner, broadcast, liveHead: () => waiters.head, checkoutDir: import.meta.dirname });
const ticketBranch = ships.branch;
// Each build branch's header in the minions list (src/builds.ts): feeders folded in and open, commits behind main.
const builds = new Builds({ store, broadcast });
runner.ship = ships.ship;

// What each minion waits on (#544): the land line in this checkout's git dir (tools/deploy-queue.sh), the heavy slots.
const deployState = (() => {
  try {
    return join(execFileSync('git', ['rev-parse', '--absolute-git-dir'], { cwd: import.meta.dirname, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(), 'cc-deploy');
  } catch {
    return null;
  }
})();
// CI runs in flight (#546): a minion's PR (the PR watcher below names its runs) and a landing's CI gate, every 20 s.
const ciRuns = new CiRuns({ changed: (id) => waits.check(id) });
let liveSlug: string | null = null;
void originRepo(import.meta.dirname).then((slug) => (liveSlug = slug));
const waits = new Waits({
  store,
  deployState,
  heavyDir: join(DATA_DIR, 'projects', '.heavy'),
  ship: ships.ship,
  interruptible: () => runner.interruptible(),
  changed: (id) => runner.broadcastTicket(id),
  ci: ciRuns,
  ciSlug: () => liveSlug,
  // The land gate's alarm (#561), under the scheme whose repo the live checkout is.
  // Not before the live repo is known: a guess of no scheme would clear the alarm, and a restart would ring it again.
  early: (id) => earlyCi(readTail(landings.log(id))),
  earlyWhy: (id, next) => earlyDroppedWhy(readTail(landings.log(id)), next),
  landLine: (seen, now) => {
    const live = liveSlug && store.listProjects().find((p) => repoSlug(p.repo_url) === liveSlug);
    if (live) ciHealth.land(live.id, seen, now).catch((err) => console.error(`Land alarm: ${err?.message ?? err}`));
  },
});
runner.wait = waits.wait;
// The release monitor's data (#625, src/releases.ts): Citadel's own server as a target, every scheme's test copies.
const citadelServer = new CitadelServer({
  store,
  scheme: ownScheme,
  head: () => waiters.head,
  line: () => waits.line,
  ticketFor: (label) => waits.ticketFor(label),
  wait: waits.wait,
  ship: ships.ship,
  usual: waits.usual,
  interruptible: () => runner.interruptible(),
  ciQueued: (id) => ciRuns.view(id)?.stage === 'queued',
  news: (id, name) => landNews(readTail(landings.log(id)), name),
});
// Every other scheme's targets, found from what it has (#627, src/release-targets.ts), and a reader per kind.
const targetFinder = new TargetFinder({ store, own: ownScheme, apkFeed: (name) => join(services.opts.home, '.local/share', name, 'android', 'latest.json') });
const contraptionReader = new ContraptionReader({ store, finder: targetFinder, folder: (row) => services.folder(row), running: (name) => services.running(name), heavy: () => heavySnapshot.get() });
// A Capacitor app's APK, built and published once a deploy carrying a change to it is live (#837, src/apk-build.ts).
const apkBuilds = new ApkBuilds({
  home: services.opts.home,
  folder: (row) => services.folder(row),
  dataDir: (row) => services.dataDir(row),
  cacheDir: join(services.opts.home, '.cache/citadel-apk'),
  keyDir: join(services.opts.home, '.config/citadel-android'),
  heavy: join(import.meta.dirname, 'tools/citadel-heavy'),
  ciRelease: (row) => targetFinder.ciRelease(row),
  published: (row, code, _commit, by) => {
    if (row.home_scheme != null) store.recordApkPublish({ projectId: row.home_scheme, contraption: row.name, versionCode: code, runId: 0, by, uid: null });
    void releases.refresh();
  },
  tell: (row, text) => row.home_scheme != null && tellHome(row.home_scheme, text),
});
// A red main's fix and a failed deploy's minion go Urgent by themselves (#1888).
const urgentFixes = new UrgentFixes({
  store,
  urgent: runner.urgent,
  from: APP_NAME,
  chains: () => waiters.chains(),
  reds: () =>
    redFixes(
      store,
      (p, mark) => ciHealth.fixTicket(p, mark),
      (id) => fastMode.view(id).reds,
    ),
});
services.onDeploy = (view) => {
  if (view.finished_at === null) return showReleases();
  // Its frames open in Citadel catch up to the new version (#1690, public/frames.js appDeployed).
  if (view.state === 'deployed') broadcast({ type: 'app-deployed', name: view.name });
  const live = view.state === 'deployed' && !services.opts.off ? store.getContraption(view.name) : undefined;
  if (live) void apkBuilds.schedule(live, view.by);
  contraptionReader
    .record(view)
    .catch((err) => console.error(`Recording ${view.name}'s deploy failed:`, err))
    .finally(() => void releases.refresh());
  const home = store.getContraption(view.name)?.home_scheme;
  const deployer = /^#(\d+)$/.exec(view.by);
  const minion = home != null && deployer ? store.getTicketByNumber(home, Number(deployer[1])) : undefined;
  urgentFixes.deployEnded(view.name, minion?.id ?? null, view.state === 'deployed', `Its deploy of ${view.name} ${view.state === 'rolled back' ? 'was rolled back' : 'failed'}`);
  if (view.state === 'deployed') void passLiveClaims();
  if (home != null) rollback.deployEnded(home, `app:${view.name}`, view.state === 'deployed', view.to, view.said.at(-1) ?? view.state);
  // Nobody watches an auto-deploy (#629), so one that didn't go live is told to the app's home Taskmaster.
  const row = view.by === AUTO_BY && view.state !== 'deployed' ? store.getContraption(view.name) : undefined;
  if (row?.home_scheme != null)
    tellHome(
      row.home_scheme,
      `Auto-deploy of ${row.title} (${row.name}) to ${view.to?.slice(0, 9) ?? 'its main'}: ${view.state}. ${view.said.at(-1) ?? ''}\n\nIt won't try that commit again by itself: the next landing on main, or Deploy on its card on the Releases page, deploys again. deploy_contraption's status has the whole log.`,
    );
  // The debounce watches the scheme's clone, the deploy fetches GitHub: a main not pushed yet ships the older commit, and auto-deploy won't try again at that head.
  const shipped = view.by === AUTO_BY && view.state === 'deployed' ? store.getContraption(view.name) : undefined;
  const meant = shipped?.home_scheme != null ? autoDeploy.triedAt(shipped.home_scheme, `app:${shipped.name}`) : null;
  if (shipped?.home_scheme != null && meant && view.to && meant !== view.to)
    tellHome(shipped.home_scheme, `Auto-deploy of ${shipped.title} (${shipped.name}) went live at ${view.to.slice(0, 9)}, but your clone's ${view.branch} is at ${meant.slice(0, 9)}: GitHub didn't have it yet. Push ${view.branch}, then press Deploy on its card on the Releases page (or call deploy_contraption).`);
};
/** A message from Citadel to a scheme's Taskmaster, if it has one. */
// Scheme-wide news (auto-deploys, alerts) is nobody's in particular: the Overlord's (#921), the only Taskmaster before a split.
const tellHome = (projectId: number, text: string) => {
  const tm = store.getOverlord(projectId);
  if (tm) runner.send(tm.id, APP_NAME, text, [], runner.isOverlord(tm) ? { everyone: true } : {});
};
// The workflow readers go through CI health's etag-cached reads (defined below; first called after startup's scan).
const actions = { workflowRuns: (p: Project, w: string, b: string) => ciHealth.workflowRuns(p, w, b), runJobs: (p: Project, r: Run) => ciHealth.runJobs(p, r), runArtifacts: (p: Project, r: Run) => ciHealth.runArtifacts(p, r) };
// A shipped run's GitHub artifact, copied into the CI store so its release links a file on perigee (#673).
// Big uploads (#832); UPLOAD_FLOOR_GB moves the free-disk floor (tests, a dev copy on a small disk).
const chunked = new ChunkedUploads(DATA_DIR, config.uploadFloor ?? DISK_FLOOR);
// Push to contraptions' Android apps (#1138); CITADEL_FCM_API points a test at a stub Firebase.
const fcm = new Fcm(fcmKeyPath(), { api: config.fcmApi });
const ciMirror = new CiMirror(
  ciStore,
  ghDownload((p) => (p.repo_dir ? githubOf(p.repo_dir) : undefined)),
);
// Last green and the pins come from lastGreen below, read only once refreshes run.
// Desktop apps' feeds (#1148): the launcher is built from the kit's source by perigee's .NET SDK, kept by its hash.
const desktop = {
  feeds: new DesktopFeeds(DATA_DIR),
  launchers: new Launchers({ src: join(import.meta.dirname, 'kit/desktop-launcher'), cache: join(homedir(), '.cache/citadel-desktop'), dotnet: join(homedir(), '.dotnet/dotnet'), log: (m) => console.error(m) }),
};
// Only the live server publishes what CI ships, like the APK reader: a dev copy's feed is its own to fill by hand.
const desktopFromCi =
  services.opts.off || DATA_DIR !== DEFAULT_DATA_DIR
    ? undefined
    : ciPublisher({
        feeds: desktop.feeds,
        tell: tellHome,
        log: (m) => console.error(m),
        file: async (projectId, run) => {
          const f = store.ciFiles(projectId).find((x) => x.run_id === run && x.kind === 'release' && /\.(zip|tgz|tar\.gz|exe)$/i.test(x.name));
          return f ? ciStore.plain(f).catch(() => null) : null;
        },
      });
const ciPackageReader = new CiPackageReader({ store, finder: targetFinder, actions, mirror: ciMirror, contains: gitContains, lastGreen: { get: (id) => lastGreen.get(id), pinned: (id, t) => lastGreen.pinned(id, t) }, desktop: desktopFromCi, feeds: desktop.feeds });
ciStore.keep = () => ciPackageReader.keeps();
const apkReader = new ApkReader({
  store,
  finder: targetFinder,
  actions,
  mirror: ciMirror,
  feed: async (name) => {
    const file = join(services.opts.home, '.local/share', name, 'android', 'latest.json');
    try {
      const [text, st] = await Promise.all([readFile(file, 'utf8'), stat(file)]);
      const f = JSON.parse(text);
      return Number.isInteger(f?.versionCode) ? { versionCode: f.versionCode, apk: f.apk, versionName: f.versionName, at: st.mtimeMs } : null;
    } catch {
      return null;
    }
  },
  // A CI-signed APK's roll back (ADR 0012): its release run on citadel/rollback signs last green, published once signed.
  pinned: (id, t) => lastGreen.pinned(id, t),
  rolledBack: (t, run, current, code) => {
    // A copy (a preview, a dev copy) reads the live scheme's runs and shares the live feed's folder: only the live server publishes.
    if (services.opts.off || DATA_DIR !== DEFAULT_DATA_DIR) return;
    const pin = lastGreen.pinned(t.projectId, t.id);
    void publishRun(t, run, current, { code, name: null }, pin?.by ?? 'a roll back', null).then(
      () => void releases.refresh(),
      (err) => pin && rollback.failed(t.projectId, t.id, pin.sha, `publishing its signed run ${run.id} failed: ${err?.message ?? err}`),
    );
  },
  rollbackFailed: (t, why) => {
    const pin = lastGreen.pinned(t.projectId, t.id);
    if (pin) rollback.failed(t.projectId, t.id, pin.sha, why);
  },
});
const publishRun = publisher({ store, ciStore, home: services.opts.home, githubOf, tellHome });
// Each minion's PR as the PR watcher last saw it, for Main's next release (#627).
const prs = new Map<number, PrSnapshot>();
const prDeps = {
  store,
  pr: (id: number) => prs.get(id) ?? null,
  ci: (id: number) => {
    const v = ciRuns.view(id);
    return v && !v.ended ? { since: v.since, usual: v.usual, text: v.text } : null;
  },
};
const mainReader = new MainReader({ ...prDeps, finder: targetFinder });
// Every other scheme's open PRs, on its first target (#655).
const prsInFlight = new PrsInFlight(prDeps);
const landsInFlight = new LandsInFlight({ store, finder: targetFinder, landings });
// The other test copies (#627): minions' downloads, preview sites and debug APKs, read with the targets on the slow poll.
const testCopyReader = new TestCopyReader({
  store,
  finder: targetFinder,
  actions,
  mirror: ciMirror,
  sharedDir,
  listening: (port) =>
    new Promise((done) => {
      const s = createConnection({ host: '127.0.0.1', port, timeout: 500 }, () => (s.destroy(), done(true)));
      s.on('error', () => done(false)).on('timeout', () => (s.destroy(), done(false)));
    }),
});
// Roll back to last green (#1016, src/rollback.ts): each scheme's last green from CI health's reads, and the button on
// a Releases card that can deploy a given commit: an app's two-slot deploy, or Citadel's own tools/deploy.sh --to.
const lastGreen = new LastGreen(store);
const rollbackJobs = new HostJobs(() => runner.units);
const ROLLBACK_DIR = join(DATA_DIR, 'run', 'rollback');
// deploy.sh's paths, only where this server was given them (a dev copy rolling back a scratch checkout): the live
// server's defaults otherwise. Any other copy (another DATA_DIR, or one that doesn't deploy) without them can't roll
// back, so it never touches the live checkout.
const deployEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k, v]) => /^DEPLOY_(LIVE|SOURCE|URL|DB|SERVICE|UNIT)$/.test(k) && v)) as Record<string, string>;
/** Whether Citadel's own roll back still runs; once its job ended, say why if it didn't go live, and clear it for the next one. */
function citadelRollingBack(current: string | null): boolean {
  const job = rollbackJobs.state(ROLLBACK_DIR, 2000);
  if (!job) return false;
  if (job.code === null) return true;
  const p = ownScheme();
  const pin = p && lastGreen.pinned(p.id, CITADEL_TARGET);
  if (p && pin && job.code !== 0 && current !== pin.sha) rollback.failed(p.id, CITADEL_TARGET, pin.sha, `tools/deploy.sh --to said: ${job.output.trim().split('\n').slice(-3).join(' ') || `exit ${job.code}`}`);
  rmSync(ROLLBACK_DIR, { recursive: true, force: true });
  return false;
}
const rollback = new Rollback({
  lastGreen,
  repoDir: (id) => store.getProject(id)?.repo_dir ?? null,
  tell: tellHome,
  changed: () => showReleases(),
  get: (k) => store.getSetting(k) ?? undefined,
  set: (k, v) => store.setSetting(k, v),
  // An APK Citadel builds after each deploy (#837: a feed, no release workflow) rolls back with its app (ADR 0012).
  follows: (tv) => {
    const t = tv.target.kind === 'apk' ? targetFinder.list('apk').find((f) => f.projectId === tv.target.projectId && f.id === tv.target.id) : null;
    return t?.contraption && !t.workflow ? `app:${t.contraption}` : null;
  },
  published: (tv) => (tv.target.kind === 'apk' ? apkReader.published(tv.target.projectId, tv.target.id) : null),
  running: (tv) => (tv.target.kind === CITADEL_TARGET ? citadelRollingBack(tv.current?.version ?? null) : tv.target.kind === 'apk' ? apkReader.rollingBack(tv.target.projectId, tv.target.id) : !!services.running(/^app:(.+)$/.exec(tv.target.id)?.[1] ?? '')),
  starters: {
    contraption: (tv, to, by, uid) => {
      const row = store.getContraption(/^app:(.+)$/.exec(tv.target.id)?.[1] ?? '');
      if (!row || row.home_scheme !== tv.target.projectId) throw new HttpError(404, `${tv.target.name} isn't one of this scheme's apps`);
      try {
        startDeploy(app, row, by, null, uid, false, to);
      } catch (err) {
        if (err instanceof ServiceError) throw new HttpError(err.status, err.message);
        throw err;
      }
    },
    // A CI package (ADR 0012, "Feed, no rebuild"): held at last green's existing build in the CI store, which its card
    // shows as current and the CI store's pins hand to its app's updater. Nothing deploys.
    ci: (tv) => {
      const build = ciPackageReader.greenBuild(tv.target.projectId, tv.target.id);
      if (!build) throw new HttpError(409, `${tv.target.name} has no build from last green or before it in Citadel's CI store, so there's nothing to hand out.`);
      return { build };
    },
    // A CI-signed APK (ADR 0012, Q4 "Yes, now"): point citadel/rollback at last green and start its release workflow
    // there numbered one past the published build; the APK reader publishes the run once it has signed.
    apk: async (tv, to) => {
      const t = targetFinder.list('apk').find((f) => f.projectId === tv.target.projectId && f.id === tv.target.id);
      const p = store.getProject(tv.target.projectId);
      if (!t?.contraption || !p?.repo_dir) throw new HttpError(409, `${tv.target.name} has no app or repo to roll back with`);
      const code = await rollBackApk({ name: tv.target.name, workflow: t.workflow ?? null, slug: repoSlug(p.repo_url), current: tv.current?.number, copy: !!services.opts.off || DATA_DIR !== DEFAULT_DATA_DIR, as: githubOf(p.repo_dir), branch: ROLLBACK_BRANCH }, to);
      apkReader.started(t);
      void releases.refresh();
      return { code };
    },
    // Citadel's server (the every-scheme skill's §1: only the scheme whose repo this server runs has it): deploy.sh
    // --to in a unit of its own, as a landing runs, since its restart ends this server. The next one reads how it went.
    [CITADEL_TARGET]: (tv, to) => {
      const p = store.getProject(tv.target.projectId);
      if (!p?.repo_dir || p.id !== ownScheme()?.id) throw new HttpError(404, 'Only the scheme this server runs can roll it back');
      if ((services.opts.off || DATA_DIR !== DEFAULT_DATA_DIR) && !config.deployLive) throw new HttpError(409, "This copy of Citadel doesn't deploy, so it can't roll the server back");
      rollbackJobs.start({
        dir: ROLLBACK_DIR,
        cwd: p.repo_dir,
        argv: ['bash', 'tools/deploy.sh', '--to', to],
        env: { ...turnEnv(process.env), ...deployEnv() },
        unit: `citadel-rollback-${Date.now()}`,
        description: `tools/deploy.sh --to ${to.slice(0, 9)} (Roll back to last green)`,
        ticketId: 0,
      });
    },
  },
});
const releases = new Releases({
  store,
  readers: [citadelServer, contraptionReader, ciPackageReader, apkReader, new FileReader({ finder: targetFinder }), mainReader],
  broadcast,
  deploy: (tv) => autoDeploy.info(tv),
  rollback: (tv, views) => rollback.info(tv, views),
  // A keyless Capacitor app's card offers Make release key (#837): the app's own card, as it has no Android one until its first APK.
  releaseKey: (tv) => {
    const name = tv.target.kind === 'contraption' ? /^app:(.+)$/.exec(tv.target.id)?.[1] : null;
    return name && apkBuilds.keyless(name) ? name : null;
  },
  lines: () => landsInFlight.refresh(),
  inFlight: (views, fresh) => {
    landsInFlight.attach(views, fresh);
    prsInFlight.attach(views);
    attachFailures(views, { store, landing: (id) => landings.hasHandoff(id), running: (id) => runner.isRunning(id) });
  },
  scan: async () => {
    await targetFinder.scan();
    await testCopyReader.scan();
  },
  testCopies: () => {
    const all = previewCopies(store, { own: ownScheme, running: (key) => previews?.runningAt(key) ?? null, builds: (id) => builds.get(id).map((b) => b.build) });
    for (const [id, copies] of testCopyReader.list()) all.set(id, [...(all.get(id) ?? []), ...copies]);
    return all;
  },
});
/** Show a change on the release cards from an event with nobody waiting on it. */
function showReleases() {
  releases.pollA().catch((err) => console.error(`Reading the releases failed: ${thrown(err).message ?? err}`));
}
// Auto-deploy and the release cards' Deploy button (#629, src/auto-deploy.ts): each kind's release step.
const autoDeploy = new AutoDeploy({
  store,
  targets: () => targetFinder.list(),
  view: () => releases.view(() => true),
  held: lastGreen,
  failed: (t, why) => tellHome(t.projectId, `Auto-deploy of ${t.name} couldn't start: ${why}`),
  enabled: () => !services.opts.off,
  // More is coming (#1736): a ship in the scheme's line, or a hand-off not reported yet (its land running, or its own deploy about to start).
  shipping: (id) => {
    const at = lineFor(app, id);
    return (!!at && readQueue(at.q, at.orderAt).length > 0) || landings.handoffs().some((t) => store.getTicket(t)?.project_id === id);
  },
  deployers: {
    contraption: {
      // The reader's next release waits at its deploy call while main is ahead and no deploy runs.
      waits: (_t, tv) => tv.next?.stage === 'call',
      head: async (t) => {
        const row = store.getContraption(t.contraption!);
        const p = store.getProject(t.projectId);
        return (row && p?.repo_dir && (await git(['rev-parse', '--verify', '--quiet', `${row.branch ?? t.branch}^{commit}`], p.repo_dir))?.trim()) || null;
      },
      start: (t, by, uid) => {
        const row = store.getContraption(t.contraption!);
        if (!row) throw new HttpError(404, `No contraption ${t.contraption}`);
        startDeploy(app, row, by, null, uid);
      },
    },
    apk: apkDeployer({ store, apkReader, githubOf, publishRun, refresh: () => void releases.refresh() }),
  },
});

runner.onFilesMayChange = (ticketId, soon) => {
  artifacts.schedule(ticketId, soon);
  ships.scheduleCheck(ticketId, soon);
};
runner.filesDir = sharedDir;
runner.sharedDir = (project) => projectSharedDir(DATA_DIR, project.id);
runner.ticketsDir = (project) => join(projectDir(DATA_DIR, project.id), 'tickets');
// Threads stored before events were slimmed carry megabytes of thinking and usage data nobody
// reads; slim them once so opening a long thread downloads only what the chat shows.
if (!store.getSetting('events_slimmed')) {
  const { changed, deleted } = store.rewriteClaudeEvents((data) => slimEvent(data, true));
  store.db.exec('VACUUM');
  store.setSetting('events_slimmed', 1);
  console.log(`Slimmed stored events: ${changed} rewritten, ${deleted} dropped.`);
}

// Turns from before each turn's cost was kept: work it out from their stored result events, once.
{
  const added = store.backfillTurns();
  if (added) console.log(`Backfilled the cost of ${added} past turns.`);
}

// Pick up anything made while the server was down (or before artifacts existed), one ticket at a time.
// Rows for file types that no longer count as artifacts go first, pinned or not.
store.pruneArtifacts(isArtifact);
// A preview's copy already holds what these sweeps would find, and they read the live folders.
// The vocabulary docs follow the registry; the first run replaces the hand-written ones (kept aside).
if (!PREVIEW) writeVocabularies().catch((err) => console.error('Could not write the property vocabularies:', err));
// A build a restart cut off, or a deploy from before #837: each Capacitor app's APK catches up with its live commit.
if (!PREVIEW && !BOOT_CHECK && !services.opts.off)
  setTimeout(() => {
    for (const c of store.listContraptions()) if (c.repo) void apkBuilds.schedule(c, AUTO_BY);
  }, 60_000).unref();
if (!PREVIEW)
  void safely('startup sweep', async () => {
    for (const p of store.listProjects()) {
      for (const t of store.listTickets(p.id)) {
        await artifacts.scan(t.id).catch((err) => console.error(`Artifact scan of ticket ${t.id} failed:`, err));
      }
    }
    // Copy every open thread's Claude session into the database (only what changed since last time), so
    // threads from before this existed are covered too; dismissed ones are skipped (#1486). Nothing is pruned here: this config dir may be
    // a fresh one that hasn't had the sessions restored into it yet.
    const configDir = claudeConfigDir(process.env);
    for (const p of store.listProjects()) {
      for (const t of store.listTickets(p.id)) {
        if (!t.session_id || runner.isRunning(t.id)) continue;
        // Threads from before the model picker: fill in what they last ran with.
        if (!t.last_effort || !t.last_model) {
          const init = store
            .listEvents(t.id)
            .reverse()
            .find((e) => e.kind === 'claude' && e.data.includes('"subtype":"init"'));
          const model = t.last_model ?? (init ? (JSON.parse(init.data).model ?? null) : null);
          store.updateTicketQuietly(t.id, { last_model: model, last_effort: t.last_effort ?? lastEffort(t, configDir) });
        }
        // On its lane, so a turn a message starts meanwhile waits for it (#259); errors are logged there.
        await runner.saveIdleSession(t.id, configDir);
      }
    }
  });

// Deploys happen in other minions' turns, so merged work that isn't live yet is looked at again every
// SHIP_POLL_MS, and at startup every open minion's branch is, so the list has its badges.
const SHIP_POLL_MS = 15_000;
// Only git reads, so a preview shows the badges too.
if (!BOOT_CHECK || PREVIEW) {
  void safely('branch sweep', () => ships.sweep());
  every('ship poll', SHIP_POLL_MS, () => ships.poll());
  every('builds', 2 * SHIP_POLL_MS, () => builds.poll(), 0);
  // A few small files, so every 2 s: a landing's phases last tens of seconds.
  every('waits', 2_000, async () => {
    await waits.poll();
    await releases.pollA();
  });
  // Release targets' git reads every 15 s, and finding every scheme's targets again every 5 minutes (#627).
  every('release reads', SHIP_POLL_MS, async () => {
    await releases.refresh();
    await autoDeploy.tick();
    await releases.pollA(); // a due time it just noted shows on the cards
  });
  every('release targets', 20 * SHIP_POLL_MS, () => releases.refresh(true), 0);
  ciRuns.start();
}

// Tickets hear about their PR's CI, reviews, comments, merge and close as messages from "GitHub".
// An fyi is only news of success (CI passed, the PR merged), so it also runs at low effort (#951).
const github = new GithubWatcher(store, (ticketId, text, fyi, quiet) => (quiet ? runner.leaveMail(ticketId, GITHUB_NAME, text) : runner.send(ticketId, GITHUB_NAME, text, [], fyi ? { fyi, light: true } : {})));
github.as = githubOf;
github.onPr = (id, repo, as, pr) => {
  if (pr) prs.set(id, pr);
  else prs.delete(id);
  ciRuns.pr(id, repo, as, pr);
};
runner.openPr = (id) => prs.get(id)?.state === 'OPEN';
if (!BOOT_CHECK) github.start();
// Alarm items wake the Taskmaster they're about (#869, src/alert-wakes.ts): its scheme's, or for Citadel-wide senders
// (id 0: CI health, timers with no home scheme) the live checkout's scheme's. Its item links that chat, where it explains.
const alertScheme = (from: number) => from || store.listProjects().find((p) => liveSlug && repoSlug(p.repo_url) === liveSlug)?.id || 0;
// Each scheme's batch is an `alert` row in the outbox (ADR 0021 step 6, #1392), sent by its timer.
const alertWakes = new AlertWakes(store, outbox, {
  wake: (from, text) => {
    const scheme = alertScheme(from);
    if (!scheme || !store.getOverlord(scheme)) return false;
    tellHome(scheme, text);
    return true;
  },
});
/** Put (with `title`) or clear (null) a Mandate item for `person`, from `project`, an alert unless `quiet`; true once Mandate has it settled. `what` names the sender in the log; `parts`, an alert's problems for its Taskmaster's wake. */
async function mandateAlert(what: string, project: Pick<Project, 'id' | 'name'>, person: User, key: string, title: string | null, link = `/c/#/p/${project.id}`, quiet = false, parts?: AlertPart[]): Promise<boolean> {
  const c = store.getContraption('mandate');
  const identity = c && contraptions.signIdentity(c.name, person, { name: `scheme-${project.id}`, title: project.name });
  if (!c || !identity) return false;
  // CI health wakes each problem's own Taskmaster itself, once, as it opens (#983), so its bundled item doesn't wake Citadel's too; timer alerts too (#1662), an hour before they ring.
  const wakes = title !== null && !quiet && what !== 'CI health' && what !== 'Timer alerts';
  const scheme = wakes ? alertScheme(project.id) : 0;
  // A wake's item opens the Taskmaster's chat, but CI's keep their CI page (#968: what, why and the fix are there).
  if (scheme && store.getOverlord(scheme) && !link.endsWith('/ci')) link = `/c/#/p/${scheme}`;
  try {
    const { status, answer } = await callMandate(c, identity, key, title === null ? undefined : { title, alert: !quiet, link });
    if (status === 200 && wakes) alertWakes.raise({ from: project, key, title, link, person: person.name, parts });
    else if (status === 200 && title === null) alertWakes.clear(project, key);
    // 403: she switched the scheme off in Mandate, which keeps it off; asking again won't change that.
    if (status === 200 || status === 403) return true;
    console.error(`${what}: Mandate answered ${status} for ${person.name}'s ${key}:`, JSON.stringify(answer).slice(0, 300));
  } catch (err) {
    console.error(`${what}: ${thrown(err).message ?? err}`);
  }
  return false;
}
// CI health (#368): runners offline, jobs that never started, or no verdict on main for hours, in every scheme, make
// one Mandate alert for every admin (#540), cleared when it's all over (green that skipped jobs, a quiet item from
// its scheme); no turn runs.
const ciHealth = new CiHealth(store, {
  outbox,
  longs: () => longJobs.list(),
  get: withoutHeld(ghGet, (run) => ciHold.isHeld(run)),
  as: (p) => (p.repo_dir ? githubOf(p.repo_dir) : undefined),
  // shortcut: compares against the clone's local branch, so a scheme whose clone lags GitHub's main gets its last green late; read origin's ref too if one does.
  green: (p, runs, branch) => {
    if (p.repo_dir)
      lastGreen.note(p.id, p.repo_dir, `refs/heads/${branch}`, runs).then(
        () => showReleases(),
        (err) => console.error(`Last green of ${p.name} failed:`, err),
      );
  },
  mandate: (from, person, key, title, quiet, link, parts) => mandateAlert('CI health', from, person, key, title, link, quiet, parts),
  wake: (ticketId, text, fyi) => runner.send(ticketId, APP_NAME, text, [], fyi ? { fyi, light: true } : {}),
  home: () => store.getProject(alertScheme(0)),
  // Wakes (a red on main, any trigger, #774/#968; a problem that rings, #983) or held mail (back to green) for the scheme's Taskmaster.
  // The CI-red judge's one act (#1503): log-only turns every Taskmaster wake and mail from CI health into a retro-log line.
  tell: judged<[Project, string, boolean | undefined, number[] | undefined], boolean | number>(
    'ci-red',
    'tell',
    (project, text, wake, people) => {
      const to = taskmastersFor(store, project.id, people);
      if (!to.length) return false;
      // One wake per problem (a cold context each, and each would start its own fix minion): the first person's Taskmaster; the others get held mail.
      let sent = false;
      to.forEach((coordinator, i) => {
        try {
          if (!wake || i > 0) runner.leaveMail(coordinator.id, APP_NAME, i > 0 ? `${text}\n(${store.getTicket(to[0].id)?.title ?? 'Another Taskmaster'} was woken for this; check list_tickets for a fix minion before starting one.)` : text);
          else runner.send(coordinator.id, APP_NAME, text, [], runner.isOverlord(coordinator) ? { everyone: true } : {});
          if (i === 0) sent = true; // the wake itself; the others only get mail
        } catch (err) {
          console.error(`CI health: telling Taskmaster #${coordinator.id} failed:`, err);
        }
      });
      if (!sent) return false;
      if (!wake) return true;
      // The chat entry the wake became (the CI page links to it, #992); true if it can't be found.
      return store.eventsOfKinds(to[0].id, ['user_message']).at(-1)?.id ?? true;
    },
    () => true,
    judgeNote((project) => project.id),
  ),
  // A red's fix minion (#1074): its branch tip once its own commits (since it started) are in `sha`, GitHub's main.
  // shortcut: reads the scheme's clone, so a PR-merging scheme whose clone lacks GitHub's tip starts no re-run until it fetches; add a fetch if one does.
  shipped: (p, t, sha) => (p.repo_dir && t.branch ? fixShipped(p.repo_dir, t.branch, Math.floor(t.created_at / 1000), sha) : Promise.resolve(null)),
  // #1491: a red's fixer by its shipped commit; the same clone, so a PR-merging scheme is seen once its clone has fetched.
  touched: (p, branch, files, since) => (p.repo_dir ? touchedSince(p.repo_dir, branch, files, since) : Promise.resolve([])),
  held: (id, note) => {
    const t = store.getTicket(id);
    if (!t || t.status === 'closed') return;
    if (note) store.updateTicket(id, { state: 'outside', note: note.slice(0, 60) });
    else if (t.state === 'outside') store.updateTicket(id, { state: null, note: null });
    runner.broadcastTicket(id);
  },
  dismiss: (id, text) => runner.ciGreen(id, text),
});
runner.ciHold = (id) => {
  const held = ciHealth.hold(id);
  const t = held ? store.getTicket(id) : null;
  // Only as its deploy goes live, not at every close_self or turn end: two extra looks per scheme cost API calls.
  if (t?.state === 'pending-deploy') ciHealth.soon(t.project_id);
  return held;
};
if (!BOOT_CHECK) ciHealth.start();
// Handed-off lands (#706): the server reports each once its land.sh ends, with no turn on a clean land (src/land.ts).
// Fast mode's testing behind (#1017, src/fast-mode.ts): the full suite on main after fast lands, in each fast scheme.
const recordFlakes = (projectId: number, ticketId: number | null, commit: string | null, output: string) => {
  const found = parseFlakes(output);
  if (found.length) store.addFlakeEvents(projectId, ticketId, commit, Date.now(), found);
};
const fastMode = new FastMode({
  flakes: (id, sha, output) => recordFlakes(id, null, sha, output),
  schemes: () =>
    store
      .listProjects()
      .filter((p) => p.land_mode === 'fast' && p.repo_dir)
      .map((p) => ({ id: p.id, repo: p.repo_dir! })),
  get: (k) => store.getSetting<FastState>(k) ?? undefined,
  set: (k, v) => store.setSetting(k, v),
  jobs: new HostJobs(() => runner.units),
  dir: (id) => join(DATA_DIR, 'run', 'fast-mode', String(id)),
  // As the lander's land ran (its person's GitHub login), with no Citadel token of its own: it calls no tools, and a fresh one would log a live turn out (#225).
  env: (id, ticketId) => {
    const t = (ticketId != null ? store.getTicket(ticketId) : null) ?? store.getOverlord(id);
    return t ? runner.hostEnv(t, '') : turnEnv(process.env);
  },
  ticketOf: (id, n) => store.getTicketByNumber(id, n)?.id ?? null,
  numberOf: (id) => store.getTicket(id)?.number ?? null,
  tell: (id, text) => runner.send(id, APP_NAME, text),
  taskmaster: tellHome,
  green: (id, sha) => {
    const p = store.getProject(id);
    if (p?.repo_dir)
      lastGreen.note(id, p.repo_dir, 'refs/heads/main', [{ head_sha: sha, workflow_id: 0, status: 'completed', conclusion: 'success', created_at: new Date().toISOString(), file: 'land.sh --verify' }]).then(
        () => showReleases(),
        (err) => console.error(`Last green of ${p.name} failed:`, err),
      );
  },
});
if (!BOOT_CHECK && !PREVIEW) every('fast mode', 30_000, () => fastMode.tick());
if (!BOOT_CHECK && !PREVIEW) every('urgent fixes', 60_000, () => urgentFixes.tick());
// A flake fix has to prove it held (#1120, src/flake-fixes.ts): the retro log's flake lines counted, the third sighting in 7 days
// starting one minion, and a fix held after 50 clean runs on the desktop. The minion runs for the scheme's owner, like a schedule's.
const flakeFixes = new FlakeFixes({
  store,
  sharedDir: (id) => projectSharedDir(DATA_DIR, id),
  start: judged<Parameters<FlakeFixDeps['start']>, ReturnType<FlakeFixDeps['start']>>(
    'flake-counter',
    'start',
    async (project, brief) => {
      const { id } = await newMinion(project, { title: brief.title, props: { type: 'bug' }, model: brief.model, effort: brief.effort }, APP_NAME);
      store.updateTicket(id, { person_id: project.owner_id ?? null });
      runner.emit(id, 'note', { text: 'Started by the flaky-test rule (a third sighting in 7 days, or a held fix that flaked again): the Test health tab shows its owner, age and clean runs.' });
      await heldStarts.start({ ticket: id, from: APP_NAME, message: brief.message, opts: { brief: true } }, () => runner.send(id, APP_NAME, brief.message, [], { brief: true }));
      return { id };
    },
    async () => ({ id: -1 }),
    judgeNote((project) => project.id),
  ),
  wake: judged<[Project, string], boolean>(
    'flake-counter',
    'wake',
    (p, text) => {
      tellHome(p.id, text);
      return !!store.getOverlord(p.id);
    },
    () => true,
    judgeNote((p) => p.id),
  ),
  runs: (p, branch) => ciHealth.workflowRuns(p, 'flake-proof.yml', branch),
  jobs: (p, run) => ciHealth.runJobs(p, run),
  front: (p, ticketId, reason) => shipFirst({ store, releases, waits }, p.id, ticketId, { name: 'The broken-test rule', taskmaster: true }, reason),
  evidence: async (p, branch, file, at) => {
    const slug = repoSlug(p.repo_url);
    return slug && p.repo_dir ? ciEvidence(slug, githubOf(p.repo_dir), branch, file, at) : null;
  },
});
if (!BOOT_CHECK && !PREVIEW) every('flake fixes', 5 * 60_000, () => flakeFixes.tick(store.listProjects().filter((p) => p.repo_dir)));
// The live probe (#1741): a big ship's own check of itself, run by the server once it is live (src/live-probe.ts).
const liveProbes = new LiveProbes({
  store: store as ConstructorParameters<typeof LiveProbes>[0]['store'],
  runner,
  from: APP_NAME,
  log: probeLog(DATA_DIR),
  run: (id, p) => {
    const t = store.getTicket(id);
    const person = t?.person_id != null ? store.getUser(t.person_id) : null;
    // GETs signed in as the minion's own person, from this process to its own loopback only; what they answer never reaches the chat.
    // An app's path goes to the app's own host when apps have one (src/apps.ts moves them off Citadel's host).
    const headers = (path: string): Record<string, string> | null => {
      if (!person || person.disabled_at) return null;
      const app = APPS_DOMAIN ? /^\/apps\/([^/?#]+)/.exec(path)?.[1] : undefined;
      return app ? { 'x-forwarded-host': `${app}.${APPS_DOMAIN}`, cookie: auth.issueAppCookie(app, person, false).split(';')[0] } : { cookie: auth.issueCookie(person, false).split(';')[0] };
    };
    return runProbe(p, { base: `http://${LOCAL_HOST.includes(':') ? `[${LOCAL_HOST}]` : LOCAL_HOST}:${boundPort}`, headers, dbPath: join(DATA_DIR, 'coordinator.db') });
  },
  isLive: async (id, commit) => {
    const dir = store.getProject(store.getTicket(id)?.project_id ?? 0)?.repo_dir;
    const head = waiters.proven;
    if (!commit || !dir || !head) return false;
    return new Promise((done) => execFile('git', ['merge-base', '--is-ancestor', commit, head], { cwd: dir }, (err) => done(!err)));
  },
});
runner.probeHold = (id) => liveProbes.hold(id);
const shipApps = shipDeploys({ store, services, autoDeploy, startDeploy: (row, by, uid) => startDeploy(app, row, by, null, uid) });
const landHandoffs = new LandHandoffs({
  landings,
  store,
  runner,
  from: APP_NAME,
  probe: (id, probe, commit, when) => liveProbes.shipped(id, probe, commit, when),
  flakes: (id, output) => {
    const t = store.getTicket(id);
    if (t) recordFlakes(t.project_id, id, /main is now at ([0-9a-f]{7,40})/.exec(output)?.[1] ?? null, output);
  },
  failed: (id, kind) => {
    runner.places.refused(id, true);
    stallWatch.shipFailed(id, kind);
    const run = landings.get(id);
    if (run) recordFailure(store, id, run.output, run.code);
  },
  landed: (id, commit) => {
    runner.urgent.done(id);
    runner.startNow.end(id);
    runner.holderShipped(id, commit);
    // A front-end ship can be live by now. Another scheme's is once it is on its main, or its apps' deploy is live (the deploy's end passes it on).
    // shortcut: one whose deploy failed passes on at Citadel's next go-live; make the claim ask the deploy when another scheme keeps claims.
    void waiters
      .elsewhere(id)
      .then((other) => (other && shipApps.apps(id).length ? null : passLiveClaims()))
      .catch((err) => console.error('Passing on the claims of a ship failed:', err));
    const t = store.getTicket(id);
    if (t && store.getProject(t.project_id)?.land_mode === 'fast') void fastMode.landed(t.project_id, id, commit);
  },
  learned: (id, h) => {
    const t = store.getTicket(id);
    if (t && h.learned !== undefined) queueLesson(store, DATA_DIR, t, h.learned, h.touched ?? [], 'land', (text) => void tellTaskmaster(app, t, text, false, true, 'fyi', true).catch((e) => console.error(`Ship lessons repeat alert failed: ${e?.message ?? e}`)));
  },
  runnersBack: (id, reason) => {
    const project = store.getProject(store.getTicket(id)?.project_id ?? 0);
    if (!project || !repoSlug(project.repo_url ?? null) || !runnerLabel(project.name)) return false;
    addRunnerWaiter(store, id, reason, outbox);
    const run = landings.get(id); // CI gave no verdict: parked till runners are back, still a failed try (#1375)
    if (run) recordFailure(store, id, run.output, run.code);
    runner.places.refused(id, true);
    return true;
  },
  liveAlready: async (id) => (await waiters.pendingLive()).includes(id),
  // A stay_open land with waiting_on wakes its minion once live (#942), through wake_when_live's waiter.
  wakeWhenLive: async (id, commit, text) => {
    const full = commit && (await waiters.resolve(commit, store.getProject(store.getTicket(id)?.project_id ?? 0)?.repo_dir ?? null));
    return waiters.add(id, full || null, text, true);
  },
  buildOwner: (id, n) => store.getSetting<number>(buildOwnerKey(store.getTicket(id)?.project_id ?? 0, n)) ?? null,
  ...shipApps,
});
// The minions the server is landing for (#727): working, in the views. Synced again after the poll, since settling a
// land sends its row before the hand-off is marked settled.
const serverWork = serverWorkWatch(
  () => landings.handoffs(),
  (id) => runner.broadcastTicket(id),
);
// A turn's start asks fresh: one stat on that minion's own folder, not the list.
runner.serverWork = (id, fresh) => (fresh ? (landings.hasHandoff(id) ? { kind: 'land' as const } : null) : (serverWork.of(id) ?? minionJobs.work(id)));
// Every ship line, for the time log's record of each ship (#1992): Citadel's as last polled, every other scheme's read now.
const shipTrail = new ShipTrail({
  store,
  landings,
  lines: () => everyLine({ store, own: ownScheme()?.id ?? null, line: waits.line, ticketFor: (label) => waits.ticketFor(label) }),
});
// Two seconds at most: a slow disk under one scheme's line must not hold up every scheme's ship reports.
const trailPoll = () => Promise.race([shipTrail.poll().catch((err) => console.error(`[ship trail] ${thrown(err).message}`)), new Promise((r) => setTimeout(r, 2000))]);
if (!BOOT_CHECK && !PREVIEW) every('land hand-offs', 5_000, async () => (serverWork.sync(), await trailPoll(), await landHandoffs.poll(), serverWork.sync()));
// Was a blocking scan at each start, before the listen (#1463).
if (!BOOT_CHECK && !PREVIEW) every('landings prune', 24 * 3600_000, () => landings.prune(), 10 * 60_000);
if (!BOOT_CHECK) {
  every('deploy watch', 60_000, () => deployWatch!.tick(), 0);
}
// Incident timelines (#1145): the server down, the ship line still 15 min, a burst of red CI runs make one read-only
// timeline per incident in Citadel's shared reports/, and an ask to the Taskmaster to start a research minion on it.
const ownGithub = (p: Project) => (p.repo_dir ? githubOf(p.repo_dir) : undefined);
const incidents = new Incidents({
  store,
  bootAt: BOOT_AT,
  line: () => waits.line,
  jobs: () => {
    const p = ownScheme();
    return p ? (ciHealth.recent.get(p.id) ?? []) : [];
  },
  sources: {
    dbPath: join(DATA_DIR, 'coordinator.db'),
    deploys: (from, to) => readDeploys(import.meta.dirname, from, to),
    journal: (from, to) => readJournal(from, to),
    ci: async (from, to) => {
      const p = ownScheme();
      const slug = p && repoSlug(p.repo_url);
      if (!p || !slug) throw new Error('no scheme runs this server');
      return readCiRuns(ghGet, slug, ownGithub(p), from, to);
    },
  },
  write: (name, text) => {
    const p = ownScheme();
    if (!p) return null;
    const dir = join(projectSharedDir(DATA_DIR, p.id), 'reports');
    mkdirSync(dir, { recursive: true });
    let file = join(dir, name);
    for (let i = 2; existsSync(file); i++) file = join(dir, name.replace(/\.md$/, `-${i}.md`));
    writeFileSync(file, text);
    return file;
  },
  tell: (text) => {
    const p = ownScheme();
    const tm = p && store.getOverlord(p.id);
    if (!tm) return false;
    runner.send(tm.id, APP_NAME, text, [], runner.isOverlord(tm) ? { everyone: true } : {});
    return true;
  },
});
if (!BOOT_CHECK && !PREVIEW) {
  incidents.boot();
  every('incidents', 60_000, () => incidents.tick());
}
// GitHub artifact sweep (#657): weekly, every scheme's repo keeps its newest few artifacts of each kind (src/artifact-sweep.ts).
const artifactSweep = new ArtifactSweep(store, { as: (p) => (p.repo_dir ? githubOf(p.repo_dir) : undefined), log: (line) => console.log(line) });
// The server's GitHub polls each 10 min (#1722: ghGet, ghPost and the long heavy jobs; not one-off calls such as the
// artifact sweep's deletes): the login's hour is shared with land.sh and every turn, so the journal says what the
// server spent when "API rate limit exceeded" comes back. Restarts are often, so not hourly, and SIGTERM logs the rest.
const logGhTally = (when: string) => {
  const r = ghTally.report();
  if (r) console.log(`github: ${when} ${r}`);
};
if (!BOOT_CHECK) every('github tally', 10 * 60_000, () => logGhTally('last 10 min'));
if (!BOOT_CHECK)
  every('artifact sweep', 60 * 60_000, async () => {
    if (await pressure.gate('artifact sweep')) await artifactSweep.tick();
  });
// The CI desktop's load (#534): the runner agents' samples and CI health's jobs become a verdict per PC; one that
// holds is a quiet Mandate item for every admin, cleared when it ends.
const ciLoad = new CiLoad(store, {
  jobs: () => store.listProjects().map((project) => ({ project, jobs: ciHealth.recent.get(project.id) ?? [] })),
  hosts: () =>
    machines
      .list()
      .filter((m) => m.runners && m.online)
      .map((m) => m.host ?? ''),
  mandate: (project, person, key, title) => mandateAlert('CI load', project, person, key, title, undefined, true),
});
if (!BOOT_CHECK) ciLoad.start();
// Ships go first on the CI desktop (#1268): every 15 s, the runners on a ship run's job in any repo with runners on an
// agent's PC go to that PC's runner agents, which squeeze every other runner there while one runs (src/ci-ships.ts).
// The agents' samples name their runners' repos; a scheme whose self-hosted jobs ran today counts too, for an agent that sends none.
const runnerRepos = () =>
  [
    ...ciLoad.runnerRepos(),
    ...store
      .listProjects()
      .filter((p) => ciHealth.recent.get(p.id)?.some((j) => j.labels?.includes('self-hosted')))
      .map((p) => repoSlug(p.repo_url) ?? ''),
  ].filter(Boolean);
const schemeOf = (repo: string) => store.listProjects().find((x) => x.repo_dir && repoSlug(x.repo_url)?.toLowerCase() === repo.toLowerCase());
const asScheme = (repo: string) => {
  const p = schemeOf(repo);
  return p ? githubOf(p.repo_dir!) : null;
};
const shipWatch = new ShipWatch({
  repos: runnerRepos,
  as: asScheme,
  send: (ships) => machines.sendShips((host) => shipsOn(host, ships, ciLoad.runnersByPc())),
  first: () => liveSlug,
});
if (!BOOT_CHECK) shipWatch.start();
// Deploys first (#1902, Josh 2026-11-24): while a ship is in Citadel's line, optional work stays off the CI desktop.
const tellHeld = (repo: string, text: string) => {
  const p = schemeOf(repo);
  for (const t of p ? taskmastersFor(store, p.id) : []) runner.send(t.id, APP_NAME, text, [], runner.isOverlord(t) ? { everyone: true } : {});
};
const ciHold = new CiHold({
  own: () => liveSlug?.toLowerCase() ?? null,
  repos: () => runnerRepos().map((r) => r.toLowerCase()),
  as: asScheme,
  line: () => waits.line.filter((l) => l.label !== 'tools/deploy.sh').length,
  off: async () =>
    !!deployState &&
    (await stat(join(deployState, 'hold-off')).then(
      () => true,
      () => false,
    )),
  ticket: (repo, branch, heavyId) => {
    if (heavyId) return longJobs.list().find((j) => j.id === heavyId)?.ticket ?? null;
    const p = schemeOf(repo);
    return (p && store.listTickets(p.id).find((t) => t.branch === branch)?.id) ?? null;
  },
  closed: (id) => store.getTicket(id)?.status === 'closed',
  mayResume: (heavyId) => longJobs.mayResume(heavyId),
  heldSince: (heavyId) => longJobs.heldSince(heavyId),
  tell: (id, text) => runner.leaveMail(id, APP_NAME, text),
  report: tellHeld,
  number: (id) => store.getTicket(id)?.number ?? undefined,
  changed: (id) => runner.broadcastTicket(id),
  waiting: () => longJobs.list().flatMap((j) => (j.state === 'queued' && j.held_at && j.held_why ? [{ id: j.id, repo: j.slug.toLowerCase(), ticket: j.ticket, what: j.what, since: j.held_at, why: j.held_why, reported: !!j.reported }] : [])),
  told: (heavyId) => void longJobs.told(heavyId).catch((e) => console.error(`CI hold: ${heavyId}: ${e?.message ?? e}`)),
  heldTold: (heavyId) => longJobs.list().find((j) => j.id === heavyId)?.reported,
  store,
  publish: (state) => writeHold(join(DATA_DIR, 'projects', '.heavy'), state),
});
runner.heldLine = (id) => ciHold.noteFor(id);
// After the first read of the long jobs: before it, a held one would look free to start again in the day.
if (!BOOT_CHECK && !PREVIEW) void longJobs.refresh().then(() => ciHold.start());
// One Peek build while Citadel ships (#1902; Josh, 2026-11-25, "Yes, use labels"). His pick is for Peek alone.
const CAPPED_REPO = 'caraminden/peek-auras';
const runnerCap = new RunnerCap({
  project: () => schemeOf(CAPPED_REPO) ?? null,
  label: (p) => runnerLabel(p.name),
  why: () => ciHold.shipNow(),
  here: () => runnersBeside(ciLoad.runnersByPc(), liveSlug, CAPPED_REPO),
  tokens: runnerTokens,
  store,
  report: (p, text) => tellHeld(repoSlug(p.repo_url)!, text),
});
runnerTokens.owed = (id, label) => runnerCap.owes(id, label);
if (!BOOT_CHECK && !PREVIEW) runnerCap.start();
// A job that ran in the server because systemd-run failed (#519): the first of each cause each day is a Mandate
// alert for every admin, from the job's scheme, linking its minion, cleared once a job gets its own unit again (#532).
fallbacks.observe = (job, error) => deployWatch?.record('fallback', `${job}: ${error}`.replace(/\d+/g, '#'));
fallbacks.alert = adminAlert(store, (project, person, key, title, link) => mandateAlert('In-server fallback', project, person, key, title, link));
fallbacks.clear = adminClear(store, (project, person, key) => mandateAlert('In-server fallback', project, person, key, null));
// Contraptions' timer jobs (#555): a failed run wakes its home scheme's Taskmaster, and still failing an hour later is
// one Mandate alert for every admin and the app's home-scheme owner (#1662), cleared once a run of that job succeeds. Only a server that manages app services reads them.
const timerAlerts = new TimerAlerts(store, {
  runs: (rows) => services.timerRuns(rows),
  journal: (unit) => services.journalTail(unit),
  mandate: (from, person, key, title, link) => mandateAlert('Timer alerts', from, person, key, title, link),
  wake: (from, text) => {
    const scheme = alertScheme(from.id);
    if (!scheme || !store.getOverlord(scheme)) return false;
    tellHome(scheme, text);
    return true;
  },
});
if (!BOOT_CHECK && !services.opts.off) timerAlerts.start();
// Ships and checks in the line whose cgroup somebody froze (#1881): each freeze and thaw is a health event, and one frozen over 5 minutes is
// one Mandate alert for its scheme's owner, cleared when it thaws. Reads only what the line's readers noted; it thaws nothing.
const frozenShips = new FrozenShips(store, {
  mandate: (from, person, key, title, link) => mandateAlert('Frozen ships', from, person, key, title, link),
  schemeOf: (label) => {
    const t = labelTicket(store, label);
    const p = t && store.getProject(t.project_id);
    return p ? { id: p.id, name: p.name } : null;
  },
  fallback: () => ownScheme(),
  scan: async () => {
    const dirs = [waits.queue && { q: waits.queue, at: 4 }, ...store.listProjects().map((p) => p.repo_dir && { q: landQueue(p.repo_dir), at: 7 })];
    await Promise.all([...dirs.map((d) => d && readQueueA(d.q, d.at)), readHeavyA(join(DATA_DIR, 'projects', '.heavy'))]);
  },
});
if (!BOOT_CHECK) frozenShips.start();
// Each app's DATA_DIR size for Settings and the app's own read (#847): du in the background, never on a request.
if (!BOOT_CHECK) services.watchDisk(() => store.listContraptions());
// Apps with a database but no backup timer or disk_warn_gb are flagged to their scheme's Taskmaster, once each (#1383).
if (!BOOT_CHECK) {
  const flagRound = (oncePerDay: boolean) =>
    void flagUnbacked(
      {
        apps: () => store.listContraptions(),
        dataDir: (a) => services.dataDir(a),
        manifest: (a) => services.manifest(a),
        taskmaster: (scheme) => store.getCoordinator(scheme)?.id ?? null,
        mail: (id, text) => runner.leaveMail(id, APP_NAME, text),
        getState: () => store.getSetting<Record<string, string>>(FLAG_KEY) ?? {},
        setState: (s) => store.setSetting(FLAG_KEY, s),
      },
      { oncePerDay },
    ).catch((err) => console.warn(`Checking the apps for backups failed: ${err.message}`));
  setTimeout(() => flagRound(true), 5 * 60_000).unref();
  setInterval(() => flagRound(false), 24 * 3_600_000).unref();
}
// Every contraption's errors in a daily file in its home scheme's shared folder (#835): failed agent tool calls, 5xx
// answers through the proxy (set on the proxy below) and its journals' error lines; list_tickets shows yesterday's count.
const errorDigest = new ErrorDigest(store, {
  sharedDir: (id) => projectSharedDir(DATA_DIR, id),
  journal: services.opts.off ? undefined : (row, cursor) => services.journalSince(row, cursor),
  // 502-504s while an app restarts (a deploy's or a person's) or just after are deploy windows, not errors (#1728).
  restarting: (name) => apps.restarts.restarting(name, RESTART_WINDOW_MS),
});
contraptionTurns.onToolError = (c, tool, error) => void safely('error digest', () => errorDigest.toolError(c, tool, error));
if (!BOOT_CHECK && !PREVIEW) errorDigest.start();
// Every contraption's main pages, shot nightly from a sealed copy and compared with the night before (#1783).
const appShotsMail = (scheme: number, text: string) => {
  const tm = store.getOverlord(scheme);
  if (tm) runner.leaveMail(tm.id, APP_NAME, text);
  return !!tm;
};
const appShots = new AppShots(store, {
  dir: join(DATA_DIR, 'app-shots'),
  home: homedir(),
  sharedDir: (id) => projectSharedDir(DATA_DIR, id),
  citadel: () => alertScheme(0),
  wake: judged(
    'app-shots',
    'wake',
    (scheme: number, text: string) => {
      if (!store.getOverlord(scheme)) return false;
      tellHome(scheme, text);
      return true;
    },
    () => true,
    judgeNote((scheme) => scheme),
  ),
  mail: judged(
    'app-shots',
    'mail',
    appShotsMail,
    () => true,
    judgeNote((scheme) => scheme),
  ),
  report: appShotsMail,
  watching: judge('app-shots')?.mode === 'log-only',
  start: startRun,
  alive: runAlive,
  kill: killRun,
});
if (!BOOT_CHECK && !PREVIEW && !services.opts.off) appShots.start();
// Members already in schemes get their invites, and leavers' are withdrawn (#310); it settles, so later boots only retry what failed.
if (!BOOT_CHECK) void safely('repo access sweep', () => repoAccess.sweep());
runner.onTurnEnd = (ticketId) => github.poke(ticketId);
// A merged PR catches its scheme's main up, and chains and commit waiters look again.
github.onMerged = (repoDir, ticket, base) => {
  // Into a build branch isn't shipped yet.
  if (!base?.startsWith('build/')) {
    runner.urgent.done(ticket.id);
    runner.startNow.end(ticket.id);
  }
  runner.places.refused(ticket.id, false);
  catchUp(repoDir);
};

// Each CI runner token handed out (#320) is told in the scheme Taskmaster's chat, without waking it.
// One fetched by a runner agent job's scripts goes under that job's note instead (#339).
runnerTokens.onFetched = (project, text, machine) => {
  if (runnerJobs.absorb(project, machine, text)) return;
  const coordinator = store.getOverlord(project.id);
  if (coordinator) runner.emit(coordinator.id, 'note', { everyone: true, text });
};
// So is each runner agent add or remove (#328), once, when it ends, its output collapsed under it (#339); a list isn't.
// The CI store (#658): a refusal for room is told in the scheme Taskmaster's chat; the rules also run daily (and soon
// after a start), for schemes that have stopped uploading and for what a restart cut off mid-upload.
ciStore.onFull = (project, text) => {
  const coordinator = store.getOverlord(project.id);
  if (coordinator) runner.emit(coordinator.id, 'note', { everyone: true, text });
};
// A step up in a scheme's CI numbers that held (#1369) wakes its Taskmaster, as a CI alert does (#983); never a gate.
ciNumbers.onStep = judged(
  'ci-numbers',
  'wake',
  (project: Project, _step: CiNumberStep, text: string) => {
    const coordinator = store.getOverlord(project.id);
    if (coordinator) runner.send(coordinator.id, APP_NAME, text, [], runner.isOverlord(coordinator) ? { everyone: true } : {});
  },
  () => {},
  judgeNote((project) => project.id),
);
if (!BOOT_CHECK && !PREVIEW) {
  every('ci store sweep', 24 * 60 * 60_000, () => (ciNumbers.sweep(), ciStore.sweep(true)), 15 * 60_000);
}
runnerJobs.onNote = (project, text, detail) => {
  const coordinator = store.getOverlord(project.id);
  if (coordinator) runner.emit(coordinator.id, 'note', { everyone: true, text, detail });
};

// A scheme's main that can't follow origin's (#208) is told in its Taskmaster's chat, once per reason.
mainSync.stuck = (repoDir, why) => {
  if (!why) return;
  console.warn(`Not fast-forwarding main in ${repoDir}: ${why}`);
  const project = store.listProjects().find((p) => p.repo_dir === repoDir);
  const coordinator = project && store.getOverlord(project.id);
  if (coordinator) runner.emit(coordinator.id, 'note', { everyone: true, text: `This scheme's main checkout (${repoDir}) isn't level with GitHub's main, and ${APP_NAME} didn't fast-forward it: ${why}. A person needs to look.` });
};

/** Rewrite each scheme's property-vocabulary.md from the registry; a hand-written one is kept aside once. */
async function writeVocabularies(projectIds = store.listProjects().map((p) => p.id)) {
  for (const id of projectIds) {
    const project = store.getProject(id);
    if (!project) continue;
    const dir = projectSharedDir(DATA_DIR, id);
    const path = join(dir, 'property-vocabulary.md');
    const text = store.props.doc(id, project.name);
    const old = await readFile(path, 'utf8').catch(() => null);
    if (old === text) continue;
    await mkdir(dir, { recursive: true });
    if (old && !/^generated: true$/m.test(old)) await writeFile(join(dir, 'property-vocabulary.before-registry.md'), old, { flag: 'wx' }).catch(() => {});
    await writeFile(path, text);
  }
}

/** After a registry change: regenerate the docs it touches (every scheme's for a global key). */
function registryChanged(projectId: number, global: boolean) {
  writeVocabularies(global ? undefined : [projectId]).catch((err) => console.error('Could not write the property vocabulary:', err));
  broadcast({ type: 'properties', projectId: global ? null : projectId });
}

// Android colours an installed app's status and navigation bars from the manifest, which can't vary
// by light or dark mode yet (color_scheme_dark is still a proposal). Ask the browser for its colour
// scheme (COLOR_SCHEME_HINT) and hand dark-mode devices a manifest with the dark colours, so the app doesn't get a white bar.
function darkManifest(assets: Map<string, Buffer>) {
  const manifest = JSON.parse(assets.get('manifest.webmanifest')!.toString());
  return Buffer.from(JSON.stringify({ ...manifest, ...manifest.color_scheme_dark }, null, 2));
}
// The CI runner agent's installer and scripts (#328), which Cara's one-time install downloads: read from tools/ci-runner/
// at each request, so they are always the deployed checkout's. Nothing in them is secret.
const RUNNER_FILES = new Set([
  'install-runner-agent.ps1',
  'add-runner.ps1',
  'list-runners.ps1',
  'remove-runner.ps1',
  'start-runner.ps1',
  'sample-load.ps1',
  // The Linux agent in WSL (#510).
  'install-runner-agent.sh',
  'add-runner.sh',
  'list-runners.sh',
  'remove-runner.sh',
  'keep-wsl-up.ps1',
  'keep-runners.ps1',
]);
// The same for the Android emulator's distro on that desktop (#533): deploy/desktop/android/setup.sh and what it downloads.
const ANDROID_FILES: Record<string, string> = { 'setup.sh': 'deploy/desktop/android/setup.sh', 'citadel-android': 'tools/citadel-android', 'install-sdk.sh': 'tools/android/install-sdk.sh' };
const SETUP_PATH = /^\/(ci-runner|android-desktop)\//;
async function serveRunnerFile(res: ServerResponse, path: string) {
  const name = path.replace(SETUP_PATH, '');
  const file = path.startsWith('/ci-runner/') ? RUNNER_FILES.has(name) && join('tools', 'ci-runner', name) : Object.hasOwn(ANDROID_FILES, name) && ANDROID_FILES[name];
  if (!file) throw new HttpError(404, 'Not found');
  const body = await readFile(join(import.meta.dirname, file));
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': body.length });
  res.end(body);
}
/** Each front-end file as it is sent: the headers a request doesn't change, its body and gzipped body, and the variants a request picks. */
async function staticTable(assets: Map<string, Buffer>, version: string, hashes: Map<string, string>, dark: Buffer): Promise<Statics> {
  const file = (name: string, body: Buffer) => {
    const headers: Record<string, string> = { ...SECURITY_HEADERS, 'Content-Type': MIME[extname(name)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' };
    // The service worker keeps only files of the version it was made for (public/sw.js); its own copy names that version
    // and the files, or is the off switch's worker (src/shell.ts).
    headers['X-Front-Version'] = version;
    headers['X-Front-Hash'] = hashes.get(name) ?? '';
    if (name === 'index.html') headers['Accept-CH'] = COLOR_SCHEME_HINT;
    if (name === 'manifest.webmanifest') headers.Vary = `Accept-Encoding, ${COLOR_SCHEME_HINT}`;
    return readyFile(headers, body);
  };
  const sw = (off: boolean) => Buffer.from(shellWorker(assets.get('sw.js')!.toString('utf8'), version, hashes, off));
  const files = Object.fromEntries(await Promise.all([...assets].map(async ([name, body]) => [name, await file(name, name === 'sw.js' ? sw(false) : body)] as const)));
  return { files, darkManifest: await file('manifest.webmanifest', dark), swOff: await file('sw.js', sw(true)), dataDir: DATA_DIR };
}
async function serveStatic(req: IncomingMessage, res: ServerResponse, path: string) {
  const a = STATICS && staticAnswer(STATICS, path === '/' ? 'index.html' : path.replace(/^\//, ''), req.headers);
  if (!a) throw new HttpError(404, 'Not found');
  res.writeHead(a.status, a.headers).end(a.body);
}

/** A person's container stuck at its memory limit loses its biggest process (#1876), from a worker thread; started with the storms below. */
let containerRelief: { stop: () => void } | null = null;
let stoppingWork = false;
// Memory-limit storms (#1280): a Citadel slice or container stalling at its MemoryHigh, read every 15 s, recorded for the Status page.
const memoryStorms = new MemoryStorms({ record: (at, storm) => store.addHealthEvent('memory-high', at, BOOT_COMMIT ?? null, stormDetail(storm)) });
// The Status page (#1123): perigee's memory and disk every 5 minutes, and this start recorded with why it happened.
/** One real GET /api/health a second from a worker thread (#1559); starts once the server is bound. */
const answerProbe = new AnswerProbe();
const status = new StatusPage({
  warm: () => dbWarmer?.stats() ?? null,
  storms: () => memoryStorms.current(),
  easing: () => memoryEase.current(),
  store,
  dataDir: DATA_DIR,
  bootAt: BOOT_AT,
  commit: BOOT_COMMIT ?? '',
  ownScheme: () => ownScheme()?.id ?? null,
  ciSnapshot: (canSee) => ciHealth.snapshot(canSee),
  desktops: () => ciLoad.views(),
  diskUse: (row) => services.diskUse(row),
  unitStates: PREVIEW ? undefined : (units) => services.unitStates(units),
  tell: (projectId, text) => tellHome(projectId, text),
  answer: !BOOT_CHECK && !PREVIEW ? { probe: answerProbe, turns: () => runner.runningCount() } : undefined,
  // The growth alarm (#1762): open fds, supervisor units, /tmp and app servers' memory, and a wake when one keeps growing.
  growth: !BOOT_CHECK && !PREVIEW ? { read: async () => readGrowth({ slice: await citadelSliceDir(), apps: store.listContraptions().map((c) => c.name) }), turns: () => runner.runningCount() } : undefined,
});
if (!BOOT_CHECK && !PREVIEW) {
  recordBoot(store, BOOT_COMMIT ?? '', BOOT_AT, readStop(DATA_DIR));
  status.start();
  memoryStorms.start();
  // Each container's memory room, for tools/mem-room inside it (#1982). A slow reading isn't run twice over.
  let readingRooms = false;
  every(
    'container memory room',
    ROOM_EVERY_MS,
    async () => {
      if (readingRooms) return;
      readingRooms = true;
      await publishRooms(await citadelSliceDir(), join(DATA_DIR, 'projects', '.heavy')).finally(() => (readingRooms = false));
    },
    0,
  );
  void citadelSliceDir().then((dir) => {
    if (!dir || stoppingWork) return;
    containerRelief = startContainerRelief({
      dir,
      prefix: claudeLink.prefix,
      report: (v) => {
        console.log(`[container-relief] ${v.group}: ${victimText(v)}`);
        store.addHealthEvent('memory-kill', Date.now(), BOOT_COMMIT ?? null, JSON.stringify(v));
        if (v.ticket !== null && store.getTicket(v.ticket)) runner.emit(v.ticket, 'note', { text: victimText(v) });
      },
    });
  });
}
/** What the route table (src/routes/) reaches of this server. */
const app: App = {
  usageKnown: () => [...routes.groups().map((name) => ({ kind: 'route' as const, name })), ...store.schedules.allNames().map((n) => ({ kind: 'schedule' as const, name: usageName(n) })), ...listSkills(KIT_DIR, null).map((i) => ({ kind: i.kind === 'agent' ? ('grunt' as const) : ('skill' as const), name: i.name }))],
  store,
  runner,
  auth,
  waiters,
  timedWakes,
  outbox,
  previews,
  releases,
  autoDeploy,
  rollback,
  fastMode,
  urgentFixes,
  waits,
  apkBuilds,
  desktop,
  machines,
  jobs,
  pusher,
  clients,
  github: githubLink,
  repoAccess,
  runnerTokens,
  runnerJobs,
  ciLoad,
  heavyDir: join(DATA_DIR, 'projects', '.heavy'),
  ciHealth,
  ciStore,
  ciNumbers,
  codeCounts,
  ciTests: (repo, run, c) => ciRuns.testCounts(repo, run, c),
  ciHold,
  runnerCap,
  chunked,
  claude: claudeLink,
  codex: codexLink,
  openrouter,
  outsideSpend,
  secrets,
  contraptions,
  fcm,
  contraptionTurns,
  errorDigest,
  landings,
  minionJobs,
  status,
  kitSync,
  services,
  ultrareviews,
  sideAsks,
  presence,
  reaper,
  memory: { embed, model: EMBED_MODEL, indexed: memoryScheme },
  dataDir: DATA_DIR,
  preview: PREVIEW,
  machinesUrl: MACHINES_URL,
  liveCommit: BOOT_COMMIT,
  health: { watch: deployWatch, clientErrors },
  get assetVersion() {
    return ASSET_VERSION;
  },
  broadcast,
  notify,
  newMinion,
  held: heldStarts,
  startChained: startChain,
  ticketBranch,
  builds,
  sharedFiles: artifacts.sharedFiles,
  sharedDir,
  registryChanged,
};
// Decisions (#1064): a reversal made in a repo commit reaches its Taskmaster without anyone opening the page. Off the boot's hot path, then daily.
if (!BOOT_CHECK && !PREVIEW) {
  every(
    'decisions sweep',
    24 * 60 * 60_000,
    async () => {
      for (const p of store.listProjects()) await loadDecisions(app, p).catch(() => {});
    },
    15 * 60_000,
  );
}
// A reply's status trailer (#711) goes through set_thread_status's checks; one they refuse is noted, and the state stays cleared.
runner.onStatusTrailer = (id, fields) => {
  const ticket = store.getTicket(id);
  if (!ticket) return;
  // A handed-off land's state and note are the server's until it is reported (#962): the closing "set no state" line can't clear them.
  if (landings.hasHandoff(id)) fields = { replies: fields.replies };
  try {
    setLabels(app, ticket, fields, AGENT_NAME, id);
  } catch (err) {
    console.log(`[status] minion ${id}: refused a status trailer, ${thrown(err).message}`);
    runner.emit(id, 'note', { text: `The reply's status line was refused: ${thrown(err).message}` });
  }
};
// What a minion armed for CI goes out when CI passes, with no turn (#715).
github.onCi = (ticket, pr, result) => {
  if (result === 'passed' && store.getProject(ticket.project_id)?.ship_path !== 'citadel') runner.places.refused(ticket.id, false);
  return ciFinished(app, ticket, pr, result);
};
// A scheme that ships by pull request fails a ship when CI goes red on the PR; land.sh schemes count theirs in LandHandoffs.
github.onCiFailed = (t) => {
  if (store.getProject(t.project_id)?.ship_path === 'citadel') return;
  stallWatch.shipFailed(t.id, 'red CI on its PR');
  runner.places.refused(t.id, true);
};
// A minion past four times its budget (#1114): its Taskmaster hears, waking unless cold (no one's around to act on it then).
runner.onBudgetWake = (ticketId, text) => {
  const ticket = store.getTicket(ticketId);
  if (ticket) tellTaskmaster(app, ticket, text, false, true, 'ask', true).catch((e) => console.error(`[budget] minion ${ticketId}:`, e));
};
// Past ten times (#1672): a carry on / split / stop card to its owner (`assigned`, else who asked); everyone's with neither.
runner.onBudgetCard = (ticketId, question) => {
  const ticket = store.getTicket(ticketId);
  const owner = ticket && store.minionOwner(ticket);
  const to = owner != null ? store.getUser(owner)?.name : undefined;
  if (ticket) postCard(app, ticket, { questions: [question], budget: true, ...(to ? { to } : {}) });
};
const routes = router(apiRoutes);

// The scheme the backup chat at /backup talks to: Citadel's own.
const BACKUP_SCHEME = 2;

// Contraptions' own services under /apps/<name>/, on their own hosts with APPS_DOMAIN (src/apps.ts).
contraptions.appsDomain = APPS_DOMAIN;
contraptions.appsHome = services.opts.home;
const apps = new AppProxy(store, contraptions, auth, APPS_DOMAIN, { chunked, home: services.opts.home });
// A drain comes before every restart of an app's service: its requests wait for it until the release, and a little after (#1118).
// A stop's don't, and it ends a restart's grace, so a stopped app fails fast.
const drainTurns = services.drain;
services.drain = async (row, stop) => {
  if (stop) {
    apps.restarts.stopped(row.name);
    return drainTurns(row);
  }
  const restarted = apps.restarts.hold(row.name);
  try {
    const quiet = await drainTurns(row);
    return { said: quiet.said, release: () => (quiet.release(), restarted()) };
  } catch (err) {
    restarted();
    throw err;
  }
};
// A person's Start takes no drain: it ends a stop's mark here, so GETs during the app's boot get the proxy's retry (#1173).
const act = services.act.bind(services);
services.act = (row, action) => (action === 'start' && apps.restarts.running(row.name), act(row, action));
apps.onServerError = (row, status, method, path, note) => void safely('error digest', () => errorDigest.httpError(row, status, method, path, note));
// Installers fetch manifests and icons with no login (#987): read each older app's file paths once its service is up,
// then again every so often for one that was down or had nobody enabled at the first read (rows already read are skipped).
const readStatics = () => void safely('static paths', () => apps.backfillStatics()).finally(() => setTimeout(readStatics, config.staticBackfillEveryMs).unref());
setTimeout(readStatics, config.staticBackfillMs).unref();
// Citadel UI's files for contraptions' pages (public/, src/theme.ts); no contraption can be called _citadel.

// Requests not yet answering, for settled() (src/settled.ts). Busy only until its headers go out: send() holds those until
// the request's own writes land, and a stream (an agent's connect, a page's events) stays open by design once it answers.
const inFlight = new Map<ServerResponse, string>();
// writeHead(status, headers) leaves getHeader() blind, so read the head as sent.
const isEventStream = (res: ServerResponse) => res.headersSent && !res.writableEnded && /^content-type:\s*text\/event-stream/im.test(String((res as ServerResponse & { _header?: unknown })._header ?? ''));
busySource(() => [...inFlight].filter(([res]) => !res.headersSent).map(([, what]) => `request ${what}`));
// A test server's "is everything you were doing finished?" (#1437, test/helpers.ts settled()): only with CITADEL_TEST_SETTLED=1.
const SETTLED_ROUTE = config.testSettled;

// Only /apps/ requests and a contraption's own host are upgraded (contraptions' websockets), the same check as the front thread's; anything else asking is served as usual.
const server = createServer({ shouldUpgradeCallback: (req) => upgrades(req, APPS_DOMAIN) }, (req, res) =>
  writes.request.run({ seq: 0 }, async () => {
    stampServerTime(res);
    if (/\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''))) acceptsGzip.add(res);
    inFlight.set(res, `${req.method} ${(req.url ?? '').split('?')[0]}`);
    res.once('close', () => inFlight.delete(res));
    if (passingOn) return passOn(req, res);
    try {
      if (SETTLED_ROUTE && req.url?.startsWith('/api/test/settled')) {
        inFlight.delete(res);
        const busy = await settled(Math.min(Number(requestUrl(req).searchParams.get('ms')) || 30_000, 120_000));
        return json(res, 200, { busy });
      }
      // test/front.test.ts: the main thread held busy, as a long timer holds it, to show reader routes still answer.
      if (SETTLED_ROUTE && req.url?.startsWith('/api/test/block')) {
        const until = Date.now() + Math.min(Number(requestUrl(req).searchParams.get('ms')) || 0, 5000);
        while (Date.now() < until);
        return json(res, 200, {});
      }
      // test/reader-stall.test.ts: a page read that holds this thread, as one on a swamped disk does.
      const held = SETTLED_ROUTE && /[?&]citadel-test-main-read=(\d+)/.exec(req.url ?? '');
      if (held) for (const until = Date.now() + Number(held[1]); Date.now() < until; );
      // test/front.test.ts: one step of the main thread that writes, pauses, then writes again; no reader may see the half.
      if (SETTLED_ROUTE && req.url?.startsWith('/api/test/half-step')) {
        const q = requestUrl(req).searchParams,
          id = Number(q.get('ticket'));
        store.updateTicket(id, { title: 'half' });
        const until = Date.now() + Math.min(Number(q.get('ms')) || 0, 5000);
        while (Date.now() < until);
        store.updateTicket(id, { title: 'whole' });
        return json(res, 200, {});
      }
      // test/front.test.ts: the client addresses this thread sees, which a client must not be able to set.
      if (SETTLED_ROUTE && req.url?.startsWith('/api/test/peer')) return json(res, 200, connection(req));
      // A contraption's own host is the proxy's alone, besides Citadel UI's files: none of Citadel's pages or API.
      if (apps.onAppHost(req)) {
        const path = (req.url ?? '/').split('?')[0];
        if (KIT_FILE.test(path) && (req.method === 'GET' || req.method === 'HEAD')) await serveStatic(req, res, path.slice('/apps/_citadel'.length));
        else apps.serve(req, res);
        return;
      }
      const own = ownPath(req.url ?? '/');
      if (own && 'redirect' in own) {
        if (req.method === 'GET' || req.method === 'HEAD') return void res.writeHead(302, { Location: own.redirect }).end();
      } else if (own) req.url = own.url;
      const url = requestUrl(req);
      // /preview/<ticket id>/ or a build's /preview/build/<n>/: the id is digits only, so "build" never reads as one.
      const preview = previews && /^\/preview\/(build\/)?(\d+)(\/.*)?$/.exec(url.pathname);
      // The frozen backup chat with the Citadel scheme's (2) Taskmaster, ahead of everything else (src/backup.ts).
      if (isBackupPath(url.pathname)) {
        await serveBackup(app, BACKUP_SCHEME, req, res, url);
      } else if (url.pathname.startsWith('/api/')) {
        const session = auth.session(req);
        // A route's own Set-Cookie (logout's clearing one) goes in writeHead, which wins over this.
        const renewed = auth.renewal(session, isSecure(req));
        if (renewed) res.setHeader('Set-Cookie', renewed);
        await routes(app, req, res, url, session);
      } else if (KIT_FILE.test(url.pathname)) {
        // The app rail, phone drawers (and their types), the Alt+` switcher, drag to reorder and link handling (extlinks.js) the rail loads, colours and Citadel UI (public/ui/).
        await serveStatic(req, res, url.pathname.slice('/apps/_citadel'.length));
      } else if (url.pathname.startsWith('/apps/')) {
        apps.serve(req, res);
      } else if (preview) {
        const session = auth.session(req);
        // An HTML page's files under its file token come from a frame that sends no cookies; the preview checks the token.
        const [, build, id, rest] = preview;
        const tokened = /^\/(c\/)?api\/files\//.test(rest ?? '') && (req.method === 'GET' || req.method === 'HEAD');
        // People only, signed in to the live app; a page load without a login goes to the login.
        if (!tokened && (!session || session.agent !== undefined)) {
          if (req.method === 'GET' && /text\/html/.test(String(req.headers.accept ?? ''))) return void res.writeHead(302, { Location: '/' }).end();
          throw new HttpError(401, 'Not logged in');
        }
        // Only for people in the minion's scheme, or for a build, the scheme whose code this server runs.
        const shownIn = build ? previews.buildScheme()?.id : store.getTicket(Number(id))?.project_id;
        if (session && session.agent === undefined && (shownIn === undefined || !store.canSee(session, shownIn))) throw new HttpError(404, build ? 'There is no preview for this build' : 'There is no preview for this minion');
        // The front end's URLs are relative, so the page itself needs the trailing slash.
        if (!rest) return void res.writeHead(302, { Location: `/${build ? buildPreviewPath(Number(id)) : previewPath(Number(id))}${url.search}` }).end();
        const who = session?.agent === undefined ? session : null;
        if (build) await previews.proxyBuild(req, res, Number(id), rest + url.search, who);
        else await previews.proxy(req, res, Number(id), rest + url.search, who);
      } else if (SETUP_PATH.test(url.pathname)) {
        await serveRunnerFile(res, url.pathname);
      } else {
        await serveStatic(req, res, url.pathname);
      }
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error(err);
      // Ids in the path would split one failing route into many readings.
      if (countsAsServerFault(status, err)) deployWatch?.record('server-5xx', `${req.method} ${(req.url ?? '').split('?')[0].replace(/\d+/g, '#')}: ${String(thrown(err).message ?? err).slice(0, 200)}`);
      // An HttpError's words were written for the caller, a 500 too; only an unexpected throw stays vague.
      if (!res.headersSent) json(res, status, { error: err instanceof HttpError ? err.message : 'Internal error' });
      else res.end();
    }
  }),
);

// Contraptions' websockets, which a restart ends (their pages reconnect): open ones never let server.close finish.
const upgraded = new Set<Duplex>();
// A dev copy (tools/dev-copy.ts sets IDLE_EXIT_MS) stops itself once nothing has asked it anything for that long, as an unused preview is stopped (#1365).
const IDLE_EXIT_MS = config.idleExitMs;
if (IDLE_EXIT_MS > 0) {
  let asked = Date.now();
  const touch = () => {
    asked = Date.now();
  };
  server.on('request', touch);
  server.on('upgrade', touch);
  every('dev copy idle exit', Math.min(60_000, Math.max(1000, IDLE_EXIT_MS / 4)), () => {
    if (Date.now() - asked < IDLE_EXIT_MS) return;
    console.log(`Nothing asked this copy anything for ${Math.round(IDLE_EXIT_MS / 60_000)} min, so it stops.`);
    process.exit(0);
  });
}
server.on('upgrade', (req, socket, head) => {
  upgraded.add(socket);
  socket.once('close', () => upgraded.delete(socket));
  try {
    apps.upgrade(req, socket, head);
  } catch (err) {
    console.error(err);
    socket.destroy();
  }
});

// Node's default 5 minutes to receive a whole request is too short for a 200 MB attachment on a slow
// uplink; headers still have to arrive within headersTimeout.
server.requestTimeout = 30 * 60_000;
// Once up, a stray error is logged rather than fatal. Not before: a failed start (a port in use, a
// database that won't open) must still exit non-zero so systemd restarts it.
server.on('listening', keepServing);

// Under socket activation (deploy/claude-coordinator.socket) systemd holds the listening socket, fd 3,
// across restarts: requests made while the server restarts wait for the next one instead of failing.
// A warm handover's new server got the socket from the old one (src/handover.ts), and becomes systemd's main process once it listens.
const onSocket = handover !== null || config.heldSocket;
const listened = (port: number) => {
  boundPort = port;
  // It asks the port people use, so through the front thread too: /api/health stays on the main thread (#1563).
  // Behind the front thread, a reader's answer too: a route of theirs asked signed out, a 401 from a reader (#1628).
  if (!BOOT_CHECK) answerProbe.start(boundPort, LOCAL_HOST, throughFront ? '/api/status' : undefined);
  console.log(onSocket ? `${APP_NAME} listening on the socket systemd holds (${HOST}:${PORT})` : `${APP_NAME} listening on http://${HOST}:${boundPort}`);
  handover?.live();
};
// People's read-only page requests answer on reader threads, behind a front thread that owns the port (#1563).
// CITADEL_FRONT=0 is the off switch: the main thread listens itself, as before.
if (config.front) {
  front.on = true;
  throughFront = listenThroughFront(
    server,
    {
      ...(onSocket ? { fd: 3 } : { host: HOST, port: PORT }),
      readers: 2,
      appsDomain: APPS_DOMAIN,
      ...(SETTLED_ROUTE ? { answerMs: config.readerAnswerMs, stuckMs: config.readerStuckMs } : {}),
      reader: { testHooks: SETTLED_ROUTE, bootWait: SETTLED_ROUTE ? config.readerBootWait : undefined, dbPath: store.path, ...signInKeys, shared: writer?.shared ?? null, embedUrl: EMBED_URL, embedModel: EMBED_MODEL, memorySchemes: MEMORY_SCHEMES ?? null, dataDir: DATA_DIR },
    },
    {
      listening: listened,
      usage: (args) => (store.usage.used as (...a: unknown[]) => void)(...args),
      setting: (key, value) => {
        if (/^plan:\d+:page$/.test(key)) store.setSetting(key, value);
      },
    },
  );
  if (STATICS) throughFront.statics(STATICS);
  // What the minions list, a minion's page and Status show from this thread's memory, for the readers (#1590).
  publishLive({
    publish: throughFront.publish,
    coming: throughFront.coming,
    store,
    runner,
    builds: (id) => builds.get(id),
    ownScheme: () => ownScheme()?.id ?? null,
    previews: !!previews,
    status,
    ships: () => ({ queue: waits.queue, releases: releases.view(() => true) }),
    statusInputs: { bootAt: BOOT_AT, commit: BOOT_COMMIT ?? '', probing: !BOOT_CHECK && !PREVIEW, lastMs: () => answerProbe.lastMs, readerMs: () => answerProbe.readerMs, storms: () => memoryStorms.current(), easing: () => memoryEase.current(), desktops: () => ciLoad.views(), diskUse: (row) => services.diskUse(row) },
    ...(SETTLED_ROUTE && config.readerSweepMs ? { sweepMs: config.readerSweepMs } : {}),
  });
} else if (onSocket) {
  server.listen({ fd: 3 }, () => listened(PORT));
} else {
  server.listen(PORT, HOST, () => listened((server.address() as AddressInfo).port));
}
// Contraption deploys a restart or crash cut short start again (#847), once: cut short twice, they're left for a person.
server.on(
  'listening',
  () =>
    void services.interrupted().then(
      (cut) => {
        for (const d of cut) {
          const row = store.getContraption(d.name);
          if (!row) continue;
          if (d.resumed) {
            console.log(`${d.name}'s deploy was cut short by a restart twice: not starting it again.`);
            // It may have died with the app stopped: start the units back up (a no-op when it runs).
            void services.startAfterCut(row).then(
              (started) => started && console.log(`${d.name}: started its service after the deploy was cut short twice.`),
              (err) => console.error(`Couldn't start ${d.name} after its deploy was cut short twice:`, err.message),
            );
            continue;
          }
          try {
            startDeploy(app, row, d.by, null, d.uid, true, d.to);
            console.log(`${d.name}'s deploy, cut short by the restart, starts again.`);
          } catch (err) {
            console.error(`Couldn't start ${d.name}'s deploy again:`, thrown(err).message);
          }
        }
      },
      (err) => console.error('Reading deploys cut short failed:', err),
    ),
);

// A restart: running turns carry on in their units, and the next server re-attaches. Stop taking
// requests, end the ones that never finish (event streams, approval long-polls, websockets; their
// callers come back), and exit once the rest are answered, a few seconds at most. Requests made
// meanwhile wait in systemd's socket for the next server, so every second spent here is a stall (#493).
const SHUTDOWN_GRACE_MS = 5000;
// Let go of the work a next server picks up: turns, app turns, the usage ledger, a storm going on.
let holdsLifted: Promise<void> = Promise.resolve();
function stopWork() {
  stoppingWork = true;
  containerRelief?.stop();
  services.stopping = true;
  contraptionTurns.stopping = true; // an app turn systemd's SIGTERM cuts off now says Citadel restarted (#1382)
  claudeLink.close(); // before detachAll: a turn's start still in flight must not see its container idle and replace it
  runner.detachAll();
  store.usage.flush();
  memoryStorms.stop(); // records a storm still going, which the next server would otherwise only see from its middle
  memoryEase.stop(); // records a stretch of easing still going
  holdsLifted = growthStop.stop(); // no turn stays held once the server watching it is gone; the exit waits for it
}
// Stop taking requests, end the ones that never finish, and exit once the rest are answered.
function closeDown(why: string) {
  process.once('exit', () => ciLoad.stop()); // at the exit itself, after the last request: writes the runner-load samples it still holds
  // A handover's new server is already listening: pages come back after 0.2 s, not EventSource's 3 s, and hold the chip.
  const last = why === 'Handover' ? `retry: 200\ndata: ${JSON.stringify({ type: 'handover' })}\n\n` : undefined;
  for (const c of clients.keys()) c.end(last);
  agentListener?.close();
  for (const s of upgraded) s.destroy();
  // Every other event stream too (an app's through /apps/, a machine session, a contraption route): none ends by itself, so
  // each held the whole grace (#1578). The exit cuts them anyway; their callers reconnect to the next server.
  for (const [res] of inFlight) if (isEventStream(res)) res.destroy();
  runner.approvals.wakeAll();
  // Nothing exits while a reader thread is still starting: killing one then takes the process down on a signal
  // instead of exiting 0 (src/front.ts, #1625). Capped, so a reader that never starts only slows the restart down:
  // the grace timer below can add one more grace on top of its own, which is the headroom this fix needs and still
  // well inside systemd's default 90 s stop timeout (deploy/claude-coordinator.service sets none).
  const exit = async () => {
    await Promise.race([Promise.all([throughFront?.quiet, holdsLifted]), sleep(SHUTDOWN_GRACE_MS, undefined, { ref: false })]);
    await leaveWithTest?.();
    process.exit(0);
  };
  // Through the front thread (#1563) this thread keeps listening until the front has let go of the port and answered
  // what it took, readers' answers and requests piped here alike.
  void (throughFront?.stop() ?? Promise.resolve()).then(() => {
    server.close(() => void exit());
    // A kept-alive connection (Caddy's, or the front thread's) stays open after answering a request that was running
    // at close(), until its keep-alive timeout: close each one as soon as it goes idle.
    server.closeIdleConnections();
    every('close idle connections', 50, () => server.closeIdleConnections());
  });
  setTimeout(() => {
    server.getConnections((_err, n) => {
      const open = [...inFlight]
        .map(([res, what]) => `${what}${res.headersSent ? ' (answering)' : ''}`)
        .slice(0, 10)
        .join(', ');
      console.log(`${why}: exiting with ${n} connection(s) still open after ${SHUTDOWN_GRACE_MS / 1000} s${open ? `: ${open}` : ''}`);
      void exit();
    });
  }, SHUTDOWN_GRACE_MS).unref();
}
process.on('SIGTERM', () => {
  console.log('SIGTERM: finishing requests, then exiting; running turns carry on.');
  logGhTally('since the last tally');
  stopWork();
  closeDown('SIGTERM');
});
// The machines-only listener, once it is made below: a warm handover lets go of its port for the new server.
let agentListener: Server | null = null;
// Once a handover has let go of this server's work, requests still coming in on connections it already had (Caddy keeps
// them alive) go on to the new server through the socket, which holds them until it listens: this one starts no turn,
// timer or write the new one doesn't know about.
let passingOn = false;
function passOn(req: IncomingMessage, res: ServerResponse) {
  const up = httpRequest({ host: LOCAL_HOST, port: boundPort, method: req.method, path: req.url, headers: req.headers, agent: false }, (answer) => {
    res.writeHead(answer.statusCode ?? 502, answer.headers);
    answer.pipe(res);
  });
  up.on('error', (err) => (res.headersSent ? res.destroy() : json(res, 502, { error: `Citadel is handing over to its new server: ${err.message}` })));
  res.once('close', () => up.destroy());
  req.pipe(up);
}
// A deploy's warm handover (#1170, src/handover.ts): the new code boots beside this server, which lets go once it is
// ready. Its streams stay open until the new one listens, so pages reconnect straight to it, with no "Reconnecting…".
process.on('SIGUSR2', () =>
  handOver(
    {
      quiesce() {
        // Stop accepting; the socket's queue holds what comes in until the new server listens. net's close, not http's: that
        // one also closes "idle" connections, which takes in one just accepted whose request isn't read yet (ECONNRESET).
        if (throughFront)
          throughFront.release(); // the front thread owns the socket; the main thread's own stays open for it
        else NetServer.prototype.close.call(server);
        try {
          markStop({ SERVICE_RESULT: 'handover' }, DATA_DIR);
        } catch (err) {
          console.error('Handover: stop mark failed:', err);
        } // the new server's boot reads it as this server's stop
        passingOn = true;
        agentListener?.close();
        stopAll();
        watchdog?.stop();
        stopWork();
        writer?.drain(5000, 'handover'); // the new server reads what this one last wrote
      },
      finish: () => closeDown('Handover'),
    },
    { schema: SCHEMA_VERSION, onSocket, env: bootEnv },
  ),
);

// A kit/- or tools/-only deploy reaches turns that start from now on; running turns keep the pin they started with (#1416).
// One at a time, so two quick SIGHUPs don't both re-pin; a failure rejects, so the SIGHUP leaves liveCommit alone and deploy.sh restarts.
let repinning: Promise<void> = Promise.resolve();
function repinIfChanged(head: string | null): Promise<void> {
  const next = repinning
    .catch(() => {})
    .then(async () => {
      if (!head || head === pinnedAt) return;
      const changed = await new Promise<boolean>((done) => (!pinnedAt ? done(true) : execFile('git', ['diff', '--name-only', pinnedAt, head, '--', 'kit/', 'tools/'], { cwd: import.meta.dirname }, (err, out) => done(!!err || out.trim() !== ''))));
      if (changed) {
        pinTurnFiles(DATA_DIR); // about 20 ms (measured 2026-11-22): the copies are small, the 7 s stalls were per-turn copies under load
        void fillPinSpares();
        console.log(`Re-pinned turn files on SIGHUP at ${head.slice(0, 9)}`);
      }
      pinnedAt = head;
    });
  return (repinning = next);
}

// A front-end-only deploy: re-read public/ and tell open tabs, which reload once nobody is typing.
process.on('SIGHUP', () => {
  const before = ASSET_VERSION;
  // Re-pin first (#1416): deploy.sh calls a SIGHUP live once health shows the new commit or front end.
  repinIfChanged(checkoutHead())
    .then(loadAssets)
    .then(
      () => {
        console.log(`Reloaded public/ on SIGHUP: front end ${before} → ${ASSET_VERSION}`);
        if (ASSET_VERSION !== before) broadcast({ type: 'hello', version: ASSET_VERSION });
        // tools/deploy.sh sends SIGHUP only for a change to public/, light paths, test/ or (re-pinned) kit/ and tools/, so the checkout's
        // HEAD is now live; deploy.sh waits for /api/health to report it.
        app.liveCommit = checkoutHead();
        if (!BOOT_CHECK) liveOn(app.liveCommit);
        if (!BOOT_CHECK && !PREVIEW && app.liveCommit) recordLive(store, app.liveCommit, Date.now());
      },
      (err) => console.error('Reloading on SIGHUP failed (re-pinning turn files or public/); still serving the old commit, so deploy.sh restarts:', err),
    );
});

// The machines-only listener: every agent route (connect, send, info, upload) and the agents' scripts, nothing else.
if (MACHINES_URL) {
  const agentApi = router(agentRoutes);
  const agents = createServer((req, res) =>
    writes.request.run({ seq: 0 }, async () => {
      try {
        const url = requestUrl(req);
        if (agentApi.knows(url.pathname)) await agentApi(app, req, res, url, null);
        else if ((url.pathname === '/machine-agent.mjs' || url.pathname === '/runner-agent.mjs') && req.method === 'GET') await serveStatic(req, res, url.pathname);
        else if (SETUP_PATH.test(url.pathname) && req.method === 'GET') await serveRunnerFile(res, url.pathname);
        else throw new HttpError(404, 'Not found');
      } catch (err) {
        const status = err instanceof HttpError ? err.status : 500;
        if (status === 500) console.error(err);
        // An HttpError's words were written for the caller, a 500 too; only an unexpected throw stays vague.
        if (!res.headersSent) json(res, status, { error: err instanceof HttpError ? err.message : 'Internal error' });
        else res.end();
      }
    }),
  );
  const port = Number(MACHINES_URL.port || 80);
  // The tailnet address may not be up yet at boot; keep trying rather than keep the app from starting.
  agentListener = agents;
  const listen = () => agents.listen(port, MACHINES_URL.hostname);
  agents.on('listening', () => console.log(`Machines connect at ${MACHINES_URL.origin}`));
  agents.on('error', (err) => {
    console.error(`Machines listener on ${MACHINES_URL.host}: ${err.message}; retrying in 30s`);
    setTimeout(listen, 30_000).unref();
  });
  listen();
}
