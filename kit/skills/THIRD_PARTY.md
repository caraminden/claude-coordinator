# Third-party skills

Some skills in the Citadel kit are copies of two open-source packs, plus one rules file in
Citadel's repo. They are copied in, not installed as the upstream plugins, so every Citadel
turn of every scheme loads the same set the same way, through the kit (`kit/README.md`).

| Pack | Pinned at | License |
|------|-----------|---------|
| [mattpocock/skills](https://github.com/mattpocock/skills) | `49dd158` (2026-10-09, plugin 1.3.1) | MIT, Matt Pocock |
| [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail) | `2961b52` (2026-10-13, v5.2.0) | MIT, Dietrich Gebert |

## What is here

Carried over from the Delve repo (`.claude/skills/THIRD_PARTY.md` there, 2026-10-27), with
Delve's paths taken back out, then moved into the kit (Citadel #164, 2026-10-29), where repo
paths come from each repo's CLAUDE.md "Project facts".

| Path | From | Local change |
|------|------|--------------|
| `.claude/rules/ponytail.md` (Citadel's repo; a plugin can't carry rules) | ponytail `AGENTS.md` | Path-scoped to code files; "In this repo" section added |
| `ponytail-review/` | ponytail `skills/ponytail-review` | none |
| `ponytail-audit/` | ponytail `skills/ponytail-audit` | none |
| `ponytail-debt/` | ponytail `skills/ponytail-debt` | none |
| `grilling/` | mattpocock `skills/productivity/grilling` | A round is asked as decision cards where the session has a card tool, numbered questions elsewhere |
| `domain-modeling/` | mattpocock `skills/engineering/domain-modeling` | Glossary and decisions log from Project facts |
| `codebase-design/` | mattpocock `skills/engineering/codebase-design` | none |
| `diagnosing-bugs/` | mattpocock `skills/engineering/diagnosing-bugs` | Narrower description (the escalation from `bug-fixing`), glossary from Project facts and optional |
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
  test-first for bugs.
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

## Updating

Copy the files again from a newer upstream commit, re-apply the local changes above, and
bump the pins in the first table. Do not also install either pack as a plugin: a session
would see every skill twice.

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
