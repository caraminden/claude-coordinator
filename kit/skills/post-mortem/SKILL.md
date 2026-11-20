---
name: post-mortem
description: What went wrong with a minion, ship, chat or thing it made, and how to stop it happening again: a timeline, a cause class and one fix on a card. Use for "what happened to #N", "what went wrong with X", "why so long", "stop that from happening again". A live bug is citadel:bug-fixing.
---

A person asks what went wrong. The answer they can act on has three parts: a **timeline** (what
happened, what it cost, and the **turn point**: the first moment the work went off course), a
**cause class**, and **one fix**, a mechanism where one can do the job. The reads stay out of your
session: the `citadel:investigator` Grunt does them.

## 1. Pin the case

Write down, before any read:

- **Which work**: the minions by #N and scheme, or the chat. A thing named without a number
  ("the Flash Grenade aura") goes to the investigator as is: finding the minions that touched it
  is its first job.
- **The window**: from the ask that started it to now, unless the person gives one.
- **Their complaint, in their words**: "spent a LOT of time on a simple bug", "the icon/pips came
  out wrong". The post-mortem answers that complaint, not another one.

When the question is plain status ("did #N ship?", "what's #N doing?"), the investigator's
answer is the whole reply: skip the rest.

## 2. Send the investigator

One `citadel:investigator` call per case (two cases with no shared minion run in parallel). Brief it
with step 1's three lines, and ask it to show, within its 15 lines:

- each turn's start, cost and tool calls, and the totals;
- the person's corrections, strikes, rejected plans and run-backs, quoted;
- the **turn point**, with its evidence: the first event after which the work stopped converging
  (a wrong reading of the ask, a fix that didn't hold, a tool that failed, a loop on one error).

An app's own agent chat (a contraption's, like an aura or a planner agent) is in the app, not the
database. `contraption_read` reads it, as the person, only on a turn that answers their own typed
message: send a general-purpose Grunt (Sonnet, medium) with the window and step 2's three asks.
On any other turn, say the chat was not reached and ask them to send the question in this chat.

Read its timeline, not the sources. When its turn point doesn't explain the complaint, send it one
follow-up question about that gap; a third call means the case is two cases.

## 3. Name the cause class

Ask: **what, changed before the turn point, would have kept the work on course and still given the
person what they asked for?** Its class is the cause class. A brief that asked for something the
person wanted (a real-window repro, a test on their device) is not the cause; the missing setup
for it is. One class per case:

| Class | The thing that would have changed it |
|---|---|
| `brief` | The ask, handoff or spec: it left the deciding fact out, or said something else. |
| `rule` | Written guidance (a skill, rule file, prompt or tool description) was missing, wrong or ambiguous. |
| `tool` | The machinery around the turn (a tool, hook, script, CI, the server) failed, misled or was missing. |
| `model` | Brief, rules and tools were right, and the model skipped or misread them, or its tier was too low. |
| `bug` | The scheme's own product code: a defect that hid the cause or brought the problem back. |

When two fit, take the one nearest the start of the chain (brief before rule before tool before
model). `model` is the class of last resort: name the rule or tool that should have caught the
slip first, since a model class has no mechanism fix. Done when the class names one thing you can
point at in the timeline.

## 4. Pick one fix

The fix stops the turn point from recurring, in this order of preference:

1. **A mechanism**: a check that sends the mistake back (a hook, a test, a tool refusing the
   call), or a tool default that makes the right path the easy one.
2. **A tool or flow change**: the tool reports what was missing, the brief template gets the slot.
3. **Text**: a skill, rule or prompt line, only when no mechanism fits. Say why none does.

Before proposing it, look for a twin: an open minion or a handoff in the shared folder that
already covers it (`list_tickets`, the `handoffs/` folder). A twin means the fix is "finish #N", and
a shipped fix that didn't hold means the next fix must be a mechanism. A shipped fix with no later
case against it is the answer: report it and propose nothing new. Done when the fix names
where it lives (which hook, test, tool or file kind) and what it would have done at the turn point.

## 5. Report and ask

Reply with:

- the timeline (trim the investigator's lines to the ones that bear on the complaint), the cost
  total and the turn point, marked;
- `Cause class: <class>: <one sentence pointing at the timeline>`, on its own line, so the
  scheme's process digest can count them;
- the fix, and the twin or the past fix it replaces, if any.

When there is a fix to build, one `ask_question` card, written for someone who didn't follow the case: the cause in one
plain sentence, the fix in one, and three options: **Build it** (recommended), **Not now**, and
**The cause is wrong** (its description asks what they saw). On Build it, write a handoff in the
shared folder's `handoffs/` (why, with the timeline's evidence; the fix; done when the turn point
can't recur) and send its path to the Taskmaster (`message_coordinator`, `need: start`); a fix in
Citadel's own code or the kit is for the Citadel scheme, so say so and the Taskmaster relays it.
On The cause is wrong, take their account as a new lead: back to step 2 with it.
