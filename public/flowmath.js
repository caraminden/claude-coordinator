// The Flow tab's sums (#1989), apart from the page so a test can pin them.

// [key, its name, the shorter one a narrow river has room for]
export const KINDS = [
  ['feature', 'Feature'],
  ['bug', 'Bug fix'],
  ['chore', 'Chore'],
  ['research', 'Research'],
  ['other', 'Design, ideas, other', 'Other'],
];
export const PATHS = [
  ['shipped', 'Shipped, under two refusals', 'Shipped'],
  ['untold', 'On main, refusals not recorded', 'Refusals unknown'],
  ['refused', 'Two or more refused ships', '2+ refusals'],
  ['other', 'On main, no release of its own', 'No release'],
  ['never', 'Never shipped'],
];
export const ENDS = [
  ['live', 'Live'],
  ['main', 'On main, no release recorded', 'On main'],
  ['late', 'Got there after refusals', 'After refusals'],
  ['build', 'In a build that is not on main', 'In a build'],
  ['nothing', 'Closed, nothing on main', 'Not on main'],
  ['why', 'Done, replaced or dropped', 'Said why'],
  ['norepo', 'Closed, no repo to look in', 'No repo'],
  ['answer', 'Answer, report or design', 'Answer'],
  ['open', 'Still open', 'Open'],
];
export const COLS = [
  ['kind', KINDS],
  ['path', PATHS],
  ['end', ENDS],
];
export const value = (ms, unit) => (unit === 'cost' ? ms.reduce((s, m) => s + m.cost, 0) : ms.length);

/** Each column's nodes that hold anything, in their fixed order, with their minions. */
export function nodesOf(minions) {
  return COLS.map(([col, names]) => names.map(([key, name, short = name]) => ({ col, key, name, short, ms: minions.filter((m) => m[col] === key) })).filter((n) => n.ms.length));
}

/**
 * The river laid out along `across` px (its length, kind to ending) and `along` px (the size its nodes share): each node's
 * place and thickness in its column, and each ribbon from one to the next. A node too thin to see keeps `least` px.
 */
export function layout(minions, unit, along, { gap = 14, least = 2 } = {}) {
  const cols = nodesOf(minions);
  const total = value(minions, unit);
  const most = Math.max(1, ...cols.map((c) => c.length));
  const k = total > 0 ? Math.max(0, along - gap * (most - 1) - least * most) / total : 0;
  for (const c of cols) {
    for (const n of c) {
      n.v = value(n.ms, unit);
      n.size = Math.max(least, n.v * k);
    }
    // The column fills the length: what its gaps leave over is shared between them.
    const used = c.reduce((s, n) => s + n.size, 0);
    const space = c.length > 1 ? Math.min(gap * 2.2, (along - used) / (c.length - 1)) : 0;
    let at = 0;
    for (const n of c) {
      n.at = at;
      at += n.size + space;
    }
  }
  const links = [];
  for (const i of [0, 1]) {
    const out = new Map(cols[i].map((n) => [n, 0])),
      into = new Map(cols[i + 1].map((n) => [n, 0]));
    for (const a of cols[i])
      for (const b of cols[i + 1]) {
        const ms = a.ms.filter((m) => m[b.col] === b.key);
        if (!ms.length) continue;
        const v = value(ms, unit);
        // A node that cost nothing shares its width by count.
        const wa = (a.v ? v / a.v : ms.length / a.ms.length) * a.size,
          wb = (b.v ? v / b.v : ms.length / b.ms.length) * b.size;
        links.push({ from: a, to: b, ms, v, a0: a.at + out.get(a), a1: a.at + out.get(a) + wa, b0: b.at + into.get(b), b1: b.at + into.get(b) + wb });
        out.set(a, out.get(a) + wa);
        into.set(b, into.get(b) + wb);
      }
  }
  return { cols, links, total };
}

/** A ribbon's outline: from [a0, a1] at depth d0 to [b0, b1] at depth d1; `down` runs it down the screen. */
export function ribbon({ a0, a1, b0, b1 }, d0, d1, down) {
  const mid = (d0 + d1) / 2;
  const p = (depth, pos) => (down ? `${pos.toFixed(1)} ${depth.toFixed(1)}` : `${depth.toFixed(1)} ${pos.toFixed(1)}`);
  return `M${p(d0, a0)} C${p(mid, a0)} ${p(mid, b0)} ${p(d1, b0)} L${p(d1, b1)} C${p(mid, b1)} ${p(mid, a1)} ${p(d0, a1)} Z`;
}

/** The table's rows: every kind, path and ending that holds anything, biggest first. */
export function rows(minions, unit) {
  const by = new Map();
  for (const m of minions) {
    const key = `${m.kind}/${m.path}/${m.end}`;
    if (!by.has(key)) by.set(key, { kind: m.kind, path: m.path, end: m.end, ms: [] });
    by.get(key).ms.push(m);
  }
  return [...by.values()].map((r) => ({ ...r, n: r.ms.length, cost: value(r.ms, 'cost') })).sort((a, b) => value(b.ms, unit) - value(a.ms, unit) || b.n - a.n);
}

/** "$1,204", "$11", "$0.40": costs are estimates at API prices, said once on the page. */
export const money = (usd) => `$${usd >= 10 ? Math.round(usd).toLocaleString('en-US') : usd.toFixed(2)}`;

/** A Pacific day `back` days before `today` ('2026-11-25'). */
export const dayBefore = (today, back) => new Date(Date.parse(`${today}T12:00:00Z`) - back * 86_400_000).toISOString().slice(0, 10);
