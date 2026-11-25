// Speaker avatars in chat (#1976): a person's own switch, off until they turn it on, and their picture, which everyone
// who has the switch on sees. Each is one settings row by person; the pictures are files in <data dir>/avatars/.
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Store } from './db.ts';
import { HttpError } from './http.ts';

export const AVATAR_MAX_BYTES = 256 * 1024;

export const avatarsOnKey = (person: number) => `chat_avatars:${person}`;
/** The saved picture's version (a hash of it, in its URL); no row, no picture. */
export const avatarPicKey = (person: number) => `avatar_pic:${person}`;
// A file per version, so two uploads at once never share one.
const picFile = (dataDir: string, person: number, pic: AvatarPic) => join(dataDir, 'avatars', `${person}-${pic.v}`);

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
  await mkdir(join(dataDir, 'avatars'), { recursive: true });
  await writeFile(picFile(dataDir, person, pic), body);
  const old = store.getSetting<AvatarPic>(avatarPicKey(person));
  store.setSetting(avatarPicKey(person), pic);
  if (old && old.v !== pic.v) await rm(picFile(dataDir, person, old), { force: true });
  return pic;
}

export async function dropAvatar(store: Store, dataDir: string, person: number) {
  const old = store.getSetting<AvatarPic>(avatarPicKey(person));
  if (!old) return;
  store.deleteSetting(avatarPicKey(person));
  await rm(picFile(dataDir, person, old), { force: true });
}

/** The picture's version, type and bytes, or null when there is none. */
export async function readAvatar(store: Store, dataDir: string, person: number) {
  const pic = store.getSetting<AvatarPic>(avatarPicKey(person));
  const body = pic && (await readFile(picFile(dataDir, person, pic)).catch(() => null));
  return pic && body ? { ...pic, body } : null;
}

/** What api/me says: whether this person has avatars on, their own picture, and everyone's by display name (or null). */
export function avatarsView(store: Store, person: number) {
  // The order their hues go by (public/avatars.js): yours first, so it is always the same one, then by id. Disabled
  // people are left out, as /api/people leaves them out.
  const users = store.listUsers().filter((u) => !u.disabled_at);
  const people = Object.fromEntries(
    [...users.filter((u) => u.id === person), ...users.filter((u) => u.id !== person)].map((u) => {
      const pic = store.getSetting<AvatarPic>(avatarPicKey(u.id));
      return [u.name, pic ? `api/people/${u.id}/avatar?v=${pic.v}` : null];
    }),
  );
  return { on: store.getSetting<boolean>(avatarsOnKey(person)) === true, pic: people[store.getUser(person)?.name ?? ''] ?? null, people };
}
