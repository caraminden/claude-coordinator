// Times people read are Pacific, labelled PST or PDT (Josh, 2026-11-12). One copy of the formats, for alerts, briefs and notes.

import { FIXED_ZONE } from './host-signals.ts';

// A server a test boots reads its day and hour in the zone the test hands it instead (src/host-signals.ts, #1485, #1536).
export const ZONE = FIXED_ZONE ?? 'America/Los_Angeles';

/** `ms` as "Nov 14, 06:30 PST" (24-hour). */
export const pacific = (ms: number) => new Date(ms).toLocaleString('en-US', { timeZone: ZONE, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short' });

/** `ms` as its Pacific day, "2026-11-16" (en-CA). */
const DAY = new Intl.DateTimeFormat('en-CA', { timeZone: ZONE }); // made once: inbox calls it per row
export const pacificDay = (ms: number) => DAY.format(ms);

/** `ms` as "Nov 14, 6:30 AM PST" (12-hour): the stamp in text people read. */
export const pacificStamp = (ms: number) => new Date(ms).toLocaleString('en-US', { timeZone: ZONE, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });

/** `ms` as "Nov 14, 2026, 6:30 AM PST": the stamp with its year, for a reset far off. */
export const pacificStampYear = (ms: number) => new Date(ms).toLocaleString('en-US', { timeZone: ZONE, month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });

/** `ms` as "Tue 18 Nov, 09:00 PST": the weekday variant, for times a person sets or is told ahead. */
export function pacificWeekday(ms: number): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: ZONE, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short' }).formatToParts(ms).map((x) => [x.type, x.value]));
  return `${p.weekday} ${p.day} ${p.month}, ${p.hour}:${p.minute} ${p.timeZoneName}`;
}

/** When "resets 3:30pm (America/Los_Angeles)" next comes round after `now`, or null for words without a plain time of day. */
export function parseResetTime(text: string, now = Date.now()): number | null {
  const m = /resets (\d{1,2})(?::(\d{2}))?\s*([ap]m)\b(?:\s*\(([\w/+-]+)\))?/i.exec(text);
  if (!m) return null;
  const hour = (Number(m[1]) % 12) + (m[3].toLowerCase() === 'pm' ? 12 : 0);
  const minute = Number(m[2] ?? 0);
  // The zone's offset at `t`: its wall clock read as UTC, minus t.
  const offset = (t: number) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: m[4], hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(t).map((x) => [x.type, Number(x.value)]));
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(t / 1000) * 1000;
  };
  try {
    const wall = new Date(now + offset(now));
    const day = Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate(), hour, minute);
    // The offset at the time itself, not at `now`: a clock change between them moves it an hour (ME5).
    const at = (d: number) => d - offset(d - offset(now));
    let t = at(day);
    if (t <= now) t = at(day + 24 * 60 * 60 * 1000);
    return t;
  } catch {
    return null; // a time zone Intl doesn't know
  }
}

// en-US formatters by their options, made once: a new one per date (toLocaleTimeString) took 0.1 ms, and the
// settled cards of a scheme-refs snapshot format hundreds (#609). A zone Intl doesn't know throws, as before.
const formats = new Map<string, Intl.DateTimeFormat>();
function dateFormat(opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = JSON.stringify(opts);
  let f = formats.get(key);
  if (!f) formats.set(key, (f = new Intl.DateTimeFormat('en-US', opts)));
  return f;
}

/** "3:31pm", in Pacific unless a zone is given (people read Pacific, whatever zone Claude's limit message named); "Fri 3:31pm" on another day, "Thu, Nov 5 3:31pm" six days or more out (a weekly limit). */
export function clockTime(ms: number, tz = ZONE, now = Date.now()): string {
  const say = (timeZone?: string) => {
    const time = dateFormat({ hour: 'numeric', minute: '2-digit', timeZone }).format(ms).replace(' ', '').toLowerCase();
    const day = (at: number) => dateFormat({ timeZone }).format(at);
    if (day(ms) === day(now)) return time;
    const far = ms - now >= 6 * 86_400_000;
    return `${dateFormat({ weekday: 'short', ...(far && { month: 'short', day: 'numeric' }), timeZone }).format(ms)} ${time}`;
  };
  try {
    return say(tz);
  } catch {
    return say(ZONE);
  }
}
