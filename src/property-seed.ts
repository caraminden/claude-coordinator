// What the property registry starts with, taken from the hand-written vocabulary docs it replaces
// (projects/2 and projects/1 shared/project/property-vocabulary.md, 2026-10-27). Used once, on an
// empty registry; from then on the registry is the source of truth, except that a global key added
// here later is added once to a registry that lacks it.

export interface SeedValue {
  value: string;
  label?: string;
  description?: string;
  aliases?: string[];
}

export interface SeedKey {
  key: string;
  label: string;
  description: string;
  multi: boolean;
  value_kind: 'enum' | 'integer' | 'user' | 'text';
  values?: SeedValue[];
}

export const GLOBAL_SEED: SeedKey[] = [
  {
    key: 'type',
    label: 'Type',
    description: 'What kind of work. Every minion has one; when nothing fits, use `other` and ask people whether it should stay `other` or go in another bucket. Replaces the old minion tag (feature, bug, design → the same; idea → ideation; process → chore).',
    multi: false,
    value_kind: 'enum',
    values: [
      { value: 'feature', aliases: ['enhancement'] },
      { value: 'bug', aliases: ['fix', 'defect'] },
      { value: 'art', aliases: ['artwork', 'illustration'] },
      { value: 'ideation', aliases: ['idea', 'brainstorm'] },
      { value: 'design' },
      { value: 'research', description: 'A minion that investigates something.' },
      { value: 'chore', aliases: ['process', 'tooling', 'docs', 'setup'] },
      { value: 'other', description: 'Nothing else fits yet. Ask people whether to keep it or move it to another type.' },
    ],
  },
  {
    key: 'stage',
    label: 'Stage',
    description: 'Where the work is. Moves on its own (new → in-progress, or idea for ideation; dismissed → done; reopened → in-progress), and anyone can still set it.',
    multi: false,
    value_kind: 'enum',
    values: [{ value: 'idea' }, { value: 'in-progress', aliases: ['wip', 'doing'] }, { value: 'review' }, { value: 'done' }],
  },
  {
    key: 'requestedBy',
    label: 'Requested by',
    description: "Who asked for the work: a person's login name. Set automatically when a person starts a minion.",
    multi: false,
    value_kind: 'user',
  },
  {
    key: 'assigned',
    label: 'Assigned to',
    description: "Who the minion is assigned to: a person's login name (e.g. Cara). Starts as whoever started it (a minion the Taskmaster starts for another minion takes that one's); set when a person asks to assign it (\"assign this to Josh\"); null unassigns it.",
    multi: false,
    value_kind: 'user',
  },
];

/** Delve's own keys, for the scheme named Delve. Ranger + Void has no name yet, so it isn't a class. */
export const DELVE_SEED: SeedKey[] = [
  {
    key: 'playerClass',
    label: 'Player class',
    description: [
      'The hero classes the work is about: the 8 base classes (`HeroClass` in src/Delve.Sim/Content/HeroClass.cs) and the 16 advanced classes of Build 8. Each base class has two advanced classes, one from each of the two elements that beat it.',
      '`Untrained` is not a value: an untrained hero has no class, so leave playerClass unset.',
      'Rename trap: `Warrior` is the Earth class now. Work from before 2026-10-23 that says "Warrior" means the Emberknight, and "Sapper" means today\'s Warrior; map by date.',
      'Ranger + Void (element Nightshade) has no name yet: leave playerClass off, or set `Ranger` if the work is about the base class too.',
    ].join('\n\n'),
    multi: true,
    value_kind: 'enum',
    values: [
      { value: 'Emberknight', description: 'Base · Fire' },
      { value: 'Shadow', description: 'Base · Void', aliases: ['Shade'] },
      { value: 'Ranger', description: 'Base · Nature' },
      { value: 'Warrior', description: 'Base · Earth (was Sapper until 2026-10-23)', aliases: ['Sapper'] },
      { value: 'Tidecaller', description: 'Base · Water' },
      { value: 'Paladin', description: 'Base · Light', aliases: ['Warden'] },
      { value: 'Necromancer', description: 'Base · Death', aliases: ['Gravecaller'] },
      { value: 'Windshaper', description: 'Base · Air', aliases: ['Arcanist'] },
      { value: 'Pyreguard', description: 'Advanced · Emberknight · Balefire (+ Death)' },
      { value: 'Smoulderer', description: 'Advanced · Emberknight · Smoke (+ Air)' },
      { value: 'Infernal', description: 'Advanced · Shadow · Brimstone (+ Fire)' },
      { value: 'Whisper', description: 'Advanced · Shadow · Silence (+ Air)' },
      { value: 'Ashstalker', description: 'Advanced · Ranger · Ash (+ Fire)' },
      { value: 'Sunderer', description: 'Advanced · Warrior · Rift (+ Void)' },
      { value: 'Bramblelord', description: 'Advanced · Warrior · Bramble (+ Nature)' },
      { value: 'Tidetamer', description: 'Advanced · Tidecaller · Reef (+ Nature)' },
      { value: 'Lurker', description: 'Advanced · Tidecaller · Quicksand (+ Earth)' },
      { value: 'Refractor', description: 'Advanced · Paladin · Crystal (+ Earth)' },
      { value: 'Absolver', description: 'Advanced · Paladin · Purity (+ Water)' },
      { value: 'Draugr', description: 'Advanced · Necromancer · Undertow (+ Water)' },
      { value: 'Banisher', description: 'Advanced · Necromancer · Consecration (+ Light)' },
      { value: 'Tempest', description: 'Advanced · Windshaper · Lightning (+ Light)' },
      { value: 'Banshee', description: 'Advanced · Windshaper · Lament (+ Death)' },
    ],
  },
  {
    key: 'assetType',
    label: 'Asset type',
    description: 'What kind of asset; mainly on artifacts.',
    multi: true,
    value_kind: 'enum',
    values: [
      { value: 'concept', aliases: ['concept-art'] },
      { value: 'sprite' },
      { value: 'animation', aliases: ['anim'] },
      { value: 'vfx', aliases: ['fx', 'effects'] },
      { value: 'icon' },
      { value: 'ui' },
      { value: 'audio' },
      { value: 'doc' },
    ],
  },
  {
    key: 'area',
    label: 'Area',
    description: [
      "The game systems the work touches, following the system tags in Delve's docs/design/decisions.md.",
      '`research` is the in-game system (Artifact study, Scholars, the tech tree, manuals), not `type: research`. `tech` is the code; the tech tree is `research`. `#pillars` has no area: set the areas it touches. There is no `art` area (art is a type) and no `audio` area.',
    ].join('\n\n'),
    multi: true,
    value_kind: 'enum',
    values: [
      { value: 'heroes', aliases: ['classes', 'recruiting', 'training', 'injuries', 'retirement', 'guildmaster'] },
      { value: 'dungeons', aliases: ['delving', 'combat', 'bosses', 'lairs', 'finds', 'explorers'] },
      { value: 'town', aliases: ['jobs', 'buildings', 'workers', 'foremen', 'land', 'food', 'kitchens', 'hunger'] },
      { value: 'gear', aliases: ['armor', 'weapons', 'crafting', 'essences', 'enchanting'] },
      { value: 'alchemy', aliases: ['potions', 'apothecary', 'herbs', 'stillroom'] },
      { value: 'research', aliases: ['scholars', 'tomes', 'manuals', 'artifacts', 'tech-tree'] },
      { value: 'balance', aliases: ['pacing', 'tuning', 'knobs'] },
      { value: 'ui', aliases: ['screens', 'tabs', 'tooltips', 'text'] },
      { value: 'tech', aliases: ['engine', 'architecture', 'saves', 'performance', 'perf'] },
      { value: 'tooling', aliases: ['tools', 'ci', 'hooks', 'runner', 'bots', 'process'] },
    ],
  },
  {
    key: 'build',
    label: 'Build',
    description: [
      'The major build the work rides or ships in, as a plain integer (`build: 7`); for a bug, the build it was found in.',
      'The number is the count of entries in `TestBuilds.All` (src/Delve.Sim/Testing/TestBuilds.cs); count them rather than reading a name. No git tags, CI run numbers or commit hashes.',
    ].join('\n\n'),
    multi: false,
    value_kind: 'integer',
  },
];

/** The old minion tag each `type` value matches, and back. Types with no tag of their own clear it. */
export const TAG_TO_TYPE: Record<string, string> = { feature: 'feature', bug: 'bug', design: 'design', idea: 'ideation', process: 'chore' };
