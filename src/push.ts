// Web Push: notifications that reach people's devices with the app closed. Claude only speaks up
// for decisions, blockers and results (see notificationFor), never for every reply.
// Everything is node:crypto: VAPID (RFC 8292) signs who is sending, and aes128gcm (RFC 8291)
// encrypts the payload so the push service can't read it.
import { createECDH, createPrivateKey, generateKeyPairSync, hkdfSync, randomBytes, sign, createCipheriv, type KeyObject } from 'node:crypto';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Store, PushSubscriptionRow, Ticket } from './db.ts';

/** The app's VAPID key pair: the public key as browsers want it (raw P-256 point, base64url). */
export interface VapidKeys {
  publicKey: string;
  privateKey: KeyObject;
}

/** What a browser hands over when it subscribes (PushSubscription.toJSON()). */
export interface PushSubscriptionJson {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** What the service worker shows. */
export interface PushMessage {
  title: string;
  body: string;
  /** One notification per thread: a newer one replaces the last. */
  tag: string;
  /** Where clicking it opens the app. */
  url: string;
  /** Replace the last one without ringing again: news that something is over, not a new problem (#532). */
  silent?: boolean;
}

/** `eventId`: the chat event the notification is about, which clicking it scrolls to (#236). */
export type PushTrigger =
  | { kind: 'question'; questions: { question: string }[]; eventId?: number; to?: string }
  | { kind: 'plan'; summary: string; eventId?: number; to?: string }
  | { kind: 'error'; text: string; eventId?: number }
  /** A running turn passed a spend stage (#723); `also` is the turn's person, who hears it on top of the usual people. */
  | { kind: 'spend'; text: string; eventId?: number; also?: string }
  | { kind: 'state'; state: string | null; note: string | null }
  /** A person @mentioned `to` in a message (#1149): theirs alone, as a card addressed to them is. */
  | { kind: 'mention'; by: string; text: string; eventId: number; to: string };

/** States worth a ping: a result to look at, or a blocker. */
export const NOTIFY_STATES: Record<string, string> = {
  ready: 'Ready to ship',
  complete: 'Done, read it',
  try: 'Ready to try',
  blocked: 'Blocked on something outside the minion',
};

const KEY_FILE = 'vapid.json';
const RECORD_SIZE = 4096;
// Long enough to reach a phone that was off overnight; older news isn't worth a buzz.
const TTL_SECONDS = 24 * 3600;
const MAX_BODY = 300;

/**
 * The app's VAPID keys, made on first start and kept in the data dir (mode 600), never in the
 * repo. A new key pair would orphan every subscription, so the file is only ever written once.
 */
export function loadVapidKeys(dataDir: string): VapidKeys {
  const file = join(dataDir, KEY_FILE);
  let jwk: any;
  try {
    jwk = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err: any) {
    if (err.code !== 'ENOENT') throw err;
    jwk = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'jwk' });
    writeFileSync(file, JSON.stringify(jwk), { mode: 0o600, flag: 'wx' });
  }
  chmodSync(file, 0o600);
  const privateKey = createPrivateKey({ key: jwk, format: 'jwk' });
  const publicKey = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]).toString('base64url');
  return { publicKey, privateKey };
}

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');

/** A VAPID JWT (ES256) for one push service: `aud` is its origin, valid for 12 hours. */
export function vapidJwt(audience: string, subject: string, key: KeyObject, now = Date.now()): string {
  const input = `${b64({ typ: 'JWT', alg: 'ES256' })}.${b64({ aud: audience, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject })}`;
  // JWS wants the raw r||s signature, not DER.
  const sig = sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' });
  return `${input}.${sig.toString('base64url')}`;
}

/**
 * Encrypt a payload for one subscription (RFC 8291, aes128gcm, a single record). `salt` and
 * `serverPrivateKey` are random for each message; tests pass the RFC's to check the output.
 */
export function encryptPayload(
  payload: Buffer,
  uaPublicB64: string,
  authB64: string,
  salt = randomBytes(16),
  serverPrivateKey?: Buffer,
): Buffer {
  const uaPublic = Buffer.from(uaPublicB64, 'base64url');
  const authSecret = Buffer.from(authB64, 'base64url');
  if (uaPublic.length !== 65 || uaPublic[0] !== 4) throw new Error('p256dh must be an uncompressed P-256 point');
  if (authSecret.length !== 16) throw new Error('auth must be 16 bytes');
  const ecdh = createECDH('prime256v1');
  if (serverPrivateKey) ecdh.setPrivateKey(serverPrivateKey);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);
  // Mix in the browser's auth secret and both public keys, then derive the content key and nonce.
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', shared, authSecret, keyInfo, 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  if (payload.length + 1 + 16 > RECORD_SIZE) throw new Error('Push payload too large');
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  // 0x02 marks the last (here, only) record; no padding.
  const body = Buffer.concat([cipher.update(Buffer.concat([payload, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header[20] = asPublic.length;
  return Buffer.concat([header, asPublic, body]);
}

function clip(s: string, max = MAX_BODY): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * The notification for something that happened in a thread, or null if it isn't worth one:
 * a question card, a turn that failed, a mention, or a state of ready, complete, try or blocked. Replies alone never are.
 */
export function notificationFor(ticket: Ticket, trigger: PushTrigger, projectName = ''): PushMessage | null {
  let body: string;
  if (trigger.kind === 'question') {
    const [first, ...rest] = trigger.questions;
    if (!first) return null;
    body = clip(first.question) + (rest.length ? ` (+${rest.length} more)` : '');
  } else if (trigger.kind === 'plan') {
    body = clip(`Plan to approve: ${trigger.summary}`);
  } else if (trigger.kind === 'error') {
    body = clip(`Turn failed: ${trigger.text.split('\n')[0]}`);
  } else if (trigger.kind === 'spend') {
    body = clip(trigger.text);
  } else if (trigger.kind === 'mention') {
    body = clip(`${trigger.by}: ${trigger.text}`);
  } else {
    if (!trigger.state || !NOTIFY_STATES[trigger.state]) return null;
    body = clip(trigger.note || NOTIFY_STATES[trigger.state]);
  }
  const coordinator = ticket.kind === 'coordinator';
  // The chat opens at what it's about: the card or error, or for a state the minion's latest reply (public/base.js jumpHref).
  const jump = trigger.kind === 'state' ? 'latest' : trigger.eventId;
  return {
    title: coordinator ? `${projectName ? `${projectName} ` : ''}Taskmaster` : `#${ticket.number ?? ticket.id} ${ticket.title}`,
    body,
    tag: `thread-${ticket.id}`,
    url: `${coordinator || ticket.number == null ? `/c/#/p/${ticket.project_id}` : `/c/#/p/${ticket.project_id}/t/${ticket.number}`}${jump ? `?e=${jump}` : ''}`,
  };
}

/**
 * A desktop app's device (#1186): Electron has no Web Push, so its pings go down the page's own live stream
 * (Pusher.local) while the app runs. Stored like a subscription, `desktop:<uuid>`, so it keeps the same per-device settings.
 */
export const DESKTOP = 'desktop:';
export const desktopId = (raw: unknown) => typeof raw === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(raw) ? raw : null;

/** Is this a subscription worth storing: an https push service and well-formed keys? */
export function validSubscription(raw: any): raw is PushSubscriptionJson {
  if (!raw || typeof raw.endpoint !== 'string' || raw.endpoint.length > 2000) return false;
  try {
    if (new URL(raw.endpoint).protocol !== 'https:') return false;
  } catch {
    return false;
  }
  const p256dh = typeof raw.keys?.p256dh === 'string' ? Buffer.from(raw.keys.p256dh, 'base64url') : null;
  const auth = typeof raw.keys?.auth === 'string' ? Buffer.from(raw.keys.auth, 'base64url') : null;
  return p256dh?.length === 65 && p256dh[0] === 4 && auth?.length === 16;
}

export class Pusher {
  private store: Store;
  private keys: VapidKeys;
  private fetch: typeof fetch;
  /** Who the push services can contact about this sender: the app's own address. */
  subject = 'https://localhost';
  /** Hands a desktop app's ping to its open page (server.ts); none open, and it is dropped. */
  local: (sub: PushSubscriptionRow, msg: PushMessage) => void = () => {};

  constructor(store: Store, keys: VapidKeys, fetchFn: typeof fetch = fetch) {
    this.store = store;
    this.keys = keys;
    this.fetch = fetchFn;
  }

  get publicKey(): string {
    return this.keys.publicKey;
  }

  /**
   * Tell the people a ping is for who subscribed, except `except` (the person who caused it), devices that muted the
   * project, people who hid it (#226), and pinned-only devices whose person hasn't pinned this minion (the Taskmaster
   * can't be pinned, so it always gets through). Who it is for: a card's addressee alone (#687); else for a minion with an
   * owner (`assigned`, #690; Cara, 2026-11-14: "Owner only, switch for all"), its owner, whoever pinned it, and devices
   * set to everything in this scheme; else (the Taskmaster, an unassigned minion, an owner gone from the scheme) everyone
   * in it. A spend alert (#723) also reaches the turn's own person. Resolves once every push service has answered.
   */
  async notify(ticket: Ticket, trigger: PushTrigger, except: string | null = null): Promise<void> {
    const project = this.store.getProject(ticket.project_id);
    const msg = notificationFor(ticket, trigger, project?.name);
    if (!msg) return;
    const to = 'to' in trigger && trigger.to ? trigger.to.toLowerCase() : null;
    // A person's own Taskmaster (#919) pings its person, as its cards are in their Needs you alone (src/inbox.ts).
    const mine = ticket.kind === 'coordinator' && ticket.coordinator_of != null ? this.store.getUser(ticket.coordinator_of)?.name : undefined;
    const owner = to ? null : ticket.kind === 'ticket' ? this.owner(ticket) : mine && this.inScheme(mine, ticket.project_id) ? mine.toLowerCase() : null;
    // A mention is said to its person (#1149): it reaches their pinned-only devices too, as a spend alert's person.
    const also = trigger.kind === 'spend' && trigger.also ? trigger.also.toLowerCase() : trigger.kind === 'mention' ? to : null;
    const pinned = (name: string) => this.store.isTicketPinned(name, ticket.id);
    const forThem = (s: PushSubscriptionRow) => to ? s.name.toLowerCase() === to
      : !owner || s.name.toLowerCase() === owner || s.name.toLowerCase() === also || pinned(s.name) || JSON.parse(s.everything).includes(ticket.project_id);
    const subs = this.store.listPushSubscriptions().filter((s) => s.name !== except && forThem(s) && !JSON.parse(s.muted).includes(ticket.project_id)
      && this.inScheme(s.name, ticket.project_id) && (!s.only_pinned || ticket.kind !== 'ticket' || pinned(s.name) || s.name.toLowerCase() === also));
    await Promise.all(subs.map((s) => this.send(s, msg).catch((err) => console.error(`Push to ${s.name} failed:`, err.message))));
  }

  /** Tell every device of the scheme's members (no mute or pin filters: this is about the server, not a minion). */
  async broadcast(projectId: number, msg: PushMessage): Promise<void> {
    const subs = this.store.listPushSubscriptions().filter((s) => this.inScheme(s.name, projectId));
    await Promise.all(subs.map((s) => this.send(s, msg).catch((err) => console.error(`Push to ${s.name} failed:`, err.message))));
  }

  /** A minion's owner's name, lowercased, while they're still in its scheme; null for none, so everyone hears (a missed ping is worse than an extra one). */
  private owner(ticket: Ticket): string | null {
    const raw = String(this.store.props.forTarget('minion', ticket.id).assigned ?? '').trim();
    const name = raw && (this.store.props.personName(raw) ?? raw);
    return name && this.inScheme(name, ticket.project_id) ? name.toLowerCase() : null;
  }

  /**
   * Whether the person a device belongs to (by name) is still here, owns or is a member of the scheme, and hasn't hidden it.
   * Admin reach opens the rest but doesn't push them (#674; Cara, 2026-11-14: "Members only").
   */
  private inScheme(name: string, projectId: number): boolean {
    const user = this.store.findUser('name', name);
    return !!user && !user.disabled_at && this.store.memberSchemes(user.id).has(projectId)
      && !this.store.hiddenProjects(user.id).has(projectId);
  }

  /** Send one message (a desktop app's through its page); a subscription the push service says is gone (404, 410) is deleted. */
  async send(sub: PushSubscriptionRow, msg: PushMessage): Promise<number> {
    if (sub.endpoint.startsWith(DESKTOP)) {
      this.local(sub, msg);
      return 202;
    }
    const res = await postPush(sub, msg, this.keys, this.subject, this.fetch);
    if (res.status === 404 || res.status === 410) this.store.deletePushSubscription(sub.endpoint);
    else if (!res.ok) console.error(`Push service answered ${res.status} for ${sub.name}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
    return res.status;
  }
}

/** Encrypt, sign and POST one message to one subscription. No store: tools/watchdog.ts sends with the server down. */
export function postPush(sub: Pick<PushSubscriptionRow, 'endpoint' | 'p256dh' | 'auth'>, msg: PushMessage, keys: VapidKeys, subject: string, fetchFn: typeof fetch = fetch): Promise<Response> {
  const body = encryptPayload(Buffer.from(JSON.stringify(msg)), sub.p256dh, sub.auth);
  const jwt = vapidJwt(new URL(sub.endpoint).origin, subject, keys.privateKey);
  return fetchFn(sub.endpoint, {
    method: 'POST',
    headers: {
      Authorization: `vapid t=${jwt}, k=${keys.publicKey}`,
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(TTL_SECONDS),
      Urgency: 'high',
      // The push service keeps only the newest undelivered message per topic (thread).
      Topic: msg.tag,
    },
    body,
    signal: AbortSignal.timeout(15_000),
  });
}
