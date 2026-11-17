// Which of the Overlord's events show in every person's Mine (#920): what's marked for everyone, and its
// cards' answers and results so the cards settle there. src/db.ts MINE_EVENTS is the same rule as a query.

/** Whether an Overlord event (a row with its JSON `data`) shows in Mine. */
export function inMine(event) {
  if (['question_result', 'plan_result', 'approval_result'].includes(event.kind)) return true;
  const data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
  return data?.everyone === true || (event.kind === 'user_message' && (data.answer != null || data.plan != null));
}
