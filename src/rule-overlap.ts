// The matcher behind one home per rule (#1162): finds copies of a registered rule (src/rule-homes.ts) and, for an
// instruction edit, every paragraph elsewhere that already speaks to the same thing. Pure functions over texts, so the
// repo test (test/rule-homes.test.ts) and the server's Settings check run the same code.
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { githubHref, norm } from './decisions.ts';
import { PHRASE_HITS, RULE_HOMES, RUN_WORDS, type RuleHome } from './rule-homes.ts';

/** One text to search: a file or a Settings text, whether it is code (each line its own paragraph), and its link (a GitHub file's gets the line). */
export interface Source {
  label: string;
  text: string;
  code?: boolean;
  href?: string | null;
}
export interface Para {
  text: string;
  line: number;
}
export interface Copy {
  rule: string;
  title: string;
  label: string;
  line: number;
  phrases: string[];
  run: string | null;
  excerpt: string;
}

const LIST = /^\s{0,3}(?:[-*+]|\d+[.)])\s/;

/** Paragraphs as people read them: blank-line blocks and list items in markdown, lines in code. */
export function paragraphs(text: string, code = false): Para[] {
  const out: Para[] = [];
  let cur: string[] = [];
  let start = 0;
  const flush = () => {
    if (cur.length) out.push({ text: cur.join(' '), line: start });
    cur = [];
  };
  text.split('\n').forEach((l, i) => {
    // A comment in code speaks to maintainers, not agents.
    if (code && /^\s*(?:\/\/|\/?\*)/.test(l)) return;
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
  if (h.kind === 'scheme') return null;
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

/** A paragraph elsewhere that speaks to the same thing as an edit's new words. */
/** `rule`: the registered rule's id, on a registered-rule hit (whose excerpt is the new words, not the rule's home). */
export interface Overlap {
  label: string;
  href: string | null;
  line: number;
  excerpt: string;
  why: string;
  rule?: string;
}

/** Paragraphs of `text` that are new against `before` (an edit's added words). */
export function added(before: string, text: string): Para[] {
  const old = new Set(paragraphs(before).map((p) => norm(p.text)));
  return paragraphs(text).filter((p) => !old.has(norm(p.text)) && norm(p.text).split(' ').length >= 6);
}

/**
 * What already speaks to an edit's new paragraphs: a registered rule they repeat (outside its home section), and any
 * paragraph in the sources that shares a run of RUN_WORDS words with them (Josh, 2026-11-20, #1211: no word-share test).
 * `inHome(rule, para)` says whether a new paragraph sits in that rule's own home, where its phrases belong.
 */
export function overlapsFor(news: Para[], sources: Source[], inHome: (rule: RuleHome, p: Para) => boolean, rules = RULE_HOMES): Overlap[] {
  const out: Overlap[] = [];
  const seen = new Set<string>();
  const push = (o: Overlap) => {
    const k = `${o.label}|${o.line}|${o.why}`;
    if (!seen.has(k)) {
      seen.add(k);
      out.push(o);
    }
  };
  const others = news.length ? sources.flatMap((s) => paragraphs(s.text, s.code).map((q) => ({ s, q, qn: norm(q.text), qr: runs(q.text) }))) : [];
  for (const p of news) {
    for (const rule of rules) {
      const hits = phraseHits(p.text, rule);
      if (hits.length >= PHRASE_HITS && !inHome(rule, p)) push({ label: `Registered rule: ${rule.title}`, href: null, line: p.line, excerpt: excerpt(p.text), rule: rule.id, why: `repeats ${hits.map((h) => `"${h}"`).join(', ')}; its one home is ${rule.pointer}` });
    }
    const pr = runs(p.text);
    const pn = norm(p.text);
    for (const { s, q, qn, qr } of others) {
      if (!qn || qn === pn) continue;
      const run = sharedRun(q.text, pr);
      if (run) push({ label: s.label, href: s.href && /^https:/.test(s.href) ? `${s.href}?plain=1#L${q.line}` : (s.href ?? null), line: q.line, excerpt: excerpt(q.text), why: `shares "${run}"` });
    }
  }
  return out;
}

/**
 * Markdown files (or those matching `re`) under a folder of a repo, as repo-relative paths; none when it is missing.
 * The one walker for instruction files: the Decisions page (src/decisions-load.ts) reads its sources with it too.
 */
export function mdFiles(repo: string, dir: string, depth = 6, re = /\.md$/i): string[] {
  if (depth < 0) return [];
  let names: string[];
  try {
    names = readdirSync(join(repo, dir));
  } catch {
    return [];
  }
  return names.sort().flatMap((n) => {
    const rel = dir ? `${dir}/${n}` : n;
    let st;
    // Never through a link: a linked file or folder could pull lines from outside the repo (as src/memory-files.ts refuses).
    try {
      st = lstatSync(join(repo, rel));
    } catch {
      return [];
    }
    return st.isDirectory() ? mdFiles(repo, rel, depth - 1, re) : re.test(n) ? [rel] : [];
  });
}

/** mdFiles with every folder read off the server's thread (#1980). */
export async function mdFilesA(repo: string, dir: string, depth = 6, re = /\.md$/i): Promise<string[]> {
  if (depth < 0) return [];
  const names = await readdir(join(repo, dir)).catch((): string[] => []);
  const found = await Promise.all(
    names.sort().map(async (n) => {
      const rel = dir ? `${dir}/${n}` : n;
      const st = await lstat(join(repo, rel)).catch(() => null);
      if (!st) return [];
      return st.isDirectory() ? mdFilesA(repo, rel, depth - 1, re) : re.test(n) ? [rel] : [];
    }),
  );
  return found.flat();
}

export const readIn = (root: string, f: string): string | null => {
  try {
    return lstatSync(join(root, f)).isFile() ? readFileSync(join(root, f), 'utf8') : null;
  } catch {
    return null;
  }
};
const fileSources = (root: string, files: string[], href: (f: string) => string | null): Source[] =>
  files.flatMap((f) => {
    const text = readIn(root, f);
    return text === null ? [] : [{ label: f, text, code: !f.endsWith('.md'), href: href(f) }];
  });

/** Citadel's own files whose words reach every scheme's agents: the prompt, the tool descriptions, the tripwire line, the model table and the kit. */
const CITADEL_FILES = ['src/prompts.ts', 'src/mcp.ts', 'src/mcp-apps.ts', 'src/mcp-ship.ts', 'src/mcp-cards.ts', 'src/mcp-scheme.ts', 'src/mcp-call.ts', 'src/mcp-minions.ts', 'src/mcp-lookup.ts', 'src/tripwire-blocks.ts', 'public/model-table.js'];

/** The repo files whose words reach agents: Citadel's own (above), CLAUDE.md, AGENTS.md and the rule files. */
export function repoSources(root: string): Source[] {
  const files = [...CITADEL_FILES, 'CLAUDE.md', 'AGENTS.md', ...mdFiles(root, 'kit', 6, /\.(md|ts)$/), ...mdFiles(root, '.claude', 6, /\.(md|ts)$/)];
  return fileSources(root, files, () => null);
}

/**
 * What a Settings edit is checked against (#1162): the other Settings text, the edited text itself, Citadel's prompt,
 * tool descriptions and kit (every scheme loads them), and the scheme repo's CLAUDE.md, AGENTS.md and rule files.
 */
export function settingsSources(o: { root: string; citadelUrl: string | null; pid: number; repo: string | null; repoUrl: string | null; scope: 'citadel' | 'scheme'; text: string; other: string }): Source[] {
  const gh = (url: string | null) => (f: string) => githubHref(url, 'main', f);
  const mine = o.scope === 'citadel' ? ['Citadel-wide instructions', 'app-instructions'] : ['Scheme instructions', 'instructions'];
  const theirs = o.scope === 'citadel' ? ['Scheme instructions', 'instructions'] : ['Citadel-wide instructions', 'app-instructions'];
  return [
    { label: mine[0], text: o.text, href: `#/p/${o.pid}/${mine[1]}` },
    { label: theirs[0], text: o.other, href: `#/p/${o.pid}/${theirs[1]}` },
    ...fileSources(o.root, [...CITADEL_FILES, ...mdFiles(o.root, 'kit')], gh(o.citadelUrl)),
    ...(o.repo ? fileSources(o.repo, [...new Set(['CLAUDE.md', 'AGENTS.md', ...mdFiles(o.repo, '.claude/rules'), ...schemeRules(o.repo).flatMap((r) => (r.home.kind === 'repo' ? [r.home.file] : []))])], gh(o.repoUrl)).map((s) => ({ ...s, label: `Scheme repo: ${s.label}` })) : []),
  ];
}

/** Whether a paragraph of a Settings text sits under the `## ` heading of a rule's home in that same text. */
export function inSettingsHome(scope: 'citadel' | 'scheme', text: string) {
  const lines = text.split('\n');
  return (rule: RuleHome, p: Para): boolean => {
    if (rule.home.kind !== scope) return false;
    const want = norm(rule.home.section);
    for (let i = p.line - 1; i >= 0; i--) if (/^#{1,6}\s/.test(lines[i])) return norm(lines[i]).includes(want);
    return false;
  };
}

/**
 * A scheme's own registered rules (#1211): its repo's .claude/rule-homes.json, a list shaped like RULE_HOMES whose homes
 * are a `scheme` Settings section or a `repo` file inside that repo. An entry that doesn't fit is skipped, and a missing
 * or broken file is no rules: a scheme's typo never blocks its saves.
 */
export function schemeRules(repo: string | null): RuleHome[] {
  if (!repo) return [];
  let list: unknown;
  try {
    list = JSON.parse(readIn(repo, '.claude/rule-homes.json') ?? '[]');
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];
  const text = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
  return list.flatMap((r: { id?: unknown; title?: unknown; pointer?: unknown; phrases?: unknown; home?: { kind?: unknown; section?: unknown; file?: unknown; anchor?: unknown } } | null): RuleHome[] => {
    if (!r || !text(r.id) || !text(r.title) || !text(r.pointer) || !Array.isArray(r.phrases)) return [];
    const h = r.home;
    const home =
      h?.kind === 'scheme' && text(h.section)
        ? { kind: 'scheme' as const, section: h.section }
        : // Inside the repo only: no absolute path and no `..` (readIn already refuses a link).
          h?.kind === 'repo' && text(h.file) && !isAbsolute(h.file) && !h.file.split(/[\\/]/).includes('..')
          ? { kind: 'repo' as const, file: h.file, ...(text(h.section) ? { section: h.section } : text(h.anchor) ? { anchor: h.anchor } : {}) }
          : null;
    const phrases = r.phrases.filter((p: unknown): p is string => typeof p === 'string' && norm(p) !== '').slice(0, 40);
    return home && phrases.length ? [{ id: r.id, title: r.title, home, pointer: r.pointer, phrases }] : [];
  });
}

/** Each rule's home text as the repo holds it (Citadel-wide homes are null here: they live in Settings). */
export function repoHomes(root: string, citadel: string | null = null): Map<string, string | null> {
  return new Map(RULE_HOMES.map((r) => [r.id, homeText(r, (f) => readIn(root, f), citadel)]));
}
