// Speaker avatars in chat (#1976): a person's own switch, off until they turn it on, and their picture, which everyone
// who has the switch on sees. Each is one settings row by person; the pictures are files in <data dir>/avatars/.
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Store } from './db.ts';
import { HttpError } from './http.ts';

export const AVATAR_MAX_BYTES = 256 * 1024;

export const avatarsOnKey = (person: number) => `chat_avatars:${person}`;
/** The saved picture's version (a hash of it, in its URL); no row, no picture. */
export const avatarPicKey = (person: number) => `avatar_pic:${person}`;
const picFile = (dataDir: string, person: number) => join(dataDir, 'avatars', String(person));

export type AvatarPic = { v: string; type: string };

/** The image type its first bytes name: never the sender's word, and never SVG or HTML, which could run script. */
export function imageType(b: Uint8Array): string | null {
  const at = (i: number, s: string) => Buffer.from(b.subarray(i, i + s.length)).toString('latin1') === s;
  if (at(0, '\x89PNG\r\n\x1a\n')) return 'image/png';
  if (at(0, '\xff\xd8\xff')) return 'image/jpeg';
  if (at(0, 'RIFF') && at(8, 'WEBP')) return 'image/webp';
  return null;
}

export async function saveAvatar(store: Store, dataDir: string, person: number, body: Buffer): Promise<AvatarPic> {
  const type = imageType(body);
  if (!type) throw new HttpError(400, 'The picture must be a PNG, JPEG or WebP image');
  const pic = { v: createHash('sha256').update(body).digest('hex').slice(0, 16), type };
  const file = picFile(dataDir, person);
  await mkdir(join(dataDir, 'avatars'), { recursive: true });
  await writeFile(`${file}.new`, body);
  await rename(`${file}.new`, file);
  store.setSetting(avatarPicKey(person), pic);
  return pic;
}

export async function dropAvatar(store: Store, dataDir: string, person: number) {
  store.deleteSetting(avatarPicKey(person));
  await rm(picFile(dataDir, person), { force: true });
}

/** The picture's bytes and type, or null when there is none. */
export async function readAvatar(store: Store, dataDir: string, person: number) {
  const pic = store.getSetting<AvatarPic>(avatarPicKey(person));
  const body = pic && (await readFile(picFile(dataDir, person)).catch(() => null));
  return pic && body ? { type: pic.type, body } : null;
}

/** What api/me says: whether this person has avatars on, their own picture, and everyone's by display name (or null). */
export function avatarsView(store: Store, person: number) {
  // In id order, which is the order their hues go by (public/avatars.js).
  const people: Record<string, string | null> = {};
  for (const u of store.listUsers()) {
    const pic = store.getSetting<AvatarPic>(avatarPicKey(u.id));
    people[u.name] = pic ? `api/people/${u.id}/avatar?v=${pic.v}` : null;
  }
  const name = store.getUser(person)?.name ?? '';
  return { on: store.getSetting<boolean>(avatarsOnKey(person)) === true, pic: people[name] ?? null, people };
}
