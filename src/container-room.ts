// How much memory each person's container has left (#1982). A container's /proc/meminfo is the whole box's, and it can't
// read its own limit (the memory controller is off in its payload's cgroup), so tools/mem-room there sized test runs and
// heavy jobs by the box: 19,678 MB and 8 test files at once on 2026-11-25, in a container at its 10G. So the server reads
// each container's unit here every 5 s and writes <CITADEL_HEAVY_DIR>/container-room, which every container mounts:
//
//   <inode> <MB> <unit>     a line for each container with a memory limit
//
// The inode is the container's payload cgroup's, which is what `stat /sys/fs/cgroup` gives inside it and nowhere else (the
// host's is the root's, 1), so a container finds its own line without being told its name and a host turn finds none. MB is
// its unit's headroom under the lower of memory.high and memory.max, inactive file cache counted as room: the kernel
// drops that before anything else, as mem-room counts it for citadel-heavy.slice. mem-room treats a file over 60 s old
// (a stopped or stalled server) as no reading. The Taskmasters' containers (#1882) have lines of their own.
import { mkdir, rename, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { hostDir, hostText } from './host-signals.ts';
import { TASKMASTER_SLICE } from './turn-launch.ts';

export const ROOM_EVERY_MS = 5_000;
/** The file's name in citadel-heavy's folder (tools/mem-room reads it). */
export const ROOM_FILE = 'container-room';

export interface ContainerRoom {
  /** The inode of its payload's cgroup: `/sys/fs/cgroup` inside it. */
  ino: string;
  mb: number;
  /** Its unit's name, for a person reading the file. */
  unit: string;
}

const MB = 1024 ** 2;
const CONTAINER = /^citadel-claude-\d+(-tm)?\.service$/;

/** A cgroup file's bytes: Infinity for `max`, NaN for anything else that isn't a number. */
const bytes = (text: string): number => (text.trim() === 'max' ? Infinity : /^\d+$/.test(text.trim()) ? Number(text) : NaN);

/** One container's line; null without a limit, a reading or a payload. Its files one at a time: a thrashing container's can be slow, and each read holds one of the server's 4 file threads. */
async function room(dir: string): Promise<ContainerRoom | null> {
  try {
    const payload = (await hostDir(dir)).find((n) => n.startsWith('libpod-payload-'));
    if (!payload) return null;
    const current = bytes(await hostText(join(dir, 'memory.current')));
    const limit = Math.min(bytes(await hostText(join(dir, 'memory.high'))), bytes(await hostText(join(dir, 'memory.max'))));
    if (!Number.isFinite(current) || !Number.isFinite(limit)) return null;
    const cache = Number((await hostText(join(dir, 'memory.stat')).catch(() => '')).match(/^inactive_file (\d+)$/m)?.[1] ?? 0);
    const used = cache <= current ? current - cache : current; // more cache than use: the two were read apart
    const { ino } = await stat(join(dir, payload), { bigint: true });
    return { ino: String(ino), mb: Math.max(0, Math.floor((limit - used) / MB)), unit: basename(dir) };
  } catch {
    return null; // it stopped meanwhile
  }
}

/** Every container under `slice` (citadel.slice's cgroup dir) with a limit, the Taskmasters' last. */
export async function containerRooms(slice: string): Promise<ContainerRoom[]> {
  const out: ContainerRoom[] = [];
  for (const parent of [slice, join(slice, TASKMASTER_SLICE)])
    for (const name of (await hostDir(parent).catch((): string[] => [])).filter((n) => CONTAINER.test(n)).sort()) {
      const r = await room(join(parent, name));
      if (r) out.push(r);
    }
  return out;
}

/** Writes the file, by a rename so no reader sees half of it. Nothing outside citadel.slice (a dev copy, CI). */
export async function publishRooms(slice: string | null, heavyDir: string): Promise<void> {
  if (!slice) return;
  const rooms = await containerRooms(slice);
  const file = join(heavyDir, ROOM_FILE);
  await mkdir(heavyDir, { recursive: true });
  await writeFile(`${file}.tmp`, rooms.map((r) => `${r.ino} ${r.mb} ${r.unit}\n`).join(''));
  await rename(`${file}.tmp`, file);
}
