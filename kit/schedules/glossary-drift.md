---
name: Glossary drift check
type: chore
model: claude-sonnet-5-5
effort: medium
min_minions: 3
cron: 0 8 2 * *
stagger: 10m within 180m
applies: every scheme; Citadel adds it to each scheme by itself, and the run skips at no cost when fewer than 3 minions worked in the scheme since the last one
---
Monthly glossary drift check for {scheme}: compare the scheme's glossary with what its code, screens and docs say now, and propose edits. Change nothing yourself: this run is read-only, so write no file in the repo, shared folder or memory.

1. Find the glossary: the "Glossary" key under "Project facts" in the repo's CLAUDE.md (usually GLOSSARY.md or docs/glossary.md). If there is none, or it says "none", say so in one line and close yourself (close_self); don't look for one elsewhere.
2. Read it, then search the repo (code, UI text and strings, docs, the scheme's instructions) with Read, grep and ls only. Collect:
   - **Stale**: a glossary term that code, UI text and docs no longer use (zero hits outside the glossary itself, or only under old/archived paths), or whose definition contradicts what the code does now.
   - **Missing**: a domain word used often in code identifiers, UI text or docs (roughly 5 or more places, in 2 or more files) that the glossary lacks. Skip generic programming words, library names and names of files.
   - **Synonyms**: two or more words used for one glossary term (in code, UI text or docs); name the term, the variants and where each shows up.
   Count with case-sensitive, term-specific greps, not a bare common word (Group, Variant) in any case. A term the glossary marks as "code keeps the old name" is not stale and not a synonym problem: propose at most a reword if that note is missing.
   Check a term's definition against how it is really used before you call it missing or stale; one grep isn't evidence for either.
3. Nothing found: say so in one line and close yourself (close_self).
4. Otherwise post one card of proposed edits, each saying what changes in the glossary (add, remove, reword, or add a synonym note), the term and one line of evidence (count and a path or two). Write it for a person who hasn't read the glossary. More than 4 edits go on a choices page with the card that opens it; 4 or fewer on a plain multi-select card. Mark your recommendation.
5. End your turn in state ready. When a member answers, apply only the edits they picked, to the glossary file alone, through this scheme's usual landing route (citadel:self-review first), then close yourself. Nothing picked: change nothing and close.

Use a Sonnet-sized effort and keep the searches targeted. Never touch another scheme.
