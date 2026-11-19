---
name: ui-screenshots
extends: citadel:critique/rubrics/ui-screenshots
when: "diff: public/**, docs/design-system/**, kit/skills/contraption-ui/starter/**"
person: Cara
calibrated: "2026-11-08, sonnet: 6/6 hits, 1/4 false alarms (the starter's board)"
---
# UI screenshots: Citadel

Citadel's rubric for front-end changes, on top of the kit starter (`citadel:critique`,
`rubrics/ui-screenshots.md`). People's verdicts on Citadel's UI go here (the skill's step 9).

**The dev copy for the checks.** `node tools/ui-sweep.ts [--only <screens>] [--keep]` does all of this
for the whole app (`--list` names the screens) and writes shots at 1440 and 390 with ui-measure's
numbers; it reads the live database, which a turn in a container can't see. For the few screens a
change touches, `node tools/ui-shot.ts <#route>...` shoots them at 1440 and 390 (and dark, or after a
few clicks with `--steps`) in under a second each on this worktree's dev copy; `ui-measure.mjs` on the
same URLs gives the numbers. A state the data lacks (a waiting card, a turn mid-run, a long chat) comes from
`citadel-dev-copy seed <name>` (`--list`), which prints the route to shoot, on `--data empty` too. Views are hash routes: `#/p/<scheme>`, `#/p/<scheme>/t/<minion>`,
`#/p/<scheme>/properties` and the rest in `public/core.js`'s router.

## Blockers

## Watch-list

- Tap targets: since #471 (2026-11-10) buttons, summaries, rows, chips, tabs and drawer controls are
  at least 24 px on desktop and 40 px on phone. A change that brings one back under is a finding.
  Still under, by choice: inline text links and desktop checkboxes (the label is the target).
- Errors and empty states as a bare red or grey sentence: Cara picked fixing them (#471, group 5).
  Use a `.cui-notice` with a tone, or the `.empty-state` box with a way out.
- More than one standout in a view (a glow, an animation, a gradient and a big number all at once):
  First look's rule 10 allows one. A finding when two or more compete, unless the brief asked.
- An app's own radius set or heading face (First look, 10) is not a finding when the first reply names
  its reason, the radii keep their order, and body type is still Citadel's.

### First look: Citadel's own pages

Josh picked Citadel's look on 2026-11-19 (#1068, `.claude/rules/citadel-look.md`). On a page under
`public/` (not `public/ui/`, which is the apps'), each of these is a finding:

- Shot with every row closed, the page doesn't tell its state: a part with no closed row, or a closed
  line with no toned chip or no number.
- Detail open by default: a table, list or explanation on the page itself in place of inside a row.
- A status as a grey sentence in place of a toned chip.
- A grey page: no hue on row tiles or section headings, a scheme not in its own hue, items as plain
  text where they could be hue rows, numbers compared across rows with no bar.
- A list or table over about six items shown whole, with no "Show all".
- An empty state as a bare sentence in place of an empty card.
- An opened row whose body sits tight under its head (Josh asked for "better padding below the
  header once expanded"), or a head that doesn't tint when opened.

## Notes

| Date | Minion | About | Words |
|---|---|---|---|
| 2026-11-10 | #471 | Whole-app sweep: which finding groups to fix | "1 Flow and layout bugs; 3 Tap targets; 4 Cut-off text; 5 Empty and error states; 6 Walls of text". Not picked: 2, uneven padding inside pills and bars, which the critics flagged on chips that look even: ui-measure's padding check on small chips is not worth a finding by itself. |

## Calibration board

| Item | Verdict | Why |
|---|---|---|

## Known blind spots
