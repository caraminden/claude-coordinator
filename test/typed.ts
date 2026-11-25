// Types for tests (#1817): an API answer's shape, a fake with only the fields a test needs, and the shapes many tests read.
// No runtime imports, so a small unit test can take these without the server's plumbing in helpers.ts.
import type { EventRow, Ticket } from '../src/db.ts';

/** A response's JSON body as the shape the test reads: the one place an untyped body becomes a type. */
export async function json<T>(res: { json(): Promise<unknown> }): Promise<T> {
  return (await res.json()) as T;
}

/** A stand-in holding only the fields of `T` the code under test reads; each one given is still checked against `T`. */
export function fake<T>(parts: Partial<T>): T {
  return parts as T;
}

/** An API call's answer. */
export type Reply<T> = { status: number; data: T };
/** A refused call's body. */
export type Refused = { error: string };
/** A minion as the API answers with it: the stored row, with the fields the views parse or add. */
export type ApiTicket = Omit<Ticket, 'replies' | 'properties'> & { replies: string[]; properties: Record<string, unknown>; notes?: string[] };
/** A stored event: its `data` is a JSON string. */
export type ApiEvent = Pick<EventRow, 'id' | 'kind' | 'data' | 'created_at'>;
