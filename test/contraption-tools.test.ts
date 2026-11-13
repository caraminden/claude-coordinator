import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { after, before, test } from 'node:test';
import { Auth } from '../src/auth.ts';
import { Store } from '../src/db.ts';
import { GLOBAL_OWNER } from '../src/properties.ts';
import { bootServer, fakeSystemd, PASSWORD, REPO, SECRET, type Booted } from './helpers.ts';

// Settings → Contraptions as coordinator tools (#246): only the Citadel scheme's Taskmaster, only on a
// turn an admin asked for (#255), through the same routes the settings page calls, and never showing a key.
const root = mkdtempSync(join(tmpdir(), 'contraption-tools-'));
const data = join(root, 'data');
mkdirSync(data, { recursive: true });

const store = new Store(join(data, 'coordinator.db'));
const Delve = store.createProject('Delve', null);
const Citadel = store.createProject('Citadel', null);
assert.equal(Citadel.id, GLOBAL_OWNER, 'the second scheme stands in for Citadel');
const cara = store.createUser({ name: 'Cara', login: 'cara', admin: true });
const olive = store.createUser({ name: 'Olive', login: 'olive' });
// A login can be all digits, so the person route takes logins as @login.
const digits = store.createUser({ name: 'Forty-two', login: '42' });
const thread = (p: number, kind: 'coordinator' | 'ticket') => store.createTicket({ project_id: p, kind, title: 'T', permission_mode: 'default', created_by: 'Cara' });
const CitadelTM = thread(Citadel.id, 'coordinator');
const DelveTM = thread(Delve.id, 'coordinator');
const Minion = thread(Citadel.id, 'ticket');
const turnFor = (t: { id: number }, person: number) => store.updateTicket(t.id, { person_id: person });
turnFor(CitadelTM, cara.id);
turnFor(DelveTM, cara.id);
turnFor(Minion, cara.id);

const tokens = new Auth(PASSWORD, SECRET);
// Its services (#266) through a stand-in systemctl, a temp unit folder and a temp home for ~/apps.
const home = join(root, 'home');
const fake = fakeSystemd(join(root, 'systemd'));
const serviceEnv = { HOME: home, XDG_CONFIG_HOME: join(home, '.config'), CITADEL_SYSTEMCTL: fake.bin, CITADEL_JOURNALCTL: fake.journal };
let srv: Booted;
before(async () => {
  srv = await bootServer({ root, env: serviceEnv });
});
after(async () => {
  await srv?.stop(); // ends the server and its turns before the folder goes (#218)
  rmSync(root, { recursive: true, force: true });
});

/** One tools/list or tools/call through the real MCP server, as `ticket`; `citadel` is the env the runner sets for Citadel's Taskmaster. */
async function mcp(ticket: { id: number; project_id: number }, method: string, params: object, citadel = ticket.project_id === GLOBAL_OWNER, home?: string, role = 'coordinator'): Promise<any> {
  const child = spawn(process.execPath, [join(REPO, 'src', 'mcp.ts')], {
    env: {
      ...process.env, COORDINATOR_API: srv.base, COORDINATOR_TOKEN: tokens.agentToken(ticket.id),
      COORDINATOR_PROJECT: String(ticket.project_id), COORDINATOR_TICKET: String(ticket.id), COORDINATOR_ROLE: role,
      COORDINATOR_APP_INSTRUCTIONS: citadel ? '1' : undefined, COORDINATOR_HOME_CONTRAPTIONS: home,
    },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  try {
    const reply = new Promise<any>((resolve) => createInterface({ input: child.stdout }).once('line', (l) => resolve(JSON.parse(l))));
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) + '\n');
    return (await reply).result;
  } finally {
    child.kill();
  }
}
const tool = async (t: { id: number; project_id: number }, name: string, args: object = {}, citadel?: boolean) => {
  const r = await mcp(t, 'tools/call', { name, arguments: args }, citadel);
  return { isError: !!r.isError, text: r.content[0].text as string };
};

const keysDir = (name: string) => join(srv.data, 'contraptions', name);
const keyFiles = (name: string) => ({ pub: readFileSync(join(keysDir(name), 'identity.pub'), 'utf8'), key: readFileSync(join(keysDir(name), 'contraption.key'), 'utf8') });
/** Nothing secret, nor either key file, in what a tool said. */
function noKeys(text: string, name: string) {
  const { pub, key } = keyFiles(name);
  assert.ok(!text.includes(key) && !/ck_/.test(text), 'no contraption key');
  assert.ok(!text.includes(pub.trim()) && !/BEGIN|PRIVATE/.test(text), 'no identity key');
}
const MANDATE = { title: 'Mandate', port: 7341, icon: '/icons/icon.svg', default_model: 'haiku', open_paths: [] };
const ALL = ['list_contraptions', 'register_contraption', 'update_contraption', 'set_contraption_person', 'rotate_contraption_keys', 'contraption_service'];

test('Citadel\'s Taskmaster registers and enables a contraption just as Settings → Contraptions does', async () => {
  const names = (await mcp(CitadelTM, 'tools/list', {})).tools.map((x: any) => x.name);
  for (const n of ALL) assert.ok(names.includes(n), n);

  const reg = await tool(CitadelTM, 'register_contraption', { name: 'mandate', ...MANDATE });
  assert.equal(reg.isError, false, reg.text);
  assert.doesNotMatch(reg.text, /To do/, 'it has an icon');
  assert.match(reg.text, new RegExp(`key folder ${keysDir('mandate')}`));
  noKeys(reg.text, 'mandate');
  // The same through the settings page's route, to compare rows and files.
  assert.equal((await srv.call('/api/contraptions', { name: 'twin', ...MANDATE })).status, 201);

  const pick = (name: string) => {
    const { id, name: _, created_at, identity_public, identity_private, key_hash, keys_at, ...rest } = store.getContraption(name)!;
    return rest;
  };
  assert.deepEqual(pick('mandate'), pick('twin'));
  for (const name of ['mandate', 'twin']) {
    assert.deepEqual(readdirSync(keysDir(name)).sort(), ['contraption.key', 'identity.pub']);
    assert.equal(statSync(keysDir(name)).mode & 0o777, 0o700);
    for (const f of ['contraption.key', 'identity.pub']) assert.equal(statSync(join(keysDir(name), f)).mode & 0o777, 0o600);
    assert.equal(store.getContraption(name)!.identity_public, keyFiles(name).pub, 'the row holds the public key in the file');
  }
  assert.equal((await tool(CitadelTM, 'register_contraption', { name: 'mandate', ...MANDATE })).isError, true, 'a second mandate is refused');
  for (const name of ['mine', 'Bad Name']) {
    const r = await tool(CitadelTM, 'register_contraption', { name, ...MANDATE });
    assert.equal(r.isError, true, name);
    assert.match(r.text, /short slug/);
  }

  const on = await tool(CitadelTM, 'set_contraption_person', { name: 'mandate', login: 'cara', enabled: true });
  assert.equal(on.isError, false, on.text);
  assert.match(on.text, /enabled for cara/);
  assert.equal(store.contraptionEnabled('mandate', cara.id), true);
  assert.equal(store.db.prepare('SELECT added_by FROM contraption_users WHERE user_id = ?').get(cara.id)!.added_by, cara.id, 'enabled by the turn\'s person');
  assert.equal((await tool(CitadelTM, 'set_contraption_person', { name: 'mandate', login: '42', enabled: true })).isError, false);
  assert.equal(store.contraptionEnabled('mandate', digits.id), true, 'an all-digit login is a login, not an id');
  assert.equal(store.contraptionEnabled('mandate', 42), false);
  assert.equal((await tool(CitadelTM, 'set_contraption_person', { name: 'mandate', login: '42', enabled: false })).isError, false);
  assert.equal(store.contraptionEnabled('mandate', digits.id), false);
  assert.match((await tool(CitadelTM, 'set_contraption_person', { name: 'mandate', login: 'nobody', enabled: true })).text, /No such person/);

  const upd = await tool(CitadelTM, 'update_contraption', { name: 'mandate', title: 'Mandate!', turn_cap: 50, home_scheme: Citadel.id });
  assert.equal(upd.isError, false, upd.text);
  assert.deepEqual([store.getContraption('mandate')!.title, store.getContraption('mandate')!.turn_cap, store.getContraption('mandate')!.port], ['Mandate!', 50, 7341]);
  assert.equal((await tool(CitadelTM, 'update_contraption', { name: 'mandate', port: 80 })).isError, true, 'the route\'s checks apply');

  const before = keyFiles('mandate');
  const rot = await tool(CitadelTM, 'rotate_contraption_keys', { name: 'mandate' });
  assert.equal(rot.isError, false, rot.text);
  assert.notEqual(keyFiles('mandate').key, before.key);
  assert.ok(!rot.text.includes(before.key));
  noKeys(rot.text, 'mandate');

  const list = await tool(CitadelTM, 'list_contraptions');
  assert.match(list.text, /^mandate: Mandate! \| port 7341 \| icon \/icons\/icon\.svg \| model haiku \| open paths none \| relay paths none \| home scheme 2 \| turn cap 50 \| enabled for cara \| key folder /m);
  assert.match(list.text, /^twin: Mandate/m);
  noKeys(list.text, 'mandate');
  noKeys(list.text, 'twin');

  // Registered without an icon: the answer says it's a to-do (#418), and still registers it.
  const bare = await tool(CitadelTM, 'register_contraption', { name: 'bare', title: 'Bare', port: 7399 });
  assert.equal(bare.isError, false, bare.text);
  assert.match(bare.text, /To do: it has no icon.*update_contraption.*filled from its manifest/);
  assert.match(bare.text, /^bare: Bare/m);
});

test('a turn someone who isn\'t an admin asked for is refused, and changes nothing', async () => {
  turnFor(CitadelTM, olive.id);
  try {
    const before = keyFiles('twin');
    for (const [name, args] of [
      ['list_contraptions', {}], ['register_contraption', { name: 'sneaky', ...MANDATE }], ['update_contraption', { name: 'twin', title: 'Mine' }],
      ['set_contraption_person', { name: 'twin', login: 'olive', enabled: true }], ['rotate_contraption_keys', { name: 'twin' }],
      ['contraption_service', { name: 'twin', action: 'status' }], ['contraption_service', { name: 'twin', action: 'install' }],
    ] as const) {
      const r = await tool(CitadelTM, name, args);
      assert.equal(r.isError, true, name);
      assert.match(r.text, /Only a turn a Citadel admin asked for may do this, and this one is Olive's ask\. Ask a Citadel admin or a member of the Citadel scheme to send the request in this chat\./, name);
    }
    assert.equal(existsSync(keysDir('sneaky')), false);
    assert.equal(store.getContraption('sneaky'), undefined);
    assert.equal(store.getContraption('twin')!.title, 'Mandate');
    assert.equal(store.contraptionEnabled('twin', olive.id), false);
    assert.deepEqual(keyFiles('twin'), before);
  } finally {
    turnFor(CitadelTM, cara.id);
  }
});

test('another scheme\'s Taskmaster isn\'t offered the tools, and the API refuses it and a minion even if they get them', async () => {
  const names = (await mcp(DelveTM, 'tools/list', {})).tools.map((x: any) => x.name);
  for (const n of ALL) assert.ok(!names.includes(n), n);
  assert.match((await tool(DelveTM, 'list_contraptions')).text, /Unknown tool/);
  for (const t of [DelveTM, Minion]) {
    for (const [name, args] of [['list_contraptions', {}], ['register_contraption', { name: 'sneaky', ...MANDATE }], ['rotate_contraption_keys', { name: 'twin' }], ['contraption_service', { name: 'twin', action: 'install' }]] as const) {
      const r = await tool(t, name, args, true);
      assert.equal(r.isError, true, `${name} as ${t === DelveTM ? 'Delve\'s Taskmaster' : 'a minion'}`);
      assert.match(r.text, t === DelveTM ? /Only the Citadel scheme's Taskmaster manages contraptions: ask it with message_taskmaster/ : /A minion may only update itself/, name);
    }
  }
  assert.equal(store.getContraption('sneaky'), undefined);
});

test('Citadel\'s Taskmaster installs and runs a contraption\'s service, as the Settings buttons do', async () => {
  const folder = join(home, 'apps', 'twin');
  const units = join(home, '.config', 'systemd', 'user');
  mkdirSync(units, { recursive: true });
  let r = await tool(CitadelTM, 'contraption_service', { name: 'twin', action: 'status' });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /citadel-app-twin.service: not installed/);
  assert.match(r.text, /manifest problem: No citadel-app.json in .*apps\/twin/);
  assert.match((await tool(CitadelTM, 'contraption_service', { name: 'twin', action: 'install' })).text, /Error: No citadel-app.json/);

  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'citadel-app.json'), JSON.stringify({ start: ['/usr/bin/node', 'server.ts'], health: '/health' }));
  writeFileSync(join(units, 'twin.service'), '[Service]\nWorkingDirectory=%h/apps/twin\nEnvironment=PORT=7341\n');
  writeFileSync(join(root, 'systemd', 'twin.service.active'), '');
  r = await tool(CitadelTM, 'contraption_service', { name: 'twin', action: 'status' });
  assert.match(r.text, /hand-installed: .*twin.service: active, disabled \(port 7341\)/);
  assert.match((await tool(CitadelTM, 'contraption_service', { name: 'twin', action: 'install' })).text, /Error: Hand-installed units run twin already/);
  r = await tool(CitadelTM, 'contraption_service', { name: 'twin', action: 'install', replace: true });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /Stopped and disabled twin.service/);
  assert.match(r.text, /citadel-app-twin.service: active \(running\), enabled/);
  const unit = readFileSync(join(units, 'citadel-app-twin.service'), 'utf8');
  assert.ok(unit.includes(`Environment="CITADEL_KEYS=${keysDir('twin')}"`), 'the key folder this server wrote');
  assert.match(unit, /Environment="CITADEL_URL=http:\/\/127\.0\.0\.1:\d+"/);

  r = await tool(CitadelTM, 'contraption_service', { name: 'twin', action: 'stop' });
  assert.match(r.text, /Stopped citadel-app-twin.service/);
  assert.match(r.text, /citadel-app-twin.service: inactive/);
  assert.match((await tool(CitadelTM, 'contraption_service', { name: 'twin', action: 'logs', lines: 7 })).text, /^journal --user -u citadel-app-twin.service -n 7/);
  // The settings page's route says the same.
  const s = await srv.call('/api/contraptions/twin/service');
  assert.equal(s.status, 200);
  assert.equal(s.data.service.active, 'inactive');
  assert.equal((await srv.call('/api/contraptions/twin/service', { action: 'reboot' })).status, 400);
});

test('a boot check never touches systemd, even with the stand-ins set', async () => {
  const check = await bootServer({ env: { ...serviceEnv, BOOT_CHECK: '1' } });
  try {
    const before = fake.calls().length;
    assert.equal((await check.call('/api/contraptions', { name: 'mandate', ...MANDATE })).status, 201);
    for (const [path, body] of [['/api/contraptions/mandate/service', undefined], ['/api/contraptions/mandate/service', { action: 'install' }], ['/api/contraptions/mandate/service/logs', undefined]] as const) {
      const r = await check.call(path, body);
      assert.equal(r.status, 409, path);
      assert.match(r.data.error, /boot check or a preview never touches app services/);
    }
    assert.equal(fake.calls().length, before);
  } finally {
    await check.stop();
  }
});

test('deploy_contraption: its home scheme\'s Taskmaster and minions, and Citadel\'s Taskmaster on an admin\'s turn; no one else', async () => {
  const DelveMinion = thread(Delve.id, 'ticket');
  turnFor(DelveMinion, olive.id);
  store.updateContraption('twin', { home_scheme: Delve.id, repo: null });
  const offered = async (t: any, citadel: boolean, home?: string) => (await mcp(t, 'tools/list', {}, citadel, home, t.kind === 'ticket' ? 'thread' : 'coordinator')).tools.some((x: any) => x.name === 'deploy_contraption');
  assert.equal(await offered(DelveTM, false, 'twin'), true, 'home Taskmaster');
  assert.equal(await offered(DelveMinion, false, 'twin'), true, 'home minion');
  assert.equal(await offered(DelveTM, false), false, 'a scheme home to none');
  assert.equal(await offered(Minion, false), false, 'a minion of a scheme home to none');
  assert.equal(await offered(CitadelTM, true), true, 'Citadel\'s Taskmaster');

  const call = async (t: any, citadel = false) => {
    const child = await mcp(t, 'tools/call', { name: 'deploy_contraption', arguments: { name: 'twin' } }, citadel, 'twin', t.kind === 'ticket' ? 'thread' : 'coordinator');
    return child.content[0].text as string;
  };
  // Allowed through: it gets as far as the repo nobody set.
  for (const t of [DelveTM, DelveMinion]) assert.match(await call(t), /Twin has no repo set|Mandate has no repo set/);
  assert.match(await call(CitadelTM, true), /has no repo set/);
  // Refused: a minion of another scheme, and Citadel's Taskmaster on a non-admin's turn.
  assert.match(await call(Minion), /Only its home scheme's Taskmaster and minions, or an admin, deploy a contraption/);
  turnFor(CitadelTM, olive.id);
  try {
    assert.match(await call(CitadelTM, true), /Only a turn a Citadel admin asked for/);
  } finally {
    turnFor(CitadelTM, cara.id);
  }
  // Only an admin sets the repo: the update route stays admin-only.
  const set = await srv.call('/api/contraptions/twin', { repo: 'caraminden/twin', branch: 'main', folder: '~/apps/twin' }, 'PATCH');
  assert.equal(set.status, 200);
  assert.deepEqual([set.data.repo, set.data.branch, set.data.folder], ['caraminden/twin', 'main', '~/apps/twin']);
  const cleared = await srv.call('/api/contraptions/twin', { branch: '', folder: null }, 'PATCH');
  assert.deepEqual([cleared.data.branch, cleared.data.folder], [null, null], 'blank means the defaults, which stay defaults');
  for (const bad of [{ repo: 'not a repo' }, { repo: 'a/../b' }, { branch: '-x' }, { folder: 'relative/path' }, { folder: '~/../etc' }]) {
    assert.equal((await srv.call('/api/contraptions/twin', bad, 'PATCH')).status, 400, JSON.stringify(bad));
  }
  assert.equal((await srv.call('/api/contraptions/twin/deploy')).status, 200, 'an admin reads the last deploy');
});
