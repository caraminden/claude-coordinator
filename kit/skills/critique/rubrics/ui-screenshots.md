---
name: ui-screenshots
judges: front-end changes, from desktop and phone screenshots of each view the change touches and the measuring script's numbers
when: "diff: public/**, **/*.css, **/*.html"
input: each view the change touches at 1440 and 390 wide, taken by the checks' --shots (an after-the-click shot for each action the change adds or changes, from --click, and one for each existing control in the view that failed its click, from --sweep)
checks: ["node <kit>/skills/critique/scripts/ui-measure.mjs <url of each view the change touches> --scope <the part it changed> --sweep --shots $TMPDIR/ui-shots --out $TMPDIR/ui-measure.json"]
mode: blind
model: sonnet
effort: medium
max_rounds: 2
cross_family: off
gate: advisory
person: Cara
calibrated: "2026-11-08, sonnet: 6/6 hits, 1/4 false alarms (images only; blocker 4 was then reworded and that control re-run, so 0/4 is tuned, not blind)"
---
# UI screenshots

**Starter.** A scheme's own `ui-screenshots` entry in its review set `extends:` this, sets its `when:` globs
to its front end and the URL of its dev copy, and gathers its people's notes. The rules come from the
Citadel-wide "UI checks", `citadel:contraption-ui`'s "The rules" and `citadel:self-review`'s "UI
findings"; the seen examples from #390's survey of five schemes, where 27 of Citadel's last 400
commits fixed a clip, an overflow, padding or a phone layout.

**The script measures; the critic looks.** A model's eye misses a 2 px slip, so the numbers come from
`ui-measure.mjs` (its `--help` lists the checks) and the critic judges what numbers can't: whether it
reads, what covers what, what a state shows. Run it on a dev copy or preview, with a cookie from
signing in there (`--cookie name=value`). Shoot the state the change is about: `--before` opens the
dialog or fills the list, worst-case data comes from `citadel:contraption-ui`'s
`references/worst-case-data.md`.

**Findings the change didn't cause.** `--scope` keeps the run to the part the diff touched; sideways
scroll stays page-wide. A finding outside the change is not this change's to fix: drop it with
`--ignore <check>:<selector text>` and list it under "Not fixed: pre-existing". The critic treats an
ignored finding as a note, never a blocker.

## Blockers

1. **Equal room above and below.** Text or an icon in a box, bar, button, row or chip sits with the
   same, non-zero room above and below it. See it: a `padding` finding (its `top` and `bottom` in px);
   in the shot, a label riding high or low in its pill, or touching its edge. Seen: Citadel #219's
   payer line, uneven until the fix ("even padding in the payer line"); the design-system page's
   "Row with 2px above, 12px below".
2. **Nothing clipped, nothing scrolls sideways.** Text wraps or is cut to one line with its whole self
   in a tip; no page is wider than its window. See it: a `clip` or `overflow` finding, or a
   `truncated` one with `full_text_in: null`; in the shot, words cut at an edge or running out of
   their box, a bar or menu past the phone's edge. Seen: Citadel #298, a long status line stretched
   a specimen past a phone's edge; #361, the Plugins menu hung off-screen on phones; the phone chat's
   collapsed Taskmaster rows, whose time ran 48 px out of its bubble (found by this script,
   2026-11-08).
3. **Tap targets big enough.** On a phone (800 px and under) every control is `--citadel-control-h`
   tall; on desktop 24 px each way. A text link in a sentence is exempt. See it: a `tap` finding (its
   `height` against `min`); in the phone shot, a row of small buttons or a ✕ the size of a letter.
   Seen: Citadel #289, a switch's touch target clipped by its table cell so a tap flipped the next
   row; #361, the Plugins checkboxes on phones; TWIReader #20, #55 and its dialogue-voices work, chips at
   36-37 px against 40; TripPresenter #5, 26 px pills. A `tap` or `overflow` finding **stops the loop**:
   `ui-measure` exits 3 and sets `stop`, the author fixes it and measures again, and no critic round is spent
   until it is gone. Seen (overflow): TripPresenter #12, 320 px wide.
4. **One line per edge.** A box and something inside it never both draw a border, outline or ring on
   the same edge. See it: a `double-border` finding (the two selectors, the sides and the gap); in the
   shot, two parallel lines a few px apart, one of them hugging something inside the box (a field
   inside a composer). A focus ring drawn a few px outside a box's own border is one part's ring, not
   two lines: Citadel UI's composer does it on purpose. Seen: Mandate #61, the chat box drawn with a double
   outline, which sat in screenshots for days before a person spotted it.
5. **The close button stays in view.** A dialog's ✕ stays at the top however long its body, and a
   click on the backdrop closes it (the kit dialog, rule 22). See it: a `close-scrolls` finding; in a
   shot of a long dialog, no ✕ in sight. Seen: Peek's modal ✕ scrolled away with the body; Citadel
   #383 built the kit dialog for it.
6. **Clicks never freeze the UI.** A click shows its result at once and every other control stays
   usable while its request runs; only an action whose result can't be guessed (an agent turn, a
   calculation) shows busy, and only on its own region (rule 23). See it: a `click-froze` or
   `click-no-result` finding from `--click`; in the after-the-click shot, other controls greyed out, a
   cover or spinner over more than the item clicked, or nothing changed at all. Seen: Theory of
   Crafting's Speculation reject froze the whole panel and shipped through review; Citadel #389 and
   #391 moved two batches of Citadel's own clicks to `optimistic()`. The script also clicks the existing
   buttons, tabs and summaries in `--scope` (`--sweep`, up to 10 a width, each on a fresh load): one that
   does nothing or freezes the rest is a finding too, not only the changed control. Seen: Citadel #634, Image
   cards required Send and broke selecting a card (Josh, 11-13: "You broke the ability to actually select
   the cards"); #960, mark drawing worked on one button and not another (Cara, 11-18: "ok, try again, draw
   on a different button").
7. **Nothing covers what a person came for.** On a phone, no floating button, bar or menu sits over the
   content, the composer or another control, and a status line keeps its own room. See it: in the 390
   shot, something drawn over text or over a control. Seen: Citadel #212, the Latest pill covered
   the chat on phones until it moved into the composer's row.
8. **Colour and hierarchy carry meaning; no wall of plain text.** Squinting at the shot, before
   reading a word, you can see the app's accent, the cards that group its content and where each
   status sits (`citadel:contraption-ui`, "First look"). See it: in either mode, text sitting loose
   on the page background with no surface around it; one size and weight of type down the view;
   states as plain words with no toned chip; on a view with a list or two cards and no scheme
   style guide of its own, fewer than three hues besides the status tones (the accent, accent-2, a category hue: "First look", 1 and 5), as
   when the accent and the chips are the only colour; an empty view that is one grey sentence. A plain view is fine when there's nothing on it but a chat, whose
   parts carry their own look. Seen: Transdata's Review and Ingest tabs, a single muted line on
   an empty page (2026-11-09); Cara: "a big wall of white/black text is never going to be what we
   want out of our UIs"; Peek Auras' grey accent and mock pages in one orange on cream (#683,
   2026-11-14: "pretty bland and colorless").

9. **Every link is clickable.** A URL, DOI or reference to another page or item is a link, in sight:
   no bare URL or DOI as plain text, no link only in a tooltip (rule 6). Code is exempt. See it: a
   `bare-link` finding (the text and why); in the shot, an address in body-coloured text with no
   link styling. Seen: links in The Trans Agenda's app that couldn't be clicked (2026-11-09); Cara:
   "no reason to have a link you cant click".

## Watch-list

- Meaning carried by colour alone: a red dot with no word (rule 17).
- An app still in Citadel's orange accent rather than its own ("First look", 1).
- A category drawn as a round chip, where it reads as a status ("First look", 5).
- A view of more than a screen that opens on its detail, with no closed summaries to read its state from ("First look", 11), unless the scheme's own style guide says otherwise.
- A list of more than about six items shown whole, with no "Show all" ("First look", 12), unless the scheme's own style guide says otherwise.
- An empty or failed state that is blank or says only "Error" (rule 19).
- Text on the accent that isn't `--citadel-on-accent`, or grey text too faint to read on its panel.
- A control's label off its baseline, so a row grows taller than its parts (Citadel #289: a switch
  row 49 px where 32 was meant).
- Prose lines past about 75 characters on desktop.
- Two parts on one screen that look alike but behave differently, or the reverse.

## Notes

| Date | Minion | About | Words |
|---|---|---|---|
| 2026-11-09 | Citadel #434 | links (rule 6) | Cara: "no reason to have a link you cant click" |
| 2026-11-09 | Citadel #419 | a first UI's look (blocker 8) | Cara: "a big wall of white/black text is never going to be what we want out of our UIs" |
| 2026-11-08 | Citadel #388 | clicks (rule 23) | Cara: "assume things will work instantly, but recover later if there was an issue" |
| 2026-11-08 | Citadel #383 | dialogs (rule 22) | Cara: "the X to close should stay at the top and clicking off the modal should close it" |
| 2026-11-04 | Citadel #298 | status lines (rule 13) | Cara: "set up rules that make sure status changes like that dont move any UI elements" |
| 2026-11-03 | Citadel #293 | loading (rule 10) | Cara: "keep the screen visible and just have a spinner" |

## Calibration board

| Item | Verdict | Why |
|---|---|---|
| Mandate #61 before, desktop and phone, composer focused | another round (hit) | blocker 4: the field's own border inside the composer's ring; the script's `double-border` also finds it on a rebuilt page |
| Citadel #212 before, phone | another round (hit) | blocker 7: the Latest pill over the chat |
| Citadel #289 switch table before, and the old reset row | another round (hit, both) | blocker 3 and the watch-list's row height; it missed the stray scrollbar |
| Citadel phone chat, 2026-11-08 | another round (hit) | blocker 2: the relay row's time out of its bubble; the script found it first, so not independent |
| Peek's dialog before #175 | script only, not in the critic's trial | blocker 5: `close-scrolls` finds it on a rebuilt page and passes the pinned one |
| Mandate #61 after, desktop | another round, then pass | a false alarm: it read the composer's own ring as a second line, so blocker 4 now says a ring outside a box's border is one line; re-run blind, it passed and still failed the before shot |
| Citadel #212 after, #289 after, Peek's dialog after | pass | clean controls |
| Transdata's Review tab and Database tab, 2026-11-09 | another round (hit, both) | blocker 8: one grey sentence on an empty page; rows loose on the background |
| #419's Hearth sample from the old skill | another round, then pass | a false alarm: blocker 8 failed it for Citadel's orange alone though cards and toned chips carry it, so the accent moved to the watch-list; re-run, it passed with that note |
| #419's Hearth sample from the First look checklist | pass | accent, cards, grouped rows, stat tiles, an empty state with shape |

## Known blind spots

- The shots are taken settled: the pointer is moved off the controls, finite animations finish, the network goes
  idle (3 s at most) and a spinner that never ends is frozen on its first frame. Seen: TWIReader #20, a tooltip
  the click opened; VoiceAnalyzer #31, a spinner caught mid-draw; TWIReader #36, a cut-off shot; VoiceAnalyzer
  #27, a misframed one; TripPresenter #23's card, a shot flow that timed out in 3 of 4 runs.
- What happens over time can't be seen in a still: a layout shift when a status changes (rule 13),
  motion, focus order. The script's `--click` covers the click; the rest stays with the author's own
  check (`citadel:contraption-ui`, `references/status.md`).
