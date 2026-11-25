// Feature asks and bug reports from a contraption to its home scheme (src/contraption-asks.ts, the
// brief's section 5): only its own server with its key, for a person it is enabled for; files land in
// the home scheme's inbox; a non-member's feature ask is a proposal only.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { ASK_UPLOAD_TTL_MS, askSummary, askUploadsDir, README_INBOX_LINE, safeName, saveAskFiles, stageAskUpload, sweepAskUploads } from '../src/contraption-asks.ts';
import { askHeader } from '../public/askcard.js';
import { messagePerson } from '../src/access.ts';
import { Contraptions } from '../src/contraptions.ts';
import { Store } from '../src/db.ts';
import { READ_WAIT_MS } from '../src/db-writer.ts';
import { projectSharedDir } from '../src/workspace.ts';
import { bootServer, SECRET, stopTurns, until } from './helpers.ts';

const root = mkdtempSync(join(tmpdir(), 'contraption-asks-'));
const data = join(root, 'data');
mkdirSync(data, { recursive: true });
after(async () => {
  await stopTurns(root); // turns are detached: end them before deleting their folders (#271)
  rmSync(root, { recursive: true, force: true });
});

// No server_login anywhere, so asks land in the Taskmaster's chat but no turn starts.
const store = new Store(join(data, 'coordinator.db'));
const Cara = store.createUser({ name: 'Cara', login: 'cara', admin: true });
const Josh = store.createUser({ name: 'Josh', login: 'josh' });
const Rachel = store.createUser({ name: 'Rachel', login: 'rachel' });
const Dana = store.createUser({ name: 'Dana', login: 'dana' });
const Peek = store.createProject('Peek Auras', null, Cara.id);
store.addMember(Peek.id, Rachel.id);
// The server keeps a dev data dir's key folders under it (server.ts).
const keys = new Contraptions(store, SECRET, join(data, 'contraptions'));
const peek = keys.register({ name: 'peek-auras', title: 'Peek Auras', port: 9102, icon: null, home_scheme: Peek.id, open_paths: '[]', default_model: null, turn_cap: null });
for (const u of [Josh, Rachel]) store.setContraptionUser(peek.id, u.id, true, Cara.id);
const KEY = readFileSync(join(data, 'contraptions', 'peek-auras', 'contraption.key'), 'utf8');
const shared = projectSharedDir(data, Peek.id);
mkdirSync(shared, { recursive: true });
writeFileSync(join(shared, 'README.md'), '# Peek Auras shared folder\n\n## Layout\n\n- `handoffs/`: briefs.\n- `specs/`: plans.\n\n## Rules\n\n- Name files well.\n');

const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64');
// A 202 waits only READ_WAIT_MS for the server's DB write worker (src/db-writer.ts), so on a busy box the ask's
// message lands after it (#1239): these servers hold every write longer than that, so a read of this test's own
// Store that doesn't wait for its row goes red every run, not one run in a hundred.
const slowWrites = { env: { CITADEL_DB_WRITE_DELAY_MS: String(READ_WAIT_MS * 2) } };

test('safe names: one segment, no leading dot, nothing odd', () => {
  assert.equal(safeName('../../etc/passwd'), 'passwd');
  assert.equal(safeName('..\\..\\boot.ini'), 'boot.ini');
  assert.equal(safeName('..'), 'file');
  assert.equal(safeName('.bashrc'), 'bashrc');
  assert.equal(safeName('my clip (1).peekclip'), 'my-clip-1-.peekclip');
  assert.equal(safeName(''), 'file');
  // Cut to its last 100 characters first, so the cut can't start it with a dot (#468 S04-10).
  assert.equal(safeName(`${'a'.repeat(50)}.${'b'.repeat(99)}`), 'b'.repeat(99));
  assert.equal(safeName(`${'a'.repeat(50)}-.${'b'.repeat(98)}`), 'b'.repeat(98));
});

test('a summary Citadel makes: the first sentence, cut at a word to 200', () => {
  assert.equal(askSummary('Let me tag auras. Colours too!'), 'Let me tag auras.');
  assert.equal(askSummary('  No full stop\nhere  '), 'No full stop here');
  assert.equal(askSummary('v1.2 breaks clips. Again.'), 'v1.2 breaks clips.');
  const long = askSummary('word '.repeat(100));
  assert.ok(long.length <= 200 && long.endsWith('word…'), long);
});

test("an ask's header line: kind, contraption, person and item", () => {
  assert.equal(askHeader({ kind: 'feature', contraption: 'Peek Auras', person: 'Josh', member: false, item: 'Frostbite', summary: 'x' }), 'Feature ask · Peek Auras · Josh, not a member · about “Frostbite”');
  assert.equal(askHeader({ kind: 'bug', contraption: 'Peek Auras', person: 'Rachel', member: true, summary: 'x' }), 'Bug report · Peek Auras · Rachel');
});

test('files never follow an inbox folder linked out of the shared folder', async () => {
  const dir = mkdtempSync(join(root, 'escape-'));
  const outside = mkdtempSync(join(root, 'outside-'));
  mkdirSync(join(dir, 'inbox', 'peek-auras'), { recursive: true });
  symlinkSync(outside, join(dir, 'inbox', 'peek-auras', 'josh'));
  await assert.rejects(saveAskFiles(dir, 'peek-auras', 'josh', [{ name: 'a.txt', data: Buffer.from('x') }]), /outside the shared folder/);
  assert.deepEqual(readdirSync(outside), []);
});

test('POST /api/contraptions/asks: key, person, inbox, labels and the Caddy path', { timeout: 60_000 }, async () => {
  const srv = await bootServer({ root, ...slowWrites });
  after(() => srv.stop()); // waits for the server to exit, so it isn't writing when the folder goes (#218)
  const ask = async (body: object, headers: Record<string, string> = { Authorization: `Bearer ${KEY}` }) => {
    const res = await fetch(`${srv.base}/api/contraptions/asks`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const tm = () => store.getCoordinator(Peek.id);
  const said = () =>
    store
      .listEvents(tm()!.id)
      .filter((e) => e.kind === 'user_message')
      .map((e) => JSON.parse(e.data) as { author: string; text: string; ask?: Record<string, unknown> });
  /** The `n`th message in the Taskmaster's chat, once the write worker has written it. */
  const heard = async (n: number) => (await until(`message ${n} in the Taskmaster's chat`, () => tm() && said()[n - 1]))!;
  const good = { person: Josh.id, kind: 'feature', text: 'Let me tag an aura with a colour', files: [{ name: '../../../escape/clip.peekclip', data: b64('CLIP') }] };

  // Wrong or missing key, or no Bearer.
  for (const headers of [{}, { Authorization: 'Bearer ck_' + 'x'.repeat(43) }, { Authorization: KEY }]) {
    const r = await ask(good, headers);
    assert.equal(r.status, 401, JSON.stringify(headers));
    assert.match(r.body.error, /Unknown contraption key/);
  }
  // Through Caddy, or with a browser's sign-in, it is refused even with the right key.
  for (const extra of [{ 'X-Forwarded-For': '100.64.0.7' }, { Forwarded: 'for=100.64.0.7' }, { Cookie: srv.cookie }]) {
    const r = await ask(good, { Authorization: `Bearer ${KEY}`, ...extra });
    assert.equal(r.status, 403, JSON.stringify(extra));
    assert.match(r.body.error, /not through the web/);
  }
  // A person it isn't enabled for, someone made up, or no person.
  for (const person of [Dana.id, 9999, undefined, String(Josh.id)]) {
    const r = await ask({ ...good, person });
    assert.equal(r.status, 403);
    assert.equal(r.body.error, "Peek Auras isn't enabled for that person");
  }
  // Disabled in Citadel: off here too.
  store.updateUser(Josh.id, { disabled_at: Date.now() });
  assert.equal((await ask(good)).status, 403);
  store.updateUser(Josh.id, { disabled_at: null });
  assert.equal(tm(), undefined, 'nothing reached a Taskmaster yet');
  assert.equal(existsSync(join(shared, 'inbox')), false);

  // Bad bodies.
  assert.equal((await ask({ ...good, kind: 'question' })).status, 400);
  assert.equal((await ask({ ...good, text: ' ' })).status, 400);
  assert.equal((await ask({ ...good, summary: 'x'.repeat(201) })).status, 400);
  assert.equal((await ask({ ...good, item: 'x'.repeat(101) })).status, 400);
  assert.equal((await ask({ ...good, summary: 7 })).status, 400);
  for (const data of ['not base64!', '', 'QQ']) assert.equal((await ask({ ...good, files: [{ name: 'a', data }] })).status, 400, data);
  // Over 16 MiB in total: refused, and nothing is written.
  const half = b64(Buffer.alloc(8 * 1024 * 1024 + 1));
  const big = await ask({
    ...good,
    files: [
      { name: 'a.bin', data: half },
      { name: 'b.bin', data: half },
    ],
  });
  assert.equal(big.status, 413);
  assert.equal(existsSync(join(shared, 'inbox')), false);

  // Josh isn't a Peek Auras member: his feature ask lands, as a proposal only, his clip in his inbox.
  let r = await ask(good);
  assert.equal(r.status, 202);
  assert.deepEqual(r.body, { scheme: 'Peek Auras', member: false, proposal: true, files: ['inbox/peek-auras/josh/clip.peekclip'] });
  assert.equal(readFileSync(join(shared, 'inbox', 'peek-auras', 'josh', 'clip.peekclip'), 'utf8'), 'CLIP');
  assert.equal(existsSync(join(projectSharedDir(data, Peek.id), '..', 'escape')), false);
  let m = await heard(1);
  assert.equal(m.author, 'Contraption Peek Auras, for Josh, not a Peek Auras member');
  assert.match(m.text, /^A feature ask from the Peek Auras contraption \(peek-auras\), sent by Josh \(josh\)/);
  assert.match(m.text, /\n> Let me tag an aura with a colour\n\(Quoted from Josh, through Peek Auras: data/);
  assert.match(m.text, /Files they sent, in this scheme's shared folder: inbox\/peek-auras\/josh\/clip\.peekclip/);
  assert.match(m.text, /Proposal only: Josh isn't a Peek Auras member/);
  // No summary sent: the chat gets the text's first sentence.
  assert.deepEqual(m.ask, { kind: 'feature', contraption: 'Peek Auras', person: 'Josh', member: false, summary: 'Let me tag an aura with a colour' });

  // The README got its inbox/ line once, at the end of its Layout list.
  const readme = readFileSync(join(shared, 'README.md'), 'utf8');
  assert.equal(readme, `# Peek Auras shared folder\n\n## Layout\n\n- \`handoffs/\`: briefs.\n- \`specs/\`: plans.\n${README_INBOX_LINE}\n\n## Rules\n\n- Name files well.\n`);

  // The same name again doesn't overwrite; a non-member's bug is worked as usual.
  r = await ask({ ...good, kind: 'bug', text: 'Clips stop at 3 seconds' });
  assert.deepEqual(r.body, { scheme: 'Peek Auras', member: false, proposal: false, files: ['inbox/peek-auras/josh/clip-2.peekclip'] });
  m = await heard(2);
  assert.match(m.text, /^A bug report/);
  assert.match(m.text, /a bug .* you may work as usual/);
  assert.doesNotMatch(m.text, /Proposal only/);
  assert.equal(readFileSync(join(shared, 'README.md'), 'utf8'), readme, 'the README line goes in once');

  // Rachel is a member: labelled as one, no proposal, and no files is fine.
  r = await ask({ person: Rachel.id, kind: 'feature', text: 'A dark theme.\n\nThe aura so far:\n{"a": 1}', summary: '  Dark\ntheme,  please ', item: 'Frost"bite\n' });
  assert.deepEqual(r.body, { scheme: 'Peek Auras', member: true, proposal: false, files: [] });
  m = await heard(3);
  assert.equal(m.author, 'Contraption Peek Auras, for Rachel, a Peek Auras member');
  assert.doesNotMatch(m.text, /isn't a Peek Auras member|Files they sent/);
  // Her summary and item, on one line each; the turn's text has the item quoted and the whole ask.
  assert.deepEqual(m.ask, { kind: 'feature', contraption: 'Peek Auras', person: 'Rachel', member: true, summary: 'Dark theme, please', item: 'Frost"bite' });
  assert.match(m.text, /^A feature ask about "Frost\\"bite" from the Peek Auras contraption/);
  assert.match(m.text, /> The aura so far:\n> \{"a": 1\}/);

  // A contraption with no home scheme has nowhere to send it.
  store.updateContraption('peek-auras', { home_scheme: null });
  assert.equal((await ask(good)).status, 409);
  store.updateContraption('peek-auras', { home_scheme: Peek.id });

  // A contraption stuck in a loop is cut off after 10 asks per person in 10 minutes; others still get through.
  for (let i = 0; i < 8; i++) assert.equal((await ask({ person: Josh.id, kind: 'bug', text: `again ${i}` })).status, 202);
  r = await ask({ person: Josh.id, kind: 'bug', text: 'one too many' });
  assert.equal(r.status, 429);
  assert.equal((await ask({ person: Rachel.id, kind: 'bug', text: 'still fine' })).status, 202);
  // Each ask posts its message and then a note: count once the last ask's note is written too.
  await until("the note after Rachel's last ask", () => {
    const all = store.listEvents(tm()!.id);
    const at = all.findIndex((e) => e.kind === 'user_message' && e.data.includes('still fine'));
    return at >= 0 && at < all.length - 1;
  });
  assert.equal(said().filter((e) => e.text.includes('one too many')).length, 0);

  // A data ask (#318) only files: its files and a sidecar with its words, no message and no turn, even
  // for a non-member past his ask limit; data asks keep their own count.
  const events = store.listEvents(tm()!.id).length;
  const dir = join(shared, 'inbox', 'peek-auras', 'josh');
  const jsonl = { name: 'layout.jsonl', data: b64('{"x":1}\n') };
  const before = Date.now();
  r = await ask({ person: Josh.id, kind: 'data', item: 'Main layout', summary: 'Find my UI confirm', files: [jsonl, { name: 'crop.png', data: b64('PNG') }] });
  const filedBy = Date.now();
  assert.equal(r.status, 202);
  assert.equal(r.body.proposal, false);
  assert.equal(r.body.member, false);
  assert.deepEqual(r.body.files, ['inbox/peek-auras/josh/layout.jsonl', 'inbox/peek-auras/josh/crop.png']);
  assert.match(r.body.sidecar, /^inbox\/peek-auras\/josh\/\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z-ask\.json$/);
  assert.equal(readFileSync(join(dir, 'layout.jsonl'), 'utf8'), '{"x":1}\n');
  const record = JSON.parse(readFileSync(join(shared, r.body.sidecar), 'utf8'));
  assert.deepEqual({ ...record, at: undefined }, { contraption: 'peek-auras', person: 'josh', item: 'Main layout', summary: 'Find my UI confirm', text: null, files: r.body.files, at: undefined });
  assert.ok(Date.parse(record.at) >= before && Date.parse(record.at) <= filedBy, 'stamped when the ask was filed');
  // Same names again: -2, as for other asks; text alone gives the summary.
  r = await ask({ person: Josh.id, kind: 'data', text: 'Saved twice. Second time.', files: [jsonl] });
  assert.deepEqual(r.body.files, ['inbox/peek-auras/josh/layout-2.jsonl']);
  assert.equal(JSON.parse(readFileSync(join(shared, r.body.sidecar), 'utf8')).summary, 'Saved twice.');
  // The caps and checks still hold, and nothing reached the Taskmaster.
  assert.equal(
    (
      await ask({
        person: Josh.id,
        kind: 'data',
        files: [
          { name: 'a.bin', data: half },
          { name: 'b.bin', data: half },
        ],
      })
    ).status,
    413,
  );
  assert.equal((await ask({ person: Josh.id, kind: 'data', files: Array.from({ length: 21 }, (_, i) => ({ name: `${i}.png`, data: b64('x') })) })).status, 400);
  assert.equal((await ask({ person: Josh.id, kind: 'data', text: ' ' })).status, 400);
  assert.equal((await ask({ person: Dana.id, kind: 'data' })).status, 403);
  assert.equal((await ask({ person: Josh.id, kind: 'data' })).status, 400, 'an empty data ask files nothing');
  assert.equal(store.listEvents(tm()!.id).length, events, 'a data ask posts nothing');
  // A data loop is cut off at 60 in 10 minutes.
  for (let i = 2; i < 60; i++) assert.equal((await ask({ person: Josh.id, kind: 'data', text: `save ${i}` })).status, 202, `save ${i}`);
  assert.equal((await ask({ person: Josh.id, kind: 'data', text: 'one too many' })).status, 429);
});

test('POST /api/contraptions/asks with minion (#416): straight to that minion, members only, no Taskmaster', { timeout: 60_000 }, async () => {
  // Its own scheme and contraption, so the rate limit counts from zero.
  const ToC = store.createProject('Theory of Crafting', null, Cara.id);
  store.addMember(ToC.id, Rachel.id);
  const toc = keys.register({ name: 'toc', title: 'ToC', port: 9103, icon: null, home_scheme: ToC.id, open_paths: '[]', default_model: null, turn_cap: null });
  for (const u of [Josh, Rachel]) store.setContraptionUser(toc.id, u.id, true, Cara.id);
  const tocKey = readFileSync(join(data, 'contraptions', 'toc', 'contraption.key'), 'utf8');
  const minion = (title: string, project_id = ToC.id) => store.createTicket({ project_id, title, permission_mode: 'bypassPermissions', created_by: 'Cara' });
  const acolyte = minion('Acolyte');
  const gone = minion('Dismissed');
  store.updateTicket(gone.id, { status: 'closed' });
  for (let i = 0; i < 5; i++) minion(`Peek ${i}`, Peek.id); // #5 exists in Peek Auras only
  const srv = await bootServer({ root, ...slowWrites });
  after(() => srv.stop()); // waits for the server to exit, so it isn't writing when the folder goes (#218)
  const ask = async (body: object) => {
    const res = await fetch(`${srv.base}/api/contraptions/asks`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tocKey}` }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const said = (id: number) =>
    store
      .listEvents(id)
      .filter((e) => e.kind === 'user_message')
      .map((e) => JSON.parse(e.data) as { author: string; text: string; ask?: Record<string, unknown> });

  // Rachel, a member: her brief reaches #1 as her ask, its file in her inbox, and the Taskmaster hears nothing.
  const brief = { person: Rachel.id, kind: 'feature', minion: acolyte.number, text: 'Brief: rune tooltips.\n\nShow the rune cost.', files: [{ name: 'brief.md', data: b64('# Brief') }] };
  let r = await ask(brief);
  assert.equal(r.status, 202, JSON.stringify(r.body));
  assert.deepEqual(r.body, { scheme: 'Theory of Crafting', minion: 1, member: true, proposal: false, files: ['inbox/toc/rachel/brief.md'] });
  assert.equal(readFileSync(join(projectSharedDir(data, ToC.id), 'inbox', 'toc', 'rachel', 'brief.md'), 'utf8'), '# Brief');
  const m = (await until('the brief in #1', () => said(acolyte.id)[0]))!;
  // Her own name, so the turn runs as her (runner.turnPerson goes by author), on her Claude and GitHub.
  assert.equal(m.author, 'Rachel');
  assert.equal(messagePerson(store)(m.author), Rachel.id);
  assert.match(m.text, /^A feature ask from the ToC contraption \(toc\), sent by Rachel \(rachel\)/);
  assert.match(m.text, /> Show the rune cost\./);
  assert.match(m.text, /Files they sent, in this scheme's shared folder: inbox\/toc\/rachel\/brief\.md/);
  assert.deepEqual(m.ask, { kind: 'feature', contraption: 'ToC', person: 'Rachel', member: true, summary: 'Brief: rune tooltips.' });
  assert.equal(store.getCoordinator(ToC.id), undefined, 'no Taskmaster made or woken');

  // A non-member is refused, even for a bug; nothing is sent or filed.
  r = await ask({ ...brief, person: Josh.id, kind: 'bug' });
  assert.equal(r.status, 403);
  assert.match(r.body.error, /Josh isn't a Theory of Crafting member/);
  assert.equal(existsSync(join(projectSharedDir(data, ToC.id), 'inbox', 'toc', 'josh')), false);
  // A number not in the home scheme (only Peek Auras has #5), or none at all, is a 404.
  for (const n of [5, 99]) {
    r = await ask({ ...brief, minion: n, files: [] });
    assert.equal(r.status, 404, String(n));
    assert.equal(r.body.error, `No minion #${n} in Theory of Crafting`);
  }
  // A dismissed minion is a 409, left closed.
  r = await ask({ ...brief, minion: gone.number, files: [] });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /#2 in Theory of Crafting is dismissed/);
  assert.equal(store.getTicket(gone.id)!.status, 'closed');
  assert.equal(said(gone.id).length, 0);
  // Not a number, or a data ask: 400.
  for (const bad of ['1', 0, 1.5, -1]) assert.equal((await ask({ ...brief, minion: bad, files: [] })).status, 400, String(bad));
  assert.equal((await ask({ ...brief, kind: 'data', files: [] })).status, 400);

  // The refusals cost nothing; the bug/feature limit is shared with Taskmaster asks: 10 in 10 minutes in all.
  for (let i = 0; i < 8; i++) assert.equal((await ask({ ...brief, files: [], text: `again ${i}` })).status, 202, `again ${i}`);
  assert.equal((await ask({ person: Rachel.id, kind: 'bug', text: 'to the Taskmaster' })).status, 202);
  r = await ask({ ...brief, files: [], text: 'one too many' });
  assert.equal(r.status, 429);
  await until('the eight more asks in #1', () => said(acolyte.id).length >= 9);
  assert.equal(said(acolyte.id).filter((e) => e.text.includes('one too many')).length, 0);
  assert.equal(said(acolyte.id).length, 9);
});

test("an ask to the Taskmaster runs on its asker's login, split or not (#1449 P1)", { timeout: 60_000 }, async () => {
  // Olive last ran the Taskmaster; nobody has linked Claude, so each ask's note names whose login its turn would run on.
  const Olive = store.createUser({ name: 'Olive', login: 'olive' });
  const Lanterns = store.createProject('Lanterns', null, Cara.id);
  for (const u of [Rachel, Olive]) store.addMember(Lanterns.id, u.id);
  const lanterns = keys.register({ name: 'lanterns', title: 'Lanterns', port: 9104, icon: null, home_scheme: Lanterns.id, open_paths: '[]', default_model: null, turn_cap: null });
  for (const u of [Josh, Rachel, Olive]) store.setContraptionUser(lanterns.id, u.id, true, Cara.id);
  const key = readFileSync(join(data, 'contraptions', 'lanterns', 'contraption.key'), 'utf8');
  mkdirSync(projectSharedDir(data, Lanterns.id), { recursive: true });
  const srv = await bootServer({ root, ...slowWrites });
  after(() => srv.stop());
  /** Send an ask and return the note the Taskmaster's chat got right after it. */
  const noteAfter = async (person: number, text: string) => {
    const res = await fetch(`${srv.base}/api/contraptions/asks`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, body: JSON.stringify({ person, kind: 'bug', text }) });
    assert.equal(res.status, 202, await res.text());
    return (await until(`the note after "${text}"`, () => {
      for (const tm of store.listCoordinators(Lanterns.id)) {
        const all = store.listEvents(tm.id);
        const at = all.findIndex((e) => e.kind === 'user_message' && e.data.includes(text));
        if (at >= 0 && all[at + 1]?.kind === 'note') return JSON.parse(all[at + 1].data).text as string;
      }
      return undefined;
    }))!;
  };
  await noteAfter(Olive.id, 'Wicks burn out');
  const tm = store.getCoordinator(Lanterns.id)!;
  store.updateTicket(tm.id, { person_id: Olive.id });
  // Not split: Rachel's ask runs on hers, not Olive's; a non-member's on the owner's.
  assert.match(await noteAfter(Rachel.id, 'Glass cracks'), /^Turns for Rachel start once/);
  assert.match(await noteAfter(Josh.id, 'Smoke everywhere'), /^Turns in this scheme start once its owner, Cara,/);
  // Split, and Rachel has no Taskmaster of her own: the Overlord takes it, still on hers, not the owner's.
  store.splitScheme(Lanterns.id, Olive.id);
  assert.match(await noteAfter(Rachel.id, 'Handles too hot'), /^Turns for Rachel start once/);
});

test('staged uploads (#1841): over the cap removed mid-stream, unsent ones swept after a day', async () => {
  const dir = mkdtempSync(join(root, 'stage-'));
  async function* chunks(n: number) {
    for (let i = 0; i < n; i++) yield Buffer.alloc(4, i);
  }
  await assert.rejects(stageAskUpload(dir, 'peek-auras', 1, 'big.bin', chunks(5), 10), (err: { status?: number }) => err.status === 413);
  assert.deepEqual(readdirSync(join(dir, 'peek-auras', '1')), [], 'the partial upload is gone');
  const up = await stageAskUpload(dir, 'peek-auras', 1, '../clip.webm', chunks(2), 10);
  assert.equal(up.size, 8);
  assert.match(up.upload, /^[0-9a-f]{24}$/);
  await sweepAskUploads(dir);
  assert.deepEqual(readdirSync(join(dir, 'peek-auras', '1')), [up.upload], 'a fresh one stays');
  await sweepAskUploads(dir, Date.now() + ASK_UPLOAD_TTL_MS + 1);
  assert.deepEqual(readdirSync(join(dir, 'peek-auras', '1')), [], 'a day on, it is swept');
});

test('POST /api/contraptions/asks/files (#1841): a 100 MB file streamed, then named by an ask', { timeout: 120_000 }, async () => {
  // Its own scheme and contraption, so the rate limits count from zero.
  const Rec = store.createProject('Recorder', null, Cara.id);
  store.addMember(Rec.id, Rachel.id);
  const rec = keys.register({ name: 'rec', title: 'Rec', port: 9104, icon: null, home_scheme: Rec.id, open_paths: '[]', static_paths: null, relay_paths: '[]', default_model: null, turn_cap: null, restart_risk: 'unassessed', restart_note: '' });
  for (const u of [Josh, Rachel]) store.setContraptionUser(rec.id, u.id, true, Cara.id);
  const recKey = readFileSync(join(data, 'contraptions', 'rec', 'contraption.key'), 'utf8');
  const srv = await bootServer({ root, ...slowWrites });
  after(() => srv.stop()); // waits for the server to exit, so it isn't writing when the folder goes (#218)
  const auth = { Authorization: `Bearer ${recKey}` };
  const upload = async (person: number, name: string, body: Buffer) => {
    const res = await fetch(`${srv.base}/api/contraptions/asks/files?person=${person}&name=${encodeURIComponent(name)}`, { method: 'POST', headers: { 'Content-Type': 'video/webm', ...auth }, body });
    return { status: res.status, body: (await res.json()) as { upload: string; name: string; size: number } };
  };
  const ask = async (body: object) => {
    const res = await fetch(`${srv.base}/api/contraptions/asks`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...auth }, body: JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as { files: string[] } };
  };
  const recShared = projectSharedDir(data, Rec.id);
  const staged = join(askUploadsDir(data), 'rec');

  // A 60 s 1080p screen recording's size, made here, never committed.
  const video = Buffer.alloc(100 * 1024 * 1024);
  for (let i = 0; i < video.length; i += 4096) video.writeUInt32LE(i, i);
  const sum = (b: Buffer) => createHash('sha256').update(b).digest('hex');
  let up = await upload(Rachel.id, 'screen recording.webm', video);
  assert.equal(up.status, 201, JSON.stringify(up.body));
  assert.equal(up.body.size, video.length);
  const id = up.body.upload;

  // Not enabled, or no person: refused before any of it is kept.
  assert.equal((await upload(Dana.id, 'x.webm', Buffer.from('x'))).status, 403);
  assert.equal((await upload(0, 'x.webm', Buffer.from('x'))).status, 400);
  // Over 200 MiB by its Content-Length: refused before the body is read.
  const big = await new Promise<number>((resolve, reject) => {
    const req = request(`${srv.base}/api/contraptions/asks/files?person=${Rachel.id}&name=big.webm`, { method: 'POST', headers: { ...auth, 'Content-Length': 201 * 1024 * 1024 } }, (res) => resolve(res.statusCode!));
    req.on('error', reject);
    req.flushHeaders();
  });
  assert.equal(big, 413);
  // Someone else's upload id is no upload of theirs.
  assert.equal((await ask({ person: Josh.id, kind: 'bug', text: 'Not mine', files: [{ upload: id }] })).status, 404);
  assert.equal((await ask({ person: Rachel.id, kind: 'bug', text: 'Bad id', files: [{ upload: '../../etc' }] })).status, 400);

  // A bug report naming the upload and an inline file: both land in the inbox, the big one moved, not copied in memory.
  const r = await ask({ person: Rachel.id, kind: 'bug', text: 'The aura flickers, see the recording', files: [{ upload: id, name: 'flicker.webm' }, { name: 'log.txt', data: b64('frame 12') }] });
  assert.equal(r.status, 202, JSON.stringify(r.body));
  assert.deepEqual(r.body.files, ['inbox/rec/rachel/flicker.webm', 'inbox/rec/rachel/log.txt']);
  assert.equal(sum(readFileSync(join(recShared, 'inbox', 'rec', 'rachel', 'flicker.webm'))), sum(video));
  assert.deepEqual(readdirSync(join(staged, String(Rachel.id))), [], 'the staged upload is gone once filed');
  const msg = await until("the ask in Recorder's Taskmaster chat", () => {
    const tm = store.getCoordinator(Rec.id);
    return tm && store.listEvents(tm.id).find((e) => e.kind === 'user_message' && e.data.includes('The aura flickers'));
  });
  assert.match(JSON.parse(msg!.data).text, /inbox\/rec\/rachel\/flicker\.webm/);
  // Used once: a second ask naming it finds nothing.
  assert.equal((await ask({ person: Rachel.id, kind: 'bug', text: 'Again', files: [{ upload: id }] })).status, 404);

  // A data ask takes uploads too, under its own name when it gives none.
  up = await upload(Josh.id, 'session.webm', Buffer.from('small clip'));
  const d = await ask({ person: Josh.id, kind: 'data', files: [{ upload: up.body.upload }] });
  assert.equal(d.status, 202, JSON.stringify(d.body));
  assert.deepEqual(d.body.files, ['inbox/rec/josh/session.webm']);
  assert.equal(readFileSync(join(recShared, 'inbox', 'rec', 'josh', 'session.webm'), 'utf8'), 'small clip');

  // A loop is cut off at 20 uploads in 10 minutes.
  for (let i = 1; i < 20; i++) assert.equal((await upload(Josh.id, `${i}.txt`, Buffer.from('x'))).status, 201, `upload ${i}`);
  assert.equal((await upload(Josh.id, 'one too many.txt', Buffer.from('x'))).status, 429);
});
