---
name: skills-survey
description: Survey third-party Claude skills, plugins and agents for a stack or a scheme, and say which to use as they are, which to mine into our own skills, and which to skip. Use for "survey skills for X", "are there good skills for <stack>", and for the skills-survey minion an onboarding or tune-up plan starts.
---

# Skills survey

A research minion runs this. It reads third-party skills (never installs or runs them), gives each a
verdict, and ends in a ranked report, one handoff per minion the work becomes, and a pick card.
The method is Citadel #346's (2026-11-05): 7 Sonnet Grunts, about 450k Grunt tokens and 3.5
minutes, plus a small Grunt per fire-rate test (step 4). A stack-only survey is 2 or 3 Grunts,
about a third of that.

## 1. Start from the last survey

Before searching anything, read what has been surveyed already. Your brief may name the reports;
otherwise list every scheme's:

```bash
ls -t "$COORDINATOR_SHARED_DIR"/../../../*/shared/project/reports/skills-survey-*.md
```

Read the newest general one (`skills-survey-<yyyy-mm>.md`, Citadel's) and any for your stack.
When another scheme's report can't be read (the read is refused), treat it as not surveyed and say
so in your report.
Their verdicts stand: a repo they read at a pinned commit is not read again unless it is over 3
months old or your stack needs a part they skipped. Your survey covers what they didn't, which is
mostly the stack-specific skills. When a report under 3 months old already covers the whole scope,
say so, name it, and stop: no Grunts.

*Done when* you can list, in one line each, what the old reports settled and what is left to read.

## 2. Map the field

1. **What we have.** List the kit (`citadel:*` skills and agents in your own skill list), Claude
   Code's built-ins (the rest of that list), and the scheme's own `.claude/` skills, agents and
   rules. A third-party skill is judged against these.
2. **Groups.** Split what is left into groups of one to three repos each, one Grunt per group. For
   a full survey, 6 to 8 groups: the vendor's own skills (the stack's maker, e.g. a language or
   engine org), the official marketplaces (`anthropics/skills`, `anthropics/claude-plugins-official`),
   the big community packs, and stack-specific skills found through skills.sh and GitHub stars. A
   stack-only survey is 2 or 3 groups. Check each repo exists (WebSearch, `git ls-remote`) before
   giving it to a Grunt.

*Done when* every group has a name, its repos or a search to run, and what to compare it against.

## 3. Read: one Grunt per group

1. Make a scratch folder, `$TMPDIR/survey/` with `clones/` and `verdicts/` in it.
2. Copy [grunt-brief.md](grunt-brief.md) to `$TMPDIR/survey/BRIEF.md` and fill in its blanks:
   who asked and their words, the scratch path, what we have (step 2.1), the scheme's stack.
3. Start every Grunt in one message, each with `model: "sonnet"`, `effort: "medium"`. A Grunt
   writes only its own clone folder and verdict file, and changes nothing else.
   Each prompt is the role line your own prompt gives for Grunt briefs, "First read `<BRIEF.md>` and follow it
   exactly", then the group's name, its repos or search, and what to compare against (name the
   matching kit skill and its path, and the traps you expect: old engine versions, the wrong
   language).
4. Each Grunt writes one verdict file and returns at most 3 lines. Read the verdict files, not the
   Grunts' transcripts.

*Done when* every group has a verdict file, or its 3 lines say why it failed (repo gone, clone
blocked), and that failure is in the report.

## 4. Verdicts

Every entry carries **use**, **mine** or **skip**, a value out of 5 for us, its target, why, what it
would cost (words, and when they load), what it runs, and its licence. Check each Grunt's work: a
value 4 or 5 is re-read by you at the file the Grunt quoted before it goes in the report.

**Judge how often a skill fires by trying it on a couple of the scheme's own turns, not from its
description** (Threadspace #24, 2026-11-06: a skill the survey judged "only on its own file types"
fired on almost every note turn). For each use, and each mine that becomes a skill, give a fresh
Sonnet Grunt the description among the scheme's other skill descriptions and 2 or 3 real opening
messages from its recent minions (a new scheme: its first minions' briefs from the plan; ask your
Taskmaster with `message_coordinator` when you can't see them), and ask which skills it would load
for each. That reads only text and runs nothing. Put what it fired on in the cost.

- **use** (installed as it is, pinned): rare, and always per scheme, never in the kit. Run the
  import checklist on it before recommending it: read SKILL.md, then `scripts/`, then
  `references/`, looking for prompt-injection phrasing, fetch-and-run of remote code, hidden or
  encoded text, hooks, `disable-model-invocation` (unreachable from a minion), broad
  `allowed-tools`, reads of credentials, and the licence. When `citadel:writing-for-agents` has
  its own import checklist, use that one instead.
- **mine**: name the target (an existing `citadel:<skill>`, a new one, or a scheme's repo skill) and
  the 1 to 5 rules or sections to take, written in our own words.
- **skip**: one line why.

Licences decide how: MIT and Apache-2.0 can be copied with credit; CC-BY-SA, no licence file, and
NOASSERTION are ideas only, paraphrased; proprietary is skipped.

## 5. Deliver

1. **Report:** `reports/skills-survey-<stack>-<yyyy-mm>.md` in your scheme's shared folder (a
   general survey drops the stack; make `reports/` and `handoffs/` when they aren't there), so the next survey's step 1 finds it. Lead with an "In short"
   of 4 or 5 lines, then one ranked table of use and mine (skill and source, verdict, where it
   goes, why, cost), skips grouped by reason, notes (licences, traps, what was not verified), every
   repo read with its pinned commit, the handoffs, and a decisions section.
2. **Handoffs:** one per minion the work should become, in `handoffs/`, each with the ask, what to
   take with source paths and pins, its check, and a risk label. Work for another scheme gets its
   handoff here and goes to your Taskmaster to pass on.
3. **Pick card:** one `ask_question` card, recommended first: a multi-select question holds 2 to
   6 options and a card up to 4 questions, so group the handoffs by scheme or size, at most 6 per
   question, and pair a lone handoff with "None of these".
   Log the answer in the report's decisions section, quoting the person, with the date.
4. Delete `$TMPDIR/survey/` once the report is written: clones are never shared.

The report is for people to read, so the minion stays open in state ready until someone says it
can close.

*Done when* the report, every handoff it lists and the card exist, and the decisions section
holds the pick.
