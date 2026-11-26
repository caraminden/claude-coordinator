// Push to contraptions' Android apps (#1138): Citadel is the one sender, through Firebase Cloud Messaging's HTTP v1
// API and one Firebase project for every app. The shared Android shell (kit/android-shell/) registers each phone's
// FCM token at /apps/_citadel/push/<app> (src/apps.ts), and an app's server asks Citadel to notify people with
// POST /api/contraptions/push (src/routes/contraptions.ts). Every message is data-only: the shell builds the
// notification itself from the citadel_* keys, even when the app was killed. (src/push.ts is Web Push for Citadel's
// own pages, a different thing.)
//
// The key is a Firebase service account's JSON file at FCM_KEY_PATH (mode 600), read on the first send that finds
// it, so copying it in needs no restart (replacing one already read does). Its OAuth token comes from a JWT signed
// with node:crypto and is kept until a minute before it ends.
import { createPrivateKey, sign } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ContraptionRow, Store } from './db.ts';
import { HttpError } from './http.ts';

/** Where the service account's key goes; HOME is read when this is called, so a test's HOME moves it. */
export const fcmKeyPath = () => join(homedir(), '.config/citadel-android/fcm-service-account.json');
const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
export const PUSH_MAX_TO = 100;
/** FCM's limit on a data message's keys and values, citadel_* keys included. */
const DATA_MAX_BYTES = 4096;
/** Sends to Firebase at once. */
const PARALLEL = 8;

/** The fields of a Firebase service account key file that signing in uses. */
export interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
  token_uri: string;
}
/** What an app asked to send: a notification (title) and/or silent data. */
export interface PushSend {
  title?: string;
  body?: string;
  open?: string;
  tag?: string;
  data?: Record<string, string>;
}

const optional = (v: unknown, field: string, max: number, min = 0): string | undefined => {
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || v.length < min || v.length > max) throw new HttpError(400, `${field} must be a string of ${min ? `${min} to ` : 'at most '}${max} characters`);
  return v;
};
const reservedKey = (k: string) => k.startsWith('citadel_') || ['from', 'notification', 'message_type'].includes(k) || k.startsWith('google.') || k.startsWith('gcm.');

/**
 * Whether a tap may open `open`: a page under the app's own path, no other app's, and nothing a decoder could turn into
 * one. Only the path is checked for dots, encodings and `//`: a query or fragment may carry any address. The shell's
 * PushMessage.open is the same rule; push-open-cases.txt (kit/android-shell, the Java tests' resources) tests both.
 */
function openOk(app: string, open: string): boolean {
  if (!open.startsWith(`/apps/${app}/`) || /[\\\u0000-\u001f\u007f]/.test(open)) return false;
  return !/\/\/|%2e|%2f|%5c|\/\.\.?(\/|$)/i.test(open.split(/[?#]/, 1)[0]);
}

/** Check a send body from contraption `app`; a broken rule is a 400 naming it. */
export function parsePush(app: string, raw: unknown): { to: string[]; send: PushSend } {
  const b = (raw ?? {}) as Record<string, unknown>;
  const to = typeof b.to === 'string' ? [b.to] : b.to;
  if (!Array.isArray(to) || !to.length || to.length > PUSH_MAX_TO || to.some((l) => typeof l !== 'string' || !l || l.length > 200)) {
    throw new HttpError(400, `to must be a login, or a list of 1 to ${PUSH_MAX_TO} logins`);
  }
  const send: PushSend = {
    title: optional(b.title, 'title', 200, 1),
    body: optional(b.body, 'body', 2000),
    open: optional(b.open, 'open', 1000),
    tag: optional(b.tag, 'tag', 100),
  };
  if (send.title === undefined && (send.body !== undefined || send.open !== undefined || send.tag !== undefined)) throw new HttpError(400, 'body, open and tag go with a title');
  if (send.open !== undefined && !openOk(app, send.open)) throw new HttpError(400, `open must be a path under /apps/${app}/`);
  if (b.data !== undefined) {
    if (!b.data || typeof b.data !== 'object' || Array.isArray(b.data)) throw new HttpError(400, 'data must be an object of string values');
    for (const [k, v] of Object.entries(b.data)) {
      if (typeof v !== 'string') throw new HttpError(400, `data.${k} must be a string`);
      if (!k || reservedKey(k)) throw new HttpError(400, `data key "${k}" is reserved: citadel_*, from, notification, message_type, google.* and gcm.* are not the app's`);
    }
    if (Object.keys(b.data).length) send.data = b.data as Record<string, string>; // each value checked just above
  }
  if (send.title === undefined && !send.data) throw new HttpError(400, 'Send a title or data (or both)');
  // The whole data block, Citadel's keys too, has to fit Firebase's 4 KB.
  const data = fcmMessage(app, '', send).message.data;
  const bytes = Object.entries(data).reduce((n, [k, v]) => n + Buffer.byteLength(k) + Buffer.byteLength(v), 0);
  if (bytes > DATA_MAX_BYTES) throw new HttpError(400, `data, title, body, open and tag come to ${bytes} bytes; Firebase takes at most ${DATA_MAX_BYTES} (4 KB)`);
  return { to: [...new Set(to as string[])], send };
}

/** The FCM HTTP v1 message for one phone: data-only, all strings; citadel_title marks one the shell shows. */
export function fcmMessage(app: string, token: string, p: PushSend) {
  const data: Record<string, string> = { ...p.data };
  if (p.title !== undefined) {
    data.citadel_title = p.title;
    data.citadel_body = p.body ?? '';
    if (p.open !== undefined) data.citadel_open = p.open;
    if (p.tag !== undefined) data.citadel_tag = p.tag;
  }
  data.citadel_app = app;
  return { message: { token, android: { priority: 'HIGH' as const }, data } };
}

/** Firebase's error answer, the fields read here. */
interface FcmError {
  error?: { status?: string; message?: string; details?: ({ errorCode?: string; fieldViolations?: ({ field?: string } | null)[] } | null)[] };
}

/** Whether Firebase's answer says the token is dead: unregistered (404), or a 400 about the token itself. */
function deadToken(status: number, body: FcmError | null): boolean {
  const e = body?.error ?? {};
  const details = Array.isArray(e.details) ? e.details : [];
  if (status === 404 || details.some((d) => d?.errorCode === 'UNREGISTERED')) return true;
  if (status !== 400 || e.status !== 'INVALID_ARGUMENT') return false;
  return details.some((d) => d?.fieldViolations?.some?.((f) => f?.field === 'message.token')) || /registration token/i.test(String(e.message ?? ''));
}

export class Fcm {
  readonly path: string;
  private api: string;
  private fetch: typeof fetch;
  private clock: () => number;
  private loaded: ServiceAccount | null = null;
  private access: { token: string; until: number } | null = null;
  private pending: Promise<string> | null = null;

  /** `api` and `fetch` are for tests: Google is never called from one. */
  constructor(path: string, opts: { api?: string; fetch?: typeof fetch; clock?: () => number } = {}) {
    this.path = path;
    this.api = opts.api ?? 'https://fcm.googleapis.com';
    this.fetch = opts.fetch ?? fetch;
    this.clock = opts.clock ?? Date.now;
  }

  /** The service account, read once it exists; a 503 naming the file when it's missing or isn't one. */
  async account(): Promise<ServiceAccount> {
    if (this.loaded) return this.loaded;
    if (
      !(await access(this.path).then(
        () => true,
        () => false,
      ))
    )
      throw new HttpError(503, `Push to phones isn't set up on this Citadel: its Firebase service account key goes at ${this.path} (mode 600)`);
    let a: ServiceAccount & { type?: string };
    try {
      a = JSON.parse(await readFile(this.path, 'utf8'));
      const ok = (s: unknown) => typeof s === 'string' && s.length > 0;
      if (a.type !== 'service_account' || !ok(a.project_id) || !ok(a.client_email) || !ok(a.private_key) || !/^https?:\/\//.test(a.token_uri ?? '')) throw new Error();
      createPrivateKey(a.private_key);
    } catch {
      throw new HttpError(503, `${this.path} is not a Firebase service account key, so push to phones is off`);
    }
    return (this.loaded = a);
  }

  /** An OAuth access token for FCM, cached until a minute before it ends; one sign-in at a time. */
  accessToken(): Promise<string> {
    if (this.access && this.access.until > this.clock()) return Promise.resolve(this.access.token);
    this.pending ??= (async () => {
      try {
        const a = await this.account();
        const part = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
        const iat = Math.floor(this.clock() / 1000);
        const unsigned = `${part({ alg: 'RS256', typ: 'JWT' })}.${part({ iss: a.client_email, scope: SCOPE, aud: a.token_uri, iat, exp: iat + 3600 })}`;
        const assertion = `${unsigned}.${sign('sha256', Buffer.from(unsigned), a.private_key).toString('base64url')}`;
        const res = await this.fetch(a.token_uri, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
          redirect: 'manual',
          signal: AbortSignal.timeout(15_000),
        });
        const j = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number };
        if (!res.ok || !j.access_token) throw new HttpError(502, `Firebase sign-in answered ${res.status}`);
        this.access = { token: j.access_token, until: this.clock() + ((j.expires_in ?? 3600) - 60) * 1000 };
        return j.access_token;
      } catch (err) {
        throw err instanceof HttpError ? err : new HttpError(502, "Firebase sign-in isn't answering");
      } finally {
        this.pending = null;
      }
    })();
    return this.pending;
  }

  /** Send one message (fcmMessage's); 'gone' means the token is dead and its row should go. */
  async send(token: string, message: ReturnType<typeof fcmMessage>): Promise<'sent' | 'gone' | 'failed'> {
    const at = await this.accessToken();
    try {
      const res = await this.fetch(`${this.api}/v1/projects/${encodeURIComponent((await this.account()).project_id)}/messages:send`, {
        method: 'POST',
        headers: { authorization: `Bearer ${at}`, 'content-type': 'application/json' },
        body: JSON.stringify(message),
        redirect: 'manual',
        signal: AbortSignal.timeout(15_000),
      });
      if (res.ok) return (void (await res.body?.cancel()), 'sent');
      const body = (await res.json().catch(() => null)) as FcmError | null;
      if (res.status === 401) this.access = null;
      if (deadToken(res.status, body)) return 'gone';
      console.error(`FCM send for ${message.message.data.citadel_app} failed: ${res.status} ${body?.error?.status ?? ''}`.trim());
      return 'failed';
    } catch (err) {
      console.error(`FCM send for ${message.message.data.citadel_app} failed: ${(err as Error).name}`);
      return 'failed';
    }
  }
}

export interface PushReply {
  devices: number;
  sent: number;
  dropped: number;
  skipped: string[];
}

/**
 * POST /api/contraptions/push for contraption `c`: to the phones of the named people it is enabled for now. An unknown
 * or not-enabled login is skipped; a dead token's row is deleted (dropped); other failures are logged and kept.
 */
export async function pushToPeople(store: Store, enabled: (name: string, uid: number) => boolean, fcm: Fcm, c: ContraptionRow, body: unknown): Promise<PushReply> {
  const { to, send } = parsePush(c.name, body);
  await fcm.account(); // not set up: 503 before anything else
  const skipped: string[] = [];
  const uids: number[] = [];
  for (const login of to) {
    const u = store.findUser('login', login);
    if (u && enabled(c.name, u.id)) uids.push(u.id);
    else skipped.push(login);
  }
  const tokens = store.pushDevices(c.id, uids);
  if (tokens.length) await fcm.accessToken(); // a refused sign-in is the call's error, not every phone's
  const reply: PushReply = { devices: tokens.length, sent: 0, dropped: 0, skipped };
  const queue = [...tokens];
  await Promise.all(
    Array.from({ length: Math.min(PARALLEL, queue.length) }, async () => {
      for (let t = queue.shift(); t !== undefined; t = queue.shift()) {
        const r = await fcm.send(t, fcmMessage(c.name, t, send));
        if (r === 'sent') reply.sent++;
        else if (r === 'gone') {
          reply.dropped++;
          await store.deletePushDevice(t);
        }
      }
    }),
  );
  return reply;
}
