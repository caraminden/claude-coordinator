#!/usr/bin/env node
// Prints the model table's tiers when citadel:subagents or citadel:briefing loads (#1574: the line left every minion's
// prompt). The server puts model-table.js beside this file in each turn's kit copy (src/turn-launch.ts); in Citadel's
// repo it is public/model-table.js. Never fails: with no table it says where the tiers are.
import { existsSync } from 'node:fs';

const here = new URL('.', import.meta.url);
const table = [new URL('model-table.js', here), new URL('../public/model-table.js', here)].find((u) => existsSync(u));
try {
  if (!table) throw new Error('no model table');
  const { tierSummary } = await import(table.href);
  console.log(`Models by kind of work, from the Taskmaster's model table: ${tierSummary(true)}.`);
} catch {
  console.log("Models by kind of work: the Taskmaster's model table (it couldn't be read here; ask the Taskmaster for the tiers).");
}
