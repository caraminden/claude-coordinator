// How many API requests does opening a scheme make in a fresh browser, before the page goes quiet? (#1528)
//
//   node tools/open-requests.ts [--route '#/p/2'] [--quiet 5000] [--max 30]
//
// It opens the route in the worktree's dev copy (tools/ui-shot.ts open()), forgets the HTTP cache and the
// site's storage but its sign-in cookie, as a fresh browser would have none, reloads, waits for the minion list to draw, then
// for `--quiet` ms more, and counts the requests to api/ (the event stream itself left out) with
// Resource Timing. It prints the count and each path's tally; `--max` exits 1 when the count passes it.
// The count moves a little between runs (presence, chat images, what the seed has waiting).
import { setTimeout as sleep } from 'node:timers/promises';
import { open } from './ui-shot.ts';

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? fallback : process.argv[i + 1];
};
const route = arg('route', '#/p/2');
const quiet = Number(arg('quiet', '5000'));
const max = Number(arg('max', '0'));

// Waits for the page's body only: ui-measure gives the app 15 s to draw, which a busy box can pass. The wait below is longer.
const page = await open(route, { args: ['--wait', 'body'] });
try {
  await page.s('Page.addScriptToEvaluateOnNewDocument', { source: 'performance.setResourceTimingBufferSize(2000)' });
  const origin = await page.evaluate('location.origin');
  await page.s('Storage.clearDataForOrigin', { origin, storageTypes: 'local_storage,indexeddb,cache_storage,service_workers,websql,file_systems' });
  await page.evaluate('sessionStorage.clear()');
  await page.s('Network.enable');
  await page.s('Network.clearBrowserCache');
  await page.s('Page.reload', { ignoreCache: true });
  const drawn = `document.querySelector('a.thread-row') && !document.body.classList.contains('navigating')`;
  for (const end = Date.now() + 120_000; !(await page.evaluate(drawn).catch(() => false)); await sleep(100)) if (Date.now() > end) throw new Error('the minion list never drew');
  await sleep(quiet);
  const paths: string[] = await page.evaluate(`performance.getEntriesByType('resource').map((e) => new URL(e.name)).filter((u) => u.pathname.includes('/api/') && !u.pathname.endsWith('/api/stream')).map((u) => u.pathname + u.search.replace(/[?&]v=\\d+$/, ''))`);
  const tally = new Map<string, number>();
  for (const p of paths) {
    const key = p.replace(/^.*?\/api\//, 'api/');
    tally.set(key, (tally.get(key) ?? 0) + 1);
  }
  console.log(`${paths.length} API requests opening ${route}${max ? ` (at most ${max})` : ''}`);
  for (const [p, n] of [...tally].sort((a, b) => b[1] - a[1])) console.log(`${String(n).padStart(3)} ${p}`);
  if (max && paths.length > max) process.exitCode = 1;
} finally {
  await page.close();
}
