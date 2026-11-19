# Where the research skill's advice comes from

Each step of [SKILL.md](SKILL.md) with the source it rests on. Read 2026-11-19 (#1069); refresh
with the kit's Anthropic guidance digest (`../writing-for-agents/anthropic-guidance.md`). Advice
with no source was left out.

| Step | Advice | Source |
|---|---|---|
| 1 | Scale effort to the question: simple fact-finding is one agent with 3 to 10 tool calls; complex research splits into parts with clear responsibilities | [How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system), "Scale effort to query complexity" · 2025-06-13 |
| 1 | Multi-agent runs use about 15× the tokens of a chat, and pay off on valuable, breadth-first, parallelisable work | Same post, "Benefits of a multi-agent system" · 2025-06-13 |
| 1 | A delegated part needs an objective, an output format, guidance on tools and sources, and clear boundaries | Same post, "Teach the orchestrator how to delegate" · 2025-06-13 |
| 1 | Describe what a subagent costs instead of a standing order to delegate | [Prompting Fable 5.2](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-fable-5-2) · undated, read 2026-11-18 (via the kit digest) |
| 1 | Read the last report before searching | Citadel practice: `citadel:skills-survey` step 1 (#346, 2026-11-05) |
| 2.1 | "Start with short, broad queries, evaluate what's available, then progressively narrow focus" | Multi-agent research post, "Start wide, then narrow down" · 2025-06-13 |
| 2.2 | Think after each tool result to judge its quality, find gaps and refine the next query | Same post, "Guide the thinking process" · 2025-06-13 |
| 2.3 | Parallel tool calls: subagents ran 3+ tools at once, cutting research time up to 90% on complex queries | Same post, "Parallel tool calling transforms speed and performance" · 2025-06-13 |
| 2.4 | WebSearch `standard` by default; `extended` when standard is thin or stale, or from the start for niche, very recent, price and availability questions | The WebSearch tool's description in Claude Code, read 2026-11-19 |
| 3 | Primary sources over secondary; agents "consistently chose SEO-optimized content farms over authoritative but less highly-ranked sources" until told otherwise | Multi-agent research post, "Effective evaluation of agents" · 2025-06-13 |
| 3 | A search snippet is a lead: fetch the page before citing it | #1069's baseline: both reps cited claims (a community thread, a changelog date) from search results they never opened; follows from "Quote before claiming" below |
| 3 | Extract word-for-word quotes first from long documents; a claim with no quote is retracted | [Reduce hallucinations](https://platform.claude.com/docs/en/test-and-evaluate/strengthen-guardrails/reduce-hallucinations) · undated, read 2026-11-19 |
| 4 | Cite a source for each claim | Reduce hallucinations, "Verify with citations" · undated, read 2026-11-19; [Web search tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool): citations always on, and shown to end users · undated, read 2026-11-19 |
| 4 | Give explicit permission to say "I don't know"; it "can drastically reduce false information" | Reduce hallucinations · undated, read 2026-11-19; Citadel-wide rule "I don't know is an answer" (Josh, 2026-11-19) |
| 4 | Date every fact | Citadel practice: the kit digest dates every item ("undated, read <day>" when the page has none) |
| 5 | Judge the end state (does each cited source match its claim?) rather than every step | Multi-agent research post, "Effective evaluation of agents" and appendix · 2025-06-13 |
| 5 | Check claims with a separate evaluator | [Harness design](https://www.anthropic.com/engineering/harness-design-long-running-apps) · 2026-03-24 (via the kit digest); `citadel:critique/rubrics/grounded-claims` |
| 5 | Report shape: answer first, written for someone who hasn't followed the work, every link clickable | Citadel-wide instructions: "Cards are for people" (Cara, 2026-11-18), "Links are clickable" (Cara, 2026-11-09) |

Left out: "use many sources and cross-check them all" and "always use extended search", which
turned up as folklore with no primary source; Best-of-N reruns (Reduce hallucinations) cost more
than a research minion's single run should.
