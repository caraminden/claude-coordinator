---
name: grilling
description: Grill the user relentlessly about a plan, design, decision or idea, until its open forks are settled. Use before designing or building something design-shaped (a new screen, data model or flow) whose brief leaves forks open, when the user wants to stress-test their thinking, or on any 'grill' trigger phrase.
---

Interview the user relentlessly until you reach a shared understanding. Map this as a **design tree**: every decision branches into the decisions that hang off it.

Work the tree in **rounds**. The **frontier** is every decision whose prerequisites are already settled: the questions you can ask _now_ without guessing at answers you haven't heard yet. Ask the whole frontier in one round, one card per question where cards exist (Cara, 2026-10-27: "grilling should use cards I like cards"), then wait for the user's answers before the next round.

- **Where the session has a question-card tool** (`ask_question` in a Citadel turn), each question is a card: the question in about twelve words, the background in its context, two to four options with what each one does, and your recommended answer marked with its reason. Post the whole frontier as cards in one turn, numbered Q1, Q2 and on, and say nothing else about them in a message. When the user answers a card in words instead of a tap, settle it (`settle_question`) and take their words as the answer.
- **Everywhere else** (a terminal, a session with no card tool), ask the round as one message of numbered questions, each with your recommended answer:

```
❓ **Q1** - **<question title>**: <question body, might be multiple paragraphs, including multiple choices>

➡️ <your recommended answer>
```

Word each question so "yes" accepts your recommended answer, and make the recommended option the first.

Each round the user answers reshapes the tree: settled decisions push the frontier outward and unblock questions that depended on them. Recompute the frontier and ask the next round. A question whose answer depends on another question still open in this round belongs to a _later_ round, not this one.

Finding _facts_ is your job, never the user's. When a frontier question needs a fact from the environment (filesystem, tools, etc.), dispatch a sub-agent with a fresh context window to find it; don't ask the user for anything you could look up yourself. Don't block on it: a running exploration is an unsettled prerequisite, so only the questions downstream of it wait for the sub-agent to report; ask the rest of the frontier now. The _decisions_ are the user's: put each to them and wait.

The session is done when the frontier is empty: every branch of the design tree visited, nothing left silently assumed. Do not act on it until the user confirms you have reached a shared understanding.
