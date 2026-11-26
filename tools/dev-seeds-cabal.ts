// A cabal's board seeds (#2090), apart from tools/dev-seeds.ts, which lists them: Build 7's real crew (a dev copy has no
// repo, so no build/7 branch: "shipped" stands in for "merged"), in the mock's three scenes: mid-build with a blocking ask, just
// formed (a roster nobody started), and a red run with its fixer.
import type { Ticket } from '../src/db-rows.ts';
import type { SeedCtx } from './dev-seeds.ts';

type Scene = 'mid' | 'formed' | 'red';
// label, piece, state, spend, risk, lane, waits on
const CREW: [string, string, 'shipped' | 'blocked' | 'roster' | 'sealed', number, string, string, string?][] = [
  ['T1', 'Running turn: one interface', 'shipped', 4.62, 'low', 'Turns'],
  ['T2', 'Machine agent runs a turn', 'shipped', 25.67, 'high', 'Turns'],
  ['T3', 'Minion state syncs to a machine', 'shipped', 27.6, 'high', 'Turns'],
  ['T4', 'A worker pool per machine', 'shipped', 18.98, 'low', 'Turns'],
  ['T5', 'Join a machine, self-test row', 'shipped', 24.35, 'high', 'Turns'],
  ['T6', 'Machine away and back home', 'shipped', 26.07, 'high', 'Turns'],
  ['R', 'Remove-a-machine screen', 'shipped', 7.82, 'medium', 'Turns'],
  ['T8', 'Host folders and programs', 'shipped', 21.98, 'high', 'Turns'],
  ['M1', 'Machine roles in the data', 'blocked', 12.64, 'high', 'Roles'],
  ['M2', 'Connect a machine with a code', 'sealed', 0, '', 'Roles', 'M1'],
  ['M3', 'Machine role cards', 'sealed', 0, '', 'Roles', 'M1'],
  ['M4', 'Setup and self-test per role', 'sealed', 0, '', 'Roles', 'M2'],
  ['M5', 'Pooled Windows and GPU jobs', 'sealed', 0, '', 'Roles', 'M4'],
  ['A', 'Every linked Claude account', 'sealed', 0, '', 'Roles', 'M4'],
  ['CI', 'CI runners join schemes', 'sealed', 0, '', 'Roles', 'M4'],
  ['M6', 'One balancer per machine', 'sealed', 0, '', 'Pools', 'M2'],
  ['H', 'Heavy jobs across machines', 'sealed', 0, '', 'Pools', 'M6'],
  ['T7', 'Pilot on Cara’s desktop', 'roster', 0, '', 'Pilot', 'everything'],
];

function scene(c: SeedCtx, kind: Scene): string {
  const { store, project } = c;
  const made = (title: string, fields: Parameters<typeof store.updateTicket>[1] = {}): Ticket => {
    const t = store.createTicket({ project_id: project.id, title, permission_mode: 'bypassPermissions', created_by: c.who });
    store.updateTicket(t.id, { status: 'idle', ...fields });
    return store.getTicket(t.id)!;
  };
  const cost = (t: Ticket, usd: number) => store.recordTurn(t.id, { session_id: `cabal-${t.id}`, ended_at: Date.now(), session_cost_usd: usd });
  // A build's lead reads "Build 7's Overseer"; the just-formed one is a goal cabal, named.
  const lead = made(kind === 'formed' ? 'Worker machines lead' : 'Build 7: worker machines', { status: 'running', last_activity: 'Reading the board… 2/5', build: kind === 'formed' ? null : 7 });
  cost(lead, 30.49);
  store.ensureCabal(lead.id, project.id);
  store.setCabalName(lead.id, 'Worker machines');
  for (const [label, title, state, spend, risk, lane, after] of CREW) {
    if (kind === 'formed' || state === 'roster') {
      store.addCabalRow(lead.id, { label, title, lane, after: kind === 'formed' && label !== 'T1' ? (after ?? 'T1') : (after ?? '') });
      continue;
    }
    const t = made(title, state === 'sealed' ? { state: 'parked' } : state === 'blocked' ? { status: 'running', last_activity: 'Waiting on a lend' } : { status: 'closed' });
    store.joinCabal(t.id, lead.id, project.id, title);
    store.updateCabalRow(store.cabalRowOf(t.id)!.id, { label, lane, after: after ?? '', files: label === 'M1' ? 'src/machine-roles.ts\nsrc/machine-lend.ts' : '' });
    if (spend) cost(t, spend);
    if (state === 'shipped') store.addEvent(t.id, 'note', { text: `Shipped #${t.number}: ${title}. Risk ${risk}: seeded.` });
    if (state === 'blocked') {
      store.updateCabalRow(store.cabalRowOf(t.id)!.id, { note: 'Go given. Needs a lend of src/machines.ts to merge.', note_at: Date.now() });
      if (kind === 'mid') store.addCabalAsk(lead.id, t.id, 'Lend src/machines.ts and src/routes/machines.ts for one merge', true);
    }
    if (label === 'T8') store.addCabalAsk(lead.id, t.id, 'Which test helper do you want for the host folder checks?', false);
  }
  if (kind === 'red') {
    const fixer = made('Fixer: off-thread read in Runner.view', { status: 'running' });
    store.joinCabal(fixer.id, lead.id, project.id, fixer.title);
    store.updateCabalRow(store.cabalRowOf(fixer.id)!.id, { label: 'Fix', lane: 'Turns', role: 'fixer', note: 'From T6’s merge. Started by the Overseer at 19:31.', note_at: Date.now() });
    cost(fixer, 1.4);
    store.setCabalRed(lead.id, 'Full run red on test/off-thread-fs.test.ts at 64d33ede8. T6 made it but has closed, so the fixer is on it.');
  }
  if (kind !== 'formed') store.addCabalLog(lead.id, `#${lead.number} ${lead.title}`, 'Josh, 21:20: "Lend it for one merge": M1 gets src/machines.ts for its merge.');
  if (kind === 'mid') store.addEvent(lead.id, 'fresh', { why: '152k tokens of context at the end of a turn', summary: 'Card on M1’s lend waits on Josh. Next: merge M1.', shift: true });
  return kind === 'formed' ? `#/p/${project.id}/cabal/${lead.number}` : `#/p/${project.id}/t/${lead.number}`;
}

export const cabalSeeds: Record<string, { about: string; seed: (c: SeedCtx) => string }> = {
  cabal: { about: "a cabal's lead chat (#2090): Build 7's 18 members mid-build, a blocking ask pinned over the composer, its ledger panel", seed: (c) => scene(c, 'mid') },
  'cabal-formed': { about: "a cabal's board page just formed (#2090): a roster of 18, nobody started yet", seed: (c) => scene(c, 'formed') },
  'cabal-red': { about: "a cabal's lead chat with the red-run bar and its fixer on the board (#2090)", seed: (c) => scene(c, 'red') },
};
