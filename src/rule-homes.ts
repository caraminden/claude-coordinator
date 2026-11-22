// One home per rule (#1162, from #1092's idea C2). Each rule registered here is written in full in one place, its
// home; everywhere else names it in a few words and points there. Josh, 2026-11-20, #1162's grilling: the registry is
// "A file in the repo"; a second place repeats a rule when it has "Phrases plus word runs" (two or more of the rule's
// phrases in one paragraph, or a run of RUN_WORDS words shared with the home); and the five first homes are "Yes, those
// five". test/rule-homes.test.ts fails on a copy in the repo; the server's overlap check (src/rule-overlap.ts) runs the
// same matcher on a Settings save, where the Citadel-wide homes live.
//
// Another scheme registers its own rules in its repo's .claude/rule-homes.json (#1211; Josh, 2026-11-20, "A file in its
// own repo"): a JSON list of the same shape, its homes a `scheme` section or a `repo` file of that scheme's repo, read
// on every save of its text (src/rule-overlap.ts, schemeRules).
//
// To register a rule: give it a home and phrases taken from the home's own details, not its name: a pointer may say
// "the card rule" or "write the failing test first", but not two of the details. Then run the test and turn each copy
// it names into a pointer.

/** Where a rule is written in full. */
export type Home =
  /** A section of the Citadel-wide instructions (Settings), by its `## ` heading. */
  | { kind: 'citadel'; section: string }
  /** A section of one scheme's own instructions (Settings), by its `## ` heading: only in a scheme's rule file. */
  | { kind: 'scheme'; section: string }
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
  // #1574 moved these out of every minion's prompt to where their job meets them. Strike, wake_when_live and
  // relay_when_live live in their own tool descriptions; they aren't registered, since the Taskmaster prompt keeps its
  // own strike line and the other two descriptions sit inline in a tool list a code anchor can't cut out alone.
  {
    id: 'done-lines',
    title: 'Done lines on a feature',
    home: { kind: 'repo', file: 'src/done-lines.ts', anchor: 'export const DONE_LINES' },
    pointer: "the done-lines rule (set_properties' reply on a feature)",
    phrases: ['before any code write 3 to 7', 'a report not a card', 'naming any not met', 'bugs chores and research write none'],
  },
  {
    id: 'dev-copy',
    title: 'Running a dev copy of Citadel',
    home: { kind: 'repo', file: '.claude/rules/dev-copy.md', section: 'A dev copy of Citadel' },
    pointer: 'the dev-copy rule (.claude/rules/dev-copy.md)',
    phrases: ['new seed states go in tools dev seeds ts', 'which opens the live database', 'its header lists the steps'],
  },
  {
    id: 'settings-edit',
    title: 'A Settings text edit ships like code',
    home: { kind: 'repo', file: 'src/mcp.ts', anchor: 'const EDIT_INSTRUCTIONS' },
    pointer: 'the edit_instructions description',
    phrases: ['is an agent instruction change', 'label it at least medium', 'keep its dated quotes'],
  // Six Citadel-wide Settings sections moved to where their job starts (#1576, moves 13 to 18 of #1277's ablation;
  // Cara, 2026-11-22: "Moving" on all 18 moves).
  {
    id: 'ui-checks',
    title: 'UI checks for every front end',
    home: { kind: 'repo', file: 'kit/skills/self-review/SKILL.md', section: 'UI checks for every front end' },
    pointer: 'the UI checks (citadel:self-review, "UI findings")',
    phrases: ['proportional checks', 'no reflow without input', 'sit for a minute', 'automated layout shift check', 'big pieces of the ui', 'scrollbar coming and going', 'never in backticks or a bare domain'],
  },
  {
    id: 'ports',
    title: 'Ports for dev servers and browsers',
    home: { kind: 'repo', file: 'kit/skills/contraption-ui/SKILL.md', section: 'Ports for dev servers and browsers' },
    pointer: 'the ports rule (citadel:contraption-ui, "Ports for dev servers and browsers")',
    phrases: ['free random port', 'never 8573', 'outside 8000 8999', 'unless a person needs tailscale', 'connect only to the port your process reported'],
  },
  {
    id: 'images-by-code',
    title: 'Images and sounds by code',
    home: { kind: 'repo', file: 'src/mcp-media.ts', anchor: 'export const NOT_DEFAULT =' },
    pointer: 'images by code (the media tools say when a generative one is allowed)',
    phrases: ['otherwise draw with code', 'otherwise make sound with code', 'a scheme systems call', 'explicit ask or a scheme system'],
  },
  {
    id: 'idea-minions',
    title: 'Idea minions and process-only changes',
    home: { kind: 'repo', file: 'kit/skills/briefing/SKILL.md', section: 'Idea minions and process-only changes' },
    pointer: 'idea minions end in handoffs (citadel:briefing)',
    phrases: ['an idea minion ships nothing', 'never waits for a feature build', 'process only change'],
  },
  {
    id: 'grill-first',
    title: 'Which features get grilled',
    home: { kind: 'repo', file: 'kit/skills/grilling/SKILL.md', section: 'Which features get grilled' },
    pointer: 'grill design-shaped features first (citadel:grilling)',
    phrases: ['a new flow people use', 'needs only a round on what it leaves open', 'known shape work a small feature or ui tweak'],
  },
  {
    id: 'shared-folder',
    title: 'How the shared folder is sorted',
    home: { kind: 'repo', file: 'kit/skills/briefing/SKILL.md', section: 'The shared folder' },
    pointer: "the shared folder's layout (citadel:briefing, \"The shared folder\")",
    phrases: ['sorted by kind', 'what the schemes readme adds', 'read the readme before adding files', 'raw runs or secrets'],
  },
];
