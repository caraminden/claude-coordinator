/**
 * What a caught value carries, typed. Catch variables are `unknown` under strict; what Citadel catches is an Error,
 * a child process's failure (Node's execFile adds code, stdout, stderr, signal) or a fetch failure (cause), so this
 * reads those fields with their usual types. A thrown string, number or null has none of them and reads as `{}`,
 * as `err.message` on it read undefined before (#1799: catch (err: any) became catch (err) and this).
 */
export interface Thrown {
  message?: string;
  name?: string;
  stack?: string;
  /** Node's errno code ('ENOENT') or a child process's exit code. */
  code?: string | number;
  stderr?: string | Buffer;
  stdout?: string | Buffer;
  /** execFileSync's exit status. */
  status?: number | null;
  signal?: NodeJS.Signals | null;
  killed?: boolean;
  path?: string;
  cause?: unknown;
}

export function thrown(err: unknown): Thrown {
  return typeof err === 'object' && err !== null ? (err as Thrown) : {};
}
