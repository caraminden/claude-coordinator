// The pins of src/judges.ts (#1503): each judge's deciding code, hashed by symbol so a change elsewhere in its file asks
// for no replay. Read by tools/judge-replay.ts and test/judges.test.ts only, never by the server.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Judge } from '../../src/judges.ts';

/** The lines of `symbol`'s declaration in `source`: a top-level `name`, or `Class.method` at the class body's indent; null if not found. */
export function symbolLines(source: string, symbol: string): string[] | null {
  const lines = source.split('\n');
  const lead = (l: string) => l.length - l.trimStart().length;
  const decl = (name: string, indent: number, from: number, to: number) => {
    const re = indent === 0
      ? new RegExp(`^(?:export )?(?:default )?(?:declare )?(?:async )?(?:function\\*? |const |let |var |class |interface |type |enum )${name}\\b`)
      : new RegExp(`^ {${indent}}(?:(?:private|protected|public|static|async|readonly|get|set|override) )*#?${name}\\s*[(<=:]`);
    for (let i = from; i < to; i++) if (re.test(lines[i])) return i;
    return -1;
  };
  // From the declaration through its body: the lines indented deeper, and the closer at its own indent.
  const region = (i: number) => {
    const indent = lead(lines[i]);
    let end = i;
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      if (!l.trim()) continue;
      if (lead(l) > indent) { end = j; continue; }
      if (lead(l) === indent && /^[}\])]/.test(l.trim())) end = j;
      break;
    }
    return [i, end] as const;
  };
  const [cls, method] = symbol.includes('.') ? symbol.split('.') : [null, symbol];
  if (!cls) {
    const i = decl(method, 0, 0, lines.length);
    if (i < 0) return null;
    const [a, b] = region(i);
    return lines.slice(a, b + 1);
  }
  const c = decl(cls, 0, 0, lines.length);
  if (c < 0) return null;
  const [, cEnd] = region(c);
  const i = decl(method, 2, c + 1, cEnd);
  if (i < 0) return null;
  const [a, b] = region(i);
  return lines.slice(a, b + 1);
}

/** A symbol's hash: its lines with comment-only lines and blank lines dropped and each line trimmed, so a comment or an indent change asks for no replay. */
export function symbolHash(source: string, symbol: string): string | null {
  const lines = symbolLines(source, symbol);
  if (!lines) return null;
  const code = lines.map((l) => l.trim()).filter((l) => l && !/^(\/\/|\/\*|\*)/.test(l)).join('\n');
  return createHash('sha256').update(code).digest('hex').slice(0, 16);
}

/** Every pinned symbol's hash, `path#symbol` → hash, or null for one that wasn't found; `root` is the repo. */
export function pinHashes(j: Judge, root: string): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const p of j.pins) {
    let source = '';
    try { source = readFileSync(join(root, p.path), 'utf8'); } catch { /* a missing file pins nothing: every symbol null */ }
    for (const s of p.symbols) out[`${p.path}#${s}`] = source ? symbolHash(source, s) : null;
  }
  return out;
}

/** One hash for the judge's whole decision: what a recorded replay is pinned to. */
export function judgeHash(j: Judge, root: string): string {
  const h = pinHashes(j, root);
  return createHash('sha256').update(Object.keys(h).sort().map((k) => `${k}=${h[k]}`).join('\n')).digest('hex').slice(0, 16);
}
