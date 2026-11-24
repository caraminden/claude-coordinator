// The one home for median and percentile. Callers that need a number on an empty list pick their own (`?? 0`).

/** The middle value of the list (the mean of the two middle ones when its length is even); null when empty. Takes unsorted input. */
export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b),
    m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** `median`, with NaN for an empty list, for callers that keep plain numbers. */
export const medianOrNaN = (xs: number[]): number => median(xs) ?? NaN;

/** Nearest-rank percentile: the smallest value at least `p` (0 to 1) of the list is at or below; null when empty. Takes unsorted input. */
export function percentile(xs: number[], p: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))];
}
