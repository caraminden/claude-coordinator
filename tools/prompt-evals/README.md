# Prompt evals: replay real corrections against a prompt or a tier (#1117)

`tools/prompt-eval` reruns frozen moments where a person corrected a Citadel minion or Taskmaster, against
the prompt a turn gets (the code's prompt builders, the MCP tool descriptions, the kit, CLAUDE.md and the
Citadel-wide and scheme instructions), and scores each rerun with code checks. A Sonnet judge reads each
rerun too, but it only advises: the checks decide. #1110's skill trigger evals (`tools/skill-trigger-eval`)
are the small version of the same rig.

Decisions (Josh, 2026-11-19, #1117's grilling cards):
- **Which moments:** "Citadel's own, mixed": strikes (a claim taken back), people's corrections ("why
  didn't you…") and rule slips (no card, no link, wrong time zone), from Citadel's own chats only.
- **Where:** "In the repo", here, versioned with the prompts they test.
- **Who owns the set:** "Taskmaster owns it": the Citadel Taskmaster adds and prunes cases.
- **When it runs:** "On ask + big changes": when a person asks, or once before shipping a big change to a
  minion or Taskmaster prompt. Never per edit, never in CI (each case is a real Claude turn on the asker's
  login). It runs on perigee through `citadel-heavy`.
- **Tiers:** "Both, small": opening moves on every case, plus whole reruns of a few closed bug fixes from
  before their fix (`briefs/`), passing only if the fix's own shipped test goes green.
- **A drop:** "Drop needs a go": when 2 or more cases fall (see Scoring), the change is high risk and ships
  only on a member's go.

## Running it

```sh
citadel-heavy tools/prompt-eval run                       # today's prompt: the baseline pass rate
citadel-heavy tools/prompt-eval run --base main           # your branch against main, with the cases that fell
citadel-heavy tools/prompt-eval run --ref <old sha>       # an old prompt version
citadel-heavy tools/prompt-eval run --model sonnet --effort medium --base-model opus --base-effort high   # a tier question
citadel-heavy tools/prompt-eval briefs --model sonnet     # whole reruns of closed bug fixes on a tier
tools/prompt-eval --help
```

A run of 30 cases × 3 takes a while: start it in the background and wait with `citadel-wait pid <pid>`.

## A case (`cases/<id>.json`)

One moment, frozen: what the minion had in front of it, the message it answered, and how to tell whether
a rerun made the right move.

```jsonc
{
  "id": "strike-runner-claim",              // the file name without .json; kebab-case
  "kind": "strike",                         // strike | correction | rule
  "source": "#999, event 821112, 2026-11-18 14:21 PST",   // where it came from, to find it again
  "role": "minion",                         // minion | taskmaster
  "ticket": { "number": 999, "title": "Why #993's test job hung", "type": "bug" },  // the minion it was
  "commit": "a1b2c3d",                      // main as it was then: the rerun works in a copy of the repo at it
  "from": "Cara",                           // who sent the message
  "history": "What the minion knew from earlier in its chat, in its own terms, at most ~1,500 characters. Empty for a first turn.",
  "message": "The message the minion answers, as sent (trimmed only of anything private).",
  "facts": [                                // what the fake tools answer, first match wins (see Fake tools)
    { "tool": "host_check", "match": "ci_runs|runner", "result": "id|started|waited_s\n...", "why": "what the live data said" }
  ],
  "right": "The right move in one or two sentences, for the judge.",
  "wrong": "What the minion actually did, one sentence.",
  "checks": [                               // all must hold for a run to pass
    { "call": "host_check|Bash|Read|Grep", "input": "ci_runs|runner|land", "before": "never got a runner|waited", "why": "read the runs before saying the job never got a runner" },
    { "noText": "never got a runner", "why": "the claim the strike took back" }
  ]
}
```

### Checks

Every check is code over the rerun's transcript: its tool calls (name and JSON input) and its text. Patterns
are JavaScript regexes, matched case-insensitively. Tool names match without their `mcp__thread__` prefix
(`ask_question` matches `mcp__thread__ask_question`), and a pattern must match the whole name.

| Check | Holds when |
|---|---|
| `{ "call": "<tools>", "input": "<re>" }` | at least one call to a matching tool whose input matches `input` (optional) |
| `… "before": "<re>"` | and that call came before the first text that matches `before` (no such text: holds) |
| `{ "noCall": "<tools>", "input": "<re>" }` | no call to a matching tool with a matching input |
| `{ "reply": "<re>" }` | the last text of the turn matches |
| `{ "noText": "<re>" }` | no text anywhere in the turn matches |

Each check has a `why`: the report prints it for a failed check. Write checks that test the move, not the
wording: "called ask_question" and "read before claiming" survive a reworded prompt; a phrase match on the
reply rarely does. `noText` is for the exact claim a strike took back.

### Fake tools

Reruns get the real tool list of the version under test (its `src/mcp.ts`), but every Citadel tool answers
from a stub: nothing reaches the live app. `facts` give the answers that matter for the case: the first
entry whose `tool` matches the tool name (as in checks) and whose `match` matches the call's JSON input
wins. Without a match a tool answers with a stock reply (a card "is in the chat… End your turn now", a
ship is "handed off", a lookup is "no rows"). Bash, Read, Grep and Glob are real, but read-only, in a copy
of the repo at `commit`: writes, edits, Grunts and anything outside a read-only allowlist are refused (the
call still shows in the transcript, so a check can see the attempt).

## A brief (`briefs/<id>.json`): whole reruns for tier questions

```jsonc
{
  "id": "fix-xyz",
  "source": "#812",
  "ticket": { "number": 812, "title": "…", "type": "bug" },
  "from": "Cara",
  "message": "The brief the minion started from, as sent.",
  "before": "<sha>",                        // the fix's parent: the rerun starts here
  "fix": "<sha>",                           // the fix commit; its tests are copied in after the rerun
  "tests": ["test/xyz.test.ts"],            // pass = these, as the fix shipped them, go green on the rerun's code
  "right": "What the fix was, one sentence (for the report)."
}
```

`tools/prompt-eval check-briefs` confirms each brief's tests fail at `before` and pass at `fix`; a brief
that doesn't is no test.

## Scoring

Each case runs 3 times (`--runs`). A case passes when most of its runs pass. With `--base`, a case **fell**
when its passing runs dropped by 2 or more (3/3 to 1/3 or 0/3, 2/3 to 0/3): one run's swing is noise. Two
or more fallen cases make a prompt change high risk (Josh, 2026-11-19, "Drop needs a go").

## Adding a case (the Citadel Taskmaster's)

When a person corrects a minion in a way a prompt should have prevented (a strike, a "why didn't you…", a
reopen for a rule slip), add a case: freeze the moment from the database, write `right`, `wrong` and at
least one check that the original turn fails, and run `tools/prompt-eval run --case <id> --runs 1` once
to see it parse. Prune a case whose rule is gone or that today's prompt passes 3/3 for a month: keep about
30. Cases quote Citadel's own chats only; never another scheme's, never a secret.
