# Grading an app's own agent, inside the app

For a contraption whose agent makes something a person then acts on: a proposal, a row, a wiki
page, an answer, an aura. The grade belongs on the app's own screen, beside the item, so the app's
server runs it, per item, through Citadel's turn API. No minion is in the loop. A minion builds it,
and later calibrates it from what people did.

**A critic only annotates.** The verdict never accepts, rejects, hides, edits or reorders an item,
and never changes what the person can do with it. An app's hard rules stay code (Peek Auras'
compliance script is a refusal, not a rubric). An app may require that a verdict *exists* before a
person accepts (Transdata's rows); it never accepts or refuses on the verdict's say.

## 1. The rubric file

A file in the app's repo, in the [rubric format](rubric-format.md), with `when: "in-app: <the step
that grades>"` (`"in-app: each proposal the source reader saves"`), named in the scheme's Rubrics
line so minions find it. The app reads it at start and sends it as the system prompt.

The app's server can't count on the kit's path, and a kit edit must not change a calibrated grader
under it. So a rubric that `extends:` a starter copies the starter's sections it uses into itself,
says under its title which starter and the date it was copied, and is calibrated again when it is
copied again. The app keeps a version for the rubric (the file's git hash, or a date in its
frontmatter) and saves it with every verdict.

## 2. The call

`POST /api/contraptions/turns` from the app's server with its contraption key (the turn API:
`src/contraption-turns.ts`, and the chat recipe in `citadel:contraption-ui`'s `references/chat.md`):

| Field | Value | Why |
|---|---|---|
| `person` | the person the item belongs to | It runs on their own plan, and counts against the app's `turn_cap` a day. |
| `session` | `grade-1` ... `grade-3`, from a small pool | A busy name refuses a second turn; a few names let items grade at once. |
| `fresh` | `true` | One item's grade never leaks into the next. |
| `system` | the rubric's body, then the output contract (section 3) | |
| `prompt` | the item, the ask it answered, and its source, each under its own label, the source with locations (`line 41:`, `row 812:`) | |
| `model` | `haiku` per item; a Codex model for a gate (section 6) | |
| `mcp` | `[]` | Blind: the grader sees only the prompt. It can't read the app's data or fetch the source again. |
| `agents`, `webSearch` | `false` | Same. |
| `timeoutSec` | `60` | |

The prompt holds what the item's reader would see and the source, never how the agent made it: no
reasoning, no chat, no tool log. The one exception is an excuse: when the item says it couldn't do
part of the ask, give the evidence for that (the fetch's status and URL) under its own label.

One item a turn, with all its claims. Items that share one source may go up to 6 a turn, each with
its own verdict. Read the cost off the `end` event's `usage`: Claude Code's own system prompt rides
along on every turn, so measure before trusting the report's ~$0.001 an item on Haiku.

## 3. The verdict, as JSON

The output contract, at the end of the system prompt: reply with one JSON object and nothing else.

```json
{
  "verdict": "pass | flag | cant_check",
  "claims": [
    {
      "id": "C1",
      "claim": "the item's words",
      "verdict": "supports | partly | doesnt_support | cant_check",
      "span": "the source's words, at most 25",
      "where": "row 812",
      "scope": "population | number | tier | date | null",
      "plain": "one sentence for the person, no rubric words"
    }
  ],
  "asked": "did_it | partly | no",
  "excuse": "true | false | cant_check | none"
}
```

`flag` when any blocker fires, `cant_check` when the source given can't settle the item, else
`pass`. Item-level findings that aren't about one claim (blocker 4's split or merge) go in a claim
with `"id": "item"`.

On the app's side, before saving:

1. **Parse** the last model message (the `text` events whose `message` is the last id). Bad JSON or
   a missing key: one retry, fresh; then save `{ "verdict": "error" }` and show "couldn't check".
   A grader error never blocks the person.
2. **Check each span is in the source,** as written (case and spacing aside). Free, and it catches
   the grader quoting what isn't there: a span that isn't found turns its claim into `cant_check`,
   with `"grader_misquote": true` saved.

## 4. Save it beside the item

A row per grade, keyed by the item: the JSON, the rubric version, the model asked for, the time, and
later the person's action. A re-grade adds a row; nothing is overwritten. The verdict lives in the
app's own store: Citadel keeps no turn content.

## 5. Show it in plain words

On the item's own screen, next to the item, using Citadel UI (`citadel:contraption-ui`):

- One chip for the item: checked, or a count of claims the source doesn't back, or "couldn't
  check".
- Per claim that isn't `supports`: what the item says, what the source says (the span, with where),
  and `plain`. No C-numbers, blocker numbers or rubric words.
- `supports` claims behind a toggle. `cant_check` shown as that, never as a fail.
- Who checked, against what: "Checked by Haiku against the post". Always the grader's opinion, never
  the app's ruling.

## 6. Which model

- **Per item: Haiku.** Volume is high and each check is small. If calibration (section 7) shows it
  missing more than half of what people flag, run the same set on Sonnet before rewriting the
  rubric.
- **A gate that accepts a fact** (Transdata accepting a row, ToC promoting a tier): a Codex model
  (`gpt-6.1-sol`; the names are in `src/codex.ts`), another family from the Claude agent that wrote
  it, since a judge favours its own family's text. Two catches in the turn API today: a Codex ask
  from a person whose container has no Codex signed in runs Claude's default model instead, and a
  person's "Enable Codex override" turns a Haiku ask into Codex. The turn's events don't say which
  ran, so save the model *asked for* and show "Checked by Codex" only once Citadel reports it.
- **Never Opus per item.**

## 7. Calibrate from what people did

Every accept, reject, edit or override the person makes on a graded item is a label. Log it beside
the grade: the action, any note in their words, the time. Ready-made sets: Theory of Crafting's
workshop accept/reject, Mandate's eval cases, and Peek Auras' auras a player kept or sent back to
its agent (it has no outcome field yet: the grader's minion adds one).

- **Count,** per rubric version: **hit**, the grader flagged it and the person rejected or edited it
  for that; **miss**, the grader passed it and the person rejected it; **false alarm**, the grader
  flagged it and the person accepted it unchanged.
- **Held out.** Before tuning, set aside a fixed slice (every fifth labelled item, picked by id, not
  by looking) that no rubric edit ever reads. Test on it only. Never tune on a set the scheme
  already holds out (Mandate's eval's held-out cases).
- **Trial.** Once about 20 to 30 items are judged, a minion runs [`calibrate.md`](calibrate.md) on
  them with the app's rubric and model and writes `calibrated:`. People's words and overrides go
  into the rubric as `citadel:critique`'s step 9 says, and the version moves on.
- **Tests never call a model.** The app's test suite stubs the turn API and checks the parse, the
  span check and the save; the grader's quality is the trial's job.
