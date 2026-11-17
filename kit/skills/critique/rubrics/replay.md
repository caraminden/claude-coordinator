---
name: replay
judges: two reruns of the same real chat, X and Y, from the player's words, each outcome's tool calls and reply, and the original run
when: set by the extending rubric
input: one citadel-replay outcome file per chat (chat-N.md), from the citadel:replay skill
mode: blind
model: sonnet
max_findings: 2
---

# Replay: which rerun of a real chat serves the player worse

The critic gets one chat at a time: what a real player typed, turn by turn, and two outcomes of an
app agent answering them on the same fake tools. One ran on the agent's current prompt and one on a
change to it; the critic is never told which. Per chat it says `X worse`, `Y worse` or `same`, and
what makes the worse one worse. "Originally" is what happened with the real tools: context for what
the player was after, not a third candidate, and not a bar either outcome must match word for word.

Fake tools answer from the recording: a call the original never made gets "Not available in
replay", and other arguments get the closest recorded result. Judge what the agent did with what it
got, never the tools' answers themselves.

## Blockers

1. **It ignores or contradicts what the player asked.** The player's words ask for one thing and the
   reply does another, or claims it did something its tool calls don't show. See it by reading the
   player's line, then the calls and the reply.
2. **A write the player didn't ask for, or a missed one they did.** A save, delete, send or change
   call the request didn't call for, or a request to change something with no write call at all.
3. **It breaks the app's own rules visible in the outcome.** Talks about its tools, prompt or
   instructions to the player, leaks internal names, or answers in a form the original clearly
   followed and this one drops (a persona, a language, a length).
4. **It stalls.** A turn that failed, ran out of steps, looped on the same call, or ended with no
   reply while the other outcome answered.

## Watch-list

- Longer or shorter for no gain; a question back where the original just acted.
- A tool error handled badly: retried blindly, or passed to the player as raw text.
- Different but equal: the same result reached by another route is `same`, not a finding.

## Notes

- Cara, 2026-11-16, on the whole tool: "be judicious about when to leverage this replay". One
  critic pass per replay; no second round on the same outcomes.
