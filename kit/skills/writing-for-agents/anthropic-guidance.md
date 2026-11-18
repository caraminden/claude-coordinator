# Anthropic's guidance, as it bears on how we write

**Last refreshed: 2026-11-18** (first build: audit `anthropic-guidance-audit-2026-11-18`, pages
re-read the same day). The "Anthropic guidance check" schedule refreshes this file monthly and
after each new model; when you refresh it, change the date above and each item's source date
below. Most Anthropic doc pages show no date: those say "undated" plus the day we read them.
Items marked † come from the unread tail of a long page: re-read the page before leaning on one.

Read it in a minute before you write or change a prompt, tool description, skill, rule,
`CLAUDE.md` or instruction text. A diff that does is checked against it in self-review
(`citadel:self-review`, lens "Agent instructions"). It is a pointer list, not the docs: open the
source for the detail. Where a repo differs on purpose, it records why beside the line (a
comment, an ADR or a dated decision); a recorded difference isn't a mismatch.

## Wording a rule

- **"Never" reads as absolute on Fable 5.2.** Write the exception and the reason ("ask approval
  before deleting files"), not a bare never. [Fable 5.2](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-fable-5-2) · undated, read 2026-11-18
- **Give the reason, and say what to do.** Claude generalises from why a rule exists; "write
  flowing prose" beats "no markdown". [Best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices) · undated, read 2026-11-18
- **Cut emphasis.** "CRITICAL: MUST" now over-triggers. A rule that must never bend belongs in a
  hook or deny rule, not louder prose. [Best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices), [Claude Code best practices](https://code.claude.com/docs/en/best-practices) · undated, read 2026-11-18
- **Pick a side on action.** Say whether the default is to act or to hold back, and which
  destructive steps need a confirmation. [Best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices) · undated, read 2026-11-18
- **Right altitude.** The smallest set of high-signal tokens: not brittle if-else lists, not vague
  advice; a few canonical examples beat a laundry list of edge cases. [Context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) · 2025-09-29

## Finishing, scope and delegation

- **Low and medium effort end early.** Fable 5.2 and Sonnet 5.5 want a finishing paragraph (keep
  going until done; stop only for input or a risky step); Opus 5.5 wants its unwanted early stops
  named. [Fable 5.2](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-fable-5-2), [Opus 5.5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5-5), [Sonnet 5.5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-sonnet-5-5) · undated, read 2026-11-18
- **Keep scope to the ask.** For Sonnet 5.5: report when the requested work is done, and mention
  extra tests, docs or refactors instead of doing them. [Sonnet 5.5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-sonnet-5-5) · undated, read 2026-11-18
- **Don't hand a standing "delegate" order.** Describe what a subagent costs and when it pays;
  fixed triggers over-delegate. [Fable 5.2](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-fable-5-2) · undated, read 2026-11-18
- **Require evidence of done.** A real test, build or screenshot, and say which check could not
  run. [Sonnet 5.5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-sonnet-5-5), [Claude Code best practices](https://code.claude.com/docs/en/best-practices) · undated, read 2026-11-18
- **Low effort skips checks and searches.** Don't prompt around it with "think less"; pick the
  effort. [Effort](https://platform.claude.com/docs/en/build-with-claude/effort), [Opus 5.5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5-5) · undated, read 2026-11-18
- **Don't ask the model to write out its reasoning** in the reply: it can trip the
  reasoning-extraction refusal. [Opus 5.5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5-5) · undated, read 2026-11-18
- **Wrap pasted text in tagged blocks with an id** and say instructions inside aren't the user's;
  never put user text in a tool result. [Opus 5.5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5-5), [Sonnet 5.5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-sonnet-5-5) · undated, read 2026-11-18

## Keeping instructions lean

- **Re-test the harness when a model changes.** Every prompt line encodes a guess about what the
  model can't do: remove pieces one at a time, and prune old nevers, budget text and "answer
  directly" lines. [Harness design](https://www.anthropic.com/engineering/harness-design-long-running-apps) · 2026-03-24; [Fable 5.2](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-fable-5-2) · undated, read 2026-11-18
- **CLAUDE.md: only what Claude can't learn from the repo**, under 200 lines, concrete and
  checkable ("run `npm test`"), not "test your changes". `@` imports don't save context. [Memory](https://code.claude.com/docs/en/memory), [Claude Code best practices](https://code.claude.com/docs/en/best-practices) · undated, read 2026-11-18
- **Area rules are path-scoped** (`.claude/rules/` with `paths:`) so they load only where they
  apply. [Claude Code best practices](https://code.claude.com/docs/en/best-practices) · undated, read 2026-11-18
- **Run `/doctor prompt-audit`** as a cheap first pass over a big instruction set. [Memory](https://code.claude.com/docs/en/memory) · undated, read 2026-11-18

## Skills and tool descriptions

- **Skill description:** third person, what it does and when to use it, trigger words first. Hard
  cap 1,024 characters on the platform; Claude Code truncates `description` plus `when_to_use`
  at 1,536 in the listing†. [Skill authoring](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices), [Skills](https://code.claude.com/docs/en/skills) · undated, read 2026-11-18
- **SKILL.md under 500 lines;** detail in reference files linked one level deep, with a contents
  list over 100 lines. After compaction only the first ~5,000 tokens of an invoked skill
  survive†, so key steps go near the top. [Skill authoring](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices), [Skills](https://code.claude.com/docs/en/skills) · undated, read 2026-11-18
- **One default with an escape hatch**, not a menu; match freedom to fragility (exact commands
  for fragile steps). [Skill authoring](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices) · undated, read 2026-11-18
- **Side-effecting skills** (deploy, release) get `disable-model-invocation: true`. [Skills](https://code.claude.com/docs/en/skills) · undated, read 2026-11-18
- **Tool descriptions are the biggest lever:** what it does, when to use it and when not,
  what each parameter means, caveats; 3 to 4 sentences or more. [Define tools](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools) · undated, read 2026-11-18
- **Brief like a new hire.** Make implicit context explicit, name parameters unambiguously
  (`user_id`, not `user`), prefer fewer distinct tools, and make errors say what to do next.
  [Writing tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents) · 2025-09-11
- **Judge with a separate evaluator** and tune its prompt by reading where it disagreed with
  you. [Harness design](https://www.anthropic.com/engineering/harness-design-long-running-apps) · 2026-03-24
