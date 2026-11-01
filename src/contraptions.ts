// Contraptions: personal apps with their own service, UI and data, reached through Citadel and
// AI-helped through Citadel (shared/project/specs/contraptions/citadel-apps-brief.md, section 1).
// This keeps each contraption's keys and the checks the proxy (section 2) and the turn API (section 4)
// build on:
//   - signIdentity(name, person): the X-Citadel-Identity header for a person, signed with its private key
//   - verifyIdentity(header, identity.pub, name): what a contraption does with that header (stubs, tests)
//   - byKey(bearer): the contraption a bearer contraption key belongs to, or null
//   - enabled(name, userId): whether a person may use it, read fresh every call so disabling takes at once
// Each contraption's key folder, <dir>/<name>/ (0700), holds identity.pub (an Ed25519 public key, PEM
// SPKI) and contraption.key (its bearer key, no trailing newline), both 0600. Citadel keeps the private
// key sealed under SESSION_SECRET in the contraptions row, and only a hash of the bearer key.
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { seal, sealKey, unseal } from './credentials.ts';
import type { ContraptionRow, Store, User } from './db.ts';

/** Where the live server's key folders go, unless CITADEL_CONTRAPTIONS_DIR says otherwise; another DATA_DIR keeps its own under it. */
export const DEFAULT_CONTRAPTIONS_DIR = join(homedir(), '.config', 'citadel', 'contraptions');

/** A contraption's name: a slug, used in paths and its key folder. */
export const CONTRAPTION_NAME = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

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
  register(fields: Omit<ContraptionRow, 'id' | 'created_at' | 'identity_public' | 'identity_private' | 'key_hash' | 'keys_at'>): ContraptionRow {
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

  /** The X-Citadel-Identity header for a person, or null when there's no such contraption or its key doesn't open (SESSION_SECRET changed: Rotate). */
  signIdentity(name: string, person: Pick<User, 'id' | 'login' | 'name'>, now = Date.now()): string | null {
    const row = this.store.getContraption(name);
    const pem = row && unseal(this.key, name, row.identity_private);
    if (!pem) return null;
    const iat = Math.floor(now / 1000);
    const claims: IdentityClaims = { app: name, sub: person.id, login: person.login, name: person.name, iat, exp: iat + IDENTITY_TTL };
    const part = Buffer.from(JSON.stringify(claims)).toString('base64url');
    return `v1.${part}.${sign(null, Buffer.from(`v1.${part}`), createPrivateKey(pem)).toString('base64url')}`;
  }

  /** The contraption a bearer contraption key (from `Authorization: Bearer …`) belongs to, or null. */
  byKey(bearer: string | null | undefined): ContraptionRow | null {
    if (!bearer || !/^ck_[\w-]{43}$/.test(bearer)) return null;
    return this.store.contraptionByKeyHash(keyHash(bearer)) ?? null;
  }

  /** Whether a contraption is enabled for a person (who isn't disabled in Citadel). Being in its home scheme grants nothing. */
  enabled(name: string, userId: number): boolean {
    return this.store.contraptionEnabled(name, userId);
  }
}
