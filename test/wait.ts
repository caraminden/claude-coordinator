// The one `until` for tests. It imports nothing from src/, so a pipeline test file (tools/pipeline-files.txt) can use it;
// test/helpers.ts re-exports it.

/**
 * Poll `fn` every 20 ms until it returns something truthy, or fail after `ms`. `extra` adds text to the failure
 * (a child's stderr, say), read when it fails.
 */
export async function until<T>(what: string, fn: () => Promise<T | undefined | null | false> | T | undefined | null | false, ms = 30_000, extra?: () => string): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}${extra ? `: ${extra()}` : ''}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
