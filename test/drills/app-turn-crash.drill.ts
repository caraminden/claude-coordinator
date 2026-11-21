// Drill 8 (#1326): an app's turn (POST /api/contraptions/turns) running when the server is SIGKILLed. App turns are the
// server's own children, not detached turns it can take back (C6): the turn dies with the server. This pins what is
// left: its claude ends once it has nowhere to write, the session takes a new turn, and the cut-off turn's row.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { procsUnder, until } from '../helpers.ts';
import { Drill, gap } from './harness.ts';

const d = new Drill('app-turn-crash');
after(() => d.cleanup());
let key = '';
let me = 0;
const turn = (base: string, prompt: string) =>
  fetch(`${base}/api/contraptions/turns`, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ person: me, session: 'drill', prompt }) });
// The app turn's claude: the fake, run by the server with no turn folder, so found by its own path.
const claudes = () => [...procsUnder([d.fake.fake]).keys()];

before(async () => {
  const srv = await d.boot();
  const made = await srv.call('/api/contraptions', { name: 'drillapp', title: 'Drill app', port: 9191 });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  key = readFileSync(join(made.data.keys_dir, 'contraption.key'), 'utf8');
  me = (await srv.call('/api/me')).data.id;
  assert.equal((await srv.call(`/api/contraptions/drillapp/people/${me}`, { enabled: true }, 'PUT')).status, 200);
  const res = await turn(srv.base, 'hello');
  assert.equal(res.status, 200, await (res.ok ? '' : res.text()));
  const reader = res.body!.getReader();
  let seen = '';
  while (!seen.includes('event: start')) {
    const { done, value } = await reader.read();
    if (done) assert.fail(`the app turn's stream ended before it started: ${seen}`);
    seen += new TextDecoder().decode(value);
  }
  await until("the app turn's claude running", () => claudes().length > 0);
  await d.crash();
  reader.cancel().catch(() => {});
  await d.boot();
});

test("after a crash, the app's session takes a new turn, and the cut-off turn's claude ends", async () => {
  d.fake.setRelease('ok');
  const res = await turn(d.srv!.base, 'again');
  const events = (await res.text()).trim().split('\n\n').map((b) => b.split('\n')[0].replace('event: ', ''));
  assert.ok(events.includes('end'), `the new turn ran: ${events.join(', ')}`);
  // The orphan writes its reply to a pipe nobody reads, and dies of it.
  await until('no app claude left', () => claudes().length === 0, 20_000);
});

// C6: nothing closes an app turn's row the crash cut off: it stays open (no end, no outcome) for good.
test("the cut-off app turn's row is closed", gap('C6'), () => {
  const open = d.rows("SELECT id FROM contraption_turns WHERE ended_at IS NULL OR outcome IS NULL");
  assert.equal(open.length, 0, `C6: ${open.length} app turn row(s) left open after the crash`);
});
