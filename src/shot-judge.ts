// What a nightly contraption screenshot shows (#1783): which of a page's findings count as broken. Pure, no I/O.

/** A page with this much of its content moved is a big layout change. */
export const BIG_CHANGE = 0.4;

/** One page at one width, as tools/app-shots saw it. */
export interface Shot {
  /** The page's key: '/', '/history', or '> Label' for one a click on the front page opens. */
  page: string;
  width: number;
  /** The PNG's file name in its night's folder, or null when the page couldn't be drawn. */
  file: string | null;
  /** A smaller WebP of it, for the page people look at. */
  thumb: string | null;
  /** The document's HTTP status. */
  status: number;
  /** Its visible text, the first 400 characters. */
  text: string;
  /** Page errors: uncaught exceptions, console.error calls, and its own requests that failed. */
  errors: string[];
  /** The share of the picture in one colour. */
  flat: number;
  /** Share of its content that moved since the night before, or null: no picture then. */
  moved: number | null;
  /** The picture it was compared with, as a path in the folder of nights, or null. */
  was: string | null;
  /** What changed since that picture. */
  since: Since;
  /** Why it couldn't be drawn, or null. */
  failed: string | null;
}

/** What changed between two nights that a change of layout can be laid to: Citadel UI's own files, a ship of the app, nothing. */
export type Since = 'kit' | 'ship' | null;

/** A night's answer for one app. */
export interface AppNight {
  app: string;
  title: string;
  scheme: number | null;
  /** The deployed commit, and Citadel UI's files that night, so a change of layout can be laid to them. */
  head: string | null;
  kit: string | null;
  /** Why the app has no shots tonight and that isn't its fault (not deployed, no manifest), or null. */
  skipped: string | null;
  /** The screenshot run itself failed on it, which says nothing about the app: why, or null. */
  unshot: string | null;
  /** The app's copy didn't start: its last output. */
  boot: string | null;
  /** The keys of what only one of its two tries saw: a flake, not a problem. */
  once: string[];
  shots: Shot[];
  /** The key of every main page it has, shot or not. */
  found: string[];
  /** The ones the night before had and this one hasn't. */
  gone: string[];
  /** What changed since that night. */
  goneSince: Since;
  /** What that night's code found, for the judge's replay to set today's beside. */
  called: Problem[];
}

export interface Night {
  /** Its Pacific day. */
  day: string;
  startedAt: number;
  endedAt: number;
  /** Citadel UI's files, as git names them: a change there can move every app. Null: git couldn't say. */
  kit: string | null;
  apps: AppNight[];
}

/** One thing broken: the key it stays open under, and what people read. */
export interface Problem {
  key: string;
  kind: 'boot' | 'failed' | 'error-page' | 'blank' | 'console' | 'layout' | 'gone';
  page: string | null;
  width: number | null;
  text: string;
  /** What a layout change or a gone page is laid to. */
  since: Since;
}

const ERROR_PAGE = /^(?:\W*\d{3}\W+)?(?:internal server error|bad gateway|service unavailable|gateway time-?out|not found|cannot get \/|forbidden|application error|something went wrong|unhandled)/i;

export const where = (width: number) => (width <= 800 ? 'phone' : 'desktop');

/** An error's text with the parts that differ each night (numbers, hashes, ports) taken out, so one that stays is one problem. */
export const sameError = (e: string) =>
  e
    .replace(/\b[0-9a-f]{8,}\b/gi, '#')
    .replace(/\d+/g, '#')
    .slice(0, 160);

/** What is broken in one app's night. Small pixel noise is none of it. */
export function problems(a: AppNight): Problem[] {
  if (a.skipped || a.unshot !== null) return [];
  if (a.boot !== null) return [{ key: `${a.app}|boot`, kind: 'boot', page: null, width: null, since: null, text: `its copy didn't start: ${a.boot.trim().split('\n').slice(-2).join(' ').slice(0, 300)}` }];
  const out: Problem[] = [];
  for (const s of a.shots) {
    const add = (kind: Problem['kind'], text: string, more = '') => {
      const key = `${a.app}|${s.page}|${s.width}|${kind}${more ? `|${more}` : ''}`;
      if (!a.once.includes(key) && !out.some((p) => p.key === key)) out.push({ key, kind, page: s.page, width: s.width, since: s.since, text });
    };
    if (s.failed) {
      add('failed', `couldn't be drawn: ${s.failed.slice(0, 200)}`);
      continue;
    }
    if (s.status >= 400 || (s.text.length < 300 && ERROR_PAGE.test(s.text.trim()))) add('error-page', `an error page (HTTP ${s.status}): "${s.text.trim().replace(/\s+/g, ' ').slice(0, 80)}"`);
    else if (s.flat > 0.997 && s.text.trim().length < 3) add('blank', 'blank');
    for (const e of s.errors) add('console', `a console error: ${e.slice(0, 200)}`, sameError(e));
    // A page that is gone has moved, of course: that is said once, as what it is.
    const gone = out.some((p) => p.page === s.page && p.width === s.width && (p.kind === 'blank' || p.kind === 'error-page'));
    if (!gone && s.moved !== null && s.moved >= BIG_CHANGE) add('layout', `${Math.round(s.moved * 100)}% of what it shows looks different from the night before`);
  }
  // A front page that is broken has lost its links, of course.
  if (!out.some((p) => p.page === '/' && (p.kind === 'failed' || p.kind === 'error-page' || p.kind === 'blank')))
    for (const page of a.gone) {
      const key = `${a.app}|${page}|gone`;
      if (!a.once.includes(key)) out.push({ key, kind: 'gone', page, width: null, since: a.goneSince, text: 'its link or button is gone since the night before' });
    }
  return out;
}
