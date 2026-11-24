---
name: Memory curator
type: chore
model: claude-sonnet-5-5
effort: medium
min_minions: 3
cron: 0 5 * * 2
stagger: 10m within 180m
applies: every scheme; Citadel adds it to each scheme by itself, and skips the run, at no cost, when the scheme has no memory notes or last week's tidy still waits on the Memory page
---
Weekly memory tidy for {scheme}: propose a tidier memory store, and change nothing yourself. Josh (2026-11-19) picked a curator a member approves, note by note, on the Memory page. You only propose. Never edit, write or delete a file in the memory folder: a member ticks what to apply.

The folder is {memory_dir}. Read MEMORY.md and every note in it, with Read, ls and grep only. Check each note against what is true now: list_tickets or read_minion for the minions it names, the repo for the files, tools and functions it names, and the scheme's instructions in your prompt.

Look for:
- notes nothing reaches: only MEMORY.md loads at a start, so a note counts as listed when MEMORY.md links it (`](file.md)` or `[[name]]`), or when a note MEMORY.md itself links does (a topic index); two links away is not reached. Propose an `index` line for each one left, `- [Name](file.md) — one-line hook`, or a line in the topic index when MEMORY.md is near its 200 lines (an `edit` of that note);
- notes past their date (a recheck or until date that has passed), and notes whose minion is closed and whose point is gone: `delete`, or `edit` to keep the part still true;
- duplicates and near-duplicates: `edit` one to hold both, and `delete` the other;
- a note that only repeats what the instructions, CLAUDE.md or the repo already say: `delete`;
- a file, tool, function or setting the note names that no longer exists: `edit` it, or `delete` it when nothing is left;
- two notes that contradict each other: keep the newer word (its date), and `edit` or `delete` the older;
- MEMORY.md lines over about 150 characters: `index` with a shorter line, under 150 (the date and quote stay in the note); a long line no note owns: `flag` MEMORY.md itself;
- a note whose main content is a list of minions and their states (open, sealed, waiting, owed), a tracker rather than a fact: `flag` it with the reason "live state: make it a pointer". A note that mentions a minion's state in passing is not one;
- a claim about code, a file, a tool or a setting with no date and no commit or #N it was true at: `edit` to add them when you can verify them now (cite the commit you checked, today's date), else `flag` the note. Leave notes whose claims all carry one alone. Inside a note that tracks a decision over time, an older line stays, marked "superseded (date)";
- anything you think is wrong but can't settle yourself: `flag` it, with why.

Send the whole tidy as one propose_memory call, one change per note (only `.md` notes and MEMORY.md take changes; name any other file, like an old backup, in the summary you reply with): the action, the note's file, the new text for edit and add (the whole file, frontmatter included), the MEMORY.md line for index and add (an edit may carry one too, which replaces the note's line), and a reason a member can read in one line. Keep the frontmatter as it is, apart from what you mean to change. A delete takes its own MEMORY.md line with it; a link to it in another note (a topic index) needs an `edit` of that note. A delete is never part of a merge silently: list it as its own change, with why. An owed step you can't confirm happened (a read-back, a relay) is a `flag`, not a delete.

Nothing to tidy: say so in one line and close yourself (close_self). Otherwise link the card propose_memory gives you, end your turn in state ready, and close yourself once the answer comes.
