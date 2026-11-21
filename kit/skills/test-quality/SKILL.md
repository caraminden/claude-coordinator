---
name: test-quality
description: Whether a test proves anything, and test-first for new logic. Use when writing tests for a feature or change (a quick test for someone's draft included), when reviewing a diff's tests or asked "are these tests any good", or when a green test looks too easy. Not for every edit, not for reproducing a bug (bug-fixing), and not for UI changes the scheme proves by screenshot.
---

# Test quality

A test is worth keeping when it goes red as soon as its behaviour breaks. Check commands come
from the repo's CLAUDE.md, "Project facts". Never add a test library or other
dependency: offer it once, with the test you would write, and leave the call to a person.

## When it applies

- **New logic** (a parser, a reducer, a rule, a state change, a query): test-first. One failing
  test for one behaviour, watch it go red, just enough code to pass, repeat. A batch of tests
  written up front checks the shape you imagined, not the behaviour you built.
  citadel:self-review checks the result: it runs new and changed tests against the base and
  flags any that pass there.
- **UI and front-end wiring**: no test-first; the scheme's UI checks (screenshots) are the
  proof. Pull a calculation out into a pure function when it deserves a test.
- **A bug**: citadel:bug-fixing (a failing reproduction first).

## What a good test is

- **It goes through the public interface** (the seam): the exported function, the route, the
  command, so it survives a refactor.
- **It mocks only at system boundaries**: the network, the clock, randomness, other processes,
  and sometimes the file system or database (a temp copy beats a mock). Needing to mock your own
  module means the seam is in the wrong place ([CODEBASE-DESIGN.md](../improve-codebase-architecture/CODEBASE-DESIGN.md)).
- **Its expected value comes from somewhere else**: the rule, the spec, a worked literal. Never
  recompute it the way the code does.
- **One behaviour per test, named for the behaviour** (`rejects a reply with no body`), not for
  the function it calls.
- **The PR names the seam**: "tested at `parseReply()`: catches X, misses Y".

## Tests that prove nothing

Each passes whatever the code does. Fix any you write; flag any you review.

- **Tautology**: the assertion restates the implementation, or compares a value with itself.
  The one exception: `f(x)` equal to `f(x)` is a real determinism check when `f` may not be
  pure (serialising a map, hashing, anything that reads the clock).
- **Vacuity**: a filter, guard or early return skips nearly every case, or the loop runs over an
  empty fixture, so the test ran nothing.
- **No assertion**, or only "didn't throw" or "is defined". A probe that only prints is one:
  give it an assertion, mark it ignored with the reason, or delete it.
- **A swallowed failure**: an empty catch around the act, the assertion only inside a catch, an
  async assertion without `await` (the test ends before it runs), a callback that never fires.
- **A disabled or always-true assertion**: commented out, or `true` asserted true.
- **A weaker check than the code allows**: the length checked but never the order.
- **A fragment where the whole value is known**: assert the whole value (`toEqual`,
  `toMatchInlineSnapshot`), not a fragment with `toContain`.
- **A constant pinned to its current value** (`SCHEMA_VERSION === 51`, a colour, a grace
  period, a row count that moves with data): a tautology with extra steps. Assert what the
  constant drives.

## Timing patterns that flake

Pass or fail should never depend on how fast the box is. Five patterns do exactly that; write the
right-hand side. (Citadel guards them with a per-file count that may not rise:
`.claude/rules/tests.md`.)

- A bare sleep: wait on the thing's done signal with one shared `until`, never the first sign of it.
- An assert that something was fast: take the clock as an injected knob and tick it. A deadline means
  "it hung", never "it was fast".
- A picked free port: bind port 0 and read the port back.
- A custom short deadline on a wait: use the default; shortening it only moves the flake.
- A hand-rolled recursive delete of temp folders: tear down through one shared helper.

To show nothing happens, do a second action, wait for it, then check the first stayed quiet. An escape
needs a written reason (`// timing-ok: <why>`) so a reviewer sees it.

## Tests that cost more than they prove

These can go red, but they pay for it in lines, seconds or false alarms (Citadel's audit, #739,
2026-11-15: about 5% of its test lines). Write the shape each line names; flag the other shape
in review.

- **A bug fix adds a row.** Put the failing case in the existing table or test for that
  behaviour; a new test or file is for a new behaviour, not a new bug number.
- **Assert what code reads**: tool names, flags, routes, strings another program parses, and
  the behaviour a prompt drives. Prompt, copy and doc prose stay free to change.
- **Waits are gates.** Wait on an event, a file, or an injected clock or timeout. A real sleep or
  timeout over 100 ms in a test means the code needs a knob for it: every real timer a test
  waits on (an undo bar, a proxy timeout, a lock wait) takes a setting the test turns down.
  An absence ("nothing repaints", "nothing fires") is proved by a counter: wait for the queue to
  drain, then check the count stayed put. A fixed idle proves nothing and costs its full length.
- **A failed action stays loud.** `.catch(() => {})` on a browser click hides a missing element
  and burns the full action timeout. Branch on the width or state that decides whether the
  element exists.
- **A comparison isn't a test.** When you try variants (thresholds, signal votes), the numbers go
  in the decisions log; only the shipped variant gets a test.
- **Consumers test their use, not the kit.** An app's browser tests cover how it uses a shared
  module; the module's own tests cover the module.
- **Expensive fixtures are shared per file** (a worker pool, a booted engine), unless the test
  is about the fixture.
- **A one-off's tests leave with it.** The one-off's `shortcut:` comment names its test, so
  whoever deletes the code deletes the test in the same commit.
- **Harnesses are shared.** Server boot, spawned tools, fake services and browsers come from the
  repo's test helpers; a second copy moves into them.
- **Fixtures live in the temp root.** Paths and ids a test makes up sit under its temp folder or
  use values that can't exist on the host. A test green on CI and red on the
  box is a host-path fixture until shown otherwise.

## Properties where the code has a shape

When the code has an algebraic shape (it round-trips, normalises, sorts, or has an oracle), one
test asserting a rule over many generated inputs beats a dozen examples. The catalogue, strength
order, a seeded loop needing no library, and what to do on a failure:
[references/properties.md](references/properties.md). Code with no such shape gets example tests,
and saying so is fine.

## Auditing a whole suite

A scheme-wide audit (the standard Test audit schedule, or someone asking whether a suite is too big or
too weak) follows [references/audit-method.md](references/audit-method.md): size and time, Sonnet
Grunts per batch, your own re-check, then a report and a card.

## Check before calling it done

1. **Mutate by hand.** Flip two or three risky lines of the diff (a comparison, a boundary, a
   branch, a guard), run that test file, confirm a test goes red each time, then undo the flip by hand (the tripwire refuses
   `git checkout -- <path>` and `git stash` over uncommitted work). A
   survivor is a gap, or a change that can't alter behaviour: decide which, and say. Reviewing
   read-only, name the line you would flip and the test that should catch it instead.
2. **Run the full check commands.**
3. **Rate what is still untested** on the tests lens's scale in citadel:self-review
   (`references/lenses.md`): behavioural gaps scored 1 to 10, only 7 and up fixed in this change.
   Rate honestly: no real gaps is a valid finding; don't invent one to look thorough.

## Report

One line in the PR: the seams tested, properties or examples, mutants killed (`3/3`), and any gap
left with its score.

## CI note

vitest orders files slowest-first from a cache in `node_modules/.vite`, which `npm ci` wipes, so
the slowest file can start last and set the wall time. Keep that cache between runs, or point
`cacheDir` somewhere `npm ci` leaves alone.
