// The settings page's copy of src/prompt-cost.ts (what standing instructions cost, #415); keep the two the same.

/** "These instructions are about 2.9k tokens; …", or '' for empty text. Tokens guessed at 4 characters each. */
export function instructionCost(text) {
  const tokens = Math.round(text.trim().length / 4);
  if (!tokens) return '';
  return `These instructions are about ${tokens < 1000 ? tokens : `${(tokens / 1000).toFixed(1)}k`} tokens; each 1k costs about $27 a week across minions.`;
}
