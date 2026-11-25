// The Flow tab's slow reads (#1989), for src/work-flow.ts, which runs this at low priority: what some minions' chats say,
// and which minions main's commits name. A FlowAsk as JSON on stdin, a FlowAnswer on stdout. Read-only.
import { text } from 'node:stream/consumers';
import { DatabaseSync } from 'node:sqlite';
import { attachEventsIfThere } from '../src/events-db.ts';
import { gitOut } from '../src/git.ts';
import { chatFacts, namedBy, type FlowAnswer, type FlowAsk } from '../src/work-flow.ts';

/** The minions named by commits made since `since` on the repo's main branch, here or on origin; null when it has none or git failed. */
export async function named(repo: string, since: number): Promise<number[] | null> {
  const env = { GIT_OPTIONAL_LOCKS: '0' };
  const refs = await gitOut(['for-each-ref', '--format=%(refname)', 'refs/heads/main', 'refs/heads/master', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main', 'refs/remotes/origin/master'], repo, { env });
  if (!refs) return null;
  const log = await gitOut(['log', `--since=${Math.floor(since / 1000)}`, '--no-merges', '--format=%cn%x09%s', ...refs.split('\n'), '--'], repo, { env, timeout: 60_000, maxBuffer: 64 * 1024 * 1024 });
  return log === null ? null : namedBy(log);
}

if (import.meta.main) {
  try {
    const ask = JSON.parse(await text(process.stdin)) as FlowAsk;
    const answer: FlowAnswer = { facts: [], named: null };
    if (ask.ids.length) {
      const db = new DatabaseSync(ask.db, { readOnly: true });
      db.exec('PRAGMA busy_timeout = 5000');
      attachEventsIfThere(db, ask.db);
      answer.facts = chatFacts(db, ask.ids);
      db.close();
    }
    if (ask.repo) answer.named = await named(ask.repo, ask.since);
    console.log(JSON.stringify(answer));
  } catch (err) {
    console.error((err as Error).message.split('\n')[0]);
    process.exitCode = 1;
  }
}
