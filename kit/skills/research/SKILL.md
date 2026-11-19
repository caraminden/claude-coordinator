---
name: research
description: How to research a question outside the repo (a product, service, API, price, paper, practice) with web search and docs, and write the report people decide from. Use for a research minion, for "look into", "find out whether", "compare X and Y" or "what are the limits of", and before briefing Grunts to research. Surveying third-party skills is citadel:skills-survey.
---

# Research

Every piece of advice here is sourced in [SOURCES.md](SOURCES.md). A survey of third-party
skills, plugins or agents follows `citadel:skills-survey`, which wins on its own steps and report
shape; steps 3 to 5 below still hold for its claims.

## 1. Size the question

First look for an earlier report on it in the shared folder's `reports/`: what it settled and
when, so you check that rather than redo it.

Write the ask as the questions it holds, each one a thing you could answer in a line. Then scale
the work to them:

- **A fact or two:** you alone, about 3 to 10 searches and fetches.
- **A comparison or a field to map** (several products, several sources per answer): split it into
  parts that don't depend on each other. Fan out to Grunts only when the parts are many and
  independent; a fan-out costs several times the tokens of doing it yourself. `citadel:subagents`
  decides it and says how to brief them: each Grunt gets one part, the sources to prefer, the
  output shape and where its part ends.

*Done when* every question is written down and you know whether you work alone or fan out.

## 2. Search broad, then narrow

1. **Start with short, broad queries** (two to four words, the subject and the angle), and see
   what exists before drilling in: the vendor's own docs, a changelog, a spec, a forum the makers
   answer in.
2. **After each result, judge it before the next query:** is the source primary, is it current,
   what is still open? Each next query narrows toward a gap you named.
3. **Run independent searches and fetches in one message,** in parallel.
4. Use WebSearch's `standard` mode for the broad pass; switch to `extended` when `standard` comes
   back thin or stale, or from the start for the narrow, very recent, price or availability
   questions its description names.

*Done when* each question has a primary source that answers it, or you have searched for one and
can say where you looked.

## 3. Primary sources, read at the source

- **Primary:** the maker's docs, pricing page, changelog or release notes, the spec, the repo, the
  paper, an answer from the maker's own staff. **Secondary** (a blog, a listicle, an SEO page, an AI
  summary, a forum guess) finds leads: follow each to its primary source and cite that.
- When only secondary sources say it, the claim says so ("per a 2025 blog post; the docs don't
  say").
- **A search result is a lead; the page is the source.** Open the page before you cite it, and
  cite only what you read there. A snippet's wording, date or version goes in the report only once
  the fetched page says it.
- **Quote before you claim:** pull the exact sentence from the page, then write the claim from it.
  A claim with no sentence behind it is dropped or marked as a guess.

## 4. A source and a date for every claim

- Every fact in the report carries its link and its date: the page's own date, or "undated, read"
  and the day you opened it. Prices, limits, plans and versions change, so a fact without a date is a fact you
  can't trust next month.
- A source older than what the question is about (an old plan, an earlier version) is flagged, not
  quietly used.
- **"I don't know" is an answer.** A question you couldn't settle gets "I don't know", what you
  checked, and what would settle it (a page behind a login, a test run, asking the vendor). A guess
  is labelled as a guess with how sure you are.

## 5. The report

Write it for someone who hasn't followed the work, in the scheme's shared folder as
`reports/<topic>-<yyyy-mm>.md` (its README may say otherwise); when that file exists, use the full
date, so the earlier report stays:

1. **In short:** the answer in 2 to 5 lines, with the recommendation if one was asked for.
2. **Findings:** one per question, each claim with its link and date.
3. **Not known:** what stayed open, each with what would settle it.
4. **Sources:** every page used, linked, with its date.

A choice between options people see (looks, layouts, several takes) gets a page instead
(`citadel:docs-and-mocks`). Links are markdown links, never bare domains.

When a decision rests on the report and the stakes are real (money, a migration, a vendor),
check it before handing it over with a blind `citadel:critic` Grunt (the critic has no web
tools, so give it the text). Its brief: the Grunt line, "judge with
`<kit>/skills/critique/rubrics/grounded-claims.md`" (`<kit>` is two folders up from this skill's
base directory), the report, and for each claim the sentence you quoted from its page with the
URL. Its model and effort are in that rubric's frontmatter. Fix or label what it finds.

A choice the report leaves people gets a card; the minion stays open in state complete, its note
naming the report.

*Done when* every question from step 1 is in Findings or Not known, and every claim has a link
and a date.
