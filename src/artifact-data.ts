// The artifact bridge (#168): what an HTML page saves through it, its limits, and the script injected
// into every page served under a file token, which gives the page `citadel`, `window.claude.use('db')`,
// `window.storage` and a working `localStorage`. The page reaches the server only through the viewer
// that framed it (public/bridge-host.js), with the signed-in person's session.
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { linkifyHtml } from '../public/ui/markdown.js';
import type { ArtifactDatum, Store } from './db.ts';
import { HttpError } from './http.ts';

export const LIMITS = {
  keyChars: 200,
  /** One value, as JSON text. */
  valueBytes: 64 * 1024,
  keys: 2000,
  /** Keys and values of one page's store together. */
  storeBytes: 2 * 1024 * 1024,
  /** Keys one write may set or delete. */
  entries: 100,
  /** The text a page may put in the comment box. */
  sendChars: 10_000,
};

/** A page's store as people and agents see it: values parsed. */
export const entriesView = (rows: ArtifactDatum[]) => rows.map((r) => ({ key: r.key, value: JSON.parse(r.value), by: r.by, at: r.at }));

/** A short name for a page's store, so the viewer can tell which broadcast is about its frame without seeing paths. */
export const storeId = (projectId: number, file: string) => createHash('sha256').update(`${projectId}\0${file}`).digest('base64url').slice(0, 16);

/** A write's entries, checked: each a key and a JSON value, or `value: null` (or absent) to delete it. */
export function cleanEntries(raw: unknown): { key: string; value: string | null }[] {
  if (!Array.isArray(raw) || !raw.length) throw new HttpError(400, 'entries must be a non-empty list');
  if (raw.length > LIMITS.entries) throw new HttpError(413, `At most ${LIMITS.entries} keys per write`);
  return raw.map((e) => {
    const key = e?.key;
    if (typeof key !== 'string' || !key || key.length > LIMITS.keyChars || key.includes('\0')) throw new HttpError(400, `Each key is 1 to ${LIMITS.keyChars} characters`);
    if (e.value === undefined || e.value === null) return { key, value: null };
    const value = JSON.stringify(e.value);
    if (Buffer.byteLength(value) > LIMITS.valueBytes) throw new HttpError(413, `"${key.slice(0, 40)}" is over ${LIMITS.valueBytes / 1024} KB`);
    return { key, value };
  });
}

/** Apply a write to a page's store, refusing it whole if the store would pass its limits. */
export function writeStore(store: Store, projectId: number, file: string, entries: { key: string; value: string | null }[], by: string) {
  const after = new Map(store.artifactData(projectId, file).map((r) => [r.key, r.value]));
  for (const e of entries) {
    if (e.value === null) after.delete(e.key);
    else after.set(e.key, e.value);
  }
  if (after.size > LIMITS.keys) throw new HttpError(413, `A page keeps at most ${LIMITS.keys} keys`);
  let bytes = 0;
  for (const [k, v] of after) bytes += Buffer.byteLength(k) + Buffer.byteLength(v);
  if (bytes > LIMITS.storeBytes) throw new HttpError(413, `A page keeps at most ${LIMITS.storeBytes / 1024 / 1024} MB`);
  store.writeArtifactData(projectId, file, entries, by);
}

// The page's half of the bridge, read fresh when it changes so a front-end reload picks it up.
const BRIDGE_FILE = join(import.meta.dirname, '..', 'public', 'artifact-bridge.js');
let bridge = { mtime: -1, src: '' };
function bridgeSource(): string {
  const mtime = statSync(BRIDGE_FILE).mtimeMs;
  if (mtime !== bridge.mtime) {
    // The function alone: its header comment needn't ride along in every page.
    const src = readFileSync(BRIDGE_FILE, 'utf8');
    bridge = { mtime, src: src.slice(src.indexOf('(function (cfg)')).trim() };
  }
  return bridge.src;
}

/** JSON that can sit inside a <script> element: nothing in it can close the element or open a comment. */
const scriptJson = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

// What isn't the page's prose: comments, links and code already, the head, scripts, styles, form
// fields, buttons, SVG and MathML (an HTML <a> inside them would break them or do nothing). Whichever
// starts first wins, so a comment inside a <pre> or an <a> can't split it.
const NOT_PROSE = /<!--[\s\S]*?-->|<(a|code|pre|head|script|style|textarea|title|select|button|svg|math|noscript|iframe|object|template)\b[\s\S]*?<\/\1\s*>/gi;

/**
 * A page's bare URLs, DOIs and web addresses as new-tab links, the way Citadel's markdown links them
 * (#440): any URL a page shows is clickable, whether its author wrote the <a> or not.
 */
export function linkPageText(html: string): string {
  let out = '';
  let at = 0;
  for (const m of html.matchAll(NOT_PROSE)) {
    out += linkifyHtml(html.slice(at, m.index)) + m[0];
    at = m.index + m[0].length;
  }
  return out + linkifyHtml(html.slice(at));
}

/**
 * `html` with the bridge script as its first script, and its text's URLs linked (linkPageText): after a doctype (so the page keeps its mode) and
 * any comments or whitespace before it, else at the very start. `page` is the token path the page was
 * served under, which the viewer passes on so the server can check the frame still shows the file it opened.
 */
export function injectBridge(html: Buffer, cfg: { page: string; entries: ReturnType<typeof entriesView> }): Buffer {
  const text = linkPageText(html.toString('utf8'));
  const lead = /^\uFEFF?(?:\s|<!--[\s\S]*?-->)*(?:<!doctype[^>]*>)?/i.exec(text)![0];
  const script = `<script>${bridgeSource()}(${scriptJson(cfg)});</script>`;
  return Buffer.from(lead + script + text.slice(lead.length));
}
