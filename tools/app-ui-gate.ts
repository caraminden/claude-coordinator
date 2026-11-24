// The UI gate for an app (#1146): the sweep's checks (ui-measure: padding, tap size, overflow, clipped text,
// double borders, bare links) plus Citadel UI's contract (test/ui-contract.json: no cui-* class or --citadel-*
// name the kit doesn't define), run on one app's own pages from its repo or CI.
//
//   node tools/app-ui-gate.ts --app-dir <app repo> [--paths /,/settings] [--mode report|gate] [--out <dir>]
//        [--allow <json>] [--name <app>] [--cmd 'node server.ts'] [--workdir app] [--env K=V ...] [--widths 1440,390] [--health /healthz]
//
// It starts the app as Citadel would (citadel-app.json's start, workdir and env, on a free port with BASE_PATH,
// CITADEL_URL and CITADEL_KEYS pointing at the fake Citadel), so the app must be built already. Pages load
// signed in as the fake's one person. Default mode is report: it prints and writes findings and exits 0;
// only `--mode gate` exits 1 on a finding, which an app's scheme turns on once its report is clean.
// It writes <out>/report.json and <out>/report.md.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { freePort } from '../src/ports.ts';
import { startFakeCitadel } from '../kit/skills/contraption-ui/fake-citadel/fake-citadel.ts';
import { measure } from '../kit/skills/critique/scripts/ui-measure.mjs';

const root = resolve(import.meta.dirname, '..');
const contract = JSON.parse(readFileSync(join(root, 'test/ui-contract.json'), 'utf8'));

/** The kit names an app's own files use that the kit doesn't define. `texts` are the page's HTML, CSS and JS. */
export function contractFindings(texts: Record<string, string>) {
  const known = new Set<string>(Object.values(contract.css).flat() as string[]);
  const vars = new Set<string>(contract.theme);
  const out: { file: string; kind: 'unknown-class' | 'unknown-var'; name: string }[] = [];
  for (const [file, text] of Object.entries(texts)) {
    const t = text.replace(/\/\*[\s\S]*?\*\//g, '');
    for (const n of new Set([...t.matchAll(/(?<![\w-])(cui-[a-z][\w-]*)/g)].map((m) => m[1])))
      // A class an app defines itself (`.cui-x {` in its own CSS) is its own; only unreached kit names count.
      if (!known.has(n) && !new RegExp(`\\.${n}\\b`).test(t) && !/^cui-(?:turn|ask|reply|md)$/.test(n)) out.push({ file, kind: 'unknown-class', name: n });
    for (const n of new Set([...t.matchAll(/(--citadel-[a-z][\w-]*)/g)].map((m) => m[1])))
      if (!vars.has(n) && !new RegExp(`${n}\\s*:`).test(t)) out.push({ file, kind: 'unknown-var', name: n });
  }
  return out;
}

const WORDS: [string, RegExp][] = [
  ['contraption', /\bcontraptions?\b/i], ['minion', /\bminions?\b/i], ['scheme', /\bschemes?\b/i], ['taskmaster', /\btaskmasters?\b/i],
  ['grunt', /\bgrunts?\b/i], ['/home/', /\/home\//], ['shared/project', /shared\/project/], ['tickets/', /\btickets\//],
];
export type Allow = { word: string; file?: string; reason: string };

/** Citadel's own words, or a raw server path, in text an app's people read (#1181). The line it can draw: in a page's HTML
 *  that is its text plus title, alt, placeholder, aria-label and value attributes (script, style and comments are cut out);
 *  in a script it is the string literals with a space in them (prose), since a bare identifier or URL is code. It can't tell
 *  a prose string a person sees from one that only goes to a log, and it doesn't read an app agent's prompt, so a hit in a
 *  script is a candidate; an allow-list entry (word, optional file, a reason) records a real exception. */
export function wordFindings(texts: Record<string, string>, allow: Allow[]) {
  for (const a of allow) if (!a?.reason?.trim() || !a.word) throw new Error('an allow-list entry needs a word and a reason');
  const out: { file: string; where: 'page' | 'script'; word: string; text: string }[] = [];
  const add = (file: string, where: 'page' | 'script', text: string) => {
    for (const [word, re] of WORDS) {
      const m = re.exec(text);
      if (m && !allow.some((a) => a.word.toLowerCase() === word && (!a.file || a.file === file)) && !out.some((o) => o.file === file && o.word === word && o.where === where))
        out.push({ file, where, word, text: text.slice(Math.max(0, m.index - 30), m.index + 40).replace(/\s+/g, ' ').trim() });
    }
  };
  for (const [file, raw] of Object.entries(texts)) {
    if (/\.css$/.test(file)) continue;
    if (/\.m?js$/.test(file)) { scriptStrings(raw).forEach((t) => add(file, 'script', t)); continue; }
    let h = raw.replace(/<!--[\s\S]*?-->/g, '');
    for (const m of h.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) scriptStrings(m[1]).forEach((t) => add(file, 'script', t));
    h = h.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '');
    for (const m of h.matchAll(/\b(?:title|alt|placeholder|aria-label|aria-description|value)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) add(file, 'page', m[1] ?? m[2]);
    add(file, 'page', h.replace(/<[^>]*>/g, ' '));
  }
  return out;
}

/** The string literals of a script that read as prose (they hold a space), comments cut out. */
function scriptStrings(js: string) {
  const t = js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/[^\n]*/g, '$1');
  return [...t.matchAll(/"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g)].map((m) => m[1] ?? m[2] ?? (m[3] ?? '').replace(/\$\{[^}]*(?:\}|$)/g, " ")).filter((x) => /\s/.test(x.trim()));
}

/** What ui-measure reads from a page: browser results are untyped JSON, so this names the fields read. */
interface Measured {
  ok: boolean;
  error?: string;
  counts: Record<string, number>;
  pages: { width: number; findings?: { check: string; selector?: string; text?: string }[] }[];
}

interface GateOpts {
  paths: string[];
  mode: string;
  widths: number[];
  env: string[];
  dir?: string;
  out?: string;
  name?: string;
  cmd?: string[];
  workdir?: string;
  health?: string;
  allow?: string;
}

function args(argv: string[]) {
  const o: GateOpts = { paths: ['/'], mode: 'report', widths: [1440, 390], env: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = () => { if (i + 1 >= argv.length) throw new Error(`${a} needs a value`); return argv[++i]; };
    if (a === '--app-dir') o.dir = resolve(v());
    else if (a === '--paths') o.paths = v().split(',');
    else if (a === '--mode') { o.mode = v(); if (!['report', 'gate'].includes(o.mode)) throw new Error('--mode is report or gate'); }
    else if (a === '--out') o.out = resolve(v());
    else if (a === '--name') o.name = v();
    else if (a === '--cmd') o.cmd = v().split(' ');
    else if (a === '--workdir') o.workdir = v();
    else if (a === '--health') o.health = v();
    else if (a === '--widths') o.widths = v().split(',').map(Number);
    else if (a === '--allow') o.allow = resolve(v());
    else if (a === '--env') o.env.push(v());
    else throw new Error(`unknown option ${a}`);
  }
  if (!o.dir) throw new Error('--app-dir is required');
  return { ...o, dir: o.dir };
}

export async function gate(o: ReturnType<typeof args>) {
  const manifest = existsSync(join(o.dir, 'citadel-app.json')) ? JSON.parse(readFileSync(join(o.dir, 'citadel-app.json'), 'utf8')) : {};
  const name: string = o.name ?? basename(o.dir);
  const start: string[] = o.cmd ?? manifest.start;
  if (!start) throw new Error('no start command: citadel-app.json has no "start"; pass --cmd');
  const sub = (s: string) => s.replace(/^~(?=\/)/, homedir());
  const fake = await startFakeCitadel({ app: name });
  const port = await freePort();
  const data = mkdtempSync(join(tmpdir(), 'app-ui-gate-'));
  const base = `/apps/${name}`;
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>), ...Object.fromEntries(Object.entries(manifest.env ?? {}).map(([k, v]) => [k, sub(String(v))])),
    PORT: String(port), BASE_PATH: base, DATA_DIR: data, CITADEL_URL: fake.url, CITADEL_KEYS: fake.keysDir, NODE_ENV: 'production',
    ...Object.fromEntries(o.env.map((e: string) => [e.slice(0, e.indexOf('=')), e.slice(e.indexOf('=') + 1)])),
  };
  const child = spawn(sub(start[0]), start.slice(1), { cwd: join(o.dir, o.workdir ?? manifest.workdir ?? '.'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  for (const s of [child.stdout, child.stderr]) s!.on('data', (d) => (log = (log + d).slice(-3000)));
  const headers = { 'x-citadel-identity': fake.identity() };
  const url = (p: string) => `http://127.0.0.1:${port}${base}${p === '/' ? '/' : p}`;
  const stop = async () => { if (child.exitCode === null) child.kill(); await fake.close(); rmSync(data, { recursive: true, force: true }); };
  try {
    const health = o.health ?? manifest.health ?? `${base}/`;
    for (const end = Date.now() + 60_000; ; await new Promise((r) => setTimeout(r, 300))) {
      if (child.exitCode !== null) throw new Error(`the app exited at boot (${child.exitCode}):\n${log}`);
      if (Date.now() > end) throw new Error(`the app did not answer ${health} in 60 s:\n${log}`);
      if (await fetch(`http://127.0.0.1:${port}${health}`, { headers, redirect: 'manual' }).then((r) => r.status < 500, () => false)) break;
    }
    // The page's own HTML, plus the same-origin CSS and JS it links one level deep.
    const texts: Record<string, string> = {};
    const get = (u: string) => fetch(u, { headers, signal: AbortSignal.timeout(10_000) }).then((r) => (r.ok ? r.text() : ''), () => '');
    for (const p of o.paths) {
      const html = await get(url(p));
      texts[p] = html;
      for (const m of html.matchAll(/(?:src|href)="([^"#?]+\.(?:css|js|mjs))(?:\?[^"]*)?"/g)) {
        const u = new URL(m[1], url(p));
        if (u.origin === `http://127.0.0.1:${port}` && !texts[u.pathname]) texts[u.pathname] = await get(u.href);
      }
    }
    const pages: { path: string; ok: boolean; error?: string; counts: Record<string, number>; pages: Measured['pages'] }[] = [];
    for (const p of o.paths) {
      const r: Measured = await measure({ urls: [url(p)], widths: o.widths, settle: 800, cookies: [], headers: [`x-citadel-identity: ${fake.identity()}`], ignore: [], dark: false })
        .catch((e: Error) => ({ ok: false, error: e.message, pages: [], counts: {} }));
      pages.push({ path: p, ok: r.ok, error: r.error, counts: r.counts, pages: (r.pages ?? []).map((x) => ({ width: x.width, findings: x.findings })) });
    }
    const contractF = contractFindings(texts);
    // Allow-list: --allow, else <app>/ui-gate-allow.json: [{ "word": "scheme", "file": "/", "reason": "a colour scheme" }]
    const allowFile = o.allow ?? join(o.dir, 'ui-gate-allow.json');
    const wordF = wordFindings(texts, existsSync(allowFile) ? JSON.parse(readFileSync(allowFile, 'utf8')) : []);
    const measured = pages.reduce((n, p) => n + Object.values(p.counts ?? {}).reduce((a: number, b) => a + (b as number), 0), 0);
    const errors = pages.filter((p) => p.error).length;
    return { app: name, mode: o.mode, measured, contract: contractF, words: wordF, pages, errors, clean: !measured && !contractF.length && !wordF.length && !errors };
  } finally {
    await stop();
  }
}

export function markdown(r: Awaited<ReturnType<typeof gate>>) {
  const l = [`# UI gate: ${r.app}`, '', `Mode: ${r.mode}. ${r.clean ? 'Clean.' : 'Findings below.'}`, ''];
  for (const p of r.pages) {
    l.push(`## ${p.path}`, p.error ? `Could not measure: ${p.error}` : Object.keys(p.counts ?? {}).length ? p.pages.flatMap((x) => (x.findings ?? []).map((f) => `- ${x.width}px ${f.check}: ${String(f.selector ?? f.text ?? '').slice(0, 90)}`)).join('\n') : 'No measure findings.', '');
  }
  l.push('## Kit contract', r.contract.length ? r.contract.map((c) => `- ${c.kind} \`${c.name}\` in ${c.file}`).join('\n') : 'No unknown cui-* classes or --citadel-* names.');
  l.push('', '## Citadel words', r.words?.length ? r.words.map((w) => `- ${w.word} (${w.where}) in ${w.file}: "${w.text}"`).join('\n') : 'No internal words or server paths in what people read.');
  return l.join('\n') + '\n';
}

if (import.meta.main) {
  const o = args(process.argv.slice(2));
  const r = await gate(o);
  const out = o.out ?? join(process.env.TMPDIR || tmpdir(), `app-ui-gate-${r.app}`);
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'report.json'), JSON.stringify(r, null, 1) + '\n');
  writeFileSync(join(out, 'report.md'), markdown(r));
  console.log(markdown(r));
  if (o.mode === 'gate' && !r.clean) process.exitCode = 1;
}
