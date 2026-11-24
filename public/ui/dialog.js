// Citadel UI: the dialog. Served to apps as /apps/_citadel/ui/dialog.js (types: dialog.d.ts beside it); its
// look is base.css's cui-dialog. Docs: kit/skills/contraption-ui/references/base-parts.md. Cara, 2026-11-08
// (in Peek Auras): "the X to close should stay at the top and clicking off the modal should close it".
//
// Every file in public/ui/ is standalone, because apps load it from outside Citadel's pages: no imports
// from outside ui/, nothing it writes carries style="" or <style>, and its exports are an API apps depend
// on (test/ui-contract.test.ts). Add, never rename.
//
// What it does: the CSS pins the header and scrolls the rest; this closes a <dialog class="cui-dialog">
// opened with showModal() when a click lands on its backdrop. Only a press that starts and ends outside the
// box counts, so selecting text inside and letting go on the backdrop keeps it open. It closes the way
// Escape does (requestClose(), where the browser has it), so a `cancel` listener can keep it open.
// openDialog() builds that markup, opens it and takes it out of the page once closed, so a page that makes a
// dialog per use writes only its body (#872, Cara 2026-11-17: "using reusable components").

const mounted = new WeakSet();

/** Whether a pointer event is outside the dialog's box (on its backdrop). */
function outside(dialog, e) {
  const r = dialog.getBoundingClientRect();
  return e.clientX < r.left || e.clientX >= r.right || e.clientY < r.top || e.clientY >= r.bottom;
}

/** Close any open .cui-dialog under `root` on a click on its backdrop. Call once; calling again does nothing. */
export function mountDialogs(root = document) {
  if (mounted.has(root)) return;
  mounted.add(root);
  let pressed = null; // the dialog whose backdrop the press started on
  root.addEventListener(
    'pointerdown',
    (e) => {
      const d = e.target;
      pressed = d instanceof HTMLDialogElement && d.matches('.cui-dialog[open]') && outside(d, e) ? d : null;
    },
    true,
  );
  root.addEventListener('click', (e) => {
    const d = pressed;
    pressed = null;
    if (!d || e.target !== d || !d.open || !outside(d, e)) return;
    if (typeof d.requestClose === 'function') d.requestClose();
    else d.close();
  });
}

let ids = 0;

/**
 * Build a .cui-dialog, open it with showModal() and return it: the head (an h2 of `title`, which names it, and
 * the ✕), then `body`. `className` adds classes (a width, a sheet); it leaves the page once closed unless
 * `keep`; `onClose` runs on close. Backdrop clicks close it (it mounts mountDialogs on the document).
 */
export function openDialog({ title, body = [], className = '', keep = false, onClose } = {}) {
  mountDialogs();
  const h2 = document.createElement('h2');
  h2.id = `cui-dialog-${++ids}-${Math.random().toString(36).slice(2, 7)}`;
  h2.textContent = title ?? '';
  const x = document.createElement('button');
  x.className = 'cui-btn cui-ghost cui-icon';
  x.setAttribute('aria-label', 'Close');
  x.textContent = '✕';
  const head = document.createElement('form');
  head.method = 'dialog';
  head.className = 'cui-dialog-head';
  head.append(h2, x);
  const dialog = document.createElement('dialog');
  dialog.className = `cui-dialog ${className}`.trim();
  dialog.setAttribute('aria-labelledby', h2.id);
  dialog.append(head, ...[body].flat().filter((n) => n != null && n !== false));
  dialog.addEventListener('close', () => {
    if (!keep) dialog.remove();
    onClose?.();
  });
  document.body.append(dialog);
  dialog.showModal();
  return dialog;
}
