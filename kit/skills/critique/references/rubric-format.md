# The rubric format

A rubric is one markdown file in the scheme's repo: frontmatter that tells `citadel:critique` when
and how to run, and a body the critic judges by and people's verdicts grow. It lives where the
scheme's people can read and edit it, never in the kit; the kit's `rubrics/` holds starters a
scheme rubric `extends:`. The worked example is [`../rubrics/example.md`](../rubrics/example.md).

## Opting in

A scheme opts in with one line in its CLAUDE.md's Project facts:

```
- **Rubrics:** docs/rubrics/; docs/design/art-style/taste.md
```

Paths to rubric files or folders of them, separated by `;`, relative to the repo root. A folder
means every `.md` in it with rubric frontmatter. No line, or `none`, means no critic runs in that
scheme. Every rubric the line names is a file in the repo, even one that only `extends:` a starter,
because people's verdicts are written into it (the skill's step 9).

## Frontmatter

| Key | Required | Values | What it does |
|---|---|---|---|
| `name` | yes | kebab-case | Names the rubric in result lines: `ui-screenshots critic: pass (round 1)`. |
| `judges` | yes | one line | What it judges, from what: "front-end changes, from desktop and phone screenshots". |
| `when` | yes | one or more of `diff: <glob>, <glob>` · `creative: <what>` · `schedule: <cadence>` · `in-app: <the app's step>`, joined with ` \| ` | When it runs. `diff:` matches the changed paths of the branch (self-review). `creative:` a new piece, take or rework that makes creative choices (docs-and-mocks, or the scheme's own creative loop); a small change to a design a person already saw skips it. `schedule:` a scheduled minion runs it. `in-app:` a contraption runs it on its own agent's output ([`in-app.md`](in-app.md)); minions use it only to calibrate. A starter says `set by the extending rubric`. |
| `input` | yes | one line | The artifacts the critic gets and how to make them: "screenshots at 1440 and 390 wide", "the diff", "each claim with its source rows". |
| `checks` | no | `[<command>, ...]` | Scripts run before any model looks, from the repo root. A non-zero exit is fixed first. Mechanical rules (sizes, lint, link resolution) belong here, not in Blockers. |
| `mode` | no | `blind` (default) · `informed` | Blind: the critic sees the artifacts, the brief and the rubric only. Informed: it may also read the source the brief names (a rule critic over a diff). Taste rubrics stay blind. |
| `model` | no | `opus` · `sonnet` · `haiku` | The critic's model. Default `opus` for `creative:` rubrics (taste), `sonnet` otherwise (rules). |
| `effort` | no | `low` · `medium` · `high` | The critic's effort. Default `high` with opus, `medium` with sonnet. |
| `scale` | no | `pass/fail` (default) · `<word> 1-5, pass at <n>` | A score beside the verdict, with its anchors under `## Scale`. Delve's art: `cool 1-5, pass at 4`. |
| `max_rounds` | no | integer, default 3 | Critic rounds an item gets before it goes to the person with its open findings. |
| `max_findings` | no | positive integer, default 3 | The most findings the critic returns per item, ranked most important first. Raise it for items with many parts (a contact sheet of many frames), where 3 hides real hits. |
| `cross_family` | no | `off` (default) · `final` | `final`: Codex re-judges the pass verdicts once, read-only; images go to it as `--image` attachments. |
| `gate` | no | `advisory` (default) · `blocks-ready` | Advisory: blockers are fixed or listed as "Not fixed: why", like reviewer findings. `blocks-ready`: the work isn't ready until the critic passes it or the person decides. |
| `person` | no | a person's name | Whose taste the rubric holds; the `ask <person>` verdict and the learning step name them. Default: the person who asked for the work. |
| `playbook` | no | a repo path | Fixes tried per kind of finding and how people judged them, for `citadel:professor`. |
| `extends` | no | `citadel:critique/rubrics/<name>` | A kit starter whose frontmatter and sections this file builds on (below). |
| `calibrated` | no | `<date>, <model>: <hits>/<flagged> hits, <false>/<controls> false alarms` | The last blind trial's result ([`calibrate.md`](calibrate.md)). |

Unknown keys are ignored. Values are read by an agent, but keep the frontmatter valid YAML: one line
each, and quote a value that holds `: ` (`when: "diff: public/**"`).

## Body

These headings, in this order. Leave out a section that has nothing yet, except Blockers.

- `## Blockers`: numbered. Each: the rule, how to see a breach in the artifact, and a past example
  (where it was seen). A breach makes the verdict `another round`.
- `## Watch-list`: things worth a `note:`, never a blocker. A pattern that keeps coming back
  graduates to a blocker.
- `## Scale`: the anchors for each score, only with a `<word> 1-5` scale (what a 3 and a 5 look like).
- `## Notes`: people's words, dated and quoted, newest first; newest wins where two disagree.
- `## Calibration board`: items a person judged, with their verdict and why, for the critic to
  look at before it judges (an artifact path where there is one).
- `## Known blind spots`: where the critic passed something a person then flagged, and what to look
  for there.

A rubric with its own headings (Delve's taste.md) keeps them: the critic reads the whole body, and
the learning step writes under the heading that serves each job.

## Extending a starter

`extends: citadel:critique/rubrics/<name>` resolves to `<kit>/skills/critique/rubrics/<name>.md`.
The critic reads the starter first, then this file:

- frontmatter: this file's keys win, the starter fills the rest;
- Blockers: the starter's, then this file's, numbered on (`S1`... for the starter's, `1`... here);
- every other section adds to the starter's.

A starter leaves `when:` (and often `input:`) to the file that extends it, which must set them.

A scheme that disagrees with a starter blocker says so in its own Notes ("S3 doesn't apply here:
<why>"); the critic skips it.
