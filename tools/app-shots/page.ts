// The page people look at (#1783): the newest night's shots as one self-contained HTML file, its pictures inside it, one
// file per app in its home scheme's shared folder and one of every app in Citadel's own. No script: the file viewer runs none.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AppSpec } from '../../src/app-shots.ts';
import { pacificStamp } from '../../src/pacific.ts';
import { BIG_CHANGE, problems, where, type AppNight, type Night, type Shot } from '../../src/shot-judge.ts';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const CSS = `:root{color-scheme:light dark;--bg:#f7f6f4;--card:#fff;--ink:#1d1b1a;--dim:#6b6662;--line:#dedad5;--bad:#b3261e;--badbg:#fdeceb;--ok:#1b6b3a}
@media(prefers-color-scheme:dark){:root{--bg:#161514;--card:#201f1d;--ink:#eceae7;--dim:#a09a94;--line:#383532;--bad:#ff8a80;--badbg:#3a1f1d;--ok:#7fd1a0}}
*{box-sizing:border-box}body{margin:0;padding:20px clamp(12px,3vw,40px) 60px;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,sans-serif}
h1{font-size:24px;line-height:1.25;margin:0 0 4px}h2{font-size:19px;margin:36px 0 2px}h3{font-size:13px;font-weight:600;margin:18px 0 8px;color:var(--dim)}
p{margin:0 0 4px;max-width:75ch}.dim{color:var(--dim);font-size:13px}.ok{color:var(--ok)}.bad{color:var(--bad);font-weight:600}
ul.bad{margin:10px 0;padding:10px 14px 10px 30px;background:var(--badbg);border-radius:8px;font-weight:400;overflow-wrap:anywhere;max-width:100ch}
.shots{display:grid;gap:16px;align-items:start}.desktop{grid-template-columns:repeat(auto-fill,minmax(min(100%,360px),1fr))}.phone{grid-template-columns:repeat(auto-fill,minmax(min(45%,170px),1fr));max-width:1200px}
figure{margin:0;background:var(--card);border:1px solid var(--line);border-radius:8px;overflow:hidden}figure.broken{border-color:var(--bad)}
img{display:block;width:100%;height:auto;border-bottom:1px solid var(--line)}figcaption{padding:6px 10px;font-size:13px;overflow-wrap:anywhere}
.pair{display:grid;grid-template-columns:1fr 1fr}.pair img+img{border-left:1px solid var(--line)}nav{display:flex;flex-wrap:wrap;gap:4px 16px;margin:12px 0}nav a{line-height:40px}a{color:inherit}`;

function picture(outDir: string, path: string | null): string {
  const file = path && join(outDir, path);
  if (!file || !existsSync(file)) return '';
  return `data:image/webp;base64,${readFileSync(file).toString('base64')}`;
}

const label = (s: Shot) => (s.page === '/' ? 'Front page' : s.page.replace(/^> /, ''));

function figure(outDir: string, night: Night, a: AppNight, s: Shot, broken: boolean): string {
  const src = picture(outDir, s.thumb && join(night.day, a.app, s.thumb));
  const was = s.moved !== null && s.moved >= BIG_CHANGE ? picture(outDir, s.was && s.was.replace(/\.png$/, '.webp')) : '';
  const alt = `${a.title}, ${label(s)}, ${where(s.width)}`;
  const img = src ? `<img src="${src}" alt="${esc(alt)}">` : '';
  const pair = was ? `<div class="pair"><img src="${was}" alt="${esc(`${alt}, the night before`)}">${img}</div>` : img;
  return `<figure${broken ? ' class="broken"' : ''}>${pair}<figcaption>${esc(label(s))}${was ? ' <span class="dim">(before, now)</span>' : ''}${s.failed ? ' <span class="bad">not drawn</span>' : ''}</figcaption></figure>`;
}

function section(outDir: string, night: Night, a: AppNight): string {
  const found = problems(a);
  const state = a.skipped ? `<span class="dim">Not shot: ${esc(a.skipped)}</span>` : a.unshot !== null ? '<span class="bad">Not shot: the screenshot run failed on it</span>' : found.length ? `<span class="bad">${found.length} broken</span>` : '<span class="ok">Nothing broken</span>';
  const list = found.length ? `<ul class="bad">${found.map((p) => `<li>${p.page === null ? '' : `${esc(p.page === '/' ? 'Front page' : p.page.replace(/^> /, ''))}${p.width === null ? '' : ` (${where(p.width)})`}: `}${esc(p.text)}</li>`).join('')}</ul>` : '';
  const rows = [false, true].map((phone) => {
    const shots = a.shots.filter((s) => (where(s.width) === 'phone') === phone);
    if (!shots.length) return '';
    return `<h3>${phone ? 'Phone' : 'Desktop'}</h3><div class="shots ${phone ? 'phone' : 'desktop'}">${shots
      .map((s) =>
        figure(
          outDir,
          night,
          a,
          s,
          found.some((p) => p.page === s.page && p.width === s.width),
        ),
      )
      .join('')}</div>`;
  });
  const left = a.found.filter((k) => !a.shots.some((s) => s.page === k));
  const more = left.length ? `<p class="dim">Main pages not shot: ${left.map((k) => esc(k.replace(/^> /, ''))).join(', ')}.</p>` : '';
  return `<section id="${esc(a.app)}"><h2>${esc(a.title)}</h2><p>${state}${a.head ? ` <span class="dim">at ${esc(a.head.slice(0, 9))}</span>` : ''}</p>${more}${list}${rows.join('')}</section>`;
}

export function renderPage(outDir: string, night: Night, apps: AppNight[], title: string): string {
  const broken = apps.filter((a) => problems(a).length);
  const unshot = apps.filter((a) => a.unshot !== null || a.skipped);
  const nav = apps.length > 1 ? `<nav>${apps.map((a) => `<a href="#${esc(a.app)}"${problems(a).length ? ' class="bad"' : ''}>${esc(a.title)}</a>`).join('')}</nav>` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${CSS}</style></head><body>
<h1>${esc(title)}</h1><p>Taken ${esc(pacificStamp(night.endedAt))}. ${broken.length ? `<span class="bad">Broken: ${broken.map((a) => esc(a.title)).join(', ')}.</span>` : unshot.length ? 'Nothing broken in what was shot.' : '<span class="ok">Nothing broken.</span>'}${unshot.length ? ` <span class="bad">Not shot: ${unshot.map((a) => esc(a.title)).join(', ')}.</span>` : ''}</p>
<p class="dim">Each app is a throwaway copy of what is deployed, with no data and no network, signed in as a test person. The page is replaced every night.</p>${nav}
${apps.map((a) => section(outDir, night, a)).join('\n')}
</body></html>
`;
}

export function writePages(outDir: string, night: Night, specs: AppSpec[], all: string | null) {
  const write = (dir: string, name: string, html: string) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `.${name}.tmp`), html);
    renameSync(join(dir, `.${name}.tmp`), join(dir, name));
  };
  for (const a of night.apps) {
    const dir = specs.find((x) => x.app === a.app)?.page;
    if (dir) write(dir, `${a.app}.html`, renderPage(outDir, night, [a], `${a.title}: last night's screenshots`));
  }
  if (all) write(all, 'all-apps.html', renderPage(outDir, night, night.apps, "Every app: last night's screenshots"));
}
