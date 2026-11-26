/**
 * What happened so far in the ship under way, for the Releases page's Next bar (#1368): read from the shipping minion's
 * land.sh output (its `land:` lines), not sent from anywhere new. Ships staying in line, CI red on the train and its
 * failing tests, CI's reruns of the failed files alone (#1374), a run cut off (#1377), flakes run once more, the bisect, the ship it refused and the ones that went back in line, the CI fallback.
 * Train membership is #1303's (the line and change rows); failed tries after the fact are #1375's (Previous releases).
 */
import { open, stat } from 'node:fs/promises';
import { failureDetail } from './ship-failures.ts';

export interface NewsItem {
  /** bad: something failed or was dropped; warn: a slower path (a rerun, the bisect, the fallback); info: the rest. */
  tone: 'bad' | 'warn' | 'info';
  text: string;
  /** The minions its text names, "#1331" → ticket id, for links (filled in by the Releases read). */
  refs?: Record<string, number>;
}

/** Lines shown, newest kept. */
const SHOWN = 6;
/** How much of the log's end is read: a train's lines plus CI's printed failure. */
const TAIL = 256 * 1024;

const short = (f: string) => f.replace(/^.*\//, '').replace(/\.test\.ts$/, '');
const clip = (t: string) => (t.length > 60 ? `${t.slice(0, 59)}…` : t);
const list = (xs: string[], n = 3) => xs.slice(0, n).join(', ') + (xs.length > n ? ` +${xs.length - n} more` : '');

/**
 * The news in a landing's output, oldest first, at most SHOWN. `name` turns a branch into what people call it ("#1331");
 * it is only the latest try's: lines before its last rebase belong to a train it rode or a try that went back in line.
 */
export function landNews(output: string, name: (branch: string) => string): NewsItem[] {
  const all = output.split('\n');
  const start = all.findLastIndex((l) => /^land: rebasing \S+ onto /.test(l));
  const lines = all.slice(start + 1);
  const news: NewsItem[] = [];
  let riders: string[] = [];
  let stays = new Map<string, string[]>(); // why → branches
  let bisect: NewsItem | null = null;
  let ciRuns = 0;
  let since = 0; // where the current CI wait's output starts
  let slow: NewsItem | null = null;
  const flushStays = () => {
    if (!stays.size) return;
    news.push({ tone: 'info', text: `Stayed in line: ${[...stays].map(([why, bs]) => `${bs.map(name).join(', ')} (${why})`).join('; ')}` });
    stays = new Map();
  };
  // The bisect's result replaces its progress line.
  const done = () => {
    if (bisect) news.splice(news.indexOf(bisect), 1);
    bisect = null;
  };
  // The train's red CI, with the tests CI printed since the wait began.
  const redNews = (at: number) => {
    const d = failureDetail(lines.slice(since, at).join('\n'), 1);
    const names = d.names.length ? `: ${d.names.map(clip).join(' · ')}${d.more ? ` +${d.more} more` : ''}` : '';
    news.push({ tone: 'bad', text: `CI red on the train${names}` });
  };
  const backInLine = (bs: string[]) => (bs.length ? `; back in line: ${list(bs.map(name), 6)}` : '');

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!l.startsWith('land: ')) continue;
    const s = l.slice(6);
    let m: RegExpMatchArray | null;
    if ((m = s.match(/^ship train: (\S+) stays in line \((?:it )?(.+)\)$/))) {
      stays.set(m[2], [...(stays.get(m[2]) ?? []), m[1]]);
      continue;
    }
    flushStays();
    if ((m = s.match(/^ship train: \S+ takes the \d+ ships? waiting behind it \(([^)]*)\)/))) riders = m[1].split(' ').filter(Boolean);
    else if (/^waiting for CI on /.test(s)) {
      since = i;
      slow = null;
      if (bisect) ciRuns++;
      if (bisect && !/testing the first/.test(bisect.text)) bisect.text = `Finding the ship that turned the train red: CI run ${ciRuns}`;
    } else if (/^waiting for CI or a quiet perigee: /.test(s)) {
      slow = { tone: 'warn', text: 'CI is past its time limit: waiting on CI, or on a quiet perigee to run the suite here' };
    } else if ((m = s.match(/^CI's full run ended red and it is rerunning the failed files alone.*?waits up to (.+?) more/))) {
      slow = { tone: 'warn', text: `CI's full run ended red: rerunning the failed files alone, to tell flakes from real failures (up to ${m[1]} more)` };
    } else if (/^CI passed on /.test(s)) slow = null;
    else if ((m = s.match(/^the CI run on \S+ (was cut off before any test failed|lost its runner before any step failed) \((.*)\), so/))) {
      news.push({ tone: 'warn', text: `CI run ${m[1].startsWith('lost') ? 'lost its runner' : 'cut off'} before any test failed (${m[2]}): one more run` });
    } else if ((m = s.match(/^CI is red on the ship train/))) {
      slow = null;
      redNews(i);
      bisect = { tone: 'warn', text: 'Finding the ship that turned the train red' };
      ciRuns = 0;
      news.push(bisect);
    } else if ((m = s.match(/^bisect: testing the first (\d+) of (\d+) ships/))) {
      if (bisect) bisect.text = `Finding the ship that turned the train red: testing the first ${m[1]} of ${m[2]}`;
    } else if ((m = s.match(/^only known flakes failed (?:in CI \([^)]*\)|on perigee): (.*), so this goes on as green/))) {
      slow = null; // #1419: no fresh run, so the reruns' warning is done
      news.push({ tone: 'warn', text: `Only known flakes failed (${list([...m[1].matchAll(/(\S+) \(/g)].map((f) => short(f[1])))}): going on as green, with no fresh CI run` });
    } else if ((m = s.match(/^SHIPPING THROUGH MAIN'S RED: (.*?) fails run alone on main's tip/))) {
      slow = null; // #1478: a red only on main's own red test goes on as green
      news.push({ tone: 'warn', text: `Red only on main's own red test (${list(m[1].split(', ').map(short))}): shipping through it; main still needs a fix` });
    } else if ((m = s.match(/^broken test, not a flake: (\S+) red in (.+)$/))) {
      news.push({ tone: 'bad', text: `${short(m[1])} is a broken test, not a flake: red in ${m[2]}` }); // #1487
    } else if ((m = s.match(/^failed in the full run but passed alone \(([^)]*)\)(.*)$/))) {
      const files = m[1].split(', ').map(short);
      news.push(/stays red/.test(m[2]) ? { tone: 'bad', text: `${list(files)} failed in the full suite but passed alone, but a fresh CI run couldn't start, so it stays red` } : { tone: 'warn', text: `${list(files)} failed in the full suite but passed alone: one fresh CI run` });
    } else if ((m = s.match(/^suspects: (.*): CI is red on the ship train \(/))) {
      slow = null;
      done();
      redNews(i); // land.sh guesses before it bisects, so no "CI is red" line came first
      news.push({
        tone: 'bad',
        text: `Pulled off the train: ${m[1].replace(/\(([^)]*)\)/g, (_, s: string) => {
          const [fs, ...said] = s.split('; ');
          return `(${[fs.split(', ').map(short).join(', '), ...said].join('; ')})`;
        })}. It runs again with the ships that are left`,
      });
    } else if ((m = s.match(/^(\S+) goes back in line: the train was red again on (.+?) without it, so the guess was wrong/))) {
      news.push({ tone: 'warn', text: `${m[1]} is back in line: the train was red again on ${list(m[2].split(', ').map(short))} without it, so the guess was wrong` });
    } else if ((m = s.match(/^(\S+) goes back in line to ship alone: it was pulled on a guess, and the train without it passed (.+?), but /))) {
      news.push({ tone: 'warn', text: `${m[1]} is back in line to ship alone: the train without it passed ${list(m[2].split(', ').map(short))}, but nothing proved it the cause` });
    } else if ((m = s.match(/^(\S+) goes back in line to ship alone: (.+?) flaked on other ships, so the train passing without it proves nothing/))) {
      news.push({ tone: 'warn', text: `${m[1]} is back in line to ship alone: ${list(m[2].split(', ').map(short))} flaked on other ships, so the pass without it proves nothing` });
    } else if ((m = s.match(/^(\S+) is refused: it was pulled on a guess, no ship pulled for (.+?) failed it alone, and the train without it passed it/))) {
      news.push({ tone: 'bad', text: `${m[1]} is sent back: the train without it passed ${list(m[2].split(', ').map(short))}, and no pulled ship failed it alone` });
    } else if ((m = s.match(/^(\S+) steps aside: /))) {
      news.push({ tone: 'warn', text: `${name(m[1])} steps aside: the next ship in line runs the train with what is left` });
    } else if ((m = s.match(/^red on main too: (not .*?): (.*?) fails run alone on main's tip/))) {
      slow = null;
      done();
      news.push({ tone: 'warn', text: `Red on main too, ${m[1]}: ${list(m[2].split(', ').map(short))}; main needs a fix` });
    } else if ((m = s.match(/^bisect: the first (\d+) of (\d+) ships tested green, so they ship now; back in line with nobody refused: ([^;]*)/))) {
      done();
      news.push({ tone: 'warn', text: `The first ${m[1]} of ${m[2]} ships tested green, so they ship now${backInLine(m[3].split(' ').filter(Boolean))}` });
    } else if ((m = s.match(/^the bisect found (\S+) itself red/))) {
      done();
      news.push({ tone: 'bad', text: `${name(m[1])} itself red${backInLine(riders)}` });
    } else if ((m = s.match(/^the ship train goes back in line, since CI gave no answer \((.*)\): (\S+) goes on alone/))) {
      done(); // a no-answer mid-bisect ends it too
      news.push({ tone: 'warn', text: `CI gave no answer (${m[1]}): ${name(m[2])} goes on alone${backInLine(riders)}` });
    } else if ((m = s.match(/^ship train: (\S+) left the line while the train was tested/))) {
      const at = riders.indexOf(m[1]);
      news.push({ tone: 'info', text: `${name(m[1])} left the line during the test${backInLine(at < 0 ? [] : riders.slice(at + 1))}` });
    } else if ((m = s.match(/^CI FALLBACK: (.*?)\. Running the full suite on perigee instead\./))) {
      slow = null; // it stopped waiting on CI
      news.push({ tone: 'warn', text: `CI fallback: the full suite runs on perigee (${m[1]})` });
    }
  }
  flushStays();
  if (slow) news.push(slow);
  return news.slice(-SHOWN);
}

/** Whether CI's run on this landing's train was started early, during the train ahead's deploy, and counted for it (land.sh's early_gate, #1366). It's the latest try's: a line before its last rebase belongs to an earlier one. */
export function earlyCi(output: string): boolean {
  const all = output.split('\n');
  const start = all.findLastIndex((l) => /^land: rebasing \S+ onto /.test(l));
  return all.slice(start + 1).some((l) => /^land: early next train: CI started on this train at /.test(l));
}

/** Why the ship ahead threw away the early run it stacked for `next` (land.sh's early_cancel), from its log's latest such line; null when it has none. */
export function earlyDroppedWhy(output: string, next: string): string | null {
  const re = /^land: early next train: dropped the early CI run on (\S+)'s train \((.*)\)$/;
  for (const l of output.split('\n').reverse()) {
    const m = re.exec(l);
    if (m && m[1] === next) return m[2];
  }
  return null;
}

/** Each landing log's end as last read: a few ships at most are under way at once. */
const tails = new Map<string, { size: number; mtime: number; output: string }>();
const reading = new Map<string, Promise<unknown>>();
const TAILS_KEPT = 16;

/** A landing log's end, read off the server's thread (#2111) and again only when the file changed. */
export async function readTailA(path: string): Promise<string> {
  let st;
  try {
    st = await stat(path);
  } catch {
    tails.delete(path);
    return '';
  }
  const was = tails.get(path);
  if (was && was.size === st.size && was.mtime === st.mtimeMs) return was.output;
  const len = Math.min(st.size, TAIL);
  const buf = Buffer.alloc(len);
  let fh;
  try {
    fh = await open(path, 'r');
    await fh.read(buf, 0, len, st.size - len);
  } catch {
    return was?.output ?? '';
  } finally {
    await fh?.close();
  }
  const text = buf.toString('utf8');
  const output = st.size > len ? text.slice(text.indexOf('\n') + 1) : text; // a cut first line is dropped
  tails.delete(path);
  tails.set(path, { size: st.size, mtime: st.mtimeMs, output });
  for (const old of tails.keys()) {
    if (tails.size <= TAILS_KEPT) break;
    tails.delete(old);
  }
  return output;
}

/**
 * A landing log's end as the last read found it, for what asks at every poll and can't wait (Releases' Next bar, a
 * wait's "CI started early"): it answers at once and starts the next read, so an answer is one poll old, and the first
 * is empty. What is asked once uses readTailA.
 */
export function tailNow(path: string): string {
  if (!reading.has(path))
    reading.set(
      path,
      readTailA(path)
        .catch(() => '')
        .finally(() => reading.delete(path)),
    );
  return tails.get(path)?.output ?? '';
}

/** Every read tailNow started has ended (tests wait on it). */
export const tailsRead = async (): Promise<void> => void (await Promise.all(reading.values()));
