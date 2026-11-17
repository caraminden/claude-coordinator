// An app's release key, made on the server (#837): ~/.config/citadel-android/<app>-release.jks and its password in
// <app>-release.pass, both mode 600, as src/apk-build.ts signs with. The password is random and only ever written to
// that file: keytool reads it from there (never argv), and nothing returns or logs it. A key that exists is never
// replaced: a new key means every phone has to uninstall the app to take its next update.
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, link, mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ANDROID_JDK } from './claude-link.ts';
import { CONTRAPTION_NAME } from './contraptions.ts';

/** Runs keytool with these arguments, rejecting on a non-zero exit. */
export type Keytool = (args: string[]) => Promise<void>;

export const keyFiles = (keyDir: string, app: string) => ({ jks: join(keyDir, `${app}-release.jks`), pass: join(keyDir, `${app}-release.pass`) });

/** Whether `app` has a release key: either file counts, so a half-made one is never made over. */
export const hasKey = (keyDir: string, app: string) => Object.values(keyFiles(keyDir, app)).some((f) => existsSync(f));

const realKeytool = (home: string): Keytool => (args) => new Promise((ok, no) =>
  execFile(join(home, ANDROID_JDK, 'bin', 'keytool'), args, { timeout: 120_000 }, (err, _out, stderr) =>
    err ? no(new Error(`keytool failed: ${String(stderr || err.message).trim().slice(0, 300)}`)) : ok()));

/**
 * Make `app`'s release key in `keyDir`: RSA 4096, valid about 27 years, PKCS12 with one alias (the app's name), so
 * apksigner needs no alias. Throws when the app already has one or keytool fails, leaving nothing behind.
 */
export async function makeReleaseKey(keyDir: string, app: string, o: { home: string; keytool?: Keytool }): Promise<{ jks: string; pass: string }> {
  if (!CONTRAPTION_NAME.test(app)) throw new Error(`${JSON.stringify(app)} isn't an app name`);
  const out = keyFiles(keyDir, app);
  if (hasKey(keyDir, app)) throw new Error(`${app} already has a release key (${out.jks}): it's never replaced, as phones would have to uninstall the app`);
  await mkdir(keyDir, { recursive: true, mode: 0o700 });
  // Made in a private folder beside them, then hard-linked into place: link() never overwrites, so a key made meanwhile wins.
  const tmp = await mkdtemp(join(keyDir, `.${app}-`));
  try {
    await chmod(tmp, 0o700);
    const pass = join(tmp, 'pass');
    const jks = join(tmp, 'jks');
    await writeFile(pass, `${randomBytes(24).toString('base64url')}\n`, { mode: 0o600, flag: 'wx' });
    await (o.keytool ?? realKeytool(o.home))(['-genkeypair', '-noprompt', '-keystore', jks, '-storetype', 'PKCS12', '-alias', app,
      '-keyalg', 'RSA', '-keysize', '4096', '-validity', '10000', '-dname', `CN=${app}, O=Citadel`, '-storepass:file', pass, '-keypass:file', pass]);
    if (!existsSync(jks)) throw new Error('keytool made no keystore');
    await chmod(jks, 0o600);
    await link(pass, out.pass);
    try {
      await link(jks, out.jks);
    } catch (err) {
      await unlink(out.pass).catch(() => {});
      throw err;
    }
    return out;
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}
