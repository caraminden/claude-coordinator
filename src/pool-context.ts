// Whose turn a call runs for (#1259): the shared tool server (src/mcp-pool.ts) runs each request inside its turn's
// env and folder; a turn's own stdio helper has none, so its own process env and folder stand.
import { AsyncLocalStorage } from 'node:async_hooks';

export type TurnContext = { env: NodeJS.ProcessEnv; cwd: string };
export const turnStore = new AsyncLocalStorage<TurnContext>();
export const callEnv = (): NodeJS.ProcessEnv => turnStore.getStore()?.env ?? process.env;
export const callCwd = (): string => turnStore.getStore()?.cwd ?? process.cwd();
