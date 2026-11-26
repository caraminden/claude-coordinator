// The Releases page's Flow tab's seed (#1989), apart from tools/dev-seeds.ts, which lists it as `flow`.
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { SeedCtx } from './dev-seeds.ts';

const hex = () => Math.random().toString(16).slice(2, 14).padEnd(12, '0');

export const flowSeed: { about: string; seed: (c: SeedCtx) => string } = {
  about: "the Releases page's Flow tab (#1989): a scheme with 120 minions over two weeks, of every kind, way to main and ending, with refused ships, closing notes, words why and costs",
  seed(c) {
    const taken = new Set(c.store.listProjects().map((p) => p.name));
    let n = 1;
    while (taken.has(n === 1 ? 'River Works' : `River Works ${n}`)) n++;
    const scheme = c.store.createProject(n === 1 ? 'River Works' : `River Works ${n}`, null);
    const repo = join(c.dataDir, `river-works-${scheme.id}`);
    mkdirSync(repo);
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'Start'], { cwd: repo });
    c.store.setProjectRepoDir(scheme.id, repo);
    const me = c.store.listUsers().find((u) => u.name === c.who);
    if (me) c.store.addMember(scheme.id, me.id);
    const titles = ['Aura list keeps its order', 'Search box in the top bar', 'Crash when a clip has no sound', 'Phone layout for the report page', 'Nightly backup says what it skipped', 'Compare three map libraries', 'Look ideas for the empty shelf', 'Split the settings page by section'];
    // type, ship note, refused hand-offs, live, closed, closing note, the word why
    const shapes: [string, 'ship' | 'build' | '', number, boolean, boolean, string, string?][] = [
      ...Array(9).fill(['feature', 'ship', 0, true, true, '']),
      ...Array(6).fill(['bug', 'ship', 1, true, true, '']),
      ...Array(4).fill(['chore', 'ship', 0, true, true, '']),
      ['feature', 'ship', 3, true, true, ''],
      ['bug', 'ship', 2, true, true, ''],
      ['chore', 'ship', 2, false, true, ''],
      ['feature', '', 0, true, true, ''],
      ['bug', 'ship', 0, false, true, ''],
      ['feature', 'build', 0, false, true, ''],
      ['feature', '', 4, false, true, 'Claude dismissed this minion: replaced by three smaller minions, the notes are in the handoff', 'replaced'],
      ['chore', '', 0, false, true, 'Taskmaster dismissed this minion.', 'dropped'],
      ['feature', '', 0, false, true, 'Cara dismissed this minion.'],
      ['bug', '', 0, false, true, 'Claude dismissed this minion: not a bug, the setting was off'],
      ['research', '', 0, false, true, 'Claude dismissed this minion: report read'],
      ['research', '', 0, false, true, 'Cara dismissed this minion.'],
      ['ideation', '', 0, false, true, 'Josh dismissed this minion.'],
      ['design', '', 0, false, false, ''],
      ['feature', '', 1, false, false, ''],
    ];
    const live: { number: number; title: string }[] = [];
    for (let i = 0; i < 120; i++) {
      const [type, ship, refused, isLive, closed, said, why] = shapes[(i * 7) % shapes.length];
      const t = c.store.createTicket({ project_id: scheme.id, title: titles[i % titles.length], permission_mode: 'default', created_by: c.who });
      c.store.props.set('minion', t.id, scheme.id, { type, ...(why ? { closedAs: why } : {}) }, c.who);
      for (let k = 0; k < refused; k++) c.store.addEvent(t.id, 'user_message', { author: 'Citadel', text: "[System]: Your handed-off land didn't go through: the tests failed" });
      if (ship) c.store.addEvent(t.id, 'note', { text: ship === 'ship' ? `Shipped ${hex().slice(0, 9)} "${t.title}": ${t.title}. Risk low: small. Live now.` : `Merged into build/4: ${t.title}. Risk low: small.` });
      if (said) c.store.addEvent(t.id, 'note', { text: said });
      void c.store.recordTurn(t.id, { ended_at: Date.now(), session_cost_usd: Math.round(100 * (2 + ((i * 37) % 23) * (said && i % 3 ? 4.2 : 0.9))) / 100 });
      if (isLive) live.push({ number: t.number!, title: t.title });
      c.store.db.prepare('UPDATE tickets SET status = ?, created_at = ? WHERE id = ?').run(closed ? 'closed' : 'idle', Date.now() - ((i * 11) % 14) * 86_400_000 + 1, t.id);
    }
    c.store.addRelease({ project_id: scheme.id, target: 'app', version: '1.0', changes: JSON.stringify(live), started_at: Date.now() - 60_000, live_at: Date.now(), outcome: 'live', stages: '{}' });
    return `#/p/${scheme.id}/releases/${scheme.id}/flow`;
  },
};
