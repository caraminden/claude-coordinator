// Citadel UI: optimistic actions. Served to apps as /apps/_citadel/ui/optimistic.js (types: optimistic.d.ts
// beside it). Docs: kit/skills/contraption-ui/SKILL.md (rule 15) and references/status.md. Cara 2026-11-08:
// "assume things will work instantly, but recover later if there was an issue".
//
// Every file in public/ui/ is standalone, because apps load it from outside Citadel's pages:
// - no imports from outside ui/; nothing it writes carries style="" or <style>;
// - its exports and their behaviour are an API apps depend on: test/ui-contract.test.ts holds them.
//   Add, never rename; a real break ships as a new file beside this one.
//
// What it does: optimistic() shows a click's result at once (apply) and sends the request behind it (send).
// Nothing waits on it: every click counts and every control stays usable. Actions sharing a `key` send one
// after another, in click order (accept then reject on one item reaches the server in that order); others
// send at once, side by side. When a send fails, that action alone is rolled back (undo) and a toast says
// what failed and why, with a Retry that runs apply and send again. Failures that land while that toast is up
// join it, so its one Retry covers them all (ten quick rejects with the server down: one toast, one Retry).
// The promise it returns settles once per action, Retries included: with the first send that goes through,
// or with the last error once its failure toast goes without a Retry.

import { toast } from './status.js';

const tails = new Map(); // key → a promise that settles when the key's last queued send does
let failed = null; // the attempts the showing failure toast's Retry would run again

/** Call send() now, as a promise even if it throws or returns a plain value. */
function start(send) {
  try {
    return Promise.resolve(send());
  } catch (err) {
    return Promise.reject(err);
  }
}

function queue(key, send) {
  if (key == null) return start(send);
  const prev = tails.get(key);
  // Only the first of a key starts in this tick; the rest wait for the one before to settle, failed or not.
  const sent = prev ? prev.then(() => start(send)) : start(send);
  const tail = sent.then(() => {}, () => {});
  tails.set(key, tail);
  tail.then(() => tails.get(key) === tail && tails.delete(key));
  return sent;
}

const reason = (err) => (err instanceof Error ? err.message : err == null ? '' : String(err));

function fail(attempt) {
  const all = failed ? [...failed, attempt] : [attempt];
  failed = all;
  const why = reason(all[0].err);
  const text = `Couldn't ${all[0].action.label ?? 'do that'}${why ? `: ${why}` : ''}${all.length > 1 ? ` (and ${all.length - 1} more)` : ''}`;
  let retried = false;
  toast(text, {
    tone: 'danger',
    ms: 8000,
    action: {
      label: 'Retry',
      run: () => {
        retried = true;
        // One apply() throwing (its item gone in a redraw) settles that one and still retries the rest.
        for (const a of all) {
          try {
            run(a.action, a.settle);
          } catch (err) {
            a.settle.no(err);
          }
        }
      },
    },
    onHide: () => {
      if (failed === all) failed = null;
      // Gone without a Retry, and not carried into a newer failure toast: these failures are final.
      if (!retried) for (const a of all) if (!failed?.includes(a)) a.settle.no(a.err);
    },
  });
}

function run(action, settle) {
  action.apply?.();
  queue(action.key, action.send).then(settle.ok, (err) => {
    try {
      action.undo?.(err);
    } finally {
      fail({ action, settle, err });
    }
  });
}

/**
 * Show an action's result now and send it behind: apply() at once, then send(); if send fails, undo() and a
 * toast "Couldn't <label>: <error>" with a Retry. Returns a promise of send's value that settles once, Retries
 * included (its rejection is handled here, so an unchained call never logs an unhandled rejection).
 */
export function optimistic(action) {
  let settle;
  const result = new Promise((ok, no) => (settle = { ok, no }));
  result.catch(() => {});
  run(action, settle);
  return result;
}
