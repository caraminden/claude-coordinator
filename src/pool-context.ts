// Whose turn a call runs for (#1259): the shared tool server (src/mcp-pool.ts) runs each request inside its turn's
// env and folder; a turn's own stdio helper has none, so its own process env and folder stand.
import { AsyncLocalStorage } from 'node:async_hooks';

export type TurnContext = { env: NodeJS.ProcessEnv; cwd: string };
export const turnStore = new AsyncLocalStorage<TurnContext>();
export const callEnv = (): NodeJS.ProcessEnv => turnStore.getStore()?.env ?? process.env;
export const callCwd = (): string => turnStore.getStore()?.cwd ?? process.cwd();

/** Keep an open event-stream answer alive with a comment line; the beat stops when the response ends or its client goes (a hung call's too). Returns the stop. */
export function beatWhileOpen(res: { write(s: string): unknown; once(ev: 'close', f: () => void): unknown }, ms = 15_000): () => void {
  const beat = setInterval(() => res.write(': beat\n\n'), ms);
  const stop = () => clearInterval(beat);
  res.once('close', stop);
  return stop;
}
