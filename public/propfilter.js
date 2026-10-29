// The minions list's property filter: one dropdown per key, listing the values people can pick.

/**
 * [{ key, values }] for the scheme's active keys, keys with nothing to pick left out. A list key
 * offers its registry values, archived and proposed ones left out (nothing can carry a proposed
 * one); a person, text or number key offers the values its minions carry.
 */
export function filterChoices(keys, tickets) {
  return keys.filter((k) => k.status === 'active').map((k) => ({
    key: k.key,
    values: k.value_kind === 'enum'
      ? k.values.filter((v) => v.status === 'active').map((v) => v.value)
      : [...new Set(tickets.flatMap((t) => [t.properties?.[k.key] ?? []].flat()))]
          .sort((a, b) => (typeof a === 'number' ? a - b : String(a).localeCompare(String(b)))),
  })).filter((c) => c.values.length);
}

/** Whether a minion matches the ticked values: any ticked value of a key, for every key with ticks. */
export function matchesPicks(t, picks) {
  return [...picks].every(([key, set]) => [t.properties?.[key] ?? []].flat().some((v) => set.has(v)));
}

/** For one key, value → how many minions carry it among those the other keys' picks let through. */
export function valueCounts(key, tickets, picks) {
  const others = new Map([...picks].filter(([k]) => k !== key));
  const counts = new Map();
  for (const t of tickets) {
    if (!matchesPicks(t, others)) continue;
    for (const v of new Set([t.properties?.[key] ?? []].flat())) counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  return counts;
}

/**
 * A saved view's picks as a Map of key → Set, for the scheme's keys as they are now: keys no longer
 * active, and archived or proposed values of a list key, drop out quietly.
 */
export function viewPicks(saved, keys) {
  const picks = new Map();
  for (const k of keys) {
    if (k.status !== 'active' || !Object.hasOwn(saved, k.key)) continue;
    const live = k.value_kind === 'enum' ? new Set(k.values.filter((v) => v.status === 'active').map((v) => v.value)) : null;
    const set = new Set(saved[k.key].filter((v) => !live || live.has(v)));
    if (set.size) picks.set(k.key, set);
  }
  return picks;
}

/** Whether two sets of picks tick the same values. */
export function samePicks(a, b) {
  return a.size === b.size && [...a].every(([key, set]) => b.get(key)?.size === set.size && [...set].every((v) => b.get(key).has(v)));
}
