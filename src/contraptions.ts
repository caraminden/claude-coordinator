// Contraptions: personal apps with their own service, UI and data, reached through Citadel and
// AI-helped through Citadel (shared/project/specs/contraptions/citadel-apps-brief.md, section 1).
// This keeps each contraption's keys and the checks the proxy (section 2) and the turn API (section 4)
// build on:
//   - signIdentity(name, person): the X-Citadel-Identity header for a person, signed with its private key
//   - verifyIdentity(header, identity.pub, name): what a contraption does with that header (stubs, tests)
//   - byKey(bearer): the contraption a bearer contraption key belongs to, or null
//   - enabled(name, userId): whether a person may use it, read fresh every call so disabling takes at once
//   - caller(req): the contraption calling one of its own routes ('contraption' in src/http.ts), else a refusal
// Each contraption's key folder, <dir>/<name>/ (0700), holds identity.pub (an Ed25519 public key, PEM
// SPKI) and contraption.key (its bearer key, no trailing newline), both 0600. Citadel keeps the private
// key sealed under SESSION_SECRET in the contraptions row, and only a hash of the bearer key.
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify } from 'node:crypto';
import { homedir } from 'node:os';
import type { IncomingMessage } from 'node:http';
import { connect } from 'node:net';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { appFolder, appRoot, MANIFEST, parseManifest } from './app-services.ts';
import { seal, sealKey, unseal } from './credentials.ts';
import type { ContraptionRow, Store, User } from './db.ts';
import { connection, HttpError } from './http.ts';
import { inOrder } from '../public/reorder.js';

/** Where the live server's key folders go, unless CITADEL_CONTRAPTIONS_DIR says otherwise; another DATA_DIR keeps its own under it. */
export const DEFAULT_CONTRAPTIONS_DIR = join(homedir(), '.config', 'citadel', 'contraptions');

/** A contraption's name: a slug, used in paths and its key folder. */
export const CONTRAPTION_NAME = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
/** Names Citadel's own /api/contraptions/ routes take, so no contraption may have them. */
export const RESERVED = new Set(['mine', 'turns', 'sessions', 'asks', 'relay', 'home', 'minions', 'media', 'openrouter', 'push']);

/** How long a signed identity header holds, in seconds. */
export const IDENTITY_TTL = 60;

/** What an identity header says about the person a request is from. Times in seconds. */
export interface IdentityClaims {
  app: string;
  sub: number;
  login: string;
  name: string;
  iat: number;
  exp: number;
  /** On a relayed call (src/relay.ts): the contraption calling for the person, and its title. */
  from?: string;
  fromTitle?: string;
}

const keyHash = (key: string) => createHash('sha256').update(key).digest('hex');

/** Write a secret file whole (rename into place) and readable only by this account. */
function writeSecret(path: string, text: string) {
  const tmp = `${path}.tmp`;
  rmSync(tmp, { force: true });
  writeFileSync(tmp, text, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

/**
 * Check an X-Citadel-Identity header with a contraption's identity.pub: the claims when it is signed by
 * that key, names `app` and hasn't expired, else null. The signature is over "v1." + the base64url JSON part.
 */
export function verifyIdentity(header: string | null | undefined, publicKeyPem: string, app: string, now = Date.now()): IdentityClaims | null {
  const m = /^v1\.([\w-]+)\.([\w-]+)$/.exec(header ?? '');
  if (!m) return null;
  try {
    if (!verify(null, Buffer.from(`v1.${m[1]}`), createPublicKey(publicKeyPem), Buffer.from(m[2], 'base64url'))) return null;
    const claims = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8')) as IdentityClaims;
    return claims.app === app && typeof claims.exp === 'number' && claims.exp * 1000 > now ? claims : null;
  } catch {
    return null;
  }
}

export class Contraptions {
  private store: Store;
  private key: Buffer;
  /** The root the key folders go in. */
  readonly dir: string;

  constructor(store: Store, sessionSecret: string, dir: string) {
    this.store = store;
    this.key = sealKey(sessionSecret, 'citadel contraptions v1');
    this.dir = dir;
  }

  /** A contraption's key folder, which its own service reads. */
  folder(name: string): string {
    if (!CONTRAPTION_NAME.test(name)) throw new Error(`Not a contraption name: ${name}`);
    return join(this.dir, name);
  }

  /** Register a contraption with fresh keys. The key files are written first, so a failed write registers nothing. */
  register(fields: Omit<ContraptionRow, 'id' | 'created_at' | 'identity_public' | 'identity_private' | 'key_hash' | 'keys_at' | 'repo' | 'branch' | 'folder' | 'subdir'> & Partial<Pick<ContraptionRow, 'repo' | 'branch' | 'folder' | 'subdir'>>): ContraptionRow {
    return this.store.createContraption({ ...fields, ...this.newKeys(fields.name) });
  }

  /**
   * New identity key pair and contraption key: both files rewritten, the old ones stop working at once.
   * shortcut: files are written before the row, so a failed database write leaves files the row doesn't match; Rotate again fixes it.
   */
  rotate(name: string) {
    this.store.updateContraption(name, this.newKeys(name));
  }

  private newKeys(name: string) {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const pub = publicKey.export({ type: 'spki', format: 'pem' }) as string;
    const key = `ck_${randomBytes(32).toString('base64url')}`;
    const folder = this.folder(name);
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    chmodSync(folder, 0o700);
    writeSecret(join(folder, 'identity.pub'), pub);
    writeSecret(join(folder, 'contraption.key'), key);
    return {
      identity_public: pub,
      // Bound to its name: a sealed key copied onto another contraption's row doesn't open.
      identity_private: seal(this.key, name, privateKey.export({ type: 'pkcs8', format: 'pem' }) as string),
      key_hash: keyHash(key),
      keys_at: Date.now(),
    };
  }

  /**
   * The X-Citadel-Identity header for a person, or null when there's no such contraption or its key doesn't
   * open (SESSION_SECRET changed: Rotate). `via` names the contraption calling for them through the relay.
   */
  signIdentity(name: string, person: Pick<User, 'id' | 'login' | 'name'>, via?: Pick<ContraptionRow, 'name' | 'title'>, now = Date.now()): string | null {
    const row = this.store.getContraption(name);
    const pem = row && unseal(this.key, name, row.identity_private);
    if (!pem) return null;
    const iat = Math.floor(now / 1000);
    const claims: IdentityClaims = { app: name, sub: person.id, login: person.login, name: person.name, iat, exp: iat + IDENTITY_TTL };
    if (via) Object.assign(claims, { from: via.name, fromTitle: via.title });
    const part = Buffer.from(JSON.stringify(claims)).toString('base64url');
    return `v1.${part}.${sign(null, Buffer.from(`v1.${part}`), createPrivateKey(pem)).toString('base64url')}`;
  }

  /** The contraption a bearer contraption key (from `Authorization: Bearer …`) belongs to, or null. */
  byKey(bearer: string | null | undefined): ContraptionRow | null {
    if (!bearer || !/^ck_[\w-]{43}$/.test(bearer)) return null;
    return this.store.contraptionByKeyHash(keyHash(bearer)) ?? null;
  }

  /**
   * The contraption calling one of its own routes (feature asks, the turn API): only its own server, on
   * this machine, with its contraption key. A request that came through Caddy (it adds X-Forwarded-For),
   * carries a browser's sign-in cookie (cc_session, src/auth.ts) or comes from another address is
   * refused before its key is looked at.
   */
  caller(req: IncomingMessage): ContraptionRow {
    const loopback = /^(127\.|::1$|::ffff:127\.)/.test(connection(req).remote ?? '');
    if (!loopback || req.headers['x-forwarded-for'] !== undefined || req.headers.forwarded !== undefined || /(?:^|;\s*)cc_session=/.test(req.headers.cookie ?? '')) {
      throw new HttpError(403, "Only a contraption's own server may call this, on Citadel's machine, not through the web");
    }
    const c = this.byKey(/^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1]);
    if (!c) throw new HttpError(401, 'Unknown contraption key: send the one in its key folder (contraption.key) as Authorization: Bearer');
    return c;
  }

  /** APPS_DOMAIN (server.ts), set at boot: the address people are shown for an app is https://<name>.<domain>/ (#827); null: /apps/<name>/ here. */
  appsDomain: string | null = null;

  /** The address to show a person for an app: its own host when APPS_DOMAIN is set (the path stays /apps/<name>/ behind it), else null. */
  appUrl(name: string): string | null {
    return this.appsDomain ? `https://${name}.${this.appsDomain}/` : null;
  }

  /** The home folder apps live under (~/apps/<name>, AppServices' home), set at boot. */
  appsHome = homedir();

  /**
   * The contraptions enabled for a person in their rail order, each with whether it is up: the rail's list (GET /api/contraptions/mine).
   * `clipboard: true` when its live citadel-app.json says `"clipboard": "write"`: only its frame may use navigator.clipboard (#1086).
   * `deployed`: when its last deploy went live (ms), so a frame open across a dropped stream still catches up (#1690, frames.js deploysSince).
   */
  mine(uid: number) {
    return Promise.all(
      inOrder(this.store.contraptionsFor(uid), (c: ContraptionRow) => c.name, this.store.listOrder(uid, 'apps')).map(async (c: ContraptionRow) => {
        const deployed = this.store.listContraptionDeploys(c.name, 1, 'deployed')[0]?.finished_at;
        return {
          name: c.name,
          title: c.title,
          icon: c.icon,
          up: await this.up(c),
          ...(this.appsDomain ? { url: this.appUrl(c.name) } : {}),
          ...((await this.clipboard(c)) ? { clipboard: true } : {}),
          ...(deployed ? { deployed } : {}),
        };
      }),
    );
  }

  /** Whether an app's live manifest asks for clipboard writes in its frame; an app with no readable manifest doesn't. */
  async clipboard(row: Pick<ContraptionRow, 'name' | 'folder' | 'subdir'>): Promise<boolean> {
    const text = await readFile(join(appRoot(row, appFolder(row, this.appsHome)), MANIFEST), 'utf8').catch(() => '');
    try {
      // A manifest a deploy would refuse grants nothing.
      return parseManifest(text).clipboard === 'write';
    } catch {
      return false;
    }
  }

  /**
   * Whether a contraption can serve a person right now, for the rail (#257): its key opens (it doesn't in a
   * copy of the database run with another SESSION_SECRET: the boot check, a preview) and its service takes
   * a connection. The rail draws one that can't as a greyed tile, fetching nothing from it.
   */
  async up(row: Pick<ContraptionRow, 'name' | 'port' | 'identity_private'>): Promise<boolean> {
    if (!unseal(this.key, row.name, row.identity_private)) return false;
    return new Promise((ok) => {
      const s = connect({ host: '127.0.0.1', port: row.port, timeout: 500 });
      const done = (v: boolean) => {
        s.destroy();
        ok(v);
      };
      s.once('connect', () => done(true))
        .once('error', () => done(false))
        .once('timeout', () => done(false));
    });
  }

  /** Whether a contraption is enabled for a person (who isn't disabled in Citadel). Being in its home scheme grants nothing. */
  enabled(name: string, userId: number): boolean {
    return this.store.contraptionEnabled(name, userId);
  }
}
