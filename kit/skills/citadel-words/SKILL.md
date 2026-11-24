---
name: citadel-words
description: "Citadel's own words: the name people read and the name in code (minion/ticket, sealed/parked, ship/land), and retired ones. Use when naming Citadel's things for people or in code."
---

# Citadel

Citadel runs Claude sessions for a small group of friends, one scheme for each piece of work they share. These are the words
every scheme shares. A scheme's own `GLOSSARY.md` holds its domain's words and doesn't repeat these.

Each term is the word people read. `Code` is the name it keeps in code, tool names, stored values, routes and
paths, which never take the new name. Text people read (replies, cards, notes, PR titles, pages) uses the
term; code and talk about code use the code name, in backticks. Format: `citadel:domain-modeling`'s
GLOSSARY-FORMAT.md, plus the `Code` line.

## Language

### Who does the work

**Citadel**:
The app itself: the shared web UI that runs the sessions below.
Code: `coordinator`, `claude-coordinator`

**Scheme**:
One project's workspace: its repo, its Taskmaster, minions, rules and members.
Code: `project`, `project_id`
_Avoid_: project, workspace

**Member**:
A person assigned to a scheme. Every member decides with the same authority.
Code: `project_users`

**Taskmaster**:
The Claude a scheme's people talk to first. It starts, steers and closes minions and keeps track of them.
Code: `coordinator` (`message_coordinator`, the `coordinator` MCP server)
_Avoid_: coordinator, orchestrator

**Overlord**:
In a scheme split per person, the one Taskmaster every member shares; each member also has their own Taskmaster.
Code: `overlord`

**Minion**:
One Claude session working one job, with its own chat and branch.
Code: `ticket`, `thread` (`mcp__thread`, `COORDINATOR_ROLE=thread`)
_Avoid_: ticket, thread, agent, worker

**Grunt**:
A helper a minion or Taskmaster starts for a side job. It reports back only to the one that started it.
Code: subagent (the `Agent` tool)
_Avoid_: subagent, worker

**Turn**:
One stretch of Claude working: it starts when a message reaches it and ends on a reply.

**Owner**:
The person a minion belongs to: whoever it is assigned to, else whoever asked for it.
Code: `assigned`, `requestedBy`

**Contraption**:
A small app that runs inside Citadel, under its own page, often with its own agent.
Code: `contraption`, `/apps/<name>/`
_Avoid_: plugin, widget

**Machine**:
A person's own computer connected to Citadel, lent to a scheme for its tools and workspaces.
Code: `machine`, `mcp__<name>-ws`

**Kit**:
The skills, agents and hooks every turn of every scheme loads, shown as `citadel:<name>`.
Code: `kit/`

### Asking people

**Card**:
A question waiting on a person in the chat: a choice, a go, a secret or a notice.
Code: `ask_question`, `question`

**Plan card**:
A card with Approve and Revise that only a person can approve, for a plan heard before any code.
Code: `propose_plan`

**Choices page**:
A page of mock-ups or options people pick on, opened from a card; its Send answers the card.
Code: `mock.picks`, `mock.boards`

**Go**:
A person's yes to ship, start or close something.

**Brief**:
The written job a new minion starts from.

**Handoff**:
A file a fresh minion or session starts from, written so it needs nothing else.

**Held mail**:
A message that waits for the recipient's next turn instead of waking it.

**Steer**:
A person's message to a minion while its turn runs, read mid-turn.

**Relay**:
A message the Taskmaster passes on to another minion or another scheme.

**Status line**:
The end of a minion's reply that sets its state, note and one-tap replies in the minions list.
Code: `set_thread_status`

**Goal**:
Several minions' work toward one aim, named on the first; a retro starts once all have closed.
Code: `effortName`

**Schedule**:
A minion that starts again on a timetable.
Code: `schedule_minion`

### Shipping

**Ship**:
A finished change going onto the scheme's main branch. "Ship it" is the go.
Code: `land` (`hand_off_land`, `tools/land.sh`, `land/*` branches)
_Avoid_: land, merge, fold

**Ship line**:
The queue of changes waiting their turn to ship.
Code: land queue

**Self-review**:
The check before shipping: a Grunt reviews the change and it gets a risk label, low, medium or high. High waits for a go.
Code: `citadel:self-review`, `risk`

**Live**:
Running where its people use it. A change can ship before it is live.
Code: `pending-deploy`, `deploy`

**Released**:
A build people install (an APK, a desktop app) that its people can now get. Shipped is not released.

**Major build**:
A branch where several minions' work collects before it ships together.
Code: `build/<n>`
_Avoid_: train, epic

**Feeder**:
A minion whose work goes into a major build rather than straight onto main.

**Merge**:
Only a feeder's work going into a major build ("merged into Build 3"), or a raw git step. Onto main is ship.

**Pipeline lane**:
The one-at-a-time turn for changes to the ship and deploy pipeline itself.
Code: `pipeline-lane`

**Preview**:
A minion's branch running on a copy of the data, for people to try before it ships.
Code: `start_preview`

### A minion's state

**Sealed**:
On hold on purpose: messages wait until a person, its Taskmaster or the thing it waits on wakes it.
Code: `parked` (state `parked`)
_Avoid_: parked, paused

**Unseal**:
Wake a sealed minion.
Code: `unpark`
_Avoid_: unpark

**Ready**:
A person has to act: ship it, pick it up or answer.
Code: `ready`

**Try**:
Ready for people to try out.
Code: `try`

**Complete**:
No work left; a deliverable waits to be read, and it closes once a member has seen it.
Code: `complete`

**Blocked**:
Stuck on something outside the minion that isn't a person's answer.
Code: `blocked`

**Outside**:
Work still running somewhere the minion can't wait on, such as CI.
Code: `outside`

**Pending deploy**:
Deployed and waiting to go live, with nothing else left.
Code: `pending-deploy`

**Limited**:
Its last turn hit the Claude account's usage limit; Citadel sets it, not the minion.
Code: `limited`

**Close**:
End a minion once nothing is left for a person.
Code: `close_self`, dismissed

### Rules and settings

**Citadel-wide instructions**:
Rules every minion and Taskmaster in every scheme follows.
Code: scope `citadel`

**Scheme instructions**:
Rules for one scheme's minions and Taskmaster.

**Minion rules**:
A scheme's settings page for how its minions work and ship.

**Properties**:
A minion's labels from the scheme's registry: its type, stage and the scheme's own keys.
Code: `set_properties`

**Shared folder**:
A folder every minion and the Taskmaster of a scheme can read and write.
Code: `shared/project`

**Tripwire**:
The check on every tool call that stops known accidents.

**Critic**:
A Grunt that judges finished work blind against a scheme's rubric.

## Retired and restricted words

Never in text people read. The Citadel-wide wording check sends some of them back.

**Land** _(retired)_: say ship.
**Fold** _(retired)_: say ship for main, merge into the build for a feeder, collapsed section for UI.
**Merge** _(restricted)_: only into a major build or as a raw git step; onto main is ship.
**Parked** _(retired)_: say sealed; unpark is unseal.
**Coordinator** _(retired)_: say Taskmaster.
**Ticket**, **Thread** _(retired)_: say minion.
**Project** _(retired)_: say scheme.
