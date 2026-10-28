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
