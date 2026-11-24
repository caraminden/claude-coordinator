// A scheme's Shipping settings (#1043, Cara picked N1, N2 and N4 on 2026-11-19): how a change ships, from which risk
// label a person's go is needed, and what waits for a try. The server (routes, prompts, hand_off_land) and the Minion
// rules page both read this file, so the gate is decided in one place.

/** [value, what people read] for each setting, in the order the page shows them. */
export const SHIP_PATHS = [
  ['citadel', 'Citadel ships it'],
  ['pr-auto', 'Pull request, auto-merge when green'],
  ['pr-minion', 'Pull request, the minion merges when green'],
  ['pr-person', 'Pull request, a person merges'],
];
export const GO_FROM = [
  ['never', 'Never needed'],
  ['high', 'High-risk changes'],
  ['medium', 'Medium and high-risk changes'],
  ['all', 'Every change'],
];
export const TRY_FIRST = [
  ['never', 'Ships when green'],
  ['ui', 'UI changes wait for a try'],
  ['features', 'Every feature waits for a try'],
];
export const values = (opts) => opts.map(([v]) => v);
export const label = (opts, v) => opts.find(([k]) => k === v)?.[1] ?? v;

/** The approval rules that make a merge wait for a person's Approve ("Merge a pull request" under Approvals). */
export const MERGE_RULES = ['Bash(gh pr merge:*)', 'mcp__*__merge_pull_request'];

const RANK = { low: 0, medium: 1, high: 2 };
const FROM = { all: 0, medium: 1, high: 2, never: 3 };
/** Whether a change with this risk label waits for a person's go before it ships. */
export const needsGo = (goFrom, risk) => RANK[risk] >= FROM[goFrom || 'high'];

/**
 * The one gate (N2): a person merges every change on pr-person, so its go is from every change; on a pull-request path
 * (pr-auto, pr-minion, pr-person) the merge approval is on exactly when every change needs a go, and a go by label otherwise comes on a card. On
 * Citadel's own path nothing merges a PR, so the merge approval is left as people set it. Returns the settings with
 * go_from and approval_rules made to agree; a rule list that already agrees comes back unchanged, order and all.
 */
export function shippingGate({ ship_path, go_from, approval_rules }) {
  const goFrom = ship_path === 'pr-person' ? 'all' : go_from;
  if (!ship_path?.startsWith('pr-')) return { go_from: goFrom, approval_rules };
  const rules = (approval_rules ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const next = goFrom === 'all' ? [...rules, ...MERGE_RULES.filter((r) => !rules.includes(r))] : rules.filter((r) => !MERGE_RULES.includes(r));
  return { go_from: goFrom, approval_rules: next.length === rules.length && next.every((r, i) => r === rules[i]) ? approval_rules : next.join('\n') };
}
