// Drill 6 (#1326): SIGKILL with writes queued behind a slow disk (CITADEL_DB_WRITE_DELAY_MS, each write held 1 s on the
// worker). Pins are written on the worker (WRITES in src/db-writer.ts), and since #1244 an answer waits for its own
// request's writes, so a pin the server said yes to survives; one still queued unanswered may not, and nobody was told
// it was saved. (A scheme's creation is a value write that runs inline: it would pass with no queue at all.)
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { Drill } from './harness.ts';

const d = new Drill('slow-disk');
after(() => d.cleanup());

test('writes the server acknowledged survive a SIGKILL with more queued behind a slow disk (C1)', async () => {
  await d.boot();
  const p = await d.project();
  await d.srv!.stop({ keepTurns: true });
  d.srv = null;
  const [a, b, c, x, y] = d.tickets(p.id, 5);
  const srv = await d.boot({ CITADEL_DB_WRITE_DELAY_MS: '1000' });
  const pin = (id: number) => srv.call(`/api/tickets/${id}/pin`, { pinned: true }, 'PUT');
  const acked = [a, b, c];
  for (const id of acked) assert.equal((await pin(id)).status, 200);
  // Two more behind them, never answered: each waits its second on the worker when the kill lands.
  const pending = [x, y].map((id) => pin(id).catch(() => null));
  await new Promise((r) => setTimeout(r, 300));
  await d.crash();
  await Promise.all(pending);
  await d.boot();
  const saved = d.rows<{ ticket_id: number }>('SELECT ticket_id FROM ticket_pins').map((r) => r.ticket_id);
  for (const id of acked) assert.ok(saved.includes(id), `C1: the pin on #${id} was acknowledged, then lost to the kill (saved: ${saved.join(', ')})`);
  console.log(`# slow disk: of 2 unanswered pins, ${saved.filter((id) => id === x || id === y).length} were saved`);
});
