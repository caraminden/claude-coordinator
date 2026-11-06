# Third-party skills

Some skills in the Citadel kit are copies of two open-source packs, plus one rules file in
Citadel's repo. They are copied in, not installed as the upstream plugins, so every Citadel
turn of every scheme loads the same set the same way, through the kit (`kit/README.md`).

| Pack | Pinned at | License |
|------|-----------|---------|
| [mattpocock/skills](https://github.com/mattpocock/skills) | `4ae2317` | MIT, Matt Pocock |
| [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail) | `96608e0` | MIT, Dietrich Gebert |

## What is here

Carried over from the Delve repo (`.claude/skills/THIRD_PARTY.md` there, 2026-10-27), with
Delve's paths taken back out, then moved into the kit (Citadel #164, 2026-10-29), where repo
paths come from each repo's CLAUDE.md "Project facts".

| Path | From | Local change |
|------|------|--------------|
| `.claude/rules/ponytail.md` (Citadel's repo; a plugin can't carry rules) | ponytail `AGENTS.md` | Path-scoped to code files; "In this repo" section added |
| `scheme-setup/templates/ponytail.md` (copied into each new scheme's `.claude/rules/`) | ponytail `AGENTS.md`, via the row above | "In this repo" left for each scheme to write |
| `ponytail-review/` | ponytail `skills/ponytail-review` | none |
| `ponytail-audit/` | ponytail `skills/ponytail-audit` | none |
| `ponytail-debt/` | ponytail `skills/ponytail-debt` | none |
| `grilling/` | mattpocock `skills/productivity/grilling` | A round is asked as decision cards where the session has a card tool, numbered questions elsewhere |
| `domain-modeling/` | mattpocock `skills/engineering/domain-modeling` | Glossary and decisions log from Project facts |
| `codebase-design/` | mattpocock `skills/engineering/codebase-design` | none |
| `diagnosing-bugs/` | mattpocock `skills/engineering/diagnosing-bugs` | Narrower description (the escalation from `bug-fixing`), glossary from Project facts and optional; Three strikes, Flaky tests, trigger hypotheses and fix-at-the-source added (see Ideas below) |
| `improve-codebase-architecture/` | mattpocock `skills/engineering/improve-codebase-architecture` | Model-invoked; headless output; glossary and decisions log from Project facts |
| `writing-for-agents/` | mattpocock `skills/productivity/writing-for-agents` | none |

Every copy drops the Codex-only `agents/openai.yaml`.

## Why the local changes

- **Ponytail as a rule, not a skill.** Ponytail only works when it is always on; the
  plugin does that with Node hooks, and a plain skill rarely triggers on its own. A file
  in `.claude/rules/` is loaded by every session with no hooks. Its `paths` limit it to
  code, so design talk and research keep their normal style. The plugin's levels
  (`/ponytail lite|ultra`) and status line need its hooks and are not used; asking a
  session to be more or less minimal works instead.
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

(Citadel #352 and #348, 2026-11-06, from the #346 skills survey.) The mattpocock pin here is newer than the
copied pack's on purpose: `prototype` was read at the commit the survey used, and the copies above
stay at theirs until someone re-syncs them.

## Updating

Copy the files again from a newer upstream commit, re-apply the local changes above, and
bump the pins in the first table. Do not also install either pack as a plugin: a session
would see every skill twice.

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
