#!/usr/bin/env -S node --no-warnings
// Size room (#2139): whether this branch, shipped after main and every ship ahead of it in line, still keeps each file it
// grows within test/size-budget.test.ts's limit. Ships that each grow a big file a little pass alone and go red
// together; on 2026-11-25 that sent ships back into line one after another (20 of 23 guard refusals). This adds up
// what each ship does to a file's lines and to its ALLOWED number (the size list's count merge adds raises up, #1917),
// so it needs no worktree and no rebase: about a second. land.sh's smoke check runs it before the line, and its train
// guard names the ships ahead with it; a minion runs it by hand before it hands off:
//   node tools/size-room.ts                 this branch (HEAD) after main and the ships in the live line
//   --main <ref>                            main (default main)
//   --self [<label>=]<ref | from..to>       the ship checked (default HEAD)
//   --ahead [<label>=]<ref | from..to>      a ship ahead (repeatable); with none, the live line's (--queue)
//   --queue <dir>                           the line's tickets (default <live checkout's git dir>/cc-deploy/queue)
// A bare <ref> counts what it changed since its merge base with main, or since the tip of another ship it sits on;
// from..to counts exactly that range (a ship train's steps). Exit 0: it fits (each file it grows and how much room is
// left), 1: a file it grows would be over (the file, how far, and which ships ahead used the room), 2: usage (a
// bad ref or folder too), 3: git failed (land.sh refuses only on 1).
// shortcut: the line's order isn't read, so a ship that joined after this one counts as ahead; every one ahead is
// counted whether or not it ends up shipping.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const LIST = 'test/size-budget.test.ts';
type Ship = { label: string; from: string; to: string };
type Sizes = { limit: number; slack: number; roots: string[]; code: RegExp; allowed: Map<string, number> };

const run = (args: string[]) => spawnSync('git', args, { encoding: 'utf8', maxBuffer: 64 << 20 });
const git = (...args: string[]) => {
  const r = run(args);
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.trim()}`);
  return r.stdout.trim();
};
const has = (ref: string) => run(['rev-parse', '-q', '--verify', `${ref}^{commit}`]).status === 0;
const show = (ref: string, path: string) => {
  const r = run(['show', `${ref}:${path}`]);
  return r.status === 0 ? r.stdout : null;
};

/** The size list's settings and ALLOWED numbers, read as text: an entry is `'path': [n,` on one line or n on the next. */
export function readSizes(text: string): Sizes {
  const num = (re: RegExp, fallback: number) => Number(re.exec(text)?.[1] ?? fallback);
  const roots = /^const ROOTS = \[(.*)\];$/m.exec(text)?.[1] ?? "'src'";
  const code = /^const CODE = \/(.*)\/;$/m.exec(text)?.[1] ?? '.';
  const allowed = new Map([...text.matchAll(/^ {2}'([^']+)': \[\s*(\d+),/gm)].map((m) => [m[1]!, Number(m[2])]));
  return { limit: num(/^export const LIMIT = (\d+);$/m, 1500), slack: num(/^export const SLACK = (\d+);$/m, 0), roots: [...roots.matchAll(/'([^']+)'/g)].map((m) => m[1]!), code: new RegExp(code), allowed };
}
const sizesAt = (ref: string) => readSizes(show(ref, LIST) ?? '');

/** Each changed file's change in lines over <from>..<to>. */
function growth(from: string, to: string) {
  const out = new Map<string, number>();
  for (const line of git('diff', '--numstat', '--no-renames', from, to).split('\n')) {
    const [add, del, path] = line.split('\t');
    if (path) out.set(path, add === '-' ? 0 : Number(add) - Number(del));
  }
  return out;
}

/** The ships in the live line: each ticket's 3rd line is its branch, kept while its process (1st line) lives when <alive>. A
 * minion's turn can't see land.sh's processes, so by hand every ticket counts: whoever waits behind a dead one deletes it. */
function queued(dir: string, alive: boolean): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const f of readdirSync(dir)
    .filter((f) => /^\d+$/.test(f))
    .sort()) {
    const lines = (() => {
      try {
        return readFileSync(join(dir, f), 'utf8').split('\n');
      } catch {
        return []; // gone since the listing: it left the line
      }
    })();
    const pid = lines[0]?.split(' ')[0];
    if (pid && lines[2] && (!alive || existsSync(`/proc/${pid}`))) out.push(lines[2]);
  }
  return out;
}
function liveQueue() {
  const live = process.env.DEPLOY_LIVE || join(process.env.HOME ?? '', 'claude-coordinator');
  const r = run(['-C', live, 'rev-parse', '--absolute-git-dir']);
  return r.status === 0 ? join(r.stdout.trim(), 'cc-deploy', 'queue') : '';
}

/** <label>=<spec> or <spec>, each made a range: a bare ref from its base (see the top). */
function ships(specs: string[], main: string): Ship[] {
  const parsed = specs.map((s) => {
    const at = s.indexOf('=');
    const [label, spec] = at > 0 ? [s.slice(0, at), s.slice(at + 1)] : [s, s];
    const [from, to] = spec.includes('..') ? spec.split('..') : ['', spec];
    return { label, from: from!, to: to! };
  });
  // Each bare ref's commits past main, once (git calls grow with the line, not with its square): a ship whose tip is
  // among another's sits under it, and the one with the most such commits is the newest it sits on.
  const past = new Map(parsed.filter((s) => !s.from).map((s) => [s.to, new Set(git('rev-list', `${main}..${s.to}`).split('\n').filter(Boolean))]));
  const tip = new Map(parsed.filter((s) => !s.from).map((s) => [s.to, git('rev-parse', `${s.to}^{commit}`)]));
  return parsed.map((s) => {
    if (s.from) return s;
    const under = parsed.filter((o) => !o.from && tip.get(o.to) !== tip.get(s.to) && past.get(s.to)!.has(tip.get(o.to)!));
    const on = under.sort((a, b) => past.get(b.to)!.size - past.get(a.to)!.size)[0];
    return { ...s, from: on ? tip.get(on.to)! : git('merge-base', main, s.to) };
  });
}

export function main(argv: string[]) {
  let mainRef = 'main';
  let self = 'HEAD';
  let queue = '';
  const ahead: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (!value || !['--main', '--self', '--ahead', '--queue'].includes(flag!)) {
      console.error(`size room: usage: node tools/size-room.ts [--main <ref>] [--self [<label>=]<ref>] [--ahead [<label>=]<ref>]... [--queue <dir>]`);
      return 2;
    }
    i++;
    if (flag === '--main') mainRef = value;
    else if (flag === '--self') self = value;
    else if (flag === '--ahead') ahead.push(value);
    else queue = value;
  }
  // A bad ref or the wrong folder is a usage error, never a quiet "fits"; a main with no size list has nothing to check.
  for (const ref of [mainRef, ...self.split('=').at(-1)!.split('..')].filter(Boolean)) {
    if (!has(ref)) {
      console.error(`size room: ${ref} is not a commit here (run it in the repo, with a ref that exists)`);
      return 2;
    }
  }
  if (show(mainRef, LIST) === null) return 0;
  // This ship's label: its branch's name unless one was given (HEAD on a branch reads as the branch).
  const me = self.includes('=') ? self.slice(0, self.indexOf('=')) : run(['rev-parse', '--abbrev-ref', self.split('..').at(-1)!]).stdout.trim() || self;
  if (ahead.length === 0) for (const b of queued(queue || liveQueue(), queue !== '')) if (b !== me && has(`refs/heads/${b}`)) ahead.push(`${b}=refs/heads/${b}`);
  const all = ships([...ahead, self.includes('=') ? self : `${me}=${self}`], mainRef);
  const mine = all.pop()!;
  const at = sizesAt(mainRef);
  const counted = (p: string) => at.roots.some((r) => p.startsWith(`${r}/`)) && at.code.test(p.slice(p.lastIndexOf('/') + 1));
  // What each ship does to a file's lines and to its ALLOWED number.
  const step = (s: Ship) => {
    const changed = growth(s.from, s.to);
    const raised = new Map<string, number>();
    if (changed.has(LIST)) {
      const [was, now] = [sizesAt(s.from).allowed, sizesAt(s.to).allowed];
      for (const p of new Set([...was.keys(), ...now.keys()])) if ((now.get(p) ?? 0) !== (was.get(p) ?? 0)) raised.set(p, (now.get(p) ?? 0) - (was.get(p) ?? 0));
    }
    return { s, lines: new Map([...changed].filter(([p]) => counted(p))), raised };
  };
  const before = all.map(step);
  const it = step(mine);
  const sum = (m: 'lines' | 'raised', p: string) => before.reduce((n, b) => n + (b[m].get(p) ?? 0), 0);
  let over = 0;
  for (const [path, grew] of [...it.lines].sort()) {
    if (grew <= 0) continue;
    const lines = (show(mainRef, path) ?? '').split('\n').length - 1;
    const listed = at.allowed.has(path) || before.some((b) => b.raised.has(path)) || it.raised.has(path);
    const number = (at.allowed.get(path) ?? 0) + sum('raised', path) + (it.raised.get(path) ?? 0);
    const cap = listed ? number + at.slack : at.limit;
    const theirs = sum('lines', path);
    const total = lines + theirs + grew;
    const why = listed ? `its ALLOWED number ${number} + ${at.slack} slack` : 'unlisted';
    const who = before.filter((b) => (b.lines.get(path) ?? 0) !== 0).map((b) => `${b.s.label} ${signed(b.lines.get(path)!)}`);
    const ships = before.length === 0 ? 'no ships ahead' : who.length ? `the ships ahead: ${who.join(', ')}` : `${before.length} ships ahead, none changing it`;
    if (total <= cap) {
      if (listed || total > at.limit - 100) console.log(`size room: ${path}: ${total} of ${cap} lines (${why}) with main ${lines}, ${ships} and ${mine.label} ${signed(grew)}: ${cap - total} left`);
      continue;
    }
    over++;
    console.log(
      `size room: ${path} would be ${total} lines, ${total - cap} over its limit ${cap} (${why}): main has ${lines}, ${ships}, and ${mine.label} adds ${grew}.` +
        ` Split it, or raise its number in ${LIST} by ${total - cap} or more with a reason${theirs > 0 && lines + theirs <= cap ? ` (${theirs} of its room went to the ships ahead)` : ''}`,
    );
  }
  return over ? 1 : 0;
}
const signed = (n: number) => (n < 0 ? `${n}` : `+${n}`);

if (import.meta.main) {
  // A git failure is exit 3, not 1: land.sh refuses a ship only on 1 (over its limit).
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (e) {
    console.error(`size room: could not check: ${e instanceof Error ? e.message : e}`);
    process.exit(3);
  }
}
