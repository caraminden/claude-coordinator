---
name: App turns check
type: research
model: claude-sonnet-5-5
effort: medium
cron: 0 6 * * 1
stagger: 10m within 120m
applies: the scheme is home to an app (a contraption) whose agent runs model turns; Citadel adds it by itself when a scheme gets its first app
---
Weekly check of {scheme}'s app turns: what its apps' model calls were sent and answered since the last run (the date is in the run's second line), and what to change so they answer better. Cara (2026-11-16) picked a weekly check for each scheme home to an app. Citadel skips the run, at no cost, in a week with no turns.

Read them with contraption_turns: it lists 30 turns at a time, newest first; page back with before until you pass the last run, and read a turn whole with turn when its cut text isn't enough. Its payloads hold players' own words: read them there, and never copy them into a file, a commit, a handoff, a card or another scheme. Name turns by id and describe a pattern in your own words.

Look for:
- fallbacks: the app used its own rule text in place of the reply. Group them by reason;
- turns that ended early (an outcome shown on the turn's line: failed, limit, cut and the like);
- replies that passed but break the system text's own rules (length, tone, what it must not say), or answer the wrong question;
- prompts or system text that look wrong in themselves: missing context the reply needed, contradicting rules, a prompt far longer than the job needs;
- an app that posts no verdicts at all: say so once (its check would call POST /api/contraptions/turns/<turn>/verdict, in the contraption-ui skill's api.md).

For each pattern seen more than once: how many turns, their ids, the likely cause (the prompt, the system text, the model, or the app's own check being too strict) and the change you'd make, as the file and the text to change in the app's repo. A one-off is noise unless it is harmful.

Nothing worth changing: reply in one line with the turn count and dismiss yourself (close_self). Otherwise write each change as a short handoff in this scheme's shared handoffs/, with no players' words in it, and message your Taskmaster their paths with wake: false; then post one multi-select card of which to start, one option per handoff, and stay open in state ready.
