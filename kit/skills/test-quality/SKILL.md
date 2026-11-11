---
name: test-quality
description: Whether a test proves anything, and test-first for new logic. Use when writing tests for a feature or change, when reviewing a diff's tests or asked "are these tests any good", or when a green test looks too easy. Not for every edit, not for reproducing a bug (bug-fixing), and not for UI changes the scheme proves by screenshot.
---

# Test quality

A test is worth keeping when it goes red as soon as its behaviour breaks. Check commands come
from the repo's CLAUDE.md, "Project facts". Never add a test library or other
dependency: offer it once, with the test you would write, and leave the call to a person.

## When it applies

- **New logic** (a parser, a reducer, a rule, a state change, a query): test-first. One failing
  test for one behaviour, watch it go red, just enough code to pass, repeat. A batch of tests
  written up front checks the shape you imagined, not the behaviour you built.
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
- **No assertion**, or only "didn't throw" or "is defined".
- **A swallowed failure**: an empty catch around the act, the assertion only inside a catch, an
  async assertion without `await` (the test ends before it runs), a callback that never fires.
- **A disabled or always-true assertion**: commented out, or `true` asserted true.
- **A weaker check than the code allows**: the length checked but never the order.
- **A fragment where the whole value is known**: assert the whole value (`toEqual`,
  `toMatchInlineSnapshot`), not a fragment with `toContain`.

## Properties where the code has a shape

When the code has an algebraic shape (it round-trips, normalises, sorts, or has an oracle), one
test asserting a rule over many generated inputs beats a dozen examples. The catalogue, strength
order, a seeded loop needing no library, and what to do on a failure:
[references/properties.md](references/properties.md). Code with no such shape gets example tests,
and saying so is fine.

## Check before calling it done

1. **Mutate by hand.** Flip two or three risky lines of the diff (a comparison, a boundary, a
   branch, a guard), run that test file, confirm a test goes red each time, then revert. A
   survivor is a gap, or a change that can't alter behaviour: decide which, and say. Reviewing
   read-only, name the line you would flip and the test that should catch it instead.
2. **Run the full check commands.**
3. **Rate what is still untested** on the tests lens's scale in citadel:self-review
   (`references/lenses.md`): behavioural gaps scored 1 to 10, only 7 and up fixed in this change.
   Rate honestly: no real gaps is a valid finding; don't invent one to look thorough.

## Report

One line in the PR: the seams tested, properties or examples, mutants killed (`3/3`), and any gap
left with its score.
