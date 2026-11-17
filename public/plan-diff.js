// What a revised plan changed against the plan it replaces (#907): a line diff, grouped into runs.

/** Line diff of two texts: [{ op: ' ' | '+' | '-', text }], blank lines ignored (they only space paragraphs). */
export function diffLines(oldText, newText) {
  const a = lines(oldText), b = lines(newText);
  const n = a.length, m = b.length;
  const lcs = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const out = [];
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) { out.push({ op: ' ', text: a[i] }); i++; j++; }
    else if (i < n && (j === m || lcs[i + 1][j] >= lcs[i][j + 1])) out.push({ op: '-', text: a[i++] });
    else out.push({ op: '+', text: b[j++] });
  }
  return out;
}

const lines = (t) => String(t ?? '').split('\n').map((l) => l.replace(/\s+$/, '')).filter((l) => l.trim());

/**
 * The diff plus its counts. In each run of changes, as many removed lines as added ones pair up as "changed";
 * the rest are plain additions or removals. `summary` is true when the title line differs.
 */
export function planChanges(oldPlan, newPlan, oldSummary = '', newSummary = '') {
  const ops = diffLines(oldPlan, newPlan);
  let changed = 0, added = 0, removed = 0;
  for (let k = 0; k < ops.length;) {
    if (ops[k].op === ' ') { k++; continue; }
    let plus = 0, minus = 0;
    while (k < ops.length && ops[k].op !== ' ') { if (ops[k].op === '+') plus++; else minus++; k++; }
    const pair = Math.min(plus, minus);
    changed += pair; added += plus - pair; removed += minus - pair;
  }
  return { ops, changed, added, removed, summaryChanged: oldSummary !== newSummary };
}

/** "3 lines changed, 1 added, 2 removed, summary changed", or "No changes to the text". */
export function changesLine(c) {
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const parts = [];
  if (c.changed) parts.push(`${plural(c.changed, 'line')} changed`);
  if (c.added) parts.push(`${c.added} added`);
  if (c.removed) parts.push(`${c.removed} removed`);
  if (c.summaryChanged) parts.push('summary changed');
  return parts.length ? parts.join(', ') : 'No changes to the text';
}

/** The ops as runs: changed lines stay, a stretch of more than `keep` unchanged lines becomes { gap: [lines] } with `keep` shown either side. */
export function collapseRuns(ops, keep = 1) {
  const out = [];
  for (let k = 0; k < ops.length;) {
    if (ops[k].op !== ' ') { out.push(ops[k++]); continue; }
    let e = k;
    while (e < ops.length && ops[e].op === ' ') e++;
    const run = ops.slice(k, e);
    const head = k === 0 ? 0 : keep, tail = e === ops.length ? 0 : keep;
    if (run.length > head + tail + 1) out.push(...run.slice(0, head), { gap: run.slice(head, run.length - tail) }, ...run.slice(run.length - tail));
    else out.push(...run);
    k = e;
  }
  return out;
}
