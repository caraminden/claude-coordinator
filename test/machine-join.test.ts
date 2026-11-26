import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { bootServer, ok, stopProcs, tempRoot, until, type Booted } from './helpers.ts';
import { json } from './typed.ts';
import { Store } from '../src/db.ts';
import { cleanReport, hashJoinCode, JOIN_CODE, JOIN_MS, joinState, makeJoin, nameFromHost, newJoinCode, redeemJoin } from '../src/machine-join.ts';
import { AGENT_VERSION, joinWithCode, machineReport } from '../public/machine-agent.mjs';
import { machineJoinPosix, machineJoinWindows, machineSetupWindows } from '../public/machine-setup.js';
import { guessJoinOs, reportLine } from '../public/machine-connect.js';

// Connect a computer (Build 7 M2): a join code, one use and 15 minutes, kept hashed, swapped by the PC's agent for its
// machine's token; the row is named from the hostname, and the agent says what the PC can do.
const repo = join(import.meta.dirname, '..');
const tmp = tempRoot('machine-join-');
const procs: ChildProcess[] = [];
let srv: Booted | undefined;
after(async () => {
  try {
    await srv?.settled();
  } finally {
    await stopProcs(procs);
    await tmp.teardown();
  }
});

test('a hostname becomes a machine name the page takes, and a taken one gets the next number', () => {
  const none = () => false;
  assert.equal(nameFromHost('DESKTOP-JOSH', none), 'desktop-josh');
  assert.equal(nameFromHost('Caras-MacBook-Pro.local', none), 'caras-macbook-pro');
  assert.equal(nameFromHost('  my pc__2 ', none), 'my-pc-2');
  assert.equal(nameFromHost('???', none), 'computer');
  assert.equal(nameFromHost('a'.repeat(40), none), 'a'.repeat(30));
  const taken = new Set(['desktop-josh', 'desktop-josh-2']);
  assert.equal(
    nameFromHost('DESKTOP-JOSH', (n) => taken.has(n)),
    'desktop-josh-3',
  );
  const long = 'b'.repeat(30);
  assert.equal(
    nameFromHost(long, (n) => n === long),
    `${'b'.repeat(28)}-2`,
    'the number fits inside 30',
  );
  for (let i = 0; i < 50; i++) assert.match(newJoinCode(), JOIN_CODE);
});

test("a report keeps only what it knows, bounded, and isn't one without its os", () => {
  assert.equal(cleanReport({ threads: 8 }), null);
  assert.equal(cleanReport('windows'), null);
  const r = cleanReport({ os: 'windows', os_name: 'Windows 11\u0007', host: 'DESK', threads: 32, memory_gb: 63.94, disk_free_gb: -1, gpu: 'RTX 4080', wsl: { present: true, version: '2.3.26' }, screen: true, admin: 'yes', agent: 3, extra: 'x' });
  assert.deepEqual(r, { host: 'DESK', os: 'windows', os_name: 'Windows 11', wsl: { present: true, version: '2.3.26' }, in_wsl: false, threads: 32, memory_gb: 63.9, disk_free_gb: null, gpu: 'RTX 4080', screen: true, admin: null, agent: 3 });
  assert.equal(reportLine(r), 'Windows 11, 32 threads, 64 GB, RTX 4080, WSL 2.3.26 ready, admin available'.replace(', admin available', ''));
  assert.equal(reportLine({ ...r!, wsl: { present: false, version: null }, screen: false, admin: true, disk_free_gb: 120 }), 'Windows 11, 32 threads, 64 GB, 120 GB free, RTX 4080, no WSL, no one signed in, admin available');
});

test('a code works once, for 15 minutes, is kept only hashed, and names a new row from the hostname', () => {
  const dir = tmp.dir;
  const store = new Store(join(dir, 'join.db'));
  const josh = store.createUser({ name: 'Josh', login: 'josh' });
  store.createMachine('desktop-josh', 'x', 'Josh', josh.id);
  let tokens = 0;
  const issue = (id: number) => `ccm_${id}_${String(++tokens).padStart(43, 'a')}`;
  const t0 = 1_000_000;
  const made = makeJoin(store, { uid: josh.id, name: 'Josh' }, josh.id, null, t0);
  assert.equal(made.expires_at, t0 + JOIN_MS);
  const row = store.machineJoin(made.id)!;
  assert.equal(row.code_hash, hashJoinCode(made.code));
  assert.ok(!JSON.stringify(store.db.prepare('SELECT * FROM machine_joins').all()).includes(made.code), 'the code itself is never stored');
  assert.equal(joinState(row, false, t0), 'waiting');

  assert.throws(() => redeemJoin(store, issue, { code: 'cj_nope' }, t0), /isn't a join code/);
  const report = { os: 'windows', host: 'DESKTOP-JOSH', threads: 32, memory_gb: 64 };
  const got = redeemJoin(store, issue, { code: made.code, report }, t0 + 1000);
  assert.equal(got.name, 'desktop-josh-2', 'a name another row has gets the next number');
  const m = store.getMachine(got.id)!;
  assert.deepEqual([m.owner_id, m.created_by, JSON.parse(m.report!).threads], [josh.id, 'Josh', 32]);
  assert.equal(store.machineJoin(made.id)!.joined_id, got.id);
  assert.equal(joinState(store.machineJoin(made.id)!, false, t0 + 2000), 'joined');
  assert.equal(joinState(store.machineJoin(made.id)!, true, t0 + 2000), 'connected');
  assert.throws(
    () => redeemJoin(store, issue, { code: made.code, report }, t0 + 2000),
    (e: Error & { status?: number }) => e.status === 410,
  );

  const late = makeJoin(store, { uid: josh.id, name: 'Josh' }, josh.id, null, t0);
  assert.equal(joinState(store.machineJoin(late.id)!, false, t0 + JOIN_MS), 'expired');
  assert.throws(
    () => redeemJoin(store, issue, { code: late.code, host: 'other' }, t0 + JOIN_MS),
    (e: Error & { status?: number }) => e.status === 410,
  );
  assert.equal(store.listMachines().length, 2, 'a refused code makes no row');

  // An Update reconnects its own row under its own name, with a new token.
  const before = store.getMachine(got.id)!.token_hash;
  const upd = makeJoin(store, { uid: josh.id, name: 'Josh' }, null, store.getMachine(got.id)!, t0);
  store.updateMachine(got.id, { token_hash: 'old' });
  const again = redeemJoin(store, (id) => (store.updateMachine(id, { token_hash: 'new' }), issue(id)), { code: upd.code, report: { ...report, host: 'RENAMED-PC' } }, t0 + 5000);
  assert.deepEqual([again.id, again.name, store.getMachine(got.id)!.token_hash], [got.id, 'desktop-josh-2', 'new']);
  assert.notEqual(before, 'new');
  assert.equal(store.listMachines().length, 2);
  // A machine being removed gets no new token from an Update, as from its token route: its draining agent keeps the old one.
  const gone = makeJoin(store, { uid: josh.id, name: 'Josh' }, null, store.getMachine(got.id)!, t0);
  assert.throws(
    () => redeemJoin(store, issue, { code: gone.code, report }, t0 + 6000, (id) => id === got.id),
    (e: Error & { status?: number }) => e.status === 409,
  );
  assert.equal(store.getMachine(got.id)!.token_hash, 'new', 'its token is as it was');
  store.db.close();
});

test('the report reads a Windows PC: its version, WSL (whose tools write UTF-16), GPU, screen and admin', async () => {
  const utf16 = (s: string) => Buffer.from(`﻿${s}`, 'utf16le').toString('utf16le');
  const said: Record<string, string | null> = {
    'wsl.exe --version': utf16('WSL version: 2.3.26.0\r\nKernel version: 5.15.167.4-1\r\n'),
    'nvidia-smi --query-gpu=name --format=csv,noheader': 'NVIDIA GeForce RTX 4080\n',
    'tasklist.exe /FI IMAGENAME eq explorer.exe /FI USERNAME eq josh /NH': 'explorer.exe   1234 Console   1   100,000 K',
    'whoami.exe /groups': 'BUILTIN\\Administrators  Alias  S-1-5-32-544  Group used for deny only',
  };
  const run = async (c: string, a: string[]) => said[[c, ...a].join(' ')] ?? null;
  const r = await machineReport({ platform: 'win32', env: { USERNAME: 'josh' }, run, home: tmp.dir });
  assert.equal(r.os, 'windows');
  assert.match(r.os_name, /^Windows 1[01]$/);
  assert.deepEqual([r.wsl, r.gpu, r.screen, r.admin, r.agent], [{ present: true, version: '2.3.26.0' }, 'NVIDIA GeForce RTX 4080', true, true, AGENT_VERSION]);
  assert.ok(r.threads > 0 && r.memory_gb > 0);
  // No nvidia-smi: Windows' own list, without the remote and basic adapters; no WSL --version: an inbox WSL with distros.
  const r2 = await machineReport({ platform: 'win32', env: {}, home: tmp.dir, run: async (c: string, a: string[]) => (c === 'powershell.exe' ? 'Microsoft Remote Display Adapter\r\nAMD Radeon RX 7900\r\n' : c === 'wsl.exe' && a[0] === '--list' ? 'Ubuntu' : null) });
  assert.deepEqual([r2.gpu, r2.wsl, r2.screen, r2.admin], ['AMD Radeon RX 7900', { present: true, version: null }, null, null]);
  // Linux inside WSL: no screen of its own.
  const r3 = await machineReport({ platform: 'linux', env: { DISPLAY: ':0' }, home: tmp.dir, run: async () => null, read: (f: string) => (f === '/proc/version' ? 'Linux version 5.15 (microsoft-standard-WSL2)' : 'PRETTY_NAME="Ubuntu 24.04 LTS"\n') });
  assert.deepEqual([r3.os, r3.os_name, r3.in_wsl, r3.wsl, r3.screen, r3.gpu], ['linux', 'Ubuntu 24.04 LTS', true, null, false, null]);
  // Linux with no nvidia-smi: the card's maker from the kernel, a graphics card before the processor's own.
  const cards: Record<string, string> = { '/sys/class/drm/card0/device/vendor': '0x8086\n', '/sys/class/drm/card1/device/vendor': '0x1002\n' };
  const r4 = await machineReport({ platform: 'linux', env: {}, home: tmp.dir, run: async () => null, read: (f: string) => cards[f] ?? '' });
  assert.equal(r4.gpu, 'AMD GPU');
});

test('the agent swaps a code once, keeps what came back for the same command pasted again, and refuses a bad answer', async () => {
  const dir = join(tmp.dir, 'agent');
  mkdirSync(dir);
  const file = join(dir, 'machine-agent.join.json');
  const token = `ccm_7_${'x'.repeat(43)}`;
  let posts = 0;
  const post = async (_url: URL, init: RequestInit) => {
    posts++;
    assert.equal(JSON.parse(String(init.body)).code, 'cj_AAAAAAAAAAAA');
    return new Response(JSON.stringify({ id: 7, name: 'desk', token }), { status: 201 });
  };
  const args = { appUrl: 'https://m.example:8574', code: 'cj_AAAAAAAAAAAA', file, report: {}, post: post as typeof fetch };
  assert.deepEqual(await joinWithCode(args), { name: 'desk', token });
  assert.equal(statSync(file).mode & 0o777, 0o600, 'only its person reads the token');
  assert.ok(!readFileSync(file, 'utf8').includes('cj_AAAAAAAAAAAA'), 'the code is kept hashed there too');
  assert.deepEqual(await joinWithCode(args), { name: 'desk', token });
  assert.equal(posts, 1, 'the same command again uses the kept token, not the used code');
  const refused = async () => new Response(JSON.stringify({ error: 'This join code is used' }), { status: 410 });
  await assert.rejects(joinWithCode({ ...args, code: 'cj_BBBBBBBBBBBB', post: refused as typeof fetch }), /refused the join code \(410\): This join code is used/);
  const odd = async () => new Response(JSON.stringify({ name: 'x; rm -rf ~', token }), { status: 201 });
  await assert.rejects(joinWithCode({ ...args, code: 'cj_CCCCCCCCCCCC', post: odd as typeof fetch }), /not a machine token/);
});

test('the commands carry the address and code, and the Windows one registers the same task with what the code swapped for', () => {
  assert.equal(machineJoinPosix('https://m', 'cj_AAAAAAAAAAAA'), 'mkdir -p ~/coordinator-agent && cd ~/coordinator-agent &&\ncurl -fsSLO https://m/machine-agent.mjs &&\nnode machine-agent.mjs https://m --join cj_AAAAAAAAAAAA --config machine-agent.json --install');
  const win = machineJoinWindows('https://m', 'cj_AAAAAAAAAAAA');
  const at = (s: string) => win.indexOf(s);
  assert.ok(at('--join cj_AAAAAAAAAAAA') > at('curl.exe') && at('--join') < at('Register-ScheduledTask'), 'joined after the download, before any task');
  assert.match(win, /if \(\$LASTEXITCODE\) \{ throw "The app did not take the join code/);
  assert.match(win, /-Argument "--headless `"\$node`" `"\$dir\\machine-agent\.mjs`" https:\/\/m \$token --config /);
  assert.match(win, /Register-ScheduledTask -Force -TaskName "Coordinator agent \(\$name\)"/);
  // The lines it prints expand $name only; everything else stays as typed.
  assert.match(win, /"Stop it: [^\n]*-TaskName `"Coordinator agent \(\$name\)`"[^\n]*Stop-Process -Id `\$_\.ProcessId -Force }"\n/);
  // The token line is the same script with the name and token written in.
  assert.match(machineSetupWindows('https://m', 'pc', 'ccm_1_x'), /'Its output: Get-Content -Wait -Encoding UTF8 "\$env:USERPROFILE\\coordinator-agent\\machine-agent-pc\.log"'/);
  assert.deepEqual(
    ['Win32', 'MacIntel', 'Linux x86_64', 'iPhone', ''].map((p) => guessJoinOs(p, p === 'iPhone' ? 'iPhone' : '')),
    ['windows', 'macos', 'linux', 'windows', 'windows'],
  );
});

test('Connect a computer end to end: the real agent joins with the code, the row is named from its hostname and the panel sees it connected', async () => {
  srv = await bootServer({ root: join(tmp.dir, 'srv'), stdout: true });
  procs.push(srv.proc);
  const base = srv.base;
  const call = async (path: string, body?: unknown, method = 'GET') => ok(await srv!.call(path, body, method));
  // A person who isn't an admin, with their own login: anyone in a scheme connects their own computer.
  const person = async (name: string) => {
    const made = await call('/api/people', { name }, 'POST');
    const invite = await fetch(`${base}/api/invite/${made.token}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: `${name}-password-1` }) });
    const cookie = invite.headers.get('set-cookie')!.split(';')[0];
    return async <T = Record<string, unknown>>(path: string, body?: unknown, method = 'GET') => {
      const res = await fetch(base + path, { method, headers: { Cookie: cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
      return { status: res.status, data: await json<T>(res) };
    };
  };
  const dana = await person('Dana');
  const eli = await person('Eli');
  const { status, data: code } = await dana<{ id: number; code: string; agent_url: string; expires_at: number }>('/api/machines/joins', {}, 'POST');
  assert.equal(status, 201);
  assert.match(code.agent_url, /^https?:\/\//, 'the address the command dials');
  assert.equal((await dana(`/api/machines/joins/${code.id}`)).data.state, 'waiting');
  assert.equal((await eli(`/api/machines/joins/${code.id}`)).status, 404, 'only who made it sees how it goes');

  const dir = join(tmp.dir, 'pc');
  mkdirSync(dir);
  const agent = spawn(process.execPath, [join(repo, 'public/machine-agent.mjs'), base, '--join', code.code, '--config', join(dir, 'machine-agent.json')], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, MACHINES_URL: undefined } });
  procs.push(agent);
  let out = '';
  agent.stdout!.on('data', (d) => (out += d));
  agent.stderr!.on('data', (d) => (out += d));
  const state = async () => (await dana<{ state: string; machine: { id: number; name: string; owner_id: number; report: { os: string; threads: number }; online: boolean; update: boolean } | null }>(`/api/machines/joins/${code.id}`)).data;
  await until(
    'the agent joins and connects',
    async () => (await state()).state === 'connected',
    undefined,
    () => `never connected:\n${out}`,
  );
  const { machine } = await state();
  assert.match(out, /Joined: this computer is /);
  assert.equal(
    machine!.name,
    nameFromHost((await import('node:os')).hostname(), () => false),
  );
  assert.deepEqual([machine!.report.os, machine!.report.threads > 0, machine!.online, machine!.update], ['linux', true, true, false]);
  assert.ok(existsSync(join(dir, 'machine-agent.join.json')));
  const mine = (await dana<{ id: number }[]>('/api/machines')).data;
  assert.deepEqual(
    mine.map((m) => m.id),
    [machine!.id],
    'it is Dana’s own',
  );
  // The code is spent: another PC with it is refused, and makes no row.
  const res = await fetch(`${base}/api/machines/join`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: code.code, host: 'other-pc' }) });
  assert.equal(res.status, 410);
  assert.equal((await call('/api/machines')).length, 1);

  // An agent from before posts its info with no report: its row offers Update, whose code reconnects the same row.
  agent.kill();
  await until('the agent is gone', async () => !(await state()).machine?.online);
  const token = (await dana<{ token: string }>(`/api/machines/${machine!.id}/token`)).data.token;
  const old = new AbortController();
  const stream = await fetch(`${base}/api/machines/connect?host=old`, { headers: { Authorization: `Bearer ${token}` }, signal: old.signal });
  assert.equal(stream.status, 200);
  assert.equal((await fetch(`${base}/api/machines/info`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ v: 2, found: [] }) })).status, 202);
  await until('its row offers Update', async () => (await dana<{ update: boolean }[]>('/api/machines')).data[0]?.update === true);
  assert.equal((await eli(`/api/machines/${machine!.id}/join`, {}, 'POST')).status, 404, 'only who manages it updates it');
  const upd = (await dana<{ id: number; code: string; name: string }>(`/api/machines/${machine!.id}/join`, {}, 'POST')).data;
  assert.equal(upd.name, machine!.name);
  const swapped = await fetch(`${base}/api/machines/join`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: upd.code, report: { os: 'windows', host: 'X' } }) });
  const back = await json<{ id: number; name: string; token: string }>(swapped);
  assert.deepEqual([back.id, back.name], [machine!.id, machine!.name]);
  assert.notEqual(back.token, token);
  old.abort();
  assert.equal((await call('/api/machines')).length, 1, 'an Update makes no second row');
});
