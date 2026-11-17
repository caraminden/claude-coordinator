// Secrets people save (#838): a password or key typed into a secret card's masked field, or saved in Settings, goes
// here and nowhere else: never into a chat, an event, a turn's prompt or a log. A person's own are theirs; a
// scheme's are its members'. A turn gets them as CITADEL_SECRET_<NAME> env vars (the scheme's, then the turn
// person's own over them), its output has their values hidden, and a contraption reads one by name for one of its
// people. Sealed like credentials (src/credentials.ts): a copy of the database with another SESSION_SECRET can't
// open them, and deploy/offbox.sh drops the rows from off-box copies.
import { seal, sealKey, unseal } from './credentials.ts';
import type { SecretRow, Store } from './db.ts';
import { HttpError } from './http.ts';

export type SecretScope = 'person' | 'scheme';

/** The env var a turn gets a secret in. */
export const SECRET_ENV_PREFIX = 'CITADEL_SECRET_';
/** Values longer than this are refused: a password or key, not a file. */
export const SECRET_MAX = 8192;

/** A secret's name, upper-cased: letters, digits and underscores, a letter first, as an env var name wants. */
export function secretName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.trim().toUpperCase() : '';
  if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(name)) throw new HttpError(400, 'A secret\'s name is a letter, then letters, digits or underscores (at most 64), e.g. AZURE_SPEECH_KEY');
  return name;
}

export function secretValue(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.length) throw new HttpError(400, 'The secret is empty');
  if (raw.length > SECRET_MAX) throw new HttpError(400, `A secret is at most ${SECRET_MAX} characters`);
  return raw;
}

/** What a list shows of a secret: never its value. */
export interface SecretView { name: string; scope: SecretScope; project?: number; updated_by: string | null; created_at: number; updated_at: number }

export class Secrets {
  private store: Store;
  private key: Buffer;

  constructor(store: Store, sessionSecret: string) {
    this.store = store;
    this.key = sealKey(sessionSecret, 'citadel secrets v1');
  }

  // Bound to its row: a value copied onto another owner's or name's row doesn't open.
  private aad = (scope: SecretScope, owner: number, name: string) => `${scope}:${owner}:${name}`;

  put(scope: SecretScope, owner: number, name: string, value: string, by: number | null) {
    this.store.putSecret(scope, owner, name, seal(this.key, this.aad(scope, owner, name), value), by);
  }

  /** The value, or null when there is none or it no longer opens (SESSION_SECRET changed). */
  get(scope: SecretScope, owner: number, name: string): string | null {
    const row = this.store.getSecret(scope, owner, name);
    return row ? unseal(this.key, this.aad(scope, owner, name), row.value) : null;
  }

  remove(scope: SecretScope, owner: number, name: string): boolean {
    return this.store.deleteSecret(scope, owner, name);
  }

  list(scope: SecretScope, owner: number): SecretView[] {
    return this.store.listSecrets(scope, owner).map((r: SecretRow) => ({
      name: r.name, scope, ...(scope === 'scheme' ? { project: owner } : {}),
      updated_by: r.updated_by === null ? null : this.store.getUser(r.updated_by)?.name ?? null, created_at: r.created_at, updated_at: r.updated_at,
    }));
  }

  /** What a turn of `project` running as `person` gets, by name: the scheme's, then the person's own over them. */
  forTurn(project: number, person: number | null): Map<string, string> {
    const out = new Map<string, string>();
    const owners: [SecretScope, number][] = [['scheme', project], ...(person === null ? [] : [['person', person] as [SecretScope, number]])];
    for (const [scope, owner] of owners) {
      for (const r of this.store.listSecrets(scope, owner)) {
        const v = unseal(this.key, this.aad(scope, owner, r.name), r.value);
        if (v !== null) out.set(r.name, v);
      }
    }
    return out;
  }
}

/** The env vars a turn gets for `secrets`, plus CITADEL_SECRET_NAMES listing them. */
export function secretEnv(secrets: Map<string, string>): Record<string, string> {
  if (!secrets.size) return {};
  const env: Record<string, string> = { CITADEL_SECRET_NAMES: [...secrets.keys()].join(',') };
  for (const [name, value] of secrets) env[SECRET_ENV_PREFIX + name] = value;
  return env;
}

/**
 * `text` with every secret value in it replaced by "[secret NAME hidden]": a turn that prints one (echo, a log, an
 * error with a URL in it) never puts it in the chat. Longest first, so a value inside another is hidden as the longer.
 * Values under 6 characters are left alone: hiding "abc" everywhere would garble the chat and hide nothing worth it.
 */
export function hideSecrets(text: string, secrets: Map<string, string>): string {
  let out = text;
  for (const [name, value] of [...secrets].filter(([, v]) => v.length >= 6).sort((a, b) => b[1].length - a[1].length)) {
    if (out.includes(value)) out = out.split(value).join(`[secret ${name} hidden]`);
  }
  return out;
}

/** hideSecrets on every string in a parsed stream-json event, keys left alone. */
export function hideSecretsIn<T>(v: T, secrets: Map<string, string>): T {
  if (typeof v === 'string') return hideSecrets(v, secrets) as T;
  if (Array.isArray(v)) return v.map((x) => hideSecretsIn(x, secrets)) as T;
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, hideSecretsIn(x, secrets)])) as T;
  return v;
}
