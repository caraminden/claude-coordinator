---
name: app-icons
judges: app and contraption icons, from a 1x and 4x PNG of each take on light and dark
when: "creative: a new app icon, or a rework of one | diff: public/icons/**"
input: each take as a 1x and 4x PNG on the light and dark theme, from the icon sheet script
checks: [node tools/icon-sheet.mjs --check]
mode: blind
model: opus
effort: high
scale: crisp 1-5, pass at 4
max_rounds: 3
cross_family: off
gate: advisory
person: Cara
playbook: docs/rubrics/icon-playbook.md
calibrated: "2026-11-08, opus: 7/9 hits, 0/3 false alarms"
---
# App icons

**Example only.** This file shows the rubric format ([`../references/rubric-format.md`](../references/rubric-format.md));
it is not a starter, and its notes, minion numbers and paths are made up to show the shape. Copy the
shape into your scheme's rubric folder, not the content.

## Blockers

1. **Reads as its app at 1x.** Shown the 1x icon without its label, a person names what the app
   does. See it: cover the label row and say what it is before reading the brief. Seen: #12's
   ledger icon read as a calculator.
2. **One silhouette.** The shape holds at 1x as one mass, with no detail under 2 px. See it: on the
   1x row, any stroke that disappears or turns to noise. Seen: #15's compass, its tick marks.
3. **Works on both themes.** No part vanishes on light or dark. See it: compare the two 1x rows
   side by side. Seen: #12's take B lost its outline on dark.

## Watch-list

- Text inside an icon (a letter is fine; a word isn't).
- Two icons in the set sharing a silhouette.

## Scale

- 3: clear and correct, but you'd forget it by the next screen.
- 4: you'd pick it out of the set at a glance.
- 5: the one Cara would show someone.

## Notes

| Date | Minion | About | Words |
|---|---|---|---|
| 2026-11-06 | #15 | compass take C | "Too busy at small size, I can't see the needle" |
| 2026-11-02 | #12 | ledger takes | "I want it to feel like a notebook, not a spreadsheet" |

## Calibration board

| Item | Verdict | Why |
|---|---|---|
| `shared/project/mockups/icons-round2.png`, take A | Cara: perfect (2026-11-06) | one bold shape, reads at 1x |
| same sheet, take D | Cara: sent back (2026-11-06) | "looks like every other app" |

## Known blind spots

- 2026-11-06, #15: the critic passed take C (crisp 4); Cara couldn't find the needle at 1x. Judge
  the 1x row at its real size, not the 4x zoom.
