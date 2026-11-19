// Decisions (#1064): every dated, quoted decision, parsed live from where it is written. Nothing is copied: the
import { frontmatter } from './memory-files.ts';
// Citadel-wide and scheme instructions (with their edit history), a scheme repo's CLAUDE.md, rules and ADRs, the kit
// (with git history) and the memory notes (src/memory-files.ts's mapping). Josh, 2026-11-19, #1064's grilling:
// a decision is Reversed when its source's own history replaced it with a newer one, or the text itself says so
// ("Edit history + its own words"); a quote an edit only cut is hidden ("Hide them"); a memory note that repeats a
// decision joins its row ("Yes, join repeats"); a reversed decision still written elsewhere lists those copies, with
// a cleanup button ("Show it + cleanup button"), and a new one tells the scheme's Taskmaster ("Tell the Taskmaster").
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { gitOut } from './git.ts';

/** One attribution as written: who, when, what they said, and the rule it backs. */
export interface Raw {
  who: string;
  date: string;
  /** The first quote, '' when the attribution has none (a parenthetical can back a rule without one). */
  quote: string;
  quotes: string[];
  /** The rule or heading it backs. */
  rule: string;
  section: string;
  line: number;
  /** The paragraph around it, cut to a few hundred characters. */
  text: string;
  /** Its own words say it reverses an earlier pick ("first picked X, then Y", "reverses"). */
  own: boolean;
  /** Earlier decisions it names as reversed: "This reverses Cara's 2026-11-10 "Keep failing, log it"". */
  refs: { who: string; date: string; quote: string }[];
}

const DATE = '(20\\d\\d-\\d\\d-\\d\\d)';
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** First names, longest first so "Jo" never shadows "Josh". */
const namesRe = (names: string[]) => [...new Set(names.map((n) => n.trim().split(/\s+/)[0]).filter((n) => /^[A-Z][\p{L}'-]+$/u.test(n)))].sort((a, b) => b.length - a.length).map(esc).join('|');

const OWN = /\b(first picked|reverse[sd]?|reversing|supersedes?|superseded|over keeping|instead of (?:her|his|their) earlier)\b/i;
const QUOTE_OPEN: Record<string, string> = { '"': '"', '“': '”', '`': '`' };
export const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, ' ').trim();
const words = (s: string) => new Set(norm(s).split(' ').filter((w) => w.length > 2).map((w) => w.replace(/(ing|ed|es|s)$/, '')));
const jaccard = (a: Set<string>, b: Set<string>) => {
  if (!a.size || !b.size) return 0;
  let n = 0;
  for (const w of a) if (b.has(w)) n++;
  return n / (a.size + b.size - n);
};

/** The quotes in a stretch of text, in order: "…", “…” and `…`. */
function quotesIn(s: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i++) {
    const close = QUOTE_OPEN[s[i]];
    if (!close) continue;
    const j = s.indexOf(close, i + 1);
    if (j < 0) break;
    const q = s.slice(i + 1, j).replace(/\s+/g, ' ').trim();
    if (q.length >= 2 && !/^#?\d+$/.test(q)) out.push(q);
    i = j;
  }
  return out;
}

/** Where an attribution's own clause ends: its closing paren, a `;` or a blank line, outside quotes. */
function clauseEnd(text: string, from: number, paren: boolean, stop: number): number {
  let quote: string | null = null;
  let depth = 0;
  const max = Math.min(stop, from + 600);
  for (let i = from; i < max; i++) {
    const c = text[i];
    if (quote) { if (c === quote) quote = null; continue; }
    if (QUOTE_OPEN[c]) { quote = QUOTE_OPEN[c]; continue; }
    if (c === '\n' && text[i + 1] === '\n') return i;
    if (c === '(') depth++;
    else if (c === ')') { if (depth === 0 && paren) return i; depth = Math.max(0, depth - 1); }
    else if (c === ';' && depth === 0) return i;
    else if (!paren && c === '.' && /\s/.test(text[i + 1] ?? ' ') && depth === 0 && i > from + 3) return i;
  }
  return max;
}

/**
 * Every dated attribution in a text: "(Name, YYYY-MM-DD: "quote")", "(Name, YYYY-MM-DD, picked "X")" and the bare
 * "Name, YYYY-MM-DD: "quote"" (memory writes "Name YYYY-MM-DD"). A parenthetical counts with or without a quote, since
 * it backs the rule it sits in; a bare one needs a quote close by, or it is only a mention.
 */
export function parseDecisions(text: string, names: string[], opts: { title?: string } = {}): Raw[] {
  const who = namesRe(names);
  if (!who || !text) return [];
  text = text.replace(/\\"/g, '"');
  const re = new RegExp(`(^|[^\\p{L}'’])(${who}),?\\s+${DATE}\\b`, 'gu');
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') lineStarts.push(i + 1);
  const lineOf = (pos: number) => { let lo = 0, hi = lineStarts.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStarts[mid] <= pos) lo = mid; else hi = mid - 1; } return lo; };
  const lines = text.split('\n');
  const heading = (line: number) => { for (let l = line; l >= 0; l--) { const m = /^#{1,6}\s+(.*)$/.exec(lines[l]); if (m) return stripAttr(m[1]); } return ''; };
  const matches = [...text.matchAll(re)].map((m) => ({ start: m.index! + m[1].length, end: m.index! + m[0].length, who: m[2], date: m[3] }));
  const out: Raw[] = [];
  const seen = new Set<string>();
  matches.forEach((m, k) => {
    // Skip "Cara's 2026-…" (a reference, read as refs below) and a date that is part of a longer token.
    if (text[m.end] === '-' || /\d/.test(text[m.end] ?? '')) return;
    const paraStart = Math.max(text.lastIndexOf('\n\n', m.start) + 2, 0);
    let paraEnd = text.indexOf('\n\n', m.end);
    if (paraEnd < 0) paraEnd = text.length;
    // Inside an open paren of the same paragraph?
    let open = -1, depth = 0, quote: string | null = null;
    for (let i = paraStart; i < m.start; i++) {
      const c = text[i];
      if (quote) { if (c === quote) quote = null; continue; }
      if (QUOTE_OPEN[c] && c !== '`') { quote = QUOTE_OPEN[c]; continue; }
      if (c === '(') { if (depth === 0) open = i; depth++; }
      else if (c === ')') { depth = Math.max(0, depth - 1); if (depth === 0) open = -1; }
    }
    const paren = open >= 0;
    const next = matches[k + 1]?.start ?? text.length;
    const end = clauseEnd(text, m.end, paren, Math.min(next, paraEnd));
    const clause = text.slice(m.end, end);
    const quotes = quotesIn(clause);
    if (!paren) {
      // A bare mention needs its quote within reach: "Cara, 2026-11-15, on #767's card: "…"".
      const first = clause.search(/["“`]/);
      if (!quotes.length || first > 120) return;
    }
    const line = lineOf(m.start);
    const lineText = lines[line];
    let rule = '';
    if (paren) {
      const lead = text.slice(Math.max(paraStart, lineStarts[lineOf(open)]), open).replace(/^\s*(#{1,6}\s+|[-*]\s+|\d+\.\s+|\*\*)/, '').trim();
      rule = lastSentence(lead.replace(/^(description|name):\s*"?/, ''));
    }
    if (!rule && opts.title) rule = opts.title;
    if (!rule) {
      const before = lineText.slice(0, m.start - lineStarts[line]).replace(/^\s*(#{1,6}\s+|[-*]\s+|\d+\.\s+|(description|name):\s*"?)/, '').trim();
      rule = lastSentence(before) || heading(line);
    }
    rule = rule.replace(/\*\*/g, '').replace(/[:,(—-]\s*$/, '').trim();
    rule = rule.replace(new RegExp(`^(${who}),?\\s+${DATE}[:,]?\\s*`, 'u'), '').replace(/^\p{Ll}/u, (c) => c.toUpperCase());
    const para = text.slice(paraStart, paraEnd);
    const key = `${m.who}|${m.date}|${quotes.map(norm).join('|') || norm(rule)}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      who: m.who, date: m.date, quote: quotes[0] ?? '', quotes, rule: rule.slice(0, 160), section: heading(line), line: line + 1,
      text: snippet(para, m.start - paraStart), own: OWN.test(clause) || OWN.test(sentenceAround(para, m.start - paraStart)),
      refs: refsIn(para, who),
    });
  });
  return out;
}

const stripAttr = (s: string) => s.replace(/\s*\([^()]*20\d\d-\d\d-\d\d[^()]*(\([^()]*\)[^()]*)*\)\s*$/, '').replace(/\*\*/g, '').trim();
function lastSentence(s: string): string {
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length <= 100) return s;
  const parts = s.split(/(?<=[.!?:])\s+/);
  const last = parts.at(-1)!.trim();
  return last.length > 140 ? `…${last.slice(-120)}` : last;
}
function sentenceAround(para: string, at: number): string {
  const a = Math.max(para.lastIndexOf('. ', at), 0);
  const b = para.indexOf('. ', at);
  return para.slice(a, b < 0 ? undefined : b);
}
function snippet(para: string, at: number): string {
  const flat = para.replace(/\s+/g, ' ').trim();
  if (flat.length <= 420) return flat;
  const pos = Math.min(Math.max(0, at - 160), flat.length - 420);
  return `${pos > 0 ? '…' : ''}${flat.slice(pos, pos + 420)}…`;
}
function refsIn(para: string, who: string): Raw['refs'] {
  const re = new RegExp(`\\brevers(?:es|ed|ing)\\s+(?:the\\s+)?(${who})['’]s\\s+${DATE}\\s*(?:\\([^)]*\\)\\s*)?["“\`]([^"”\`]{2,200})`, 'gu');
  return [...para.matchAll(re)].map((m) => ({ who: m[1], date: m[2], quote: m[3].trim() }));
}

/** An ADR is one decision: its title, its date, and the first person it quotes (or names). */
export function parseAdr(text: string, names: string[]): Raw | null {
  const title = /^#\s+(.*)$/m.exec(text)?.[1]?.replace(/^\d{3,4}:\s*/, '').trim();
  if (!title) return null;
  const head = text.split('\n').slice(0, 12).join('\n');
  const date = /(?:Date|Status)[^\n]*?(20\d\d-\d\d-\d\d)/.exec(head)?.[1] ?? /(20\d\d-\d\d-\d\d)/.exec(head)?.[1];
  if (!date) return null;
  const inner = parseDecisions(text, names);
  const first = inner.find((d) => d.quote) ?? inner[0];
  const who = first?.who ?? new RegExp(`\\b(${namesRe(names) || '$^'})\\b`, 'u').exec(head)?.[1] ?? '';
  const whoRe = namesRe(names);
  const body = text.replace(/^#.*$/m, '').trim();
  return {
    who, date, quote: first?.quote ?? '', quotes: first?.quotes ?? [], rule: title, section: '', line: 1,
    text: snippet(body.split('\n\n').slice(0, 2).join(' '), 0), own: OWN.test(head),
    refs: whoRe ? refsIn(text, whoRe) : [],
  };
}

/** One version of a source and the next, as an edit or a commit made them. */
export interface Edit { before: string; after: string; at: number; by: string; /** A link to see the edit, if any. */ href?: string }
/** A decision an edit replaced, and the one that replaced it. */
export interface Reversal { old: Raw; by: Raw; at: number; editor: string; href?: string }

export const rawKey = (d: Pick<Raw, 'who' | 'date' | 'quotes' | 'rule'>) => `${d.who}|${d.date}|${d.quotes.map(norm).join('|') || norm(d.rule)}`;

/**
 * Replay a source's edits, oldest first, and keep each decision one replaced. An edit that drops a decision and adds
 * a newer one in its place (or one whose own words say it reverses an earlier pick) reverses it; one that only rewords
 * it (same person and date, no such words) keeps it; one that only cuts it is a removal, which the page hides.
 */
export function replay(edits: Edit[], parse: (text: string) => Raw[]): Reversal[] {
  const out: Reversal[] = [];
  const cache = new Map<string, Raw[]>();
  const parsed = (t: string) => { let r = cache.get(t); if (!r) { r = parse(t); cache.set(t, r); if (cache.size > 8) cache.delete(cache.keys().next().value!); } return r; };
  for (const e of edits) {
    if (e.before === e.after) continue;
    const before = parsed(e.before);
    const after = parsed(e.after);
    const afterKeys = new Set(after.map(rawKey));
    const beforeKeys = new Set(before.map(rawKey));
    const added = after.filter((d) => !beforeKeys.has(rawKey(d)));
    for (const old of before) {
      if (afterKeys.has(rawKey(old))) continue;
      const by = replacement(old, added);
      if (by) out.push({ old, by, at: e.at, editor: e.by, ...(e.href ? { href: e.href } : {}) });
    }
  }
  return out;
}

function replacement(old: Raw, added: Raw[]): Raw | null {
  const topic = words(`${old.rule} ${old.quotes.join(' ')}`);
  const rule = words(old.rule);
  let best: Raw | null = null, bestScore = 0;
  for (const n of added) {
    if (n.date < old.date) continue;
    const same = n.who === old.who && n.date === old.date;
    // A rewording: same person and day, no words of reversal.
    if (same && !n.own) continue;
    const near = Math.abs(n.line - old.line) <= 6 || (n.section && n.section === old.section);
    const overlap = Math.max(jaccard(topic, words(`${n.rule} ${n.quotes.join(' ')}`)), jaccard(rule, words(n.rule)));
    const score = (n.own && n.who === old.who ? 2 : 0) + (near ? 1 : 0) + overlap * 2;
    if (!n.own && (!near || overlap < 0.15)) continue;
    if (n.own && !near && overlap < 0.15) continue;
    if (score > bestScore) { best = n; bestScore = score; }
  }
  return best;
}

/** Whether two attributions are the same decision written twice (a memory note repeating a rule, say). */
export function sameDecision(a: Raw, b: Raw): boolean {
  if (a.who !== b.who || a.date !== b.date) return false;
  const qa = new Set(a.quotes.map(norm).filter((q) => q.length > 3));
  if (b.quotes.some((q) => qa.has(norm(q)))) return true;
  return jaccard(words(`${a.quote} ${a.rule}`), words(`${b.quote} ${b.rule}`)) >= 0.25;
}

// ---- the assembled list

export type SourceKind = 'citadel' | 'scheme' | 'repo' | 'adr' | 'kit' | 'memory';
export const SOURCE_LABEL: Record<SourceKind, string> = {
  citadel: 'Citadel-wide instructions', scheme: 'Scheme instructions', repo: 'Repo CLAUDE.md and rules', adr: 'ADRs', kit: 'The kit', memory: 'Memory',
};
/** Where a decision is written: a source, a file in it and a line, and a link to open it. */
export interface Place { kind: SourceKind; label: string; file?: string; line?: number; href: string | null }
/** One document a source reads: its text, or its edits too when it keeps them. */
export interface Doc { kind: SourceKind; place: Omit<Place, 'line' | 'kind'>; text: string; adr?: boolean; edits?: Edit[]; title?: string }

export interface Decision {
  id: string;
  who: string; date: string; quote: string; rule: string; section: string; text: string;
  /** citadel: the Citadel-wide instructions or the kit; scheme: everything of this scheme's. */
  scope: 'citadel' | 'scheme';
  /** Where it is written now; the first is its home. Empty for a reversed decision no source still holds. */
  places: Place[];
  /** Its own words say it reverses an earlier pick. */
  own: boolean;
  reversed: null | { by: string | null; byText: string; at: number | null; editor: string | null; href: string | null; /** Copies still written, outside the edited source. */ stale: Place[] };
  /** Decisions this one reversed. */
  reverses: string[];
}

export interface DecisionList { decisions: Decision[]; counts: { kind: SourceKind; label: string; count: number; files: number }[] }

const idOf = (scope: string, r: Pick<Raw, 'who' | 'date' | 'quotes' | 'rule'>) => createHash('sha1').update(`${scope}|${rawKey(r)}`).digest('hex').slice(0, 12);
const scopeOf = (k: SourceKind): Decision['scope'] => (k === 'citadel' || k === 'kit' ? 'citadel' : 'scheme');

/**
 * Turn the documents into the list: each attribution once (repeats join as more places), reversals from each
 * source's edits and from words that name what they reverse, and for each reversed decision the copies still written.
 * `staleKinds` limits which sources can hold a stale copy this scheme could clean (the kit only from Citadel's own).
 */
export function assemble(docs: Doc[], names: string[], staleKinds: SourceKind[]): DecisionList {
  const all: Decision[] = [];
  const counts = new Map<SourceKind, { count: number; files: Set<string> }>();
  const raws: { raw: Raw; doc: Doc; d: Decision }[] = [];
  for (const doc of docs) {
    const c = counts.get(doc.kind) ?? { count: 0, files: new Set() };
    counts.set(doc.kind, c);
    c.files.add(doc.place.file ?? doc.place.label);
    const found = doc.adr ? [parseAdr(doc.text, names)].filter((r): r is Raw => !!r) : parseDecisions(doc.text, names, { title: doc.title });
    c.count += found.length;
    for (const raw of found) {
      const place: Place = { ...doc.place, kind: doc.kind, line: raw.line };
      // A repeat (memory echoing a rule, the kit echoing the instructions) joins the decision already listed.
      const twin = raws.find((x) => x.doc.kind !== doc.kind && x.d.places.length && sameDecision(x.raw, raw) && !raw.own === !x.raw.own);
      if (twin) { twin.d.places.push(place); continue; }
      const d: Decision = {
        id: idOf(scopeOf(doc.kind), raw), who: raw.who, date: raw.date, quote: raw.quote, rule: raw.rule, section: raw.section, text: raw.text,
        scope: scopeOf(doc.kind), places: [place], own: raw.own, reversed: null, reverses: [],
      };
      if (all.some((x) => x.id === d.id)) continue;
      all.push(d);
      raws.push({ raw, doc, d });
    }
  }
  const byId = new Map(all.map((d) => [d.id, d]));
  const current = (doc: Doc, r: Raw) => raws.find((x) => x.doc === doc && (rawKey(x.raw) === rawKey(r) || (x.raw.who === r.who && x.raw.date === r.date && x.raw.own === r.own && sameDecision(x.raw, r))))?.d ?? null;
  const parse = (doc: Doc) => (t: string) => (doc.adr ? [parseAdr(t, names)].filter((r): r is Raw => !!r) : parseDecisions(t, names, { title: doc.title }));
  const reversedOnes: { d: Decision; raw: Raw; doc: Doc | null; by: Decision | null }[] = [];
  // 1. From each source's own edits.
  for (const doc of docs) {
    if (!doc.edits?.length) continue;
    for (const rev of replay(doc.edits, parse(doc))) {
      // Still written in this source (put back later): not reversed.
      if (current(doc, rev.old)) continue;
      const by = current(doc, rev.by);
      const id = idOf(scopeOf(doc.kind), rev.old);
      let d = byId.get(id);
      if (d?.reversed) continue;
      if (!d) {
        d = { id, who: rev.old.who, date: rev.old.date, quote: rev.old.quote, rule: rev.old.rule, section: rev.old.section, text: rev.old.text, scope: scopeOf(doc.kind), places: [], own: rev.old.own, reversed: null, reverses: [] };
        all.push(d);
        byId.set(id, d);
      }
      d.reversed = { by: by?.id ?? null, byText: by ? '' : `${rev.by.rule}${rev.by.quote ? `: "${rev.by.quote}"` : ''} (${rev.by.who}, ${rev.by.date})`, at: rev.at, editor: rev.editor, href: rev.href ?? doc.place.href, stale: [] };
      if (by && !by.reverses.includes(id)) by.reverses.push(id);
      reversedOnes.push({ d, raw: rev.old, doc, by });
    }
  }
  // 2. From words that name what they reverse ("This reverses Cara's 2026-11-10 "Keep failing, log it"").
  for (const { raw, d: by } of [...raws]) {
    for (const ref of raw.refs) {
      const target = raws.find((x) => x.d !== by && x.raw.who === ref.who && x.raw.date === ref.date && (x.raw.quotes.some((q) => norm(q) === norm(ref.quote)) || norm(x.raw.text).includes(norm(ref.quote))))?.d
        ?? all.find((x) => x !== by && x.who === ref.who && x.date === ref.date && norm(x.quote) === norm(ref.quote));
      const stub = { who: ref.who, date: ref.date, quotes: [ref.quote], rule: ref.quote };
      const d = target ?? { id: idOf(by.scope, stub), who: ref.who, date: ref.date, quote: ref.quote, rule: ref.quote, section: '', text: `Named as reversed in ${by.places[0]?.label ?? 'a later decision'}.`, scope: by.scope, places: [], own: false, reversed: null, reverses: [] } as Decision;
      if (d.reversed) continue;
      if (!target) { all.push(d); byId.set(d.id, d); }
      // Its own places, if any, are the copies still written.
      d.reversed = { by: by.id, byText: '', at: null, editor: null, href: by.places[0]?.href ?? null, stale: d.places.filter((p) => staleKinds.includes(p.kind)) };
      if (!by.reverses.includes(d.id)) by.reverses.push(d.id);
    }
  }
  // 3. Copies a reversed decision still has elsewhere: same person and day, a quote only the old one had, not words of history.
  for (const { d, raw, by } of reversedOnes) {
    const byRaw = raws.find((x) => x.d === by)?.raw;
    const own = new Set((byRaw?.quotes ?? []).map(norm));
    const distinct = raw.quotes.map(norm).filter((q) => q.length > 3 && !own.has(q));
    if (!distinct.length) continue;
    for (const x of raws) {
      if (x.d === by || x.raw.own || x.raw.who !== raw.who || x.raw.date !== raw.date) continue;
      if (!x.raw.quotes.some((q) => distinct.includes(norm(q)))) continue;
      for (const p of x.d.places) if (staleKinds.includes(p.kind) && !d.reversed!.stale.some((s) => s.href === p.href && s.line === p.line)) d.reversed!.stale.push(p);
    }
  }
  const order: SourceKind[] = ['citadel', 'scheme', 'repo', 'adr', 'kit', 'memory'];
  all.sort((a, b) => b.date.localeCompare(a.date) || (b.reversed ? 0 : 1) - (a.reversed ? 0 : 1));
  return {
    decisions: all,
    counts: order.filter((k) => counts.has(k)).map((k) => ({ kind: k, label: SOURCE_LABEL[k], count: counts.get(k)!.count, files: counts.get(k)!.files.size })),
  };
}

/** A plain-text answer for the Taskmaster's tool: the same entries as the page, best matches first. */
export function searchDecisions(list: Decision[], q: string): Decision[] {
  const terms = norm(q).split(' ').filter(Boolean);
  if (!terms.length) return list;
  const score = (d: Decision) => {
    const hay = norm(`${d.rule} ${d.quote} ${d.text} ${d.who} ${d.date} ${d.section} ${d.places.map((p) => `${p.label} ${p.file ?? ''}`).join(' ')}`);
    return terms.reduce((s, t) => s + (hay.includes(t) ? 1 : 0), 0) / terms.length;
  };
  return list.map((d) => ({ d, s: score(d) })).filter((x) => x.s >= (terms.length > 2 ? 0.6 : 1)).sort((a, b) => b.s - a.s || b.d.date.localeCompare(a.d.date)).map((x) => x.d);
}

// ---- reading sources from git

/** The files a scheme repo's decisions live in: CLAUDE.md, AGENTS.md, .claude/rules and its ADR folder. */
export function adrDir(claudeMd: string): string {
  const m = /Decisions log[^\n]*?:\**\s*`([^`]+)`/.exec(claudeMd);
  return (m?.[1] ?? 'docs/adr/').replace(/^\.\//, '').replace(/\/?$/, '/');
}

/** Each commit that changed a dated line in these paths, as before/after pairs per file (oldest first). Cached by HEAD. */
const historyCache = new Map<string, { head: string; edits: Map<string, Edit[]> }>();
export async function gitEdits(repo: string, paths: string[], href: (file: string, sha: string) => string | null): Promise<Map<string, Edit[]>> {
  const head = await gitOut(['rev-parse', 'HEAD'], repo);
  if (!head) return new Map();
  const key = `${repo}|${paths.join(',')}`;
  const hit = historyCache.get(key);
  if (hit?.head === head) return hit.edits;
  const log = await gitOut(['log', '--format=%x00%H %ct %an', '-G', '20[0-9][0-9]-[0-9][0-9]-[0-9][0-9]', '--name-only', '--no-renames', '--', ...paths], repo, { timeout: 30_000 });
  const pairs: { sha: string; at: number; by: string; file: string }[] = [];
  for (const block of (log ?? '').split('\0').filter(Boolean)) {
    const [first, ...files] = block.trim().split('\n').filter(Boolean);
    const [sha, ct, ...by] = first.split(' ');
    for (const file of files) if (/\.md$/.test(file)) pairs.push({ sha, at: Number(ct) * 1000, by: by.join(' '), file });
  }
  const blobs = await catFiles(repo, pairs.flatMap((p) => [`${p.sha}^:${p.file}`, `${p.sha}:${p.file}`]));
  const edits = new Map<string, Edit[]>();
  for (const p of pairs.reverse()) {
    const before = blobs.get(`${p.sha}^:${p.file}`) ?? '';
    const after = blobs.get(`${p.sha}:${p.file}`) ?? '';
    const list = edits.get(p.file) ?? [];
    list.push({ before, after, at: p.at, by: p.by, href: href(p.file, p.sha) ?? undefined });
    edits.set(p.file, list);
  }
  historyCache.set(key, { head, edits });
  return edits;
}

/** `git cat-file --batch` for many objects at once; a missing one is left out. */
function catFiles(repo: string, specs: string[]): Promise<Map<string, string>> {
  return new Promise((resolve) => {
    const out = new Map<string, string>();
    if (!specs.length) return resolve(out);
    const child = spawn('git', ['cat-file', '--batch'], { cwd: repo, stdio: ['pipe', 'pipe', 'ignore'] });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (b: Buffer) => chunks.push(b));
    child.on('error', () => resolve(out));
    child.on('close', () => {
      const buf = Buffer.concat(chunks);
      let pos = 0;
      for (const spec of specs) {
        const nl = buf.indexOf(10, pos);
        if (nl < 0) break;
        const head = buf.subarray(pos, nl).toString();
        pos = nl + 1;
        const m = / blob (\d+)$/.exec(head);
        if (!m) continue;
        const size = Number(m[1]);
        out.set(spec, buf.subarray(pos, pos + size).toString('utf8'));
        pos += size + 1;
      }
      resolve(out);
    });
    child.stdin.end(specs.join('\n') + '\n');
  });
}

/** A GitHub file link for a repo URL, or null when the repo isn't on GitHub. */
export function githubHref(repoUrl: string | null | undefined, ref: string, file: string, line?: number): string | null {
  const m = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(repoUrl ?? '');
  return m ? `https://github.com/${m[1]}/${m[2]}/blob/${ref}/${file.split('/').map(encodeURIComponent).join('/')}${line ? `#L${line}` : ''}` : null;
}

/** A memory note's title for the rule column: its description's first clause, without a leading "Cara 2026-11-18:". */
export function memTitle(text: string): string {
  const { name, description } = frontmatter(text);
  const d = description.replace(/\\"/g, '"').split(/\s+[—–]\s+|;\s+/)[0].replace(/^\p{Lu}\p{Ll}+,?\s+20\d\d-\d\d-\d\d[:,]?\s*/u, '').trim();
  return lastSentence(d || name.replace(/-/g, ' ')).slice(0, 120);
}
