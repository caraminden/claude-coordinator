// Host reach (Build 7 T8; Cara, 2026-11-25: "Chosen folders + programs", "Programs I list"; Josh: "owner's turns only").
// A minion marked to run on a machine (src/runs-on.ts), on a turn of that machine's owner, reaches that PC: the folders
// its owner listed, at /host/<name> in its own container there (public/machine-worker.mjs boxOf, public/worker-agent.mjs
// hostFolders), and the programs its owner listed, started through the PC's agent (`run_on_host`, public/machine-agent.mjs
// loadPrograms). Every other turn, and every turn on perigee, stays sealed off. Both lists live on that PC, in files only
// its owner changes: Citadel shows them and never sends one.
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Mark } from './runs-on.ts';

/** A program's name as an owner lists it, and run_on_host takes it. */
export const PROGRAM_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/;
/** How long a start waits for the agent's word. */
export const START_MS = 30_000;
/** The most arguments, and the longest one, a start passes. */
export const ARGS_MAX = 20;
export const ARG_LEN = 1000;

/** Whether a turn reaches its machine's host: the minion is marked for that machine and the turn is its owner's. */
export function hostReach(mark: Pick<Mark, 'machine' | 'once'> | null, machine: { id: number; owner_id: number | null } | null, person: number | null): boolean {
  return !!mark && !!machine && mark.machine === machine.id && !mark.once && machine.owner_id !== null && person === machine.owner_id;
}

/** A program as the PC's agent lists it (public/machine-agent.mjs programs), for the Machines row. */
export interface HostProgram {
  name: string;
  path: string;
  about: string;
  args: boolean;
}

/** The agent's list as it sent it, checked: names and paths only, at most 40. */
export function cleanPrograms(v: unknown): HostProgram[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((p): p is Record<string, unknown> => !!p && typeof p === 'object' && typeof (p as Record<string, unknown>).name === 'string' && PROGRAM_NAME.test((p as Record<string, unknown>).name as string) && typeof (p as Record<string, unknown>).path === 'string')
    .slice(0, 40)
    .map((p) => ({ name: p.name as string, path: (p.path as string).slice(0, 500), about: typeof p.about === 'string' ? p.about.slice(0, 300) : '', args: p.args === true }));
}

/** A folder as the worker lists it (public/worker-agent.mjs hostFolders), for the Machines row. */
export interface HostFolder {
  name: string;
  path: string;
  write: boolean;
  /** Mounted in that PC's worker distro now: only then does a turn get it. */
  ready: boolean;
}

export function cleanFolders(v: unknown): HostFolder[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((f): f is Record<string, unknown> => !!f && typeof f === 'object' && typeof (f as Record<string, unknown>).name === 'string' && /^[a-z0-9][a-z0-9_-]{0,39}$/.test((f as Record<string, unknown>).name as string) && typeof (f as Record<string, unknown>).path === 'string')
    .slice(0, 20)
    .map((f) => ({ name: f.name as string, path: (f.path as string).slice(0, 500), write: f.write === true, ready: f.ready === true }));
}

/** The chat line for a program a turn started. */
export const startedLine = (program: string, machine: string, args: string[]) => `Started ${program}${args.length ? ` ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}` : ''} on ${machine}.`;

/** The one line a host turn's end adds (from host-writes.json, public/machine-worker.mjs countWrites), or null when it wrote nothing. */
export async function writesLine(dir: string, machine: string): Promise<string | null> {
  let got: { folders?: { name?: unknown; files?: unknown; more?: unknown }[]; error?: unknown };
  try {
    got = JSON.parse(await readFile(join(dir, 'host-writes.json'), 'utf8'));
  } catch {
    return null;
  }
  const folders = (Array.isArray(got.folders) ? got.folders : []).filter((f) => typeof f?.name === 'string' && typeof f.files === 'number' && f.files > 0);
  const error = typeof got.error === 'string' ? got.error.slice(0, 200) : null;
  if (!folders.length) return error ? `This turn's writes to ${machine}'s folders couldn't be counted: ${error}.` : null;
  const each = folders.map((f) => `/host/${f.name} (${f.more ? 'more than ' : ''}${f.files} file${f.files === 1 ? '' : 's'})`);
  return `This turn wrote to ${machine}'s folders: ${each.join(', ')}.${error ? ` Not all could be counted: ${error}.` : ''} Citadel can't roll those back.`;
}

/** What run_on_host gets from the agent. */
export type StartAnswer = { ok: true; pid: number | null } | { ok: false; error: string };

/**
 * Starts sent to machines' agents and waiting for their word, by id. The agent checks the program against its owner's
 * list itself: Citadel sends a name and arguments, never a path or a command.
 */
export class HostStarts {
  private waiting = new Map<string, { machineId: number; done: (a: StartAnswer) => void; timer: NodeJS.Timeout }>();

  private send: (machineId: number, msg: { id: string; program: string; args: string[] }) => boolean;
  private ms: number;

  constructor(send: (machineId: number, msg: { id: string; program: string; args: string[] }) => boolean, ms = START_MS) {
    this.send = send;
    this.ms = ms;
  }

  start(machineId: number, program: string, args: string[]): Promise<StartAnswer> {
    if (!PROGRAM_NAME.test(program)) return Promise.resolve({ ok: false, error: `"${program}" isn't a program name` });
    if (args.length > ARGS_MAX || args.some((a) => typeof a !== 'string' || a.length > ARG_LEN || a.includes('\0'))) return Promise.resolve({ ok: false, error: `at most ${ARGS_MAX} arguments, each text under ${ARG_LEN} characters` });
    const id = randomBytes(8).toString('hex');
    return new Promise((done) => {
      const timer = setTimeout(() => this.settle(id, { ok: false, error: "the machine's agent didn't answer within 30 seconds; the program may or may not have started" }), this.ms);
      timer.unref?.();
      this.waiting.set(id, { machineId, done, timer });
      if (!this.send(machineId, { id, program, args })) this.settle(id, { ok: false, error: "the machine's agent isn't connected" });
    });
  }

  /** The agent's word on a start (POST /api/machines/host-started); false when it isn't one this machine was sent. */
  answer(machineId: number, body: Record<string, unknown>): boolean {
    const id = typeof body.id === 'string' ? body.id : '';
    if (this.waiting.get(id)?.machineId !== machineId) return false;
    this.settle(id, body.ok === true ? { ok: true, pid: typeof body.pid === 'number' ? body.pid : null } : { ok: false, error: typeof body.error === 'string' ? body.error.slice(0, 1000) : 'the agent refused it' });
    return true;
  }

  /** Its agent went: what waits on it fails now. */
  dropped(machineId: number) {
    for (const [id, w] of this.waiting) if (w.machineId === machineId) this.settle(id, { ok: false, error: "the machine's agent disconnected" });
  }

  private settle(id: string, a: StartAnswer) {
    const w = this.waiting.get(id);
    if (!w) return;
    this.waiting.delete(id);
    clearTimeout(w.timer);
    w.done(a);
  }
}
