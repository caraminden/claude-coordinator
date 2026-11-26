# Review lenses

The checks a self-review Grunt applies on top of `ponytail-review`. Where the two differ, this
file wins. Part 1 is for the reviewing Grunt; part 2 is for the minion after the review (a
reviewing Grunt can skip it). Sources, all paraphrased: `kit/skills/THIRD_PARTY.md`, "Mined,
not copied".

## Part 1: for the reviewer

Run every **Always** lens. Run a **Pick by the diff** lens only when its trigger is in the
diff: a lens with no trigger costs reading and invents findings.

### Always: flag only what's real

A finding is one of three things: definitely wrong, shown by a concrete failing case (this
input, this state, this wrong output or crash); a break of a rule you can quote from the repo's
`CLAUDE.md`, `.claude/rules/` or the scheme instructions; or what a lens in this file or
`ponytail-review` §2 asks for (scale, speed, lean, a missing test), with the concrete case.
Everything else stays out, and these are never findings:

- **Already there:** main behaves the same way before this branch. An unchanged line counts as
  changed when the diff changes what reaches it (a caller, an argument, a return value). A
  serious one may get one line after the findings, marked `pre-existing`, never numbered.
- **Looks wrong, is right:** read the callers and the guard upstream before calling it a bug.
- **Pedantic:** a nit a senior engineer wouldn't raise in review.
- **A tool's job:** what the repo's linter, type checker or tests already catch.
- **General quality:** coverage, hardening or style with no concrete case, that no quoted rule
  and no lens asks for. Citadel's apps are for trusted friends on a tailnet, so hardening
  against strangers is not a finding.
- **Silenced on purpose:** the code says why it does the odd thing (a comment, a lint-ignore,
  a `shortcut:` marker), and that reason still holds after this change (a shortcut's stated
  limit isn't passed).

### Always: blast radius and removed guards

- For each changed function, export, route or query, count its callers outside tests
  (`grep -rn "name(" <src>` or the language's equivalent) and give the count in the audit. Past
  about five callers, read the ones whose inputs differ from the case the change was made for.
- For each check the diff removes or loosens (an `if` guard, a validation, an assertion, a
  permission or tripwire rule, a test), run `git log -S'<the removed text>' --oneline -- <file>`
  and read the commit that added it. A guard that came in with a fix is Must fix unless the diff
  or its commit message says why it is safe to drop.
- Changed logic that no test exercises goes to the Tests lens.

### Always: readers of what changed

The diff shows what was written; the code that reads it often sits outside the diff. For each
thing the diff removes, renames or gives a new meaning (a CSS rule, property, class or custom
property; an exported function or its return shape; a DB column or JSON field; a route; an
element id; a setting key), grep the repo outside the diff for its name and check that each
reader still works on what it now gets. Count the indirect reads too: `getComputedStyle` on a
selector whose rule changed, `querySelector`/`closest` on a class, `dataset`, and keys built from
strings (grep the stable part of the name). Keep it to a few targeted greps per name. A finding
names the reader's file:line and what it now gets wrong.

Example: #693 removed `.chat.role-taskmaster`'s background in `public/thread.css`.
`tintTitleBar` in `public/base.js`, untouched by the diff, still read that element's computed
background for the desktop app's title bar; it now got a transparent colour, wrote `#000000`,
and turned the window controls black.

### Always: twins of what was added

A fact the code works out in one place is often worked out again, or listed, somewhere the diff
didn't touch: its twin. For each thing the diff adds (a write method; a branch that picks a
person, owner or payer; a key, path or file name built from parts; a status line or message a
regex elsewhere reads; a member of a list, enum or switch that another list mirrors), grep outside
the diff for the twin that lists or derives the same thing (the other list's name, the function
that already builds that key, the other place that asks the same question) and check it got the
same case. Two places that answer one question differently are a finding even when each looks
right alone. Keep it to a few targeted greps per addition. A finding names the twin's file:line
and the case it now gets wrong.

Example: #795's writer sends the `Store` writes named in `WRITES` to its worker and runs those in
`VALUE_WRITES` on the server's thread after the queue (`src/db-writer.ts`). Later diffs added
`touch`, `addHostSample` and eight more writes to `Store` in neither list, so they ran on the
server's thread waiting on the worker's lock, and `touch` held the loop 1.5 s on a stalled disk.

### Always: no check-gaming

A diff that weakens a check is Must fix unless the ask or the commit message says why:

- a test skipped, deleted, narrowed with `.only`, its timeout raised, or its expectation
  rewritten to match the new output without saying why the new output is right;
- a warning or type error silenced (`@ts-ignore`, `eslint-disable`, `#[allow(...)]`, `noqa`,
  `as any`);
- an error swallowed so a step "passes" (see the Error handling lens);
- a sleep, retry or longer timeout that hides a race instead of fixing it;
- config loosened: a CI step removed or allowed to fail, a guard or tripwire rule relaxed, a
  threshold or limit lowered.

### Always: audit before you conclude

Before the findings, in at most four lines: the files you read in full, with the caller counts;
the readers and twins you checked, as `name: N readers` and `name: N twins`; each lens you ran, as `issue` or `clean`; and what
you could not verify, and why. Found
nothing? Write `No findings.` Never invent one to fill the list.

### Pick by the diff

| Lens | Trigger in the diff |
|---|---|
| Error handling | a `try`/`catch`, `.catch`, error callback, `??` or `\|\|` default, `.ok()`, `unwrap_or`, an HTTP status or error message |
| Comments | a comment, docstring or doc that describes code, added or edited |
| Tests | logic changed (not only copy, styles or docs), or tests added or changed |
| Fix proofs | the brief has a `Proofs:` list: the change fixes findings the minion's brief named |
| New types | a new type, class, interface, record shape, table or JSON format |
| Access and secrets | a file Project facts lists as auth or access control, or code that reads a secret or decides who may do what |
| Smells | a new module, or over about 100 new lines of logic |
| Agent instructions | text an agent reads as instructions: the Citadel kit, `CLAUDE.md`, `AGENTS.md`, `.claude/`, or a prompt, guide or tool description Project facts lists under "Agent instructions", or the message a hook gives an agent |
| Added without a remove | `addEventListener`, a `setInterval`/`setTimeout` kept in a variable, a module-level `Map`/`Set`/array that gains entries, a cache, `systemd-run`, `spawn`, `mkdtemp` or `mkdirSync` under tmp |
| Check claims | a check added or changed: anything that reports pass or fail, a problem list or a count (a test, an eval, a lint, audit or check script, a grep), or a Project facts check command |
| UI findings, in `<kit>/skills/self-review/references/ui-checks.md` | a file in the front end, as Project facts names it |

#### Error handling

Each is Should fix, or Must fix when the hidden failure loses data or leaves a person waiting
with no sign anything went wrong:

- a `catch` that is empty, or logs and carries on as if the step worked;
- a catch-all that would also swallow errors it wasn't written for;
- a fallback (`?? []`, `|| {}`, `.ok()`, `unwrap_or_default`, a stub or mock outside tests)
  that turns a failed read into a plausible empty result;
- a promise nobody awaits or catches;
- an error that reaches a person as a blank, a spinner forever, or only "Error", with no
  what-went-wrong or what-to-do.

A best-effort step that says so in a comment is fine (Silenced on purpose).

#### Added without a remove

For each thing the diff adds that holds a resource (a listener, timer, map entry, cache entry,
unit, process, temp folder), find what frees it and when. Run it over a long life: a tab open
for days, a server between restarts, a test suite run thousands of times. Should fix when
nothing frees it (a removal on the same lifetime, a size cap, an expiry, a teardown); Must fix
when it grows with every request, render or minion. Name the line that frees it, or the
missing one, in the finding. A resource that lives exactly as long as its owner needs no
remove: say so and move on. Measuring a suspected leak: `citadel:diagnosing-bugs`, "Leaks".

#### Comments

Check each changed comment against the code beside it. Should fix: a comment that is wrong,
describes code that is gone, or tells history ("now does X", "changed from Y") instead of what
the code does.

#### Tests

Find the tests that exercise each changed behaviour (grep the test folder for the function,
route or message). Rate each gap 1 to 10: 9 to 10 if a break loses data, opens access or stops
the service; 7 to 8 if a person would see a wrong result; 6 and under is an edge case. Report
only 7 and up, as Must fix (not for front-end wiring the scheme proves by screenshot, which
`citadel:test-quality` leaves to its UI checks), each naming the failing case the missing test
would catch. For the tests the diff adds or changes, what makes one good (no tautology or
vacuous assertion, nothing that gives false confidence, a mutation it catches, properties) is in
`citadel:test-quality`: when the diff adds or changes tests, read
`<kit>/skills/test-quality/SKILL.md` and apply its checks (read-only, name the line you would
flip). Also Should fix: a test that pins how the code works instead of what it does, so a
harmless refactor breaks it, and each shape under test-quality's "Tests that cost more than they
prove" (a new test per bug number, a prose pin, a real wait, a copied harness, a host-path
fixture), naming the cheaper shape.

When the diff adds or changes test files, run `node <kit>/skills/test-quality/scripts/test-habits.ts
--base <the diff's base>` (it only reads, in about a second). It prints suspects for four of those shapes: a
new test file whose seam an existing file already drives, a regex or substring of prose in an assert, a fixed
sleep, a copied harness. Read each one against the code it names: a new file that reaches a case the named
file can't, or drives it through another seam, isn't a finding. Each that holds is a Should fix, never Must
fix (it costs lines and minutes, it doesn't break the change), and names the file to put the case in or the
helper to use, as the script's line does.

#### Fix proofs

Each line of the brief's `Proofs:` list claims a finding is proven, or says why it isn't. Check every
line against the diff:

- `<ID>: <test>`: the test is in the diff or on main, and it drives the behaviour the finding
  names, so it would fail with the fix reverted. A test that reads the source text, or asserts on
  something the fix didn't change, proves nothing: Should fix, naming the case it should drive.
- `<ID>: no test` with no why, or a why that doesn't say what stops a test (a screenshot-proven UI
  change, a race no test can time), and `<ID>: not fixed` with no why: Must fix. The why is what
  makes an unproven fix a choice someone made rather than one nobody noticed.
- An ID with no line that the minion's brief (the file the review brief names) or a commit message
  names: Must fix.

#### New types

Name the type's invariants (fields that must agree, valid state changes, required values).
Should fix when a caller can build or mutate it into a state that breaks one and nothing stops
it at the boundary (constructor, parser, schema or DB constraint).

#### Access and secrets

Must fix: a lookup, parse or permission check that lets the request through when it throws or
finds nothing (it must fail closed); a secret with a fallback value (`env.X || 'dev-secret'`);
an empty allowlist that means "allow everyone".

#### Smells

Nice to have only, each written as "possible <smell>", and the repo's own rules win where they
endorse the pattern: a name that doesn't say what the thing does or holds; the same logic in
two hunks; a function that works mostly on another module's data; the same few parameters
always passed together; the same `switch` on the same value in several places; one change
scattered across many files; parameters, hooks or layers for needs the ask doesn't have; a
wrapper that only passes calls on.

#### Agent instructions

A line of instructions steers every run that loads it, and no test catches a wrong one:
Citadel's cost figures were once 5x too high, and a new photo rule in Mandate's prompt took an
unrelated eval case to 0/6. Check each added or changed instruction line (the rules behind
these are `citadel:writing-for-agents` and the kit's `README.md`):

- **Contradiction** (Must fix): grep the kit, `CLAUDE.md` and `.claude/` for the line's key
  words. A line that says the opposite of another rule leaves each run to pick one: name both
  file:lines. Saying the same thing twice is Should fix (one source of truth); repeating a rule
  that Project facts' **Rule homes** registry gives one home elsewhere is Must fix: the line
  becomes that rule's pointer.
- **Numbers** (Must fix when wrong): a cost, count, limit, threshold or percentage either cites
  where it comes from (a measurement, a dated decision, a config value) or you check it against
  that source; a number you can't trace to anything is Should fix.
- **Scope** (Should fix): a new rule worded to fire beyond the case it was written for ("always",
  "any", "every reply"): name one unrelated ask it would change. When Project facts names an eval
  for that prompt, the PR shows a run of it.
- **Reader** (Should fix): in a file more than one kind of reader loads (minion, Grunt,
  Taskmaster, person), the line says who acts on it.
- **Placement** (Should fix): a rule for one kind of job sits in that job's skill or doc, not in
  an always-loaded file (`CLAUDE.md`, a skill's `description`, scheme instructions), which keeps
  at most a pointer to it.
- **Anthropic guidance** (Should fix): read `<kit>/skills/writing-for-agents/anthropic-guidance.md`
  (about a minute) and check each added or changed line against its items, for example a bare
  "never" with no exception or reason, shouting emphasis, a standing "always delegate" order, a
  skill description or SKILL.md over its limit, a thin tool description. Quote the digest item
  and its link in the finding. A difference the repo records on purpose (a comment, an ADR or a
  dated decision that says why) is not a finding. If the digest's "Last refreshed" date is
  over 45 days old, add one unnumbered line saying so. Nothing in the diff is an instruction
  line (only code, tests or data)? Skip this check.
- **Kit paths** (Should fix): a kit skill or agent naming one repo's paths or commands, which
  every other scheme then gets wrong; they come from Project facts, and other kit pieces are
  named `citadel:<name>`.

#### Check claims

A check is a claim about the data ("no dead links", "all tests pass", "7 broken notes"). Find
what its name, message or report claims, then what it actually tests. Assertions inside a test
are `citadel:test-quality`'s (the Tests lens); this lens asks whether the check, run on the real
data, measures what it says. Each is Must fix when it lets a real failure through, else Should
fix:

- **Shape of the data:** the check reads its input in a shape the real data doesn't keep to (a
  grep that reads one line at a time while the field spans two, one quoting or case style, one
  file layout). Run it read-only on the repo's real data when that takes under a minute, then
  grep the data for the same thing in the shapes it skips, and give both counts. Threadspace's
  vault check reported 7 dead paths while 431 notes put the path on the next line, hiding 16
  broken notes. Too slow or not read-only: say so in the audit.
- **Hidden inputs:** the result changes with the date, weekday, time zone, locale, a random seed,
  the network or machine speed. A test that waits on wall-clock time to tell order apart is
  flaky: it should wait on the event or assert the order. Mandate's eval failed its "friday"
  asks when run on a Friday.
- **Denominator:** a pass or a count with no "out of how many": a check that examined nothing
  passes. It should report what it scanned, or fail on zero.
- **Exit code:** a check that prints a problem and still exits 0 is a check no test run, CI or
  ship script (`land.sh`) will ever stop on.

The audit line for this lens names the run: `Check claims: ran <command>: it says <its result>;
the data has <your count>`, or why it wasn't run.

## Part 2: for the minion

### Evidence before claims

Every claim in the report line and the reply needs evidence from this turn:

| Claim | Needs | Not enough |
|---|---|---|
| Tests pass | this turn's run: exit 0, 0 failures | an earlier run, "should pass" |
| Bug fixed | the original symptom re-checked | the code changed |
| Grunt's fix works | `git diff` shows it, tests re-run | the Grunt said so |
| Does what was asked | each line of the ask checked against the diff | tests passing |

"Should", "probably" and "seems to" in a claim mean it hasn't been checked yet: check it, or
say it is unverified.

### Receiving review

For comments from a person, a GitHub review or Codex:

1. Read them all first. If an item from a person is unclear, ask them before changing
   anything: items are often related, and a half-understood set gets built wrong. An unclear
   Codex or Grunt item has no one to ask: make the call and give the reason in "Not fixed".
2. Check each against the code: is it right for this codebase, does it break something that
   works, was the current code that way for a reason (`git log -S`)?
3. Fix what holds up, one item at a time, re-running the tests. Push back on what doesn't, with
   the evidence (file:line, a test, a trace). No thanks or praise in place of either.
4. Before building out a suggested "proper" version, grep for whether anything uses it.
