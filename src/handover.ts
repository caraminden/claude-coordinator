// The warm handover (#1170; the shared folder's specs/front-door-restarts.md). tools/deploy.sh sends the running server
// SIGUSR2, and it starts the new code beside itself, handing it systemd's held socket (fd 3) and a control pipe (fd 4).
// The copy loads its code and says "ready". The old server stops taking connections, lets go of its turns and timers,
// and says "go". The copy boots the rest, takes the socket, tells systemd it is the main process now (MAINPID=, which
// the unit's NotifyAccess=all accepts from any process in it) and says "live". The old one ends its streams, finishes
// its requests and exits. Requests made during the swap wait in the socket, as they do across a restart.
// Anything going wrong before "go" leaves the old server serving, says why on /api/health, and deploy.sh restarts as
// before. After "go" the old server exits instead, and systemd's Restart=always restarts the service cold.
import { execFile, spawn } from 'node:child_process';
import { Socket } from 'node:net';
import { createInterface } from 'node:readline';

/** In the copy's environment: the old server's SCHEMA_VERSION. Its presence is what makes a server a standby copy. */
const ENV = 'CITADEL_HANDOVER';
/** A copy whose schema differs exits with this: two servers never run different schemas at once. */
export const COLD = 75;

let state = 'ready';
/** For /api/health and deploy.sh: "ready" (this server takes SIGUSR2), "busy", or "refused <epoch ms> <why>". */
export const handoverState = () => state;

type Env = Record<string, string | undefined>;

/**
 * In a copy the old server started: back out if the schemas differ, say "ready" and wait for "go". Null in a server
 * started any other way. Exits if the old server gives up first. `live()` is for once it listens on fd 3.
 */
export async function standby(schema: number, env: Env = process.env, fd = 4): Promise<{ live(): void } | null> {
  const theirs = env[ENV];
  if (theirs === undefined) return null;
  delete env[ENV];
  const notifySocket = env.NOTIFY_SOCKET; // sd-watchdog.ts takes it out of env at boot
  if (Number(theirs) !== schema) {
    console.log(`Handover: the running server's schema is ${theirs} and this code's is ${schema}, so the deploy restarts instead.`);
    process.exit(COLD);
  }
  const ctl = new Socket({ fd, readable: true, writable: true });
  ctl.on('error', () => {});
  const gone = () => process.exit(0);
  ctl.on('close', gone);
  await new Promise<void>((go) => {
    createInterface({ input: ctl }).on('line', (line) => line === 'go' && go());
    ctl.write('ready\n');
  });
  ctl.off('close', gone);
  ctl.unref();
  return {
    live() {
      execFile('systemd-notify', [`MAINPID=${process.pid}`], { env: { ...process.env, NOTIFY_SOCKET: notifySocket }, timeout: 10_000 }, (err) => {
        // Without MAINPID systemd would take the old server's exit for the service's: it exits on the pipe's close
        // with no "live", and the restart that follows is cold.
        if (err || !notifySocket) console.error(`Handover: couldn't tell systemd this is the main process (${err?.message ?? 'no NOTIFY_SOCKET'}).`);
        else ctl.write('live\n');
        ctl.end();
      });
    },
  };
}

export type HandOverHooks = {
  /** The copy is ready: stop taking connections, stop the timers, let go of the turns and flush. */
  quiesce(): void;
  /** The copy is live: end the streams, finish the requests, exit. */
  finish(): void;
};

/**
 * The old server's side, on SIGUSR2. `env` is the environment this server started with: by now the server has taken
 * its secrets and systemd's watchdog variables out of process.env, and the copy needs them. Tests set `argv` (the
 * copy's script and arguments; this server's own by default) and `socketFd`.
 */
export function handOver(hooks: HandOverHooks, { schema, onSocket, env, argv = process.argv.slice(1), socketFd = 3, readyMs = 90_000, liveMs = 60_000, log = console.log }: {
  schema: number; onSocket: boolean; env: Env; argv?: string[]; socketFd?: number; readyMs?: number; liveMs?: number; log?: (line: string) => void;
}): void {
  if (state === 'busy') return log('Handover: one is already under way.');
  let stage: 'booting' | 'go' | 'live' | 'refused' = 'booting';
  const refuse = (why: string) => {
    stage = 'refused';
    state = `refused ${Date.now()} ${why}`;
    log(`Handover refused: ${why}. This server keeps serving; the deploy restarts instead.`);
  };
  if (!onSocket) return refuse("this server isn't on systemd's socket");
  state = 'busy';
  log('Handover: starting the new server beside this one.');
  const child = spawn(process.execPath, [...process.execArgv, ...argv], {
    argv0: 'citadel-server', // ananicy's rules go by it (#326)
    stdio: ['ignore', 'inherit', 'inherit', socketFd, 'pipe'],
    env: { ...env, WATCHDOG_PID: undefined, LISTEN_PID: undefined, LISTEN_FDS: undefined, LISTEN_FDNAMES: undefined, [ENV]: String(schema) },
  });
  const ctl = child.stdio[4] as Socket;
  ctl.on('error', () => {});
  const failAfterGo = (why: string) => {
    log(`Handover: ${why} after go; exiting, so systemd restarts the service.`);
    process.exit(1);
  };
  let timer = setTimeout(() => {
    child.kill('SIGKILL');
    refuse(`the new server wasn't ready in ${readyMs / 1000} s`);
  }, readyMs);
  createInterface({ input: ctl }).on('line', (line) => {
    if (line === 'ready' && stage === 'booting') {
      clearTimeout(timer);
      stage = 'go';
      log(`Handover: the new server (pid ${child.pid}) is ready; handing it the socket.`);
      try {
        hooks.quiesce();
      } catch (err) {
        console.error('Handover: letting go of this server\'s work threw; going on:', err);
      }
      ctl.write('go\n');
      timer = setTimeout(() => (child.kill('SIGKILL'), failAfterGo(`the new server wasn't live in ${liveMs / 1000} s`)), liveMs);
    } else if (line === 'live' && stage === 'go') {
      clearTimeout(timer);
      stage = 'live';
      log(`Handover: pid ${child.pid} is the server now; finishing this one's requests.`);
      hooks.finish();
    }
  });
  child.on('error', (err) => {
    if (stage !== 'booting') return;
    clearTimeout(timer);
    refuse(`couldn't start the new server: ${err.message}`);
  });
  child.on('exit', (code, signal) => {
    if (stage === 'booting') {
      clearTimeout(timer);
      refuse(code === COLD ? 'the new code changes the database schema' : `the new server exited (${code ?? signal}) before it was ready`);
    } else if (stage === 'go') failAfterGo(`the new server exited (${code ?? signal})`);
  });
  // A copy that took over but couldn't tell systemd closes the pipe with no "live".
  ctl.on('close', () => stage === 'go' && failAfterGo('the new server closed the pipe without going live'));
}
