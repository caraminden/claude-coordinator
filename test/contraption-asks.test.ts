// Feature asks and bug reports from a contraption to its home scheme (src/contraption-asks.ts, the
// brief's section 5): only its own server with its key, for a person it is enabled for; files land in
// the home scheme's inbox; a non-member's feature ask is a proposal only.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { askSummary, README_INBOX_LINE, safeName, saveAskFiles } from '../src/contraption-asks.ts';
import { askHeader } from '../public/askcard.js';
import { messagePerson } from '../src/access.ts';
import { Contraptions } from '../src/contraptions.ts';
import { Store } from '../src/db.ts';
import { projectSharedDir } from '../src/workspace.ts';
import { bootServer, SECRET, stopTurns } from './helpers.ts';

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

test('safe names: one segment, no leading dot, nothing odd', () => {
  assert.equal(safeName('../../etc/passwd'), 'passwd');
  assert.equal(safeName('..\\..\\boot.ini'), 'boot.ini');
  assert.equal(safeName('..'), 'file');
  assert.equal(safeName('.bashrc'), 'bashrc');
  assert.equal(safeName('my clip (1).peekclip'), 'my-clip-1-.peekclip');
  assert.equal(safeName(''), 'file');
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

test('files never follow an inbox folder linked out of the shared folder', () => {
  const dir = mkdtempSync(join(root, 'escape-'));
  const outside = mkdtempSync(join(root, 'outside-'));
  mkdirSync(join(dir, 'inbox', 'peek-auras'), { recursive: true });
  symlinkSync(outside, join(dir, 'inbox', 'peek-auras', 'josh'));
  assert.throws(() => saveAskFiles(dir, 'peek-auras', 'josh', [{ name: 'a.txt', data: Buffer.from('x') }]), /outside the shared folder/);
  assert.deepEqual(readdirSync(outside), []);
});

test('POST /api/contraptions/asks: key, person, inbox, labels and the Caddy path', { timeout: 60_000 }, async () => {
  const srv = await bootServer({ root });
  after(() => srv.stop()); // waits for the server to exit, so it isn't writing when the folder goes (#218)
  const ask = async (body: object, headers: Record<string, string> = { Authorization: `Bearer ${KEY}` }) => {
    const res = await fetch(`${srv.base}/api/contraptions/asks`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const tm = () => store.getCoordinator(Peek.id);
  const said = () => store.listEvents(tm()!.id).filter((e) => e.kind === 'user_message').map((e) => JSON.parse(e.data) as { author: string; text: string; ask?: Record<string, unknown> });
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
  const big = await ask({ ...good, files: [{ name: 'a.bin', data: half }, { name: 'b.bin', data: half }] });
  assert.equal(big.status, 413);
  assert.equal(existsSync(join(shared, 'inbox')), false);

  // Josh isn't a Peek Auras member: his feature ask lands, as a proposal only, his clip in his inbox.
  let r = await ask(good);
  assert.equal(r.status, 202);
  assert.deepEqual(r.body, { scheme: 'Peek Auras', member: false, proposal: true, files: ['inbox/peek-auras/josh/clip.peekclip'] });
  assert.equal(readFileSync(join(shared, 'inbox', 'peek-auras', 'josh', 'clip.peekclip'), 'utf8'), 'CLIP');
  assert.equal(existsSync(join(projectSharedDir(data, Peek.id), '..', 'escape')), false);
  let m = said().at(-1)!;
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
  m = said().at(-1)!;
  assert.match(m.text, /^A bug report/);
  assert.match(m.text, /a bug .* you may work as usual/);
  assert.doesNotMatch(m.text, /Proposal only/);
  assert.equal(readFileSync(join(shared, 'README.md'), 'utf8'), readme, 'the README line goes in once');

  // Rachel is a member: labelled as one, no proposal, and no files is fine.
  r = await ask({ person: Rachel.id, kind: 'feature', text: 'A dark theme.\n\nThe aura so far:\n{"a": 1}', summary: '  Dark\ntheme,  please ', item: 'Frost"bite\n' });
  assert.deepEqual(r.body, { scheme: 'Peek Auras', member: true, proposal: false, files: [] });
  m = said().at(-1)!;
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
  assert.equal(said().filter((e) => e.text.includes('one too many')).length, 0);
  assert.equal((await ask({ person: Rachel.id, kind: 'bug', text: 'still fine' })).status, 202);

  // A data ask (#318) only files: its files and a sidecar with its words, no message and no turn, even
  // for a non-member past his ask limit; data asks keep their own count.
  const events = store.listEvents(tm()!.id).length;
  const dir = join(shared, 'inbox', 'peek-auras', 'josh');
  const jsonl = { name: 'layout.jsonl', data: b64('{"x":1}\n') };
  r = await ask({ person: Josh.id, kind: 'data', item: 'Main layout', summary: 'Find my UI confirm', files: [jsonl, { name: 'crop.png', data: b64('PNG') }] });
  assert.equal(r.status, 202);
  assert.equal(r.body.proposal, false);
  assert.equal(r.body.member, false);
  assert.deepEqual(r.body.files, ['inbox/peek-auras/josh/layout.jsonl', 'inbox/peek-auras/josh/crop.png']);
  assert.match(r.body.sidecar, /^inbox\/peek-auras\/josh\/\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z-ask\.json$/);
  assert.equal(readFileSync(join(dir, 'layout.jsonl'), 'utf8'), '{"x":1}\n');
  const record = JSON.parse(readFileSync(join(shared, r.body.sidecar), 'utf8'));
  assert.deepEqual({ ...record, at: undefined }, { contraption: 'peek-auras', person: 'josh', item: 'Main layout', summary: 'Find my UI confirm', text: null, files: r.body.files, at: undefined });
  assert.ok(Date.now() - Date.parse(record.at) < 60_000);
  // Same names again: -2, as for other asks; text alone gives the summary.
  r = await ask({ person: Josh.id, kind: 'data', text: 'Saved twice. Second time.', files: [jsonl] });
  assert.deepEqual(r.body.files, ['inbox/peek-auras/josh/layout-2.jsonl']);
  assert.equal(JSON.parse(readFileSync(join(shared, r.body.sidecar), 'utf8')).summary, 'Saved twice.');
  // The caps and checks still hold, and nothing reached the Taskmaster.
  assert.equal((await ask({ person: Josh.id, kind: 'data', files: [{ name: 'a.bin', data: half }, { name: 'b.bin', data: half }] })).status, 413);
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
  const srv = await bootServer({ root });
  after(() => srv.stop()); // waits for the server to exit, so it isn't writing when the folder goes (#218)
  const ask = async (body: object) => {
    const res = await fetch(`${srv.base}/api/contraptions/asks`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tocKey}` }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const said = (id: number) => store.listEvents(id).filter((e) => e.kind === 'user_message').map((e) => JSON.parse(e.data) as { author: string; text: string; ask?: Record<string, unknown> });

  // Rachel, a member: her brief reaches #1 as her ask, its file in her inbox, and the Taskmaster hears nothing.
  const brief = { person: Rachel.id, kind: 'feature', minion: acolyte.number, text: 'Brief: rune tooltips.\n\nShow the rune cost.', files: [{ name: 'brief.md', data: b64('# Brief') }] };
  let r = await ask(brief);
  assert.equal(r.status, 202, JSON.stringify(r.body));
  assert.deepEqual(r.body, { scheme: 'Theory of Crafting', minion: 1, member: true, proposal: false, files: ['inbox/toc/rachel/brief.md'] });
  assert.equal(readFileSync(join(projectSharedDir(data, ToC.id), 'inbox', 'toc', 'rachel', 'brief.md'), 'utf8'), '# Brief');
  const m = said(acolyte.id).at(-1)!;
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
  assert.equal(said(acolyte.id).filter((e) => e.text.includes('one too many')).length, 0);
  assert.equal(said(acolyte.id).length, 9);
});
