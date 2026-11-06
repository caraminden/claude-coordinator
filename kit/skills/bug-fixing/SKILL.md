---
name: bug-fixing
description: How to fix a bug. Reproduce it as a failing test first, find the cause rather than the symptom, make the smallest fix, prove it, report in five lines. Use when someone reports wrong output, a button that does nothing, a crash, data that comes back wrong, or behaviour that contradicts a rule, a spec or a doc comment. Escalate to diagnosing-bugs when the first reproduction attempt fails. Not for complaints about pace or feel.
---

# Bug fixing

A bug report is a request for the fix, not for a diagnosis. Reproduce, fix, prove,
report; in that order. Several symptoms in one message are separate bugs: fix the ones
you can reproduce (one PR if they share a cause, else one each), and for one you cannot
reproduce, state the most likely reading and the change you made for it as a default the
reporter can veto.

The repo's CLAUDE.md, "Project facts", names its check commands, its decisions log and any
bug classes of its own; read them before step 1.

## Procedure

1. **Classify in one line.** Almost every bug is one of:
   - *Logic bug*: a rule, formula, state transition or handler does the wrong thing. Most
     bugs, including ones that look like UI ("the cost shows 12 but I was charged 13").
   - *Presentation bug*: the logic is right and the screen shows or wires it wrong (a
     missing refresh, a handler bound to the wrong element, a stale label, formatting or
     rounding that makes two correct numbers disagree on screen).
   - *Tooling bug*: build, hook, CI, deploy or editor.
   Read the code behind the symptom before deciding; a wrong label usually points at a
   value that is wrong or missing underneath. A complaint about pace or feel that
   contradicts no rule, spec or doc comment is not a bug: treat it as a design request.
2. **Reproduce as a failing test**, in the test file for the module involved, named for
   the behaviour that should hold (`checkout_charges_the_displayed_cost`), not for the
   bug. Write the assertion for the *correct* behaviour and watch it go red. If you cannot
   make it fail, check the wiring next; if the logic test passes and the wiring is right,
   it is a presentation or expectation problem: say so with the passing test as evidence.
   For a presentation bug, trace the view against the data it reads. For a tooling bug,
   reproduce the command. If none of these reproduces it, switch to the
   citadel:diagnosing-bugs skill. Reproduce and fix within one turn.
3. **Find the cause.** Walk from the symptom back to the line that is wrong and say why
   it is wrong in one sentence. "Changed X and it works now" is not a cause.
4. **Fix the minimum.** The fix touches the cause and nothing else. No refactoring, no
   renames, no second bug in the same change; note those for a separate PR. Grep every
   caller of what you touch first, and fix the root once in the shared code.
5. **Prove it.** The new test passes, the whole suite passes, the build is clean. A
   presentation-only fix is proven by a before and after screenshot or captured output.
   If it doesn't hold (still red, or the bug comes back), that is strike one: switch to
   citadel:diagnosing-bugs and follow its three-strikes rule.
6. **Hunt for siblings.** The step 3 sentence says *why* the line was wrong, and the same
   mistake is usually made elsewhere. Write a `git grep -nE` pattern that matches the
   wrong line and nothing else, and check it against the unfixed code (`git grep … main`)
   to prove it hits. Then loosen one part at a time (a name to a wildcard, one call to
   its family, one folder to the whole repo), reading every hit after each step, and stop
   once more than half the hits are noise. A sibling with the same cause is the same bug:
   fix it here with its own test case. List anything you're unsure of in the report.
   Hunts miss when they search only the module that was fixed, keep the pattern so tight
   it finds only the original, or loosen several parts at once so real hits drown.
7. **Report** in the PR: cause in one sentence, the fix, the test name, the siblings
   (fixed, listed, or "none" with the widest pattern searched), and anything related you
   saw and left alone. The reply is five lines at most: cause, fix, proof, what was left
   alone, any default they can veto, and the PR link.

## Where bugs hide

Check these, and the repo's own classes from Project facts, before anything exotic:

- **Time:** zero or negative durations, one long step versus many short ones (they must
  agree), clocks read in logic that should take time as input, time zones.
- **Rounding:** a value computed twice (display and charge) with different intermediate
  steps; comparisons at exact equality on floats.
- **Order:** an effect applied before or after the state it depends on is updated; two
  handlers racing on the same event.
- **Growth:** integer overflow, floats losing precision at large magnitudes.
- **Persistence:** a field added to the model but not to the save or the schema, a
  default that differs between a fresh object and a loaded one, a missing migration.
- **Presentation:** a refresh not called after an input, a disabled state that trails the
  data, formatting hiding a fractional bug or being the bug.

## Test smells

- A test that asserts the number the code happens to produce rather than the number the
  rule says it should (compute the expectation in the test from the rule).
- A test that still passes when the behaviour it names is broken: revert the fix and check
  that it goes red.
- Tolerances wider than the rule needs.
- Mocks of your own pure logic: if something needs a mock, it may be in the wrong layer.

## Rules

- Never fix a bug by loosening a test or widening a tolerance.
- Never change a default or a config value to make a bug disappear; a number that hides a
  bug is a second bug.
- If the reproduction shows the rule itself is wrong rather than the code, the fix is a
  rule change: say so, change the rule on purpose (and log it in the decisions log Project
  facts names, if any), and rewrite the test to the new rule in the same turn. Never end a
  turn on a red test.
- For a broad hunt ("something is off with checkout"), hand the sweep of the classes above to
  a Grunt that writes the edge-case tests and reports which fail; you put them in the
  suite and fix the code.
