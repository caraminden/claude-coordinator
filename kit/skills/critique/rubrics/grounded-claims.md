---
name: grounded-claims
judges: claims made from a source (a proposal, a row, a wiki page, an agent's answer), each against the source text or rows it rests on
when: "set by the extending rubric"
input: each item's text, the ask it answered, and the source it rests on with locations (line numbers, row ids, timestamps); for an excuse, the evidence behind it (the fetch result, the URL, the error)
mode: blind
model: sonnet
effort: medium
cross_family: final
---
# Grounded claims (starter)

A scheme's rubric `extends: citadel:critique/rubrics/grounded-claims` and sets its own `when:` and
`input:`: the scheme's claim files in a `diff:`, a `schedule:`, or `in-app:` for an app that grades
its own agent's output ([`../references/in-app.md`](../references/in-app.md)). Critics do best where
there is a truth outside the work to check against (Huang et al. 2024, CriticGPT): here it is the
source. Picked by Cara, 2026-11-08 (Citadel #390, #397).

## Per claim

1. **List the claims first,** before reading the source, as the item's reader would take them:
   every statement given as fact. A number, a name, a date or patch, a tier or certainty label
   ("confirmed", "datamined"), a cause ("because"), and an excuse for not doing the ask are all
   claims. The author's opinion or guess, labelled as one, is not. Number them C1, C2...
2. **Then judge each against the source you were given,** never against what you know. Your own
   knowledge never makes a claim `supports`; when you think the source itself is wrong, that's a
   `note:`, not a verdict.
   - **supports:** a span in the source says it, at the same scope (blocker 2).
   - **partly:** a span says some of it, or says it at a narrower scope.
   - **doesn't support:** no span says it, or a span says otherwise. Quote the span that says
     otherwise when there is one.
   - **can't check:** the source you were given can't settle it either way (a page that didn't
     load, rows that don't cover it). Never `supports` by default.
3. **Quote the evidence span** for every verdict but `can't check`: at most 25 words, with its
   location (`line 41`, `row 812`, `04:12`). A verdict with no span is `can't check`.

Report it in the critic's format: the item's `saw:` line counts the verdicts and names the claims
that aren't `supports` (`saw: 6 claims: 4 supports, C3 partly, C5 doesn't support`); each blocker
names its claim, the claim's words, the span and the change (`blocker: C5 "drops in all
difficulties": doesn't support; row 812 says "Hard and above"; narrow it to Hard and above`). An
item with more failing claims than the three-finding cap is too big: say so in the third finding.

## Blockers

1. **Every claim given as fact has a span that says it.** See it: a `doesn't support` claim, or a
   `can't check` one the item states as fact rather than labelling as unchecked. The fix is to drop
   it, narrow it to what the span says, or label it as a guess. Seen: Peek Auras' aura agent gave
   players game facts its type's docs don't hold (#390's report, section 2).
2. **Scope matches the span.** The claim is no broader, surer or newer than its evidence:
   - **population:** who or what it covers (every build vs one class, all players vs a test);
   - **number:** value, unit, range and rounding ("about 20%" from "18.4%" is fine; "20%" from
     "up to 20%" isn't);
   - **tier:** how sure it says it is (confirmed, datamined, a dev's tweet, speculation) against
     what kind of source the span is from;
   - **patch or date:** the version or time the source speaks for.
   See it: a `partly` on any of the four. Seen: Theory of Crafting's standing want, a tier and
   quote checked against the source (tier honesty).
3. **It did what was asked, and its excuse is true.** The item answers the ask in the brief. An
   excuse for not doing part of it ("blocked by robots.txt", "the page needs a login", "no data")
   is a claim too, judged against the evidence the brief gives for it. See it: the ask not done,
   with no excuse or one the evidence doesn't support; an excuse with no evidence given is `can't
   check`, which blocks too: the author attaches the evidence or drops the excuse. Seen: ToC's
   source reader gave up on a person's own Reddit share link and blamed robots.txt, falsely.
4. **One item per thing that changes.** Each item holds what a person would accept or reject as
   one: one change to the thing it describes. See it: several items a person could only accept
   together (merge them), or one item holding changes a person might split (split it). Seen: ToC
   #67, the source reader made 6 proposals for one new skill plus 1 for its mechanic, where a
   person expected 2.
5. **A quote is verbatim.** Text in quotation marks, given as the source's words, appears in the
   source as written (case and spacing aside). See it: search the source for it. A scheme that can
   should make this a `checks:` script; then the critic only reads its output.

## Watch-list

- A claim hedged until it says nothing ("may affect some builds").
- A paraphrase that keeps the facts but shifts the weight (a footnote in the source as the headline
  of the item).
- A source older than the patch or date the item is about.
- A span over 25 words, or a quote longer than the point needs: short quotes with their location
  are the rule, and some schemes (Transdata) allow nothing longer.
- A source the critic would call unreliable for the tier claimed (one forum comment behind
  "confirmed").
