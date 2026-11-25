// Property test for the claim queue (#1657, #921, #1334): random take, setQueue, release, passOn and releaseHeldBy
// calls on the real Claims against a plain-array model. A failure prints the seed and the shrunk command list;
// re-run it with FC_SEED=<seed>.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import fc from 'fast-check';
import { Claims } from '../src/claims.ts';

const seed = Number(process.env.FC_SEED ?? 20261122);
const NAME = 'pipeline-lane';
const ticket = fc.integer({ min: 1, max: 5 });

type Cmd =
  | { op: 'take'; t: number }
  | { op: 'queue'; ts: number[] }
  | { op: 'release' }
  | { op: 'passOn'; how: 'live' | 'released' | 'dismissed' }
  | { op: 'releaseHeldBy'; t: number }
  | { op: 'staleRelease'; saw: number }
  | { op: 'ship'; t: number }
  | { op: 'live' }
  | { op: 'keep'; keep: boolean }
  | { op: 'beside'; t: number }
  | { op: 'besideLive' }
  | { op: 'handOff'; t: number }
  | { op: 'skip'; t: number };

const cmd: fc.Arbitrary<Cmd> = fc.oneof(
  fc.record({ op: fc.constant('take' as const), t: ticket }),
  fc.record({ op: fc.constant('queue' as const), ts: fc.array(ticket, { maxLength: 6 }) }),
  fc.record({ op: fc.constant('release' as const) }),
  fc.record({ op: fc.constant('passOn' as const), how: fc.constantFrom('live' as const, 'released' as const, 'dismissed' as const) }),
  fc.record({ op: fc.constant('releaseHeldBy' as const), t: ticket }),
  fc.record({ op: fc.constant('staleRelease' as const), saw: ticket }),
  fc.record({ op: fc.constant('ship' as const), t: ticket }),
  fc.record({ op: fc.constant('live' as const) }),
  fc.record({ op: fc.constant('keep' as const), keep: fc.boolean() }),
  fc.record({ op: fc.constant('beside' as const), t: ticket }),
  fc.record({ op: fc.constant('besideLive' as const) }),
  fc.record({ op: fc.constant('handOff' as const), t: ticket }),
  fc.record({ op: fc.constant('skip' as const), t: ticket }),
);

function fresh() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON; CREATE TABLE projects (id INTEGER PRIMARY KEY); INSERT INTO projects (id) VALUES (1);');
  return new Claims(db);
}

test('a claim has one holder, nobody both holds and waits, nobody waiting is lost, order is kept, a stale Release is refused (#1334)', () => {
  fc.assert(
    fc.property(fc.array(cmd, { maxLength: 40 }), (cmds) => {
      const claims = fresh();
      let holder: number | null = null; // the model: a holder and a plain array
      let waiting: number[] = [];
      let now = 1000;
      let shipped = 0; // the holder's ships not live yet (#1985)
      let keep = false;
      let beside = 0; // the waiting one shipping beside the holder, and its ships not live yet
      let besideShips = 0;
      let handed = false;
      const dropBeside = () => {
        if (beside && !waiting.includes(beside)) beside = besideShips = 0;
      };
      const modelPass = () => {
        holder = beside || (waiting[0] ?? null);
        waiting = waiting.filter((t) => t !== holder);
        shipped = beside ? besideShips : 0;
        beside = besideShips = 0;
        keep = handed = false;
      };
      for (const c of cmds) {
        now += 10;
        switch (c.op) {
          case 'take': {
            const r = claims.take(1, NAME, c.t, 'p', '', now);
            if (holder == null) {
              holder = c.t;
              waiting = waiting.filter((t) => t !== c.t);
              assert.equal(r.held, undefined);
            } else if (holder !== c.t) assert.equal(r.held?.holder, holder, 'taking a held claim is refused and shows the holder');
            break;
          }
          case 'queue': {
            claims.setQueue(1, NAME, c.ts, 'p', now);
            waiting = [...new Set(c.ts)].filter((t) => t !== holder);
            dropBeside();
            break;
          }
          case 'release':
          case 'passOn': {
            const r = c.op === 'release' ? claims.release(1, NAME, now) : claims.passOn(1, NAME, c.how, now)?.from;
            assert.equal(r?.holder, holder ?? undefined, 'it ends the holder it saw, or nothing when free');
            if (holder != null) modelPass();
            break;
          }
          case 'releaseHeldBy': {
            claims.releaseHeldBy(c.t, 'dismissed', now);
            waiting = waiting.filter((t) => t !== c.t);
            dropBeside();
            if (holder === c.t) modelPass();
            break;
          }
          case 'ship': {
            claims.shipped(c.t, `c${now}`);
            if (holder === c.t) shipped++;
            else if (beside === c.t) besideShips++;
            break;
          }
          case 'live': {
            const seen = claims.get(1, NAME);
            if (seen) claims.holderLive(seen, seen.landed.split(' '), now);
            if (shipped > (keep ? 1 : 0)) modelPass();
            else if (shipped) [shipped, keep] = [0, false];
            break;
          }
          case 'keep': {
            if (holder != null) claims.take(1, NAME, holder, 'p', '', now, (keep = c.keep));
            break;
          }
          case 'beside': {
            const seen = claims.get(1, NAME);
            const let_in = !!seen && claims.setBeside(seen, c.t, now);
            const may: boolean = holder != null && !beside && waiting.includes(c.t);
            assert.equal(let_in, may);
            if (may) beside = c.t;
            break;
          }
          case 'besideLive': {
            const seen = claims.get(1, NAME);
            const went = !!seen && claims.besideLive(seen, seen.beside_landed.split(' '), now);
            assert.equal(went, besideShips > 0);
            if (went) {
              waiting = waiting.filter((t) => t !== beside);
              dropBeside();
            }
            break;
          }
          case 'handOff': {
            claims.handedOff(c.t);
            if (holder === c.t) handed = true;
            break;
          }
          case 'skip': {
            const seen = claims.get(1, NAME);
            const r = seen && claims.skip(seen, c.t, now);
            const may: boolean = holder != null && !handed && !shipped && !keep && waiting.includes(c.t);
            assert.equal(!!r, may, 'only an unready holder, for one that waits');
            if (may) {
              waiting = [holder!, ...waiting.filter((t) => t !== c.t)];
              holder = c.t;
              beside = besideShips = 0;
            }
            break;
          }
          case 'staleRelease': {
            // The route's guard (?holder=<n>, src/routes/projects.ts) is copied here, so this checks that Claims.passOn moves the claim exactly once and the model agrees, not the route itself (that lives in test/claims.test.ts's route cases).
            const current = claims.get(1, NAME);
            if (current && current.holder === c.saw) {
              claims.passOn(1, NAME, 'released', now);
              modelPass();
            } else assert.notEqual(current?.holder, c.saw);
            break;
          }
        }
        // The invariants, after every command.
        const real = claims.get(1, NAME);
        assert.equal(real?.holder ?? null, holder, 'holder matches the model');
        assert.deepEqual([real?.landed ? real.landed.split(' ').length : 0, !!real?.keep], [shipped, keep], 'its ships and keep match the model');
        assert.deepEqual([real?.beside ?? 0, real?.beside_landed ? real.beside_landed.split(' ').length : 0, !!real?.handed], [beside, besideShips, handed], 'the one beside it and its hand-off match the model');
        const wait = claims.waiting(1, NAME);
        assert.deepEqual(wait, waiting, 'the waiting line matches the model: none lost, order kept');
        assert.equal(new Set(wait).size, wait.length, 'nobody waits twice');
        if (real) assert.ok(!wait.includes(real.holder), 'nobody both holds and waits');
        assert.ok(claims.list(1).filter((r) => r.name === NAME).length <= 1, 'at most one holder row');
      }
    }),
    { seed, numRuns: 300 },
  );
});

test('two Releases that saw the same holder pass the claim on once (#1334)', () => {
  fc.assert(
    fc.property(fc.array(ticket, { minLength: 2, maxLength: 5 }), (ts) => {
      const claims = fresh();
      const [first, ...rest] = [...new Set(ts)];
      claims.take(1, NAME, first, 'p', '', 1);
      claims.setQueue(1, NAME, rest, 'p', 2);
      const saw = claims.get(1, NAME)!.holder;
      for (let i = 0; i < 2; i++) {
        const now = claims.get(1, NAME);
        if (now?.holder === saw) claims.passOn(1, NAME, 'released', 3 + i);
      }
      assert.equal(claims.get(1, NAME)?.holder, rest[0]);
    }),
    { seed, numRuns: 100 },
  );
});
