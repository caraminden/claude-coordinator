// The matcher behind one home per rule (#1162): finds copies of a registered rule (src/rule-homes.ts) and, for an
// instruction edit, every paragraph elsewhere that already speaks to the same thing. Pure functions over texts, so the
// repo test (test/rule-homes.test.ts) and the server's Settings check run the same code.
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { norm } from './decisions.ts';
import { PHRASE_HITS, RULE_HOMES, RUN_WORDS, type RuleHome } from './rule-homes.ts';

/** One text to search: a file or a Settings text, and whether it is code (each line its own paragraph). */
export interface Source { label: string; text: string; code?: boolean; href?: string | null }
export interface Para { text: string; line: number }
export interface Copy { rule: string; title: string; label: string; line: number; phrases: string[]; run: string | null; excerpt: string }

const LIST = /^\s{0,3}(?:[-*+]|\d+[.)])\s/;

/** Paragraphs as people read them: blank-line blocks and list items in markdown, lines in code. */
export function paragraphs(text: string, code = false): Para[] {
  const out: Para[] = [];
  let cur: string[] = [];
  let start = 0;
  const flush = () => { if (cur.length) out.push({ text: cur.join(' '), line: start }); cur = []; };
  text.split('\n').forEach((l, i) => {
    if (code || !l.trim() || LIST.test(l) || /^#{1,6}\s/.test(l)) flush();
    if (!l.trim()) return;
    if (!cur.length) start = i + 1;
    cur.push(l.trim());
    if (code || /^#{1,6}\s/.test(l)) flush();
  });
  flush();
  return out;
}

/** A markdown section under the heading that contains `heading`, down to the next heading of its level or above. */
export function section(text: string, heading: string): string | null {
  const lines = text.split('\n');
  const at = lines.findIndex((l) => /^#{1,6}\s/.test(l) && norm(l).includes(norm(heading)));
  if (at < 0) return null;
  const level = /^#+/.exec(lines[at])![0].length;
  const end = lines.findIndex((l, i) => i > at && new RegExp(`^#{1,${level}}\\s`).test(l));
  return lines.slice(at + 1, end < 0 ? undefined : end).join('\n');
}

/** A code statement from the line that starts with `anchor` to the line that ends it. */
export function statement(text: string, anchor: string): string | null {
  const lines = text.split('\n');
  const at = lines.findIndex((l) => l.trimStart().startsWith(anchor));
  if (at < 0) return null;
  const end = lines.findIndex((l, i) => i >= at && (i === at ? /;\s*$/.test(l) : /^\S.*;\s*$|^\];?\s*$/.test(l)));
  return lines.slice(at, end < 0 ? undefined : end + 1).join('\n');
}

/** The rule's full text where its home is, or null when the home isn't among the texts given. */
export function homeText(rule: RuleHome, read: (file: string) => string | null, citadel: string | null): string | null {
  const h = rule.home;
  if (h.kind === 'citadel') return citadel === null ? null : section(citadel, h.section);
  const text = read(h.file);
  if (text === null) return null;
  return h.section ? section(text, h.section) : h.anchor ? statement(text, h.anchor) : text;
}

/** The rule's phrases a paragraph uses. */
export function phraseHits(par: string, rule: RuleHome): string[] {
  const n = ` ${norm(par)} `;
  return rule.phrases.filter((p) => n.includes(` ${norm(p)}`));
}

/** Every run of RUN_WORDS words in a text, normalised. */
export function runs(text: string, size = RUN_WORDS): Set<string> {
  const w = norm(text).split(' ').filter(Boolean);
  const out = new Set<string>();
  for (let i = 0; i + size <= w.length; i++) out.add(w.slice(i, i + size).join(' '));
  return out;
}

/** The first run of RUN_WORDS words a paragraph shares with a set of runs, or null. */
export function sharedRun(par: string, home: Set<string>): string | null {
  for (const r of runs(par)) if (home.has(r)) return r;
  return null;
}

const excerpt = (s: string) => (s.length > 160 ? `${s.slice(0, 157)}…` : s);

/**
 * Copies of each rule in the sources: a paragraph with PHRASE_HITS or more of its phrases, or a run of words shared
 * with its home. The home's own paragraphs are skipped: those whose text is inside the home text given.
 */
export function findCopies(sources: Source[], homes: Map<string, string | null>, rules = RULE_HOMES): Copy[] {
  const out: Copy[] = [];
  for (const rule of rules) {
    const home = homes.get(rule.id) ?? null;
    const homeRuns = home ? runs(home) : new Set<string>();
    const homeNorm = home ? norm(home) : null;
    for (const s of sources) {
      for (const p of paragraphs(s.text, s.code)) {
        const n = norm(p.text);
        if (homeNorm && n && homeNorm.includes(n)) continue;
        const phrases = phraseHits(p.text, rule);
        const run = sharedRun(p.text, homeRuns);
        if (phrases.length >= PHRASE_HITS || run) out.push({ rule: rule.id, title: rule.title, label: s.label, line: p.line, phrases, run, excerpt: excerpt(p.text) });
      }
    }
  }
  return out;
}

const STOP = new Set('about after again also any been before being both but can cannot does each else even every from have here into its just like many more most must never next none not once only other over same should some such than that their them then there these they this those through under until upon very what when where which while who whom why will with would your yours'.split(' '));
const content = (s: string) => new Set(norm(s).split(' ').filter((w) => w.length > 3 && !STOP.has(w)).map((w) => w.replace(/(ing|ed|es|s)$/, '')));

/** A paragraph elsewhere that speaks to the same thing as an edit's new words. */
export interface Overlap { label: string; href: string | null; line: number; excerpt: string; why: string }

/** Paragraphs of `text` that are new against `before` (an edit's added words). */
export function added(before: string, text: string): Para[] {
  const old = new Set(paragraphs(before).map((p) => norm(p.text)));
  return paragraphs(text).filter((p) => !old.has(norm(p.text)) && norm(p.text).split(' ').length >= 6);
}

/**
 * What already speaks to an edit's new paragraphs: a registered rule they repeat (outside its home section), and any
 * paragraph in the sources that shares a run of words with them or most of their content words.
 * `inHome(rule, para)` says whether a new paragraph sits in that rule's own home, where its phrases belong.
 */
export function overlapsFor(news: Para[], sources: Source[], inHome: (rule: RuleHome, p: Para) => boolean, rules = RULE_HOMES): Overlap[] {
  const out: Overlap[] = [];
  const seen = new Set<string>();
  const push = (o: Overlap) => { const k = `${o.label}|${o.line}|${o.why}`; if (!seen.has(k)) { seen.add(k); out.push(o); } };
  for (const p of news) {
    for (const rule of rules) {
      const hits = phraseHits(p.text, rule);
      if (hits.length >= PHRASE_HITS && !inHome(rule, p)) push({ label: `Registered rule: ${rule.title}`, href: null, line: p.line, excerpt: excerpt(p.text), why: `repeats it (${hits.map((h) => `"${h}"`).join(', ')}); its one home is ${rule.pointer}` });
    }
    const pr = runs(p.text);
    const pw = content(p.text);
    const pn = norm(p.text);
    for (const s of sources) {
      for (const q of paragraphs(s.text, s.code)) {
        const qn = norm(q.text);
        if (!qn || qn === pn) continue;
        let why: string | null = null;
        for (const r of runs(q.text)) if (pr.has(r)) { why = `shares "${r}"`; break; }
        if (!why) {
          const qw = content(q.text);
          const both = [...pw].filter((w) => qw.has(w)).length;
          if (both >= 6 && both / Math.min(pw.size, qw.size) >= 0.6) why = `shares ${both} of its words`;
        }
        if (why) push({ label: s.label, href: s.href ?? null, line: q.line, excerpt: excerpt(q.text), why });
      }
    }
  }
  return out;
}

/** The repo files whose words reach agents: the prompt, the tool descriptions, the kit, CLAUDE.md and the rule files. */
export function repoSources(root: string): Source[] {
  const files: string[] = ['src/prompts.ts', 'src/mcp.ts', 'src/tripwire-blocks.ts', 'public/model-table.js', 'CLAUDE.md', 'AGENTS.md'];
  const walk = (dir: string) => {
    let names: string[] = [];
    try { names = readdirSync(join(root, dir)).sort(); } catch { return; }
    for (const n of names) {
      const rel = `${dir}/${n}`;
      const st = lstatSync(join(root, rel));
      if (st.isDirectory()) { if (n !== 'node_modules') walk(rel); } else if (/\.(md|ts)$/.test(n)) files.push(rel);
    }
  };
  walk('kit');
  walk('.claude');
  return files.flatMap((f) => {
    try { return [{ label: f, text: readFileSync(join(root, f), 'utf8'), code: !f.endsWith('.md') }]; } catch { return []; }
  });
}

/** Each rule's home text as the repo holds it (Citadel-wide homes are null here: they live in Settings). */
export function repoHomes(root: string, citadel: string | null = null): Map<string, string | null> {
  const read = (f: string) => { try { return readFileSync(join(root, f), 'utf8'); } catch { return null; } };
  return new Map(RULE_HOMES.map((r) => [r.id, homeText(r, read, citadel)]));
}
