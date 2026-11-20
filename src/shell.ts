// The app shell the service worker keeps on the device (#1144): public/sw.js caches Citadel's own static files under
// the version the server runs, so the installed app opens with no network. The server fills the worker in per request,
// so a ship (a new version) is a new worker, and the off switch below is one too.
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The off switch: while this file exists in the data folder, /sw.js is a worker that drops its cache, reloads the open
 * windows it served and steps aside (network only, as before #1144). Browsers fetch /sw.js themselves, never through
 * the worker, so a bad worker can't keep this out. `touch ~/.local/share/claude-coordinator/shell-cache-off`.
 */
export const SHELL_OFF_FILE = 'shell-cache-off';

/** The line in public/sw.js the server replaces; the file as it stands is the off worker. */
export const SHELL_LINE = 'const SHELL = null; // filled in by the server (src/shell.ts)';

/** Front-end files the worker keeps: the page's own scripts, styles and icons, not the manifest (it varies by dark mode),
 * the worker itself, the machines' and runners' agents, scripts for Windows or types for apps. */
export function shellFiles(names: Iterable<string>): string[] {
  return [...names].filter((n) => !/\.(mjs|ps1|ts|webmanifest)$/.test(n) && n !== 'sw.js' && n !== 'index.html').sort();
}

export function shellOff(dataDir: string): boolean {
  return existsSync(join(dataDir, SHELL_OFF_FILE));
}

/** public/sw.js with its shell filled in: the version and the URLs to keep, or none when the switch is off. */
export function shellWorker(source: string, version: string, names: Iterable<string>, off: boolean): string {
  if (!source.includes(SHELL_LINE)) throw new Error(`public/sw.js lost its line "${SHELL_LINE}"`);
  if (off) return source;
  const shell = { version, urls: ['/c/', ...shellFiles(names).map((n) => `/c/${n}`)] };
  return source.replace(SHELL_LINE, `const SHELL = ${JSON.stringify(shell)};`);
}
