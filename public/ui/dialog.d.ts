// Citadel UI: the dialog. Types for /apps/_citadel/ui/dialog.js. A stable API: names and options are only ever
// added (test/ui-contract.test.ts checks this file against the module's exports).
// Like every file in public/ui/, standalone: apps fetch it from /apps/_citadel/ui/ beside the module.
//
// Markup (base.css draws it): <dialog class="cui-dialog" aria-labelledby="t">
//   <form method="dialog" class="cui-dialog-head"><h2 id="t">Title</h2>
//     <button class="cui-btn cui-ghost cui-icon" aria-label="Close">✕</button></form>
//   …the body, which scrolls under the pinned head…
// </dialog>, opened with showModal().

/**
 * Close any open `dialog.cui-dialog` under `root` (default the document) on a click on its backdrop: a press
 * that starts and ends outside its box. It closes through requestClose() where the browser has it, so a
 * `cancel` listener that calls preventDefault() keeps it open, as with Escape. Call once; again does nothing.
 */
export function mountDialogs(root?: Document | Element): void;
