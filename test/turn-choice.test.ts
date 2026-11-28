import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TurnPlace } from '../src/claude-link.ts';
import { type TurnChoiceFacts, turnChoice } from '../src/turn-launch.ts';

// #2323: the Codex-or-Claude, model and effort rules a turn starts with, as one table, with no fake claude.
const host: TurnPlace = { host: true };
const box = (container: string): TurnPlace => ({ host: false, container, configDir: '/c', home: '/h', turnsDir: '/t', env: {}, ensure: async () => {} });
const ASTRA = 'gpt-6-astra';
const NOT_LINKED = 'you are not signed in to Codex (Settings → Your account)';
const NO_CONTAINER = "Codex's container isn't there yet (sign in to Codex in Settings → Your account)";

/** A minion's turn for person 7 on the host, with one person's message, signed in to Codex, its Codex container there. */
function facts(over: Omit<Partial<TurnChoiceFacts>, 'ticket'> & { ticket?: Partial<TurnChoiceFacts['ticket']> } = {}): TurnChoiceFacts {
  return {
    project: { default_effort: 'medium' },
    person: 7,
    claude: host,
    keepalive: false,
    resumed: false,
    batch: [{}],
    codexSwitch: () => false,
    codexWhy: () => null,
    codexPlace: () => box('codex-7'),
    keepaliveLight: false,
    ...over,
    ticket: { kind: 'ticket', model: 'claude-opus-5-5', effort: null, ...over.ticket },
  };
}

const rows: [string, TurnChoiceFacts, Omit<Partial<ReturnType<typeof turnChoice>>, 'place'> & { place?: string }][] = [
  // Claude
  ['a Claude pick runs on Claude at the scheme effort', facts(), { codex: false, model: 'claude-opus-5-5', effort: 'medium', light: false, note: null, place: 'host' }],
  ['its own effort wins', facts({ ticket: { effort: 'high' } }), { effort: 'high' }],
  ['a Taskmaster with none set runs opus at high', facts({ ticket: { kind: 'coordinator', model: null } }), { model: 'opus', effort: 'high' }],
  ['a person-container turn stays there', facts({ claude: box('claude-7') }), { codex: false, place: 'claude-7' }],
  // Codex
  ['a Codex pick, signed in, on the host runs in the Codex container', facts({ ticket: { model: ASTRA } }), { codex: true, model: ASTRA, note: null, place: 'codex-7' }],
  ['a Codex pick in their own container runs there', facts({ ticket: { model: ASTRA }, claude: box('claude-7') }), { codex: true, model: ASTRA, place: 'claude-7' }],
  ['the switch puts a Claude pick on Codex, model unmapped here', facts({ codexSwitch: () => true }), { codex: true, model: 'claude-opus-5-5', place: 'codex-7' }],
  // Codex falls back to Claude
  ['a Codex pick not signed in runs on Claude’s default, saying why', facts({ ticket: { model: ASTRA }, codexWhy: () => NOT_LINKED }), { codex: false, model: null, place: 'host', note: `This minion is set to GPT-6 Astra, but ${NOT_LINKED}, so this turn runs on Claude's default model.` }],
  ['a Codex Taskmaster falls back to opus', facts({ ticket: { kind: 'coordinator', model: ASTRA }, codexWhy: () => NOT_LINKED }), { codex: false, model: 'opus' }],
  ['a host turn with no Codex container falls back', facts({ ticket: { model: ASTRA }, codexPlace: () => null }), { codex: false, model: null, place: 'host', note: `This minion is set to GPT-6 Astra, but ${NO_CONTAINER}, so this turn runs on Claude's default model.` }],
  ['the switch with no person never asks and stays on Claude', facts({ person: null, codexSwitch: () => assert.fail('asked with no person') }), { codex: false, note: null }],
  ['a Codex pick with no person says why', facts({ person: null, ticket: { model: ASTRA }, codexWhy: (p) => (p === null ? 'Codex runs only for a person' : null) }), { codex: false, note: "This minion is set to GPT-6 Astra, but Codex runs only for a person, so this turn runs on Claude's default model." }],
  ['the switch not signed in says so', facts({ codexSwitch: () => true, codexWhy: () => NOT_LINKED }), { codex: false, model: 'claude-opus-5-5', note: `Codex is switched on, but ${NOT_LINKED}, so this turn runs on Claude.` }],
  // Light effort (#951)
  ['a batch of success notices runs light', facts({ batch: [{ light: true }, { light: true }] }), { light: true, effort: 'low' }],
  ['one person’s message among them keeps its effort', facts({ batch: [{ light: true }, {}] }), { light: false, effort: 'medium' }],
  ['an empty batch keeps its effort', facts({ batch: [] }), { light: false }],
  ['a resume keeps its effort', facts({ batch: [{ light: true }], resumed: true }), { light: false }],
  ['a Taskmaster never runs light', facts({ ticket: { kind: 'coordinator' }, batch: [{ light: true }] }), { light: false, effort: 'high' }],
  ['a Codex turn never runs light', facts({ ticket: { model: ASTRA }, batch: [{ light: true }] }), { codex: true, light: false }],
  ['a keepalive replays a light turn', facts({ keepalive: true, keepaliveLight: true, batch: [{}] }), { light: true, effort: 'low' }],
  ['a keepalive replays a full turn, whatever its batch', facts({ keepalive: true, keepaliveLight: false, batch: [{ light: true }] }), { light: false, effort: 'medium' }],
];

for (const [name, f, want] of rows) {
  test(name, () => {
    const got = turnChoice(f);
    const { place, ...rest } = want;
    if (place) assert.equal(got.place.host ? 'host' : got.place.container, place);
    for (const [k, v] of Object.entries(rest)) assert.deepEqual(got[k as keyof typeof rest], v, k);
  });
}

test('the Codex lookups are asked only when a rule needs them', () => {
  const never = () => assert.fail('asked');
  turnChoice(facts({ codexWhy: never, codexPlace: never }));
  turnChoice(facts({ ticket: { model: ASTRA }, codexWhy: () => NOT_LINKED, codexPlace: never }));
  turnChoice(facts({ ticket: { model: ASTRA }, claude: box('claude-7'), codexPlace: never }));
});
