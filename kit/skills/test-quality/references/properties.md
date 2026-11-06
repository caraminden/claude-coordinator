# Property tests

An example test checks one input. A property test states a rule that holds for every valid
input, then runs it over many generated ones. It pays off only when the code has a rule like
that; otherwise write examples.

## The catalogue

| Property | The rule | Fits |
|---|---|---|
| Round trip | reading back what you wrote gives the original | parse/format, encode/decode, save/load |
| Inverse | undoing an operation restores the input | add/remove, escape/unescape, compress/expand |
| Oracle | the new code agrees with a slow, obvious version | an optimisation, a rewrite, a cache |
| Idempotence | doing it twice equals doing it once | normalising, trimming, sorting, dedupe, migrations |
| Invariant | something stays true through the change | counts, totals, uniqueness, ordering, a state machine's legal states |
| Easy to check | the answer is hard to compute but cheap to verify | `isSorted(sort(xs))`, a path that really connects |
| Order doesn't matter | swapping the arguments, or the order of events, gives the same result | merges, set operations, reducers over commuting events |

From weakest to strongest: *doesn't crash*, *returns the right type*, *invariant*,
*idempotence*, *round trip or oracle*. Assert the strongest the code supports, and usually more
than one. If all you can find is "doesn't crash", look for a small refactor that pulls the logic
out of its I/O and exposes a stronger rule. If there isn't one, write example tests.

## A seeded loop, no library

Use the property-testing library the repo already has. With none, a plain loop in the repo's own
test runner does the job; adding a library is a person's call. A Node sketch:

```js
// Small seeded generator (mulberry32): the same seed gives the same cases.
function rng(seed) {
  return () => {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('format then parse gives the original back', () => {
  const seed = Number(process.env.PROP_SEED ?? 1);
  const next = rng(seed);
  for (let i = 0; i < 300; i++) {
    const input = randomInput(next);
    assert.deepEqual(parse(format(input)), input, `seed ${seed}, case ${i}: ${JSON.stringify(input)}`);
  }
});
```

- **Keep a fixed default seed**, so the suite is deterministic and never flaky. While writing
  the test, run it under several other seeds (`PROP_SEED=$RANDOM`) to explore.
- **Put the seed and the input in the failure message**, so a failure can be replayed.
- **Generate valid inputs directly** rather than generating anything and skipping the invalid
  ones. A skip that drops most cases makes the test vacuous.
- **Bias towards the edges**: empty, one item, duplicates, the maximum length, zero and
  negatives, non-ASCII text, the characters the format treats specially (quotes, newlines,
  separators).
- A few hundred cases is plenty for a unit test. Keep the whole loop well under a second.

## When it fails

1. **Shrink it.** Cut the failing input down (drop items, shorten strings, move numbers towards
   zero) while it still fails, until nothing more can go. The minimal case shows the cause.
2. **Decide what failed.** Check the input against what the code promises, most trusted source
   first: a spec or file format, the types, the doc comment, the existing tests, and last of all
   the function's name.
   - The code breaks a promise it makes: a bug. Fix it (citadel:bug-fixing).
   - The input breaks a precondition: the generator is too broad. Narrow it.
   - The rule contradicts the docs: the property is wrong. Fix the property.
   - Nothing says what should happen: the spec is open. Ask a person, and keep the case as a
     note, not a bug.
3. **Keep the minimal case** as a plain example test named for the behaviour, beside the
   property. It stays even if the generator changes.

## Reviewing property tests

On top of the general list in the skill, watch for:

- a filter so tight that the test is an example in disguise (`only when x === 42`);
- so few cases (`5`) that it can't find anything;
- the expected value rebuilt with the code's own formula: assert a rule instead (order doesn't
  matter, an identity element, a round trip);
- float equality with no tolerance, or a check on the iteration order of a map or set: flaky,
  and flaky tests get deleted.
