// Feature asks and bug reports from a contraption to its home scheme (src/contraption-asks.ts, the
// brief's section 5): only its own server with its key, for a person it is enabled for; files land in
// the home scheme's inbox; a non-member's feature ask is a proposal only.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { README_INBOX_LINE, safeName, saveAskFiles } from '../src/contraption-asks.ts';
import { Contraptions } from '../src/contraptions.ts';
import { Store } from '../src/db.ts';
import { projectSharedDir } from '../src/workspace.ts';
import { bootServer, SECRET } from './helpers.ts';

const root = mkdtempSync(join(tmpdir(), 'contraption-asks-'));
const data = join(root, 'data');
mkdirSync(data, { recursive: true });
after(() => rmSync(root, { recursive: true, force: true }));

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
  after(() => srv.proc.kill());
  const ask = async (body: object, headers: Record<string, string> = { Authorization: `Bearer ${KEY}` }) => {
    const res = await fetch(`${srv.base}/api/contraptions/asks`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const tm = () => store.getCoordinator(Peek.id);
  const said = () => store.listEvents(tm()!.id).filter((e) => e.kind === 'user_message').map((e) => JSON.parse(e.data) as { author: string; text: string });
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
  assert.equal((await ask({ ...good, files: [{ name: 'a', data: 'not base64!' }] })).status, 400);
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
  r = await ask({ person: Rachel.id, kind: 'feature', text: 'A dark theme' });
  assert.deepEqual(r.body, { scheme: 'Peek Auras', member: true, proposal: false, files: [] });
  m = said().at(-1)!;
  assert.equal(m.author, 'Contraption Peek Auras, for Rachel, a Peek Auras member');
  assert.doesNotMatch(m.text, /isn't a Peek Auras member|Files they sent/);

  // A contraption with no home scheme has nowhere to send it.
  store.updateContraption('peek-auras', { home_scheme: null });
  assert.equal((await ask(good)).status, 409);
  store.updateContraption('peek-auras', { home_scheme: Peek.id });
});
