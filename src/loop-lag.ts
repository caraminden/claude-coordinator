// The event-loop lag log (#526): the server is one thread, so while synchronous work runs (a git or gh
// call, a big delete, a gunzip, a big query) it answers nobody. This names each such stall in the journal.
// With `profile` on (the live server, #609), a CPU sampler runs all along at one sample per 10 ms, and each
// stall's line names the code that ran during it, as its commonest stacks:
//   The event loop was held for 1.2 s: ... Running: 70% listTickets (src/db.ts:1201) < handler (src/routes/projects.ts:411); 20% (garbage collector)
import { Session } from 'node:inspector/promises';

const SAMPLE_US = 10_000;
/** A fresh profile this often keeps its samples bounded (about 60,000) when nothing stalls. */
const FRESH_MS = 10 * 60_000;
/** Frames from this repo (server.ts, src/, tools/) are the ones a stall's line names. */
const ROOT = new URL('..', import.meta.url).href;

interface CallFrame { functionName: string; url: string; lineNumber: number }
interface ProfileNode { id: number; callFrame: CallFrame; children?: number[] }
/** The part of a V8 CPU profile read here; its times are microseconds on process.hrtime's clock. */
export interface Profile { nodes: ProfileNode[]; startTime: number; samples: number[]; timeDeltas: number[] }

function frameName(f: CallFrame): string {
  const where = f.url.startsWith(ROOT) ? `${f.url.slice(ROOT.length)}:${f.lineNumber + 1}` : f.url.startsWith('node:') ? f.url : '';
  return `${f.functionName || '(anonymous)'}${where ? ` (${where})` : ''}`;
}

/**
 * What ran between `from` and `to` (hrtime microseconds) by the profile's samples: its commonest stacks, each as
 * the innermost frame and then up to three of this repo's own frames outward, as "70% leaf < caller < handler".
 * Empty when no sample falls in the window.
 */
export function namedStacks(profile: Profile, from: number, to: number, top = 3): string {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const parent = new Map<number, number>();
  for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  const counts = new Map<string, number>();
  let total = 0;
  let t = profile.startTime;
  for (let i = 0; i < profile.samples.length; i++) {
    t += profile.timeDeltas[i];
    if (t < from) continue;
    if (t > to) break;
    const leaf = byId.get(profile.samples[i]);
    if (!leaf || leaf.callFrame.functionName === '(idle)') continue;
    const names = [frameName(leaf.callFrame)];
    for (let id = parent.get(leaf.id); id !== undefined && names.length < 4; id = parent.get(id)) {
      const f = byId.get(id)!.callFrame;
      if (!f.url.startsWith(ROOT) || /\/node_modules\//.test(f.url)) continue;
      const name = frameName(f);
      if (names.at(-1) !== name) names.push(name);
    }
    const key = names.join(' < ');
    counts.set(key, (counts.get(key) ?? 0) + 1);
    total++;
  }
  return [...counts].sort((a, b) => b[1] - a[1]).slice(0, top).map(([key, n]) => `${Math.round((100 * n) / total)}% ${key}`).join('; ');
}

/** The always-on sampler: `take` hands over the profile so far and starts the next. */
class Sampler {
  private session = new Session();
  private busy = false;
  private fresh?: NodeJS.Timeout;
  ready: Promise<boolean>;

  constructor() {
    this.ready = (async () => {
      this.session.connect();
      await this.session.post('Profiler.enable');
      await this.session.post('Profiler.setSamplingInterval', { interval: SAMPLE_US });
      await this.session.post('Profiler.start');
      this.fresh = setInterval(() => void this.take(), FRESH_MS).unref();
      return true;
    })().catch(() => false);
  }

  /** The profile since the last take, or null while another take runs or when the sampler failed. */
  async take(): Promise<Profile | null> {
    if (this.busy || !(await this.ready)) return null;
    this.busy = true;
    try {
      const { profile } = await this.session.post('Profiler.stop');
      await this.session.post('Profiler.start');
      return profile as unknown as Profile;
    } catch {
      return null;
    } finally {
      this.busy = false;
    }
  }

  stop() {
    clearInterval(this.fresh);
    this.session.disconnect();
  }
}

/**
 * Log each time the event loop was held more than `over` ms, measured by a timer every `every` ms; with `profile`,
 * each line also names what ran (namedStacks). `stop` ends the watch and the sampler.
 */
export function watchLoopLag(log: (text: string) => void = console.warn, every = 100, over = 500, { profile = false } = {}): { stop(): void } {
  const sampler = profile ? new Sampler() : null;
  let last = process.hrtime.bigint();
  const timer = setInterval(() => {
    const now = process.hrtime.bigint();
    const held = Number(now - last) / 1e6 - every;
    const from = Number(last / 1000n);
    last = now;
    if (held <= over) return;
    const line = `The event loop was held for ${(held / 1000).toFixed(1)} s: the server answered nobody meanwhile.`;
    if (!sampler) return log(line);
    const to = Number(now / 1000n);
    void sampler.take().then((p) => {
      const ran = p ? namedStacks(p, from, to) : '';
      log(ran ? `${line} Running: ${ran}` : line);
    });
  }, every).unref();
  return {
    stop() {
      clearInterval(timer);
      sampler?.stop();
    },
  };
}
