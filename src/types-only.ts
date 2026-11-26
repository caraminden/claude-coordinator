// Is a change to a JavaScript or TypeScript file types-only (#2143)? Two versions of a file are the same code when,
// once Node strips the types, their token streams match: comments and whitespace are dropped, string, template and
// regex text is kept byte for byte, and a line break counts only where automatic semicolon insertion reads it.
// Self-review then judges such a change by what it does, not by the "High risk by file" list, and the critic gate
// asks no screenshots of it. No parser ships with the repo (TypeScript 7 is native), so this is a small tokenizer
// that refuses what it can't read for sure: a "same" answer is a proof, a "differs" may be a false alarm.
import nodeModule from 'node:module';

type Strip = (code: string, opts: { mode: 'strip' }) => string;
const strip = (nodeModule as unknown as { stripTypeScriptTypes?: Strip }).stripTypeScriptTypes;

/** Node's own type stripping, without its one-time "experimental" warning. Throws on code it can't strip (an enum). */
export function stripTypes(code: string): string {
  if (!strip) throw new Error(`node ${process.version} has no module.stripTypeScriptTypes`);
  const emit = process.emitWarning;
  process.emitWarning = (() => {}) as typeof process.emitWarning;
  try {
    return strip(code, { mode: 'strip' });
  } finally {
    process.emitWarning = emit;
  }
}

/** One token: its kind, its text, whether a line break came before it, and (on `)`) whether it closed a group. */
export type Token = { kind: 'id' | 'num' | 'str' | 'tpl' | 're' | 'punct'; text: string; nl: boolean };

// biome-ignore format: a table, longest first
const PUNCT = [
  '>>>=', '...', '===', '!==', '**=', '<<=', '>>=', '>>>', '&&=', '||=', '??=', '=>', '==', '!=', '<=', '>=', '&&',
  '||', '??', '?.', '++', '--', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '**', '<<', '>>', '{', '}', '(', ')',
  '[', ']', ';', ',', '<', '>', '+', '-', '*', '/', '%', '&', '|', '^', '!', '~', '?', ':', '=', '.', '@',
];
const PUNCT_AT = new RegExp(PUNCT.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'y'); // longest first
const LINE = /[\n\r\u2028\u2029]/;
const ID_START = /[A-Za-z_$\\#\u0080-\uffff]/;
const ID_PART = /[\w$\\\u0080-\uffff]/;
// After these words an expression starts, so a `/` begins a regex.
const BEFORE_EXPR = new Set('return typeof instanceof in of new delete void throw case do else yield await extends default'.split(' '));
// Words after which a line break ends the statement ([no LineTerminator here]), plus a few contextual ones, to be safe.
const RESTRICTED = new Set('return throw break continue yield async let get set static accessor'.split(' '));

/** The tokens of a JavaScript text, comments and whitespace dropped. Throws on text it can't read for sure. */
export function tokenize(src: string): Token[] {
  const out: Token[] = [];
  // Each open brace: a block, an expression (object literal), a template's `${`, or one this can't tell ('?').
  const braces: ('block' | 'expr' | '?' | '${')[] = [];
  let closedBrace: string | undefined; // what the last `}` closed
  const parens: boolean[] = []; // whether each open `(` follows if/while/for/with, so a `/` after its `)` is a regex
  let closedCtrl = false;
  let i = 0;
  let nl = false;
  if (src.startsWith('#!')) while (i < src.length && !LINE.test(src[i]!)) i++;
  const push = (kind: Token['kind'], text: string) => {
    out.push({ kind, text, nl });
    nl = false;
  };
  const template = (start: number) => {
    // From just after "`" or "}": read to the closing "`" or a "${".
    let j = start;
    for (;;) {
      if (j >= src.length) throw new Error('unterminated template literal');
      const c = src[j]!;
      if (c === '\\') j += 2;
      else if (c === '`') return { end: j + 1, open: false };
      else if (c === '$' && src[j + 1] === '{') return { end: j + 2, open: true };
      else j++;
    }
  };
  while (i < src.length) {
    const c = src[i]!;
    const d = src[i + 1];
    if (LINE.test(c)) {
      nl = true;
      i++;
      continue;
    }
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '/' && d === '/') {
      while (i < src.length && !LINE.test(src[i]!)) i++;
      continue;
    }
    if (c === '/' && d === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end < 0) throw new Error('unterminated comment');
      if (LINE.test(src.slice(i, end))) nl = true;
      i = end + 2;
      continue;
    }
    const prev = out[out.length - 1];
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\') j++;
        else if (src[j] === '\n') throw new Error('unterminated string');
        j++;
      }
      if (j >= src.length) throw new Error('unterminated string');
      push('str', src.slice(i, j + 1));
      i = j + 1;
      continue;
    }
    if (c === '`' || (c === '}' && braces[braces.length - 1] === '${')) {
      if (c === '}') braces.pop();
      const t = template(i + 1);
      if (t.open) braces.push('${');
      push('tpl', src.slice(i, t.end));
      i = t.end;
      continue;
    }
    if (/\d/.test(c) || (c === '.' && d !== undefined && /\d/.test(d))) {
      const m = /^(?:0[xXoObB][\da-fA-F_]+n?|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?\d[\d_]*)?n?)/.exec(src.slice(i))!;
      push('num', m[0]);
      i += m[0].length;
      continue;
    }
    if (ID_START.test(c)) {
      let j = i + 1;
      while (j < src.length && ID_PART.test(src[j]!)) j += src[j] === '\\' ? 2 : 1;
      push('id', src.slice(i, j));
      i = j;
      continue;
    }
    if (c === '/' && regexAllowed(prev, closedCtrl, closedBrace)) {
      let j = i + 1;
      let cls = false;
      for (; ; j++) {
        if (j >= src.length || LINE.test(src[j]!)) throw new Error('unterminated regex');
        const r = src[j];
        if (r === '\\') j++;
        else if (r === '[') cls = true;
        else if (r === ']') cls = false;
        else if (r === '/' && !cls) break;
      }
      j++;
      while (j < src.length && /[\w$]/.test(src[j]!)) j++;
      push('re', src.slice(i, j));
      i = j;
      continue;
    }
    PUNCT_AT.lastIndex = i;
    let p = PUNCT_AT.exec(src)?.[0];
    if (p === '?.' && /\d/.test(src[i + 2] ?? '')) p = '?'; // a?.5:1 is a ternary
    if (!p) throw new Error(`can't read ${JSON.stringify(c)}`);
    if (p === '{') braces.push(braceKind(prev));
    if (p === '}') closedBrace = braces.pop();
    closedCtrl = false;
    if (p === '(') parens.push(prev?.kind === 'id' && ['if', 'while', 'for', 'with'].includes(prev.text));
    if (p === ')') closedCtrl = parens.pop() ?? false;
    push('punct', p);
    i += p.length;
  }
  return out;
}

// Whether a `{` after `prev` opens a block or an object literal; '?' after a class name, a label's or a case's colon.
function braceKind(prev: Token | undefined): 'block' | 'expr' | '?' {
  if (!prev) return 'block';
  if (prev.kind === 'punct') {
    if ([')', ';', '{', '}', '=>'].includes(prev.text)) return 'block';
    return prev.text === ':' ? '?' : 'expr';
  }
  if (prev.kind === 'id') {
    if (['else', 'try', 'finally', 'do'].includes(prev.text)) return 'block';
    return BEFORE_EXPR.has(prev.text) && prev.text !== 'extends' ? 'expr' : '?';
  }
  return prev.kind === 'tpl' && prev.text.endsWith('${') ? 'expr' : '?';
}

// Whether a `/` after `prev` starts a regex. After a `}`, it does when the brace closed a block; refused when unknown.
function regexAllowed(prev: Token | undefined, closedCtrl: boolean, closedBrace: string | undefined): boolean {
  if (!prev) return true;
  if (prev.kind === 'punct') {
    if (prev.text === ')') return closedCtrl;
    if (prev.text === '}') {
      if (closedBrace === '?') throw new Error("can't tell a regex from a division after '}'");
      return closedBrace === 'block';
    }
    return !['++', '--', ']'].includes(prev.text);
  }
  if (prev.kind === 'id') return BEFORE_EXPR.has(prev.text);
  if (prev.kind === 'tpl') return prev.text.endsWith('${');
  return false;
}

// Words that end or are a whole expression on their own, so they may sit inside redundant parentheses.
const ATOM_WORDS = new Set(['this', 'super', 'null', 'true', 'false']);
const RESERVED = new Set(
  ('await break case catch class const continue debugger default delete do else enum export extends finally for ' + 'function if import in instanceof new return switch throw try typeof var void while with yield let static ' + 'async of get set accessor implements interface package private protected public').split(' '),
);

/**
 * Drops trailing commas before `)` and `}`, and grouping parentheses that can't change what the code does: a pair whose inside is one member or call chain
 * (`(a.b[c](d))`, `(x)`), not after a token that would make it a call, `new`, or `?.`. A type cast's parentheses,
 * `(x as T)` or JSDoc's `/** @type {T} *\/ (x)`, are the usual such pair. Comma, operator, arrow and optional-chain
 * insides are kept, since `(a, b)`, `(a || b).c` and `(a?.b).c` mean something else without them.
 */
export function dropRedundantParens(tokens: Token[]): Token[] {
  const match = new Map<number, number>();
  const stack: number[] = [];
  tokens.forEach((t, k) => {
    if (t.kind !== 'punct') return;
    if (t.text === '(' || t.text === '[' || t.text === '{') stack.push(k);
    else if (t.text === ')' || t.text === ']' || t.text === '}') {
      const o = stack.pop();
      if (o !== undefined) match.set(o, k);
    }
  });
  const drop = new Set<number>();
  // A trailing comma in arguments, parameters, an object or a destructuring means nothing (an array's is kept: [,]).
  tokens.forEach((t, k) => {
    const next = tokens[k + 1];
    if (t.text === ',' && next?.kind === 'punct' && (next.text === ')' || next.text === '}')) drop.add(k);
  });
  for (const [open, close] of match) {
    if (tokens[open]!.text !== '(') continue;
    if (!afterOperator(tokens[open - 1])) continue;
    if (tight(tokens, open + 1, close, match)) drop.add(open).add(close);
  }
  const out: Token[] = [];
  let nl = false;
  tokens.forEach((t, k) => {
    if (drop.has(k)) {
      nl ||= t.nl;
      return;
    }
    out.push(nl ? { ...t, nl: true } : t);
    nl = false;
  });
  return out;
}

// Whether a `(` after `prev` is a group, not a call or `new`'s callee: prev is an operator or an expression keyword.
function afterOperator(prev: Token | undefined): boolean {
  if (!prev) return true;
  if (prev.kind === 'punct') return ![')', ']', '}', '++', '--', '?.', '.'].includes(prev.text);
  if (prev.kind === 'id') return BEFORE_EXPR.has(prev.text) && prev.text !== 'new';
  if (prev.kind === 'tpl') return prev.text.endsWith('${');
  return false;
}

// Whether tokens[from, to) are one member or call chain: atoms, `.`, `#name` and bracketed groups, nothing else.
function tight(tokens: Token[], from: number, to: number, match: Map<number, number>): boolean {
  if (from >= to) return false;
  if (to - from === 1 && tokens[from]!.kind === 'str') return false; // ("use strict") is not a directive
  let want: 'atom' | 'after' = 'atom';
  for (let k = from; k < to; k++) {
    const t = tokens[k]!;
    if (t.kind === 'punct' && (t.text === '(' || t.text === '[')) {
      if (want === 'atom' && t.text === '(' && k !== from) return false;
      k = match.get(k) ?? to;
      if (k >= to) return false;
      want = 'after';
      continue;
    }
    if (want === 'atom') {
      if (t.kind === 'id') {
        if (RESERVED.has(t.text) && !ATOM_WORDS.has(t.text)) return false;
      } else if (t.kind !== 'num' && t.kind !== 'str' && t.kind !== 're') return false;
      want = 'after';
    } else if (t.kind === 'punct' && t.text === '.') want = 'atom';
    else return false;
  }
  return want === 'after';
}

/** Whether a line break before tokens[k] can change what the code does: only in a [no LineTerminator here] spot. */
function breakCounts(tokens: Token[], k: number): boolean {
  const t = tokens[k]!;
  const prev = tokens[k - 1];
  if (t.kind === 'punct' && (t.text === '++' || t.text === '--' || t.text === '=>')) return true;
  return prev?.kind === 'id' && RESTRICTED.has(prev.text);
}

/** The tokens to compare for a file: types stripped for TypeScript, then redundant parentheses dropped. */
export function codeTokens(text: string, path: string): Token[] {
  return dropRedundantParens(tokenize(/\.[mc]?ts$/.test(path) ? stripTypes(text) : text));
}

export const CODE_FILE = /\.(?:[mc]?ts|[mc]?js)$/;

/**
 * Whether two versions of a file run the same code: same tokens once types and comments are gone, and the same line
 * breaks wherever automatic semicolon insertion reads them. `why` says where they part, or what couldn't be read.
 */
export function sameCode(before: string, after: string, path: string): { same: boolean; why?: string } {
  if (!CODE_FILE.test(path)) return { same: false, why: 'not a JavaScript or TypeScript file' };
  if (/\.d\.[mc]?ts$/.test(path)) return { same: true }; // a declaration file never runs
  let a: Token[];
  let b: Token[];
  try {
    a = codeTokens(before, path);
    b = codeTokens(after, path);
  } catch (e) {
    return { same: false, why: (e as Error).message };
  }
  const n = Math.max(a.length, b.length);
  for (let k = 0; k < n; k++) {
    const x = a[k];
    const y = b[k];
    if (!x || !y || x.text !== y.text || x.kind !== y.kind) {
      return { same: false, why: `code differs at token ${k + 1}: ${x?.text ?? '(end)'} → ${y?.text ?? '(end)'}` };
    }
    if (x.nl !== y.nl && breakCounts(a, k)) return { same: false, why: `a line break moved before ${y.text}` };
  }
  return { same: true };
}
