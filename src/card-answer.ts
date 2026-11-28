// What POST /api/tickets/:ticket/answer decides before it acts (#2324): which card an answer is for, whether the card can still be
// answered, and the words the minion reads. No server, so a table test reaches them.
import { HttpError } from './http.ts';
import type { App } from './http.ts';

type Store = Pick<App['store'], 'eventsOfKinds'>;
type Question = { question: string };
type Answer = { selected: string[]; other?: string };

/** The question card a body answers, or the HttpError that says why it can't be: no such card, already answered, settled, or answered on its own page or field. */
export function answerableCard(store: Store, ticketId: number, questionId: unknown) {
  const card = store.eventsOfKinds(ticketId, ['question']).find((e) => JSON.parse(e.data).id === questionId);
  if (!card) throw new HttpError(404, 'No such question');
  // Its answer can only come after it: the chat's earlier messages are never read.
  if (store.eventsOfKinds(ticketId, ['user_message'], card.id).some((e) => JSON.parse(e.data).answer?.questionId === questionId)) {
    throw new HttpError(409, 'That question has already been answered');
  }
  const data = JSON.parse(card.data);
  if (data.settled) throw new HttpError(409, data.settled.dismissed ? `${data.settled.by} dismissed this card` : data.settled.by ? `${data.settled.by} already marked this seen` : 'Claude took this as answered in the chat');
  if (data.doc) throw new HttpError(409, 'This card is answered on its page: open it and press Send there');
  if (data.secret) throw new HttpError(409, 'This card takes a secret: type it into its field and press Save');
  return { card, data };
}

/** The answer as the minion reads it: each question with its pick, and what was typed with or instead of one. */
export function answerText(questions: Question[], answers: Answer[]): string {
  return questions
    .map((q, i) => {
      const { selected, other } = answers[i]!;
      // The text typed with a pick expands on it; typed alone, it is the answer.
      const picked = !selected.length && !other ? '(no option picked; see the attachment)' : selected.length ? `${selected.join('; ')}${other ? `\n  Added: ${other}` : ''}` : `In their own words: ${other}`;
      return `${questions.length > 1 ? `${i + 1}. ` : ''}${q.question}\n→ ${picked}`;
    })
    .join('\n\n');
}
