// Times people read are Pacific, labelled PST or PDT (Josh, 2026-11-12). One copy of the formats, for alerts, briefs and notes.

const ZONE = 'America/Los_Angeles';

/** `ms` as "Nov 14, 06:30 PST" (24-hour). */
export const pacific = (ms: number) => new Date(ms).toLocaleString('en-US', { timeZone: ZONE, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short' });

/** `ms` as "Tue 18 Nov, 09:00 PST": the weekday variant, for times a person sets or is told ahead. */
export function pacificWeekday(ms: number): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: ZONE, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short' }).formatToParts(ms).map((x) => [x.type, x.value]));
  return `${p.weekday} ${p.day} ${p.month}, ${p.hour}:${p.minute} ${p.timeZoneName}`;
}
