# Testing and importing skills

The disclosed half of two sections in [`SKILL.md`](SKILL.md): "Testing a skill" and "Importing a third-party skill". Ideas from obra/superpowers, anthropics/skills, getsentry/skills and vercel-labs/skills, in our own words ([`../THIRD_PARTY.md`](../THIRD_PARTY.md), "Mined, not copied").

## The baseline run

- **Brief** a fresh Grunt with the context the guidance will live in (the whole skill or prompt, minus the new part) and a task that tempts the failure. Real paths, a concrete choice, and "do it" rather than "what should you do": a quiz gets the rule recited back.
- For a **discipline** failure (the agent knows the rule and skips it), stack the pressures a real turn has: time, sunk cost, someone saying skip it. One easy pressure proves nothing.
- Give the Grunt the task only, never your hypothesis or the expected answer.
- **Record** what it did and its reasons, word for word. Those reasons are what the guidance answers.
- Run on the model that will run the skill: the session's model for a session skill, the Grunt's for a Grunt brief.
- **Reps** are fresh Grunts, 3 to 5 per variant, so they are a fan-out (`citadel:subagents`): each writes to a file and returns three lines.

## Match the form to the failure

| What the baseline did | Write | Not |
|---|---|---|
| Skipped a rule under pressure | A hard guardrail (the case `SKILL.md`'s Negation allows), with a short table of the excuses the baseline gave and the answer to each | Soft advice ("prefer", "consider") |
| Did the job, wrong shape (bloated, verdict buried, spec restated) | A recipe: what the output is, its parts in order | A list of don'ts: the agent negotiates with them |
| Left out a part of something it already produces | A required slot in the template it fills in | A reminder near the template |
| Should act only in some cases | A condition on something observable ("if the brief exists, link it") | A rule for everyone plus exemptions |

Rules for any form:

- An exception is its own condition on something observable. Tacked onto a rule as a nuance ("unless it matters"), it reopens the negotiation and the reps scatter.
- **Exemption clauses don't scope.** "This limit doesn't apply to code blocks" still shrinks the code blocks. Restructure so the rule can't reach what must be exempt.
- When a rep with the guidance still fails, ask that Grunt how the text could have made the right choice unmissable. "It was clear, I chose otherwise" means the rule needs a stronger reason; "it should have said X" means the wording does.

## Trigger evals

A description is tested by what it fires on, among the other descriptions it competes with.

1. **Write about 20 prompts** the way people really write to a minion (`[Name]: …`), with names, paths and numbers. 8 to 10 should fire the skill. 8 to 10 are **near-misses**: they share words with the description or sit on a neighbour's seam, and need something else. An obviously unrelated negative tests nothing. One-step asks fire no skill however good the description, so make each prompt worth a skill.
2. Write the prompts from the work, before rereading the description: prompts that echo its trigger words only prove it matches itself.
3. **Run** 3 Grunts, each given the whole skill listing (every description a session sees) and the prompts shuffled, without labels: which skills would it invoke before starting? Read every answer. A prompt that splits across reps is the ambiguous one.
4. This routing check is a proxy: it finds overlaps between descriptions, not the live fire rate. For prompts on a seam, add a live check: a fresh Grunt gets the prompt as its task and reports its first three tool calls.
5. **Rewriting** a description from the results: set aside about 8 prompts before tuning and check the rewrite on them only at the end, so the description isn't fitted to the prompts it was tuned on.
6. Keep the set as `trigger-eval.tsv` in the skill's folder (`id`, expected skill or `none`, `a|b` when either is right, prompt) so the next edit re-runs it. One set can cover two neighbours: `diagnosing-bugs/trigger-eval.tsv` covers `bug-fixing` too.

7. **A kit skill's description** also gets the live rerun before it ships: `tools/skill-trigger-eval --base main --runs 3` in the Citadel repo. It runs about 45 real asks from every scheme, each as a Sonnet turn with the kit loaded, against the kit on main and on your branch, and lists the cases that flipped. A flip on a skill you didn't touch is a seam you moved: fix it or name it. A real ask that misfired in a turn goes into `tools/skill-evals/cases.json`.

## Import checklist

Read every file, in this order: `SKILL.md`, then `scripts/`, then `references/`, then the rest (images, `package.json`, test files). For each, look for:

- **Steering past its job**: text telling the agent to set earlier instructions aside, edit `CLAUDE.md`, memory or settings, add itself to an allowlist, or install more skills. A security skill may quote such text as an example; judge whether it is aimed at the reader.
- **Fetch-and-run**: `curl … | sh`, downloads that get executed, instructions loaded from a URL at run time, unpinned `npx` or `uvx` packages.
- **Hidden text**: zero-width or bidi characters, long base64 or hex runs, HTML comments, text in image metadata. Two greps catch most: `grep -nP '[\x{200B}-\x{200F}\x{202A}-\x{202E}\x{2060}-\x{2064}\x{FEFF}]'` and `grep -nE '[A-Za-z0-9+/]{80,}={0,2}'`.
- **Things that run by themselves**: hooks (in frontmatter or a plugin's `hooks.json`), `` !`command` `` lines (they run when the skill loads), test files a runner would pick up, `postinstall` scripts, symlinks out of the folder.
- **`disable-model-invocation: true`**: a minion's messages arrive as `[Name]: text`, so a slash-only skill never runs. Make it model-invoked with a narrow description, or leave it.
- **`allowed-tools`** wider than the job (Bash for a read-only skill, `*`).
- **Reads of secrets**: SSH keys, `.env`, tokens, `~/.claude`, environment dumps. The tripwire blocks many; vet anyway.
- **Fights with ours**: hooks that push or merge, a PR format other than `.github/pull_request_template.md`, a name that shadows a built-in (`code-review`).

Then the **licence**, from the repo's or the skill's own licence file:

| Licence | Take |
|---|---|
| MIT, Apache-2.0, BSD | Copy with the licence text in THIRD_PARTY.md, or paraphrase |
| CC-BY-SA, GPL | Paraphrase the ideas in our words; copying makes our file share-alike |
| None, or proprietary | Paraphrase the ideas, or leave it |

**Record** it in THIRD_PARTY.md: a copied file gets a row (path, source, pinned commit, local change) and the licence text; ideas paraphrased with no text copied go under "Mined, not copied" with source, commit and licence. If it is the repo's first copy, get the check scheduled (`citadel:upstream-check`, "Getting a repo on the schedule").
