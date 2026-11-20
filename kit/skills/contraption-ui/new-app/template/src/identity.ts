// Who's asking: the X-Citadel-Identity header Citadel signs on every request it proxies to this app
// (citadel:contraption-ui, references/api.md "The identity header"). Anyone on the box can reach the
// port directly, so this signature is the only proof of who a request is from.
import { createPublicKey, verify, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Person {
  /** Citadel's id for the person: key their data on this, never on login (logins can change). */
  sub: string;
  login: string;
  name: string;
}

/** A checker for this app's header, from the identity.pub in `keysDir` (CITADEL_KEYS). */
export function identityChecker(app: string, keysDir: string): (header: string | undefined) => Person | null {
  return checkerFor(app, createPublicKey(readFileSync(join(keysDir, 'identity.pub'))));
}

export function checkerFor(app: string, pub: KeyObject): (header: string | undefined) => Person | null {
  return (header) => {
    const m = /^v1\.([\w-]+)\.([\w-]+)$/.exec(header ?? '');
    if (!m) return null;
    try {
      if (!verify(null, Buffer.from(`v1.${m[1]}`), pub, Buffer.from(m[2], 'base64url'))) return null;
      const c = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8'));
      if (c.app !== app || typeof c.exp !== 'number' || c.exp * 1000 <= Date.now()) return null;
      // A call relayed from another app carries `from`. This app opens no relay paths yet: refuse it, so
      // another app can't act as the person here. Allow it only on routes built for it (api.md "The relay").
      if (c.from) return null;
      return { sub: String(c.sub), login: String(c.login ?? ''), name: String(c.name ?? '') };
    } catch {
      return null;
    }
  };
}
