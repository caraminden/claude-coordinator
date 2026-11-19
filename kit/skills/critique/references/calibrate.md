# Calibrating a rubric: the blind trial

Whether the critic sees what the person sees, counted on work the person already judged. Delve ran
it on its art critic: 13 creatures Cara had sent back with notes, plus 3 she passed; Opus caught about
9 of her 13 notes and Sonnet 5, and the two together no more than Opus alone. That's why taste
rubrics default to Opus.

Run it before a scheme relies on a new rubric, and again when the rubric's Blockers change a lot, the
critic's model changes, or Known blind spots grows by three since the last trial.

## 1. Pick the set

- **Flagged:** 8 to 15 items a person sent back, each with their notes. One note is one thing they
  flagged; count the notes, not the items.
- **Controls:** 3 to 5 items they passed as they were. These catch a critic that fails everything.

Take them from the rubric's Notes and Calibration board, `critic.md` logs, review pages
(`artifact_data`), and shipped PRs' review comments. Use the artifacts as they were when the person
judged them, not the fixed versions.

## 2. Hide the answers

The critic reads the whole rubric, and the rubric holds these verdicts. Copy it to `$TMPDIR` and
delete from the copy every Notes, Calibration board and Known blind spots row about an item in the
set. Write each item's brief as step 2 of the skill says, from the brief the author had, never from
the person's notes.

## 3. Run it

Run `citadel:critic` on the copy, as the skill's step 3 does, round 1 only, with the model and
effort under test. To compare models, run each on the same set, in separate Grunts.

## 4. Count

Per flagged note: **hit** when a finding names the same thing in the same place (wording may differ),
**miss** otherwise. Per control: **false alarm** when the critic's verdict is anything but pass.
Findings on flagged items that the person never mentioned: read them; a real flaw they missed is
worth a Watch-list line, noise counts nowhere.

Write the result in the rubric's `calibrated:` key, `"<date>, <model>: <hits>/<notes> hits,
<false alarms>/<controls> false alarms"`, and each miss as a Known blind spots line in the real
rubric.

## 5. Read it

- **Most notes hit, no false alarms:** rely on it.
- **Under about half the notes:** the Blockers don't say what the person looks at. Rewrite the
  missed notes as Blockers with how to see them, and rerun. If a stronger model hits more, use it.
- **False alarms on controls:** a Blocker is too broad, or the scale's pass mark is too high.

A trial costs one critic round per 6 items: about $3 for a 16-item set on Opus.
