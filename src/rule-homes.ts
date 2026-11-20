// One home per rule (#1162, from #1092's idea C2). Each rule registered here is written in full in one place, its
// home; everywhere else names it in a few words and points there. Josh, 2026-11-20, #1162's grilling: the registry is
// "A file in the repo"; a second place repeats a rule when it has "Phrases plus word runs" (two or more of the rule's
// phrases in one paragraph, or a run of RUN_WORDS words shared with the home); and the five first homes are "Yes, those
// five". test/rule-homes.test.ts fails on a copy in the repo; the server's overlap check (src/rule-overlap.ts) runs the
// same matcher on a Settings save, where the Citadel-wide homes live.
//
// To register a rule: give it a home and phrases taken from the home's own details, not its name: a pointer may say
// "the card rule" or "write the failing test first", but not two of the details. Then run the test and turn each copy
// it names into a pointer.

/** Where a rule is written in full. */
export type Home =
  /** A section of the Citadel-wide instructions (Settings), by its `## ` heading. */
  | { kind: 'citadel'; section: string }
  /** A section of a repo markdown file, by its heading, or a code statement, by the text its first line starts with. */
  | { kind: 'repo'; file: string; section?: string; anchor?: string };

export interface RuleHome {
  id: string;
  /** What people call it. */
  title: string;
  home: Home;
  /** The few words a pointer uses, e.g. "the Citadel-wide card rule (Asking and picking)". */
  pointer: string;
  /** Details only the rule spells out. Matched lower-cased with punctuation dropped, from a word start. */
  phrases: string[];
}

/** Shared words in a row that make a paragraph a copy of its home. */
export const RUN_WORDS = 12;
/** Phrases of one rule in one paragraph that make it a copy. */
export const PHRASE_HITS = 2;

export const RULE_HOMES: RuleHome[] = [
  {
    id: 'cards',
    title: 'When to use a card',
    home: { kind: 'citadel', section: 'Asking and picking' },
    pointer: 'the Citadel-wide card rule (Asking and picking)',
    phrases: ['a go a or b', 'want me to', 'offer of work', 'tuning details', 'only tunes the result', 'one card one choice', 'ask early and together', 'by what it does', 'named by what they do', 'file paths line numbers', 'never paste', 'carries a card'],
  },
  {
    id: 'closing',
    title: 'When a minion closes',
    home: { kind: 'citadel', section: 'Closing' },
    pointer: 'the Citadel-wide Closing rule',
    phrases: ['nothing is left for a person', 'are we good', 'does something by hand', 'telling the taskmaster the steps', 'deletes its own scratch', 'closes any minion that qualifies', 'never a read it deliverable', 'request to wait for feedback'],
  },
  {
    id: 'tripwire',
    title: 'What the tripwire stops',
    home: { kind: 'repo', file: 'src/tripwire-blocks.ts', anchor: 'export const TRIPWIRE_BLOCKS' },
    pointer: 'the tripwire (it says why when it stops a call)',
    phrases: ['writes outside your own folders', 'pin down', 'killing by name or pattern', 'pushing main or a plain', 'git show head', 'printenv', 'env cut d f1', 'soft or mixed reset', 'piped into sqlite3', 'over uncommitted changes'],
  },
  {
    id: 'test-first',
    title: 'Failing test first',
    home: { kind: 'repo', file: 'kit/skills/test-quality/SKILL.md', section: 'When it applies' },
    pointer: 'write the failing test first (citadel:test-quality)',
    phrases: ['watch it go red', 'one failing test for one behaviour', 'just enough code to pass', 'tests written up front', 'flags any that pass there', 'no test first'],
  },
  {
    id: 'models',
    title: 'Which model and effort a minion gets',
    home: { kind: 'repo', file: 'public/model-table.js', anchor: 'export const TIERS' },
    pointer: "the model table (the Taskmaster's, public/model-table.js)",
    phrases: ['sonnet 5 5 medium', 'sonnet 5 5 low', 'opus 5 5 high', 'opus 5 5 medium', 'fable 5 2 medium'],
  },
];
