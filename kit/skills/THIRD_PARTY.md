# Third-party skills

Some skills in the Citadel kit are copies of two open-source packs, plus one rules file in
Citadel's repo; others carry ideas mined from more packs ("Mined, not copied" below). They are copied in,
not installed as the upstream plugins, so every Citadel turn of every scheme loads the same
set the same way, through the kit (`kit/README.md`).

## Copies

Every copied path, one row each, in the format `citadel:upstream-check` reads (a scheme repo's own
`THIRD_PARTY.md` uses the same columns). **Pinned commit** is the upstream commit the copy was taken from;
**Checked** is the upstream commit and date the last upstream check compared it against, so the
next check diffs only what came after. Paths here are from the repo root.

| Upstream repo | Upstream path | Pinned commit | Path here | Licence | Copied | Checked |
|---------------|---------------|---------------|-----------|---------|--------|---------|
| [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail) | `AGENTS.md` | `96608e0` | `.claude/rules/ponytail.md` (a plugin can't carry rules) | MIT | adapted: path-scoped to code files; "In this repo" section added | `96608e0` 2026-11-06 |
| DietrichGebert/ponytail | `AGENTS.md` | `96608e0` | `kit/skills/scheme-setup/templates/ponytail.md` (copied into each new scheme's `.claude/rules/`) | MIT | adapted: as the row above, "In this repo" left for each scheme to write | `96608e0` 2026-11-06 |
| DietrichGebert/ponytail | `skills/ponytail-review/` | `96608e0` | `kit/skills/ponytail-review/` | MIT | adapted: shorter description that also covers a whole repo and the debt ledger; two pointer lines to `AUDIT.md` and `DEBT.md` (#362) | `96608e0` 2026-11-06 |
| DietrichGebert/ponytail | `skills/ponytail-audit/SKILL.md` | `96608e0` | `kit/skills/ponytail-review/AUDIT.md` | MIT | moved, otherwise unchanged (#362) | `96608e0` 2026-11-06 |
| DietrichGebert/ponytail | `skills/ponytail-debt/SKILL.md` | `96608e0` | `kit/skills/ponytail-review/DEBT.md` | MIT | moved, otherwise unchanged (#362) | `96608e0` 2026-11-06 |
| [mattpocock/skills](https://github.com/mattpocock/skills) | `skills/productivity/grilling/` | `4ae2317` | `kit/skills/grilling/` | MIT | adapted: a round is asked as decision cards where the session has a card tool, numbered questions elsewhere | `4ae2317` 2026-11-06 |
| mattpocock/skills | `skills/engineering/domain-modeling/` | `4ae2317` | `kit/skills/domain-modeling/` | MIT | adapted: glossary and decisions log from Project facts | `4ae2317` 2026-11-06 |
| mattpocock/skills | `skills/engineering/codebase-design/` | `4ae2317` | `kit/skills/improve-codebase-architecture/` (`SKILL.md` as `CODEBASE-DESIGN.md`, plus `DEEPENING.md` and `DESIGN-IT-TWICE.md`) | MIT | adapted: "each with a fresh context window" also in `SKILL.md`'s pointer to DESIGN-IT-TWICE (#354); a references file of improve-codebase-architecture, its only caller, not its own skill: frontmatter dropped, and DEEPENING and DESIGN-IT-TWICE link `CODEBASE-DESIGN.md` where upstream links `SKILL.md` (#364) | `4ae2317` 2026-11-06 |
| mattpocock/skills | `skills/engineering/diagnosing-bugs/` | `4ae2317` | `kit/skills/diagnosing-bugs/` | MIT | adapted: narrower description (the escalation from `bug-fixing`), glossary from Project facts and optional; three strikes, flaky tests, trigger hypotheses and fix-at-the-source added (see Ideas below) | `4ae2317` 2026-11-06 |
| mattpocock/skills | `skills/engineering/improve-codebase-architecture/` | `4ae2317` | `kit/skills/improve-codebase-architecture/` | MIT | adapted: model-invoked; headless output; glossary and decisions log from Project facts; reads the vocabulary from its own `CODEBASE-DESIGN.md` (the row above) rather than calling a skill (#364) | `4ae2317` 2026-11-06 |
| mattpocock/skills | `skills/productivity/writing-for-agents/` | `4ae2317` | `kit/skills/writing-for-agents/` | MIT | adapted: testing and importing sections, prose tells, `TESTING.md` (ideas mined below) | `4ae2317` 2026-11-06 |
| [android/skills](https://github.com/android/skills) | `build-system/agp/agp-9-upgrade` | `5815d27` | `kit/skills/android-app/references/agp-9.md` | Apache-2.0 | rewritten in our own words, merged with the next row; IDE steps replaced by commands (#455) | `5815d27` 2026-11-10 |
| [Kotlin/kotlin-agent-skills](https://github.com/Kotlin/kotlin-agent-skills) | `skills/kotlin-tooling-agp9-migration` | `087f568` | `kit/skills/android-app/references/agp-9.md` | Apache-2.0 | rewritten in our own words, merged with the row above; KMP parts left out (#455) | `087f568` 2026-11-10 |
| [fluxxion82/android-emulator-skill](https://github.com/fluxxion82/android-emulator-skill) | `android-emulator-skill/skills/android-emulator-skill/scripts/` (`push_notification.py`, `sms.py`, `common/emu_console.py`), `references/adb_quick.md` | `2adf5cd` | `kit/skills/android-app/SKILL.md` ("Other console and shell traps") | MIT | facts rewritten in our own words; not re-run on the shared emulator in #455 | `2adf5cd` 2026-11-10 |

Every copy drops the Codex-only `agents/openai.yaml`; "unchanged" means every other file matches
upstream at the pin. Carried over from the Delve repo (`.claude/skills/THIRD_PARTY.md` there,
2026-10-27, mattpocock `49dd158`, ponytail `2961b52`) with Delve's paths taken back out, moved into
the kit (Citadel #164, 2026-10-29), where repo paths come from each repo's CLAUDE.md "Project facts",
and re-synced to the pins above by #354 (2026-11-06). Licence texts are at the end.

## Why the local changes

- **Ponytail as a rule, not a skill.** Ponytail only works when it is always on; the
  plugin does that with Node hooks, and a plain skill rarely triggers on its own. A file
  in `.claude/rules/` is loaded by every session with no hooks. Its `paths` limit it to
  code, so design talk and research keep their normal style. The plugin's levels
  (`/ponytail lite|ultra`) and status line need its hooks and are not used; asking a
  session to be more or less minimal works instead.
- **ponytail-audit** and **ponytail-debt** live inside `ponytail-review` as `AUDIT.md` and
  `DEBT.md` (#362, from the #353 stocktake): three skills with near-identical descriptions made
  every session read three where one would do, and each is something a person asks for, so one
  description and two pointer lines reach them. The files are verbatim, frontmatter and
  `/ponytail-audit`-style names included, so a sync stays a plain copy; sessions follow the
  pointer line, not those names. `ponytail-review`'s description is rewritten to cover all
  three and to leave "code review" and "review my PR" to the built-in `code-review`, and "is
  this over-engineered" to the built-in `simplify`.
- **diagnosing-bugs** and the repo's own `bug-fixing` skill both matched every bug
  report. Its description now makes it the escalation for hard bugs.
- **improve-codebase-architecture** was user-invoked (`disable-model-invocation: true`).
  User-invoked skills run only from a `/name` at the very start of a prompt, and a
  Citadel minion's messages reach Claude Code as `[Name]: text`, so it could
  never run. It is model-invoked now, with a description that only fires on request.
  Upstream writes its HTML report to a temp folder and opens it; a headless session
  gives the path and a plain-text summary instead. Keep this in mind for any skill
  added later: a user-invoked one is unreachable from minions.
- **grilling** asked each round as one message of numbered questions. Cara answers
  faster on cards (2026-10-27), so where a card tool exists (`ask_question` in a Citadel
  turn) each question is a card; the numbered format stays for everything else.

## Left out

- **ponytail** (the skill), **ponytail-help**, **ponytail-gain**: the rules file replaces
  the first; the other two describe plugin features (levels, status line, a benchmark
  scoreboard).
- **Ponytail's plugin hooks**: not used. For the record they are benign: they write a
  mode flag and a status-line script under `~/.claude`, run `git ls-files` for a code
  map, and make no network calls.
- **tdd**: asks the user to confirm test seams before every test; `bug-fixing` covers
  test-first for bugs, and `test-quality` takes the rest of its ideas (below).
- **code-review**: a project skill with this name replaces Claude Code's built-in
  `/code-review`; its spec half also needs an issue tracker. `ponytail-review` covers
  reviews in plain English.
- **pr**: its PR body format conflicts with `.github/pull_request_template.md`.
- **grill-me**, **grill-with-docs**: user-invoked wrappers that just load `grilling` (and
  `domain-modeling`). Say "grill me" instead.
- **setup-matt-pocock-skills**, **to-spec**, **to-tickets**, **triage**, **wayfinder**,
  **implement**, **implement-spec**, **ask-matt**: built around an issue tracker. Worth a
  second look if Citadel's minions ever become that tracker.
- **prototype**, **research**, **handoff**, **teach**, **to-questionnaire**,
  **wait-what**, **retro**, **wizard**: repeat what sessions already do, write to temp
  folders nobody sees, or assume someone at a terminal. (The `retro` here is Delve's own,
  not upstream's.)
- `misc/`, `in-progress/`, `deprecated/`: TypeScript or JS tooling, or unfinished.

## Mined, not copied

Ideas taken from other skills and written out in the kit's own words. No upstream text or code is
copied, so nothing here needs re-syncing; the source is named so the idea can be traced.

| Kit file | Idea | Source, pinned | License |
|----------|------|----------------|---------|
| `docs-and-mocks/reader-test.md` | Test a doc on a context-free reader with predicted questions | [anthropics/skills](https://github.com/anthropics/skills) `skills/doc-coauthoring`, "Reader Testing", `ca45fc4` | No licence file: idea only, paraphrased |
| `docs-and-mocks/prototypes.md` | Throwaway prototypes: a logic toy, look variants, the shared rules | mattpocock/skills `skills/engineering/prototype` (`SKILL.md`, `LOGIC.md`, `UI.md`), `4ae2317` | MIT, Matt Pocock (text below) |
| `docs-and-mocks/looks.md` | A token plan checked against the brief; the "generated page" tells; boldness in one place | anthropics/skills `skills/frontend-design`, `ca45fc4` | Apache-2.0 |
| `test-quality/` | The property catalogue and its strength order; the two ways a property test asserts nothing (tautology, vacuity); "no shape, so example tests"; a library is a person's call; a failure sorted into code bug, wrong property or open spec | [trailofbits/skills](https://github.com/trailofbits/skills) `plugins/property-based-testing` (Henrik Brodin), `470419e` | CC-BY-SA 4.0, so paraphrase only: never paste its text here |
| `test-quality/` | Mutate a few lines and check a test fails (the idea only: theirs runs a mutation tool, ours is by hand) | trailofbits/skills `plugins/mutation-testing`, `470419e` | CC-BY-SA 4.0, paraphrase only |
| `test-quality/` | Tests through public interfaces, mocks only at system boundaries, expected values from an independent source, vertical slices. Left out: confirming every seam with the user first | mattpocock/skills `skills/engineering/tdd` (`SKILL.md`, `tests.md`, `mocking.md`), `4ae2317` | MIT, Matt Pocock (text below) |
| `test-quality/` | Tests that give false confidence (no assertion, swallowed exceptions, missing await, self-referential and always-true assertions); calibrate severity honestly | [dotnet/skills](https://github.com/dotnet/skills) `plugins/dotnet-test/skills/test-anti-patterns`, `d63a2a7` | MIT, .NET Foundation |
| `test-quality/` | Behavioural gaps rated 1 to 10, acting on 7 and up (the scale lives in self-review's tests lens) | [anthropics/claude-plugins-official](https://github.com/anthropics/claude-plugins-official) `plugins/pr-review-toolkit/agents/pr-test-analyzer.md`, `d189be9` | Apache-2.0 |
| `test-quality/` | Assert the whole value, not a fragment of it (suggested by Genesis Tree #6) | [vitest-dev/vitest](https://github.com/vitest-dev/vitest) `AGENTS.md`, `9fd1f22` | MIT |
| `skill-stocktake/` | Audit each skill for overlap, freshness, actionability and trigger breadth; five verdicts with reasons that stand alone; a quick scan of what changed | [affaan-m/everything-claude-code](https://github.com/affaan-m/everything-claude-code) `skills/skill-stocktake`, `b38be6a` | MIT, Affaan Mustafa (text below) |
| `writing-for-agents/` (Testing a skill, `TESTING.md`) | Run a baseline Grunt without the guidance first; reps and variance; match the form to the failure; exemption clauses don't scope | [obra/superpowers](https://github.com/obra/superpowers) `skills/writing-skills` and `references/testing-skills-with-subagents.md`, `22f0b46` | MIT, Jesse Vincent |
| `writing-for-agents/TESTING.md` | Trigger evals: about 20 realistic prompts with near-misses and a held-out part. Left out: its scripts, which loop `claude -p` | anthropics/skills `skills/skill-creator`, "Description Optimization", `ca45fc4` | Apache-2.0 (the skill's own `LICENSE.txt`) |
| `writing-for-agents/` (Importing a third-party skill, `TESTING.md`) | The import checklist: read order and what to look for. Left out: its scanner script | [getsentry/skills](https://github.com/getsentry/skills) `skills/skill-scanner`, `e94f222` | Apache-2.0 |
| `writing-for-agents/` (Importing a third-party skill) | Look for an existing skill on skills.sh first. Left out: its `npx skills` installer | [vercel-labs/skills](https://github.com/vercel-labs/skills) `skills/find-skills`, `d3701c1` | MIT, Vercel |
| `writing-for-agents/` (Pruning) | Five structural prose tells and "every sentence adds something". Left out: the 26-pattern catalogue | [blader/humanizer](https://github.com/blader/humanizer) `SKILL.md`, `0ef9fe5` | MIT, Siqi Chen |
| `scheme-setup/` (step 3) | The CLAUDE.md check (commands, non-obvious, current, concise) and its keep-out list | anthropics/claude-plugins-official `plugins/claude-md-management/skills/claude-md-improver` and `references/quality-criteria.md`, `d189be9` | Apache-2.0 |
| `self-review/references/lenses.md`, "flag only what's real" | The false-positive list and "flag only what's definitely wrong or a quotable rule" | anthropics/claude-plugins-official `d189be9`, `plugins/code-review/commands/code-review.md` | Apache-2.0 |
| `lenses.md`, "Pick by the diff" | Lenses picked by the diff: silent failures, comment accuracy, behavioural test gaps rated 1 to 10, type invariants | anthropics/claude-plugins-official `d189be9`, `plugins/pr-review-toolkit/` (`commands/review-pr.md`, agents `silent-failure-hunter`, `comment-analyzer`, `pr-test-analyzer`, `type-design-analyzer`) | Apache-2.0 |
| `lenses.md`, "blast radius and removed guards" | Blast radius by caller count, `git log -S` on removed guards | trailofbits/skills `470419e`, `plugins/differential-review` | CC-BY-SA 4.0 (paraphrase only) |
| `agents/finding-checker.md` | Argue the finding is wrong first; a verdict needs a test or a trace | trailofbits/skills `470419e`, `plugins/fp-check` | CC-BY-SA 4.0 (paraphrase only) |
| `lenses.md`, "Access and secrets" | Fail closed; no fallback secrets | trailofbits/skills `470419e`, `plugins/insecure-defaults`, `plugins/sharp-edges` | CC-BY-SA 4.0 (paraphrase only) |
| `lenses.md`, "audit before you conclude" | The pre-conclusion audit and "found nothing? say so" | getsentry/skills `e94f222`, `skills/find-bugs` | Apache-2.0 |
| `lenses.md`, "no check-gaming" | Shortcuts that game a check, generalised beyond .NET | Aaronontheweb/dotnet-skills `5ca5db8`, `skills/slopwatch` | MIT, Aaron Stannard |
| `lenses.md`, "Evidence before claims" | Claims against the evidence each needs | obra/superpowers `22f0b46`, `skills/verification-before-completion` | MIT, Jesse Vincent |
| `lenses.md`, "Receiving review" | Check review comments against the code; clear up unclear items first | obra/superpowers `22f0b46`, `skills/receiving-code-review` | MIT, Jesse Vincent |
| `self-review/SKILL.md` §4, `.github/pull_request_template.md` | Door and Blast radius | mattpocock/skills `4ae2317`, `skills/engineering/pr` | MIT, Matt Pocock |
| `lenses.md`, "Smells" | The smell baseline, with the repo's standards winning | mattpocock/skills `4ae2317`, `skills/engineering/code-review` | MIT, Matt Pocock |
| `contraption-ui/references/motion.md`, self-review "UI findings" (motion line) | Should it animate (how often, what for), easing and duration ceilings, no `scale(0)`, origin-aware popovers, transitions over keyframes, `@starting-style`, warm tooltips, the fix order. Left out: springs, gestures, stagger, custom curves per app | [emilkowalski/skills](https://github.com/emilkowalski/skills) `c8a7962`, `skills/emil-design-eng` ("Animation Decision Framework"), `skills/review-animations` (`SKILL.md`, `STANDARDS.md`) | MIT, Emil Kowalski |
| `contraption-ui/references/worst-case-data.md`, self-review step 3 | Plausible worst-case values per kind of field, change the data not the component, failure signatures and fixes, cut-or-wrap per field, Broken/Ugly/Fragile. Left out: the in-page demo toggle | emilkowalski/skills `c8a7962`, `skills/break-ui` (`SKILL.md`, `CATALOG.md`) | MIT, Emil Kowalski |
| `contraption-ui/references/craft-floor.md` | Tabular numerals, every state, browser surfaces, and the "refuse" defaults (nested cards, gradient text, emoji as icons, decorative glass, modal by reflex). Left out: the side-bar ban, type rules, its hooks and binary | [pbakaus/impeccable](https://github.com/pbakaus/impeccable) `c3bb418`, `skill/reference/craft-floor.md` | Apache-2.0 |
| `contraption-ui/references/component-checks.md` | Acceptance criteria per component (dialog, tooltip, toggletip, live region) as a checklist | [Intopia/intopia-web-accessibility-skill](https://github.com/Intopia/intopia-web-accessibility-skill) `74b3944`, `references/acceptance-criteria/`, `references/topic/` | CC BY-NC-SA 4.0 (the repo's `LICENSE`; the survey read it as NOASSERTION), so the idea only: the criteria are written from WCAG 2.2 and WAI-ARIA, never its text |
| `contraption-ui/references/dogfood.md`, self-review step 3 | Exploratory QA on a dev copy: map, real jobs end to end, write each finding as found, retry before recording, proof matched to the finding, severity scale, five to ten well-proven findings. Left out: its `agent-browser` CLI and video recording | [vercel-labs/agent-browser](https://github.com/vercel-labs/agent-browser) `71850a0`, `skill-data/dogfood` (`SKILL.md`, `references/issue-taxonomy.md`) | Apache-2.0 |

(Citadel #352, #348, #350, #347 and #355, 2026-11-06, from the #346 skills survey; the trailofbits
rows and the Intopia row are share-alike, so they stay paraphrased.) Mined rows are not re-synced,
so the upstream check skips them.

skill-stocktake (Citadel #353): upstream is a slash command that scans `~/.claude/skills` and keeps
its state in a JSON cache through jq and Node scripts. Ours is model-invoked (see
improve-codebase-architecture above), scans the kit, the repo's skills and the session's skill
list, takes "changed since last time" from `git log`, adds a cost line and a usage count of its
own (`uses.ts`), and writes a report with handoffs instead of offering to delete files.

## Updating

`citadel:upstream-check` runs monthly (a scheduled minion) and says when upstream has something
worth taking; it never applies an update itself. To take one, copy the files again from the newer
upstream commit, re-apply the local changes above, set **Pinned commit** and **Checked** to that commit,
and land it like any kit change (self-review included). Do not also install either pack as a
plugin: a session would see every skill twice.

## Ideas from other packs

These skills take ideas from other packs, written in our own words: nothing is copied,
nothing is installed, and none of their scripts run. Credited here all the same.

| Skill | Idea | From | License |
|-------|------|------|---------|
| `bug-fixing` | Step 5, hunting for siblings of the root cause by widening a search one part at a time | [trailofbits/skills](https://github.com/trailofbits/skills) `470419e`, `plugins/variant-analysis` | CC-BY-SA 4.0, so paraphrase only: never paste its text here |
| `diagnosing-bugs` | Three strikes, then ask | [OthmanAdi/planning-with-files](https://github.com/OthmanAdi/planning-with-files) `8eef6dc`, "Critical Rules"; the same point as superpowers' "3+ failed fixes means question the design" | MIT |
| `diagnosing-bugs` | Flaky tests: wait on the condition, bisect for the polluting test; fix where the bad value first appears | [obra/superpowers](https://github.com/obra/superpowers) `22f0b46`, `skills/systematic-debugging/` (`condition-based-waiting.md`, `find-polluter.sh`, `root-cause-tracing.md`) | MIT |
| `diagnosing-bugs` | Competing hypotheses, one investigator Grunt each | [wshobson/agents](https://github.com/wshobson/agents) `4bde316`, `parallel-debugging` | MIT |

## Licenses

### mattpocock/skills

```
MIT License

Copyright (c) 2026 Matt Pocock

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### affaan-m/everything-claude-code

```
MIT License

Copyright (c) 2026 Affaan Mustafa

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### DietrichGebert/ponytail

```
MIT License

Copyright (c) 2026 DietrichGebert

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
