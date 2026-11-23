// The ship train's tests share these (#1723): the train's tests are split over land-train.test.ts,
// land-train-riders.test.ts and land-train-early.test.ts so no one file sets the suite's length.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ci, git, setup, landAsync, tickets, issued } from './land-fixture.ts';
import { until } from './wait.ts';

export type Ship = { change?: [string, string]; also?: [string, string]; env?: Record<string, string>; on?: number };

// Ship 1 (ticket/1-x) lands alone and holds the lock in its deploy until every other ship is in line behind it, so
// ship 2 is the front of a train with the rest behind it. Ship i changes f<i>.txt unless it says otherwise, and starts
// from main, or from ship <on>'s branch.
export async function line(ships: Ship[], extra: Record<string, string> | ((dir: string) => Record<string, string>) = {}, before?: (r: ReturnType<typeof setup>) => void) {
  const r = setup();
  const c = ci(r);
  const state = join(git(r.live, 'rev-parse', '--absolute-git-dir'), 'cc-deploy');
  before?.(r);
  const deploys = join(r.dir, 'deploys');
  const env = { DEPLOY_LIVE: r.live, DEPLOY_SOURCE: r.source, DEPLOY_NOTE: join(r.dir, 'note'), FAKE_DEPLOY_GATE: join(r.dir, 'gate'), FAKE_DEPLOY_LOG: deploys, DEPLOY_QUEUE_POLL: '0.05', PATH: `${join(r.dir, 'bin')}:${process.env.PATH}`, LAND_CI: '1', LAND_CI_POLL: '0.1', ...(typeof extra === 'function' ? extra(r.dir) : extra) };
  const wts = [r.wt];
  for (let i = 2; i <= ships.length; i++) {
    wts.push(join(r.dir, `wt${i}`));
    git(r.source, 'worktree', 'add', '-q', '-b', `ticket/${i}-x`, wts[i - 1], ...(ships[i - 1].on ? [`ticket/${ships[i - 1].on}-x`] : []));
  }
  ships.forEach((s, i) => s.on || r.commit(wts[i], ...(s.change ?? [`f${i + 1}.txt`, `${i + 1}\n`])));
  ships.forEach((s, i) => s.on && (git(wts[i], 'reset', '-q', '--hard', `ticket/${s.on}-x`), r.commit(wts[i], ...(s.change ?? [`f${i + 1}.txt`, `${i + 1}\n`]))));
  ships.forEach((s, i) => s.also && r.commit(wts[i], ...s.also));
  const was = wts.map((wt) => git(wt, 'rev-parse', 'HEAD'));
  const out = wts.map(() => '');
  const lands = [landAsync(wts[0], { ...env, ...ships[0].env }, 150_000, (s) => (out[0] = s))];
  await until('ship 1 in its deploy', () => r.note() !== null);
  for (let i = 2; i <= ships.length; i++) {
    lands.push(landAsync(wts[i - 1], { ...env, ...ships[i - 1].env }, 150_000, (s) => (out[i - 1] = s)));
    await until(`ship ${i}'s ticket`, () => issued(state) === i);
    await until(`ship ${i} in line`, () => / in line for the deploy lock/.test(out[i - 1]));
  }
  const go = async () => {
    writeFileSync(join(r.dir, 'gate'), '');
    return Promise.all(lands);
  };
  const runs = () => new Set(c.calls().match(/head_sha=[0-9a-f]+/g)).size; // the commits CI was asked about
  const deployed = () => (existsSync(deploys) ? readFileSync(deploys, 'utf8').trim().split('\n') : []);
  const subjects = () => git(r.source, 'log', '--reverse', '--format=%s', 'main').split('\n');
  const done = () => {
    assert.deepEqual(tickets(state), [], 'every ticket is gone');
    assert.deepEqual(existsSync(join(state, 'train')) ? readdirSync(join(state, 'train')) : [], [], 'no verdict is left');
  };
  return { r, c, state, env, wts, was, out, go, runs, deployed, subjects, done };
}
// A rider's own shipped line: main at its own train commit, which its branch now points at, and how it went live.
export function shipped(l: Awaited<ReturnType<typeof line>>, d: { status: number | null; stderr: string }, i: number, front: number, of: number) {
  assert.equal(d.status, 0, `ship ${i}: ${d.stderr}`);
  assert.match(d.stderr, new RegExp(`shipped in ticket/${front}-x's ship train of ${of} ships`));
  const tip = git(l.r.source, 'rev-parse', `ticket/${i}-x`);
  const subject = git(l.r.source, 'log', '-1', '--format=%s', l.was[i - 1]);
  assert.notEqual(tip, l.was[i - 1], `ship ${i}'s branch moved to its train commit`);
  assert.equal(git(l.r.source, 'log', '-1', '--format=%s', tip), subject);
  assert.equal(git(l.r.source, 'merge-base', '--is-ancestor', tip, 'main'), '');
  // What the server reads (src/land.ts landResult): the last "main is now at", and deploy.sh's "live now:".
  assert.equal([...d.stderr.matchAll(/main is now at ([0-9a-f]{7,40}) "(.*)"/g)].pop()?.slice(1).join(' '), `${tip.slice(0, 7)} ${subject}`);
  assert.match(d.stderr, /^deploy: live now:/m);
}


export const bad = (n: number) => ({ change: [`test/p${n}.test.ts`, `throw new Error('bad ${n}');\n`] });
export const realOf = (...ns: number[]) => ns.map((n) => `test/p${n}.test.ts=test/p${n}.test.ts`).join(' ');
export const shared = (dir: string) => ({ COORDINATOR_SHARED_DIR: join(dir, 'shared') });
