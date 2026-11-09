// What standing instructions cost (#415): every API call of every minion re-reads them. About 14,600
// main-session calls per 44 hours at $0.20 per million cached tokens is about $11 a week per 1k tokens
// (#403's usage review, 2026-11-08). public/prompt-cost.js is the settings page's copy: mcp.ts runs from
// a pinned copy that only follows './' imports. test/prompt-budget.test.ts keeps the two the same.

/** "These instructions are about 2.9k tokens; …", or '' for empty text. Tokens guessed at 4 characters each. */
export function instructionCost(text: string): string {
  const tokens = Math.round(text.trim().length / 4);
  if (!tokens) return '';
  return `These instructions are about ${tokens < 1000 ? tokens : `${(tokens / 1000).toFixed(1)}k`} tokens; each 1k costs about $11 a week across minions.`;
}
