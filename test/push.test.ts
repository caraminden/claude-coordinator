import assert from 'node:assert/strict';
import { createDecipheriv, createECDH, createPublicKey, hkdfSync, randomBytes, verify } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store, type Ticket } from '../src/db.ts';
import { Pusher, type PushTrigger, desktopId, encryptPayload, loadVapidKeys, notificationFor, validSubscription, vapidJwt } from '../src/push.ts';
import { GLOBAL_OWNER } from '../src/properties.ts';

const root = mkdtempSync(join(tmpdir(), 'push-'));
after(() => rmSync(root, { recursive: true, force: true }));

/** What a browser does with a push message: undo encryptPayload with its own private key. */
function decrypt(body: Buffer, uaPrivate: Buffer, authB64: string): Buffer {
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const ua = createECDH('prime256v1');
  ua.setPrivateKey(uaPrivate);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', ua.computeSecret(asPublic), Buffer.from(authB64, 'base64url'), keyInfo, 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const data = body.subarray(21 + idlen);
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(data.subarray(-16));
  const plain = Buffer.concat([decipher.update(data.subarray(0, -16)), decipher.final()]);
  assert.equal(plain.at(-1), 2, 'last-record delimiter');
  return plain.subarray(0, -1);
}

/** A browser's side of a subscription. */
function browser(endpoint: string) {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = randomBytes(16).toString('base64url');
  return { ecdh, endpoint, p256dh: ecdh.getPublicKey().toString('base64url'), auth };
}

test('encryption matches the RFC 8291 example', () => {
  // RFC 8291 section 5 and appendix A.
  const body = encryptPayload(
    Buffer.from('When I grow up, I want to be a watermelon'),
    'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
    'BTBZMqHH6r4Tts7J_aSIgg',
    Buffer.from('DGv6ra1nlYgDCS1FRnbzlw', 'base64url'),
    Buffer.from('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw', 'base64url'),
  );
  assert.equal(body.toString('base64url'), 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN');
  const uaPrivate = Buffer.from('q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94', 'base64url');
  assert.equal(decrypt(body, uaPrivate, 'BTBZMqHH6r4Tts7J_aSIgg').toString(), 'When I grow up, I want to be a watermelon');
});

test('each message gets a fresh salt and key, and the browser can read it', () => {
  const b = browser('https://push.example/x');
  const one = encryptPayload(Buffer.from('hi'), b.p256dh, b.auth);
  const two = encryptPayload(Buffer.from('hi'), b.p256dh, b.auth);
  assert.notDeepEqual(one.subarray(0, 86), two.subarray(0, 86));
  assert.equal(one.readUInt32BE(16), 4096);
  assert.equal(decrypt(two, b.ecdh.getPrivateKey(), b.auth).toString(), 'hi');
  assert.throws(() => encryptPayload(Buffer.alloc(5000), b.p256dh, b.auth), /too large/);
});

test('VAPID keys are made once, kept with mode 600, and sign ES256 JWTs', () => {
  const dir = join(root, 'keys');
  mkdirSync(dir);
  const keys = loadVapidKeys(dir);
  assert.equal(statSync(join(dir, 'vapid.json')).mode & 0o777, 0o600);
  assert.equal(loadVapidKeys(dir).publicKey, keys.publicKey, 'the same key on the next start');
  const pub = Buffer.from(keys.publicKey, 'base64url');
  assert.equal(pub.length, 65);
  assert.equal(pub[0], 4);

  const now = Date.now();
  const jwt = vapidJwt('https://fcm.googleapis.com', 'https://app.example', keys.privateKey, now);
  const [h, c, s] = jwt.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url').toString()), { typ: 'JWT', alg: 'ES256' });
  const claims = JSON.parse(Buffer.from(c, 'base64url').toString());
  assert.equal(claims.aud, 'https://fcm.googleapis.com');
  assert.equal(claims.sub, 'https://app.example');
  assert.equal(claims.exp, Math.floor(now / 1000) + 12 * 3600, 'within the 24 hours RFC 8292 allows');
  const sig = Buffer.from(s, 'base64url');
  assert.equal(sig.length, 64, 'raw r||s, not DER');
  const jwk = JSON.parse(readFileSync(join(dir, 'vapid.json'), 'utf8'));
  const publicKey = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }, format: 'jwk' });
  assert.ok(verify('sha256', Buffer.from(`${h}.${c}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, sig));
});

const ticket = (over: Partial<Ticket> = {}) => ({ id: 7, project_id: 2, number: 34, kind: 'ticket', title: 'Web Push', note: null, state: null, ...over }) as Ticket;

test('only decisions, blockers and results make a notification', () => {
  const q = notificationFor(ticket(), { kind: 'question', questions: [{ question: 'Tabs or a list?' }, { question: 'Colour?' }] });
  assert.deepEqual(q, { title: '#34 Web Push', body: 'Tabs or a list? (+1 more)', tag: 'thread-7', url: '/c/#/p/2/t/34' });
  assert.equal(notificationFor(ticket(), { kind: 'plan', summary: 'Usage bar in the top bar' })?.body, 'Plan to approve: Usage bar in the top bar');
  assert.equal(notificationFor(ticket(), { kind: 'error', text: 'claude exited with code 1:\nboom' })?.body, 'Turn failed: claude exited with code 1:');
  assert.equal(notificationFor(ticket(), { kind: 'spend', text: 'This turn has used about $30 in 70 min.', eventId: 5 })?.url, '/c/#/p/2/t/34?e=5');
  assert.equal(notificationFor(ticket(), { kind: 'state', state: 'ready', note: 'PR #12 open' })?.body, 'PR #12 open');
  assert.equal(notificationFor(ticket(), { kind: 'state', state: 'try', note: null })?.body, 'Ready to try');
  assert.equal(notificationFor(ticket(), { kind: 'state', state: 'blocked', note: 'needs a token' })?.body, 'needs a token');
  for (const state of ['parked', 'outside', null]) assert.equal(notificationFor(ticket(), { kind: 'state', state, note: 'x' }), null);
  const coord = notificationFor(ticket({ kind: 'coordinator', number: null }), { kind: 'question', questions: [{ question: 'Which first?' }] }, 'Coordinator app');
  assert.equal(coord?.title, 'Coordinator app Taskmaster');
  assert.equal(coord?.url, '/c/#/p/2');
  // Clicking one opens the chat at what it's about (#236): its card or error, or a state's latest reply.
  assert.equal(notificationFor(ticket(), { kind: 'plan', summary: 's', eventId: 41 })?.url, '/c/#/p/2/t/34?e=41');
  assert.equal(notificationFor(ticket({ kind: 'coordinator', number: null }), { kind: 'error', text: 'boom', eventId: 9 })?.url, '/c/#/p/2?e=9');
  assert.equal(notificationFor(ticket(), { kind: 'state', state: 'try', note: null })?.url, '/c/#/p/2/t/34?e=latest');
  assert.ok(notificationFor(ticket(), { kind: 'question', questions: [{ question: 'x'.repeat(1000) }] })!.body.length <= 300);
});

test('subscriptions must be https with well-formed keys', () => {
  const b = browser('https://push.example/a');
  assert.ok(validSubscription({ endpoint: b.endpoint, keys: { p256dh: b.p256dh, auth: b.auth } }));
  assert.ok(!validSubscription({ endpoint: 'http://push.example/a', keys: { p256dh: b.p256dh, auth: b.auth } }));
  assert.ok(!validSubscription({ endpoint: b.endpoint, keys: { p256dh: 'abc', auth: b.auth } }));
  assert.ok(!validSubscription({ endpoint: b.endpoint, keys: { p256dh: b.p256dh } }));
});

test('notify skips whoever caused it, muted devices and people outside the scheme, and drops gone subscriptions', async () => {
  const store = new Store(join(root, 'notify.db'));
  const cara = store.createUser({ name: 'Cara', login: 'cara', admin: true });
  const project = store.createProject('P', null, cara.id);
  const other = store.createProject('Q', null, cara.id);
  for (const name of ['Josh', 'Cody']) store.addMember(project.id, store.createUser({ name, login: name.toLowerCase() }).id);
  store.createUser({ name: 'Olive', login: 'olive' }); // in no scheme
  const t = store.createTicket({ project_id: project.id, title: 'Fix it', permission_mode: 'default', created_by: 'Cara' });
  const browsers = {
    cara: browser('https://push.example/cara'),
    josh: browser('https://push.example/josh'),
    joshOld: browser('https://push.example/josh-old'),
    joshGone: browser('https://push.example/josh-gone'),
    cody: browser('https://push.example/cody'),
    flaky: browser('https://push.example/flaky'),
    olive: browser('https://push.example/olive'),
    stranger: browser('https://push.example/stranger'),
  };
  const owner: Record<string, string> = { cara: 'Cara', josh: 'Josh', joshOld: 'Josh', joshGone: 'Josh', cody: 'Cody', flaky: 'Cody', olive: 'Olive', stranger: 'Someone' };
  for (const [k, b] of Object.entries(browsers)) store.savePushSubscription(owner[k], b.endpoint, b.p256dh, b.auth);
  store.setPushMuted(browsers.cody.endpoint, [project.id]);
  store.setPushMuted(browsers.flaky.endpoint, [other.id]);

  const status: Record<string, number> = { [browsers.joshOld.endpoint]: 410, [browsers.joshGone.endpoint]: 404, [browsers.flaky.endpoint]: 500 };
  const sent: { url: string; headers: Record<string, string>; body: Buffer }[] = [];
  const fakeFetch = (async (url: string, init: any) => {
    sent.push({ url, headers: init.headers, body: init.body });
    return new Response('', { status: status[url] ?? 201 });
  }) as unknown as typeof fetch;
  const pusher = new Pusher(store, loadVapidKeys(root), fakeFetch);
  pusher.subject = 'https://app.example';
  const origError = console.error;
  console.error = () => {};
  try {
    await pusher.notify(t, { kind: 'state', state: 'ready', note: 'Merged' }, 'Cara');
  } finally {
    console.error = origError;
  }

  assert.deepEqual(sent.map((s) => s.url).sort(), [browsers.flaky, browsers.josh, browsers.joshGone, browsers.joshOld].map((b) => b.endpoint).sort());
  const toJosh = sent.find((s) => s.url === browsers.josh.endpoint)!;
  assert.match(toJosh.headers.Authorization, new RegExp(`^vapid t=[\\w-]+\\.[\\w-]+\\.[\\w-]+, k=${pusher.publicKey}$`));
  assert.equal(toJosh.headers['Content-Encoding'], 'aes128gcm');
  assert.equal(toJosh.headers.Topic, `thread-${t.id}`);
  assert.ok(Number(toJosh.headers.TTL) > 0);
  const msg = JSON.parse(decrypt(toJosh.body, browsers.josh.ecdh.getPrivateKey(), browsers.josh.auth).toString());
  assert.deepEqual(msg, { title: `#${t.number} Fix it`, body: 'Merged', tag: `thread-${t.id}`, url: `/c/#/p/${project.id}/t/${t.number}?e=latest` });

  // 404 and 410 mean the browser unsubscribed; anything else may be temporary. Outsiders' browsers stay, unsent.
  assert.deepEqual(
    store
      .listPushSubscriptions()
      .map((s) => s.endpoint)
      .sort(),
    [browsers.cara, browsers.cody, browsers.flaky, browsers.josh, browsers.olive, browsers.stranger].map((b) => b.endpoint).sort(),
  );

  // Nothing at all for a reply-like state.
  sent.length = 0;
  await pusher.notify(t, { kind: 'state', state: 'parked', note: 'later' });
  assert.equal(sent.length, 0);

  // A browser someone else signs in on becomes theirs, mutes and all reset.
  store.savePushSubscription('Josh', browsers.cody.endpoint, browsers.cody.p256dh, browsers.cody.auth);
  assert.equal(store.getPushSubscription(browsers.cody.endpoint)!.name, 'Josh');
  assert.equal(store.getPushSubscription(browsers.cody.endpoint)!.muted, '[]');
});

test("a pinned-only device hears about the minions its person pinned, anyone's, while they can still see the scheme", async () => {
  const store = new Store(join(root, 'pinned.db'));
  const cara = store.createUser({ name: 'Cara', login: 'cara', admin: true });
  const josh = store.createUser({ name: 'Josh', login: 'josh' });
  const p = store.createProject('P', null, cara.id);
  const q = store.createProject('Q', null, cara.id);
  store.addMember(p.id, josh.id);
  store.addMember(q.id, josh.id);
  const mk = (project_id: number, title: string, created_by: string, kind: 'ticket' | 'coordinator' = 'ticket') => store.createTicket({ project_id, title, permission_mode: 'default', created_by, kind });
  const ownPinned = mk(p.id, 'Own, pinned', 'Josh');
  const ownUnpinned = mk(p.id, 'Own, not pinned', 'Josh');
  const carasPinned = mk(p.id, "Cara's, pinned by Josh", 'Cara');
  const leftScheme = mk(q.id, 'In a scheme Josh left', 'Cara');
  for (const t of [ownPinned, carasPinned, leftScheme]) store.setTicketPinned('Josh', t.id, true);
  store.removeMember(q.id, josh.id);

  const all = browser('https://push.example/cara-all');
  const pinned = browser('https://push.example/josh-pinned');
  store.savePushSubscription('Cara', all.endpoint, all.p256dh, all.auth);
  store.savePushSubscription('Josh', pinned.endpoint, pinned.p256dh, pinned.auth);
  store.setPushOnlyPinned(pinned.endpoint, true);

  const sent: string[] = [];
  const fakeFetch = (async (url: string) => (sent.push(url), new Response('', { status: 201 }))) as unknown as typeof fetch;
  const pusher = new Pusher(store, loadVapidKeys(root), fakeFetch);
  const who = async (t: Ticket) => {
    sent.length = 0;
    await pusher.notify(t, { kind: 'state', state: 'blocked', note: 'stuck' });
    return sent.map((url) => url.split('/').pop()).sort();
  };
  // An every-minion device hears about all of them; the pinned-only one only its person's pins.
  assert.deepEqual(await who(ownPinned), ['cara-all', 'josh-pinned']);
  assert.deepEqual(await who(ownUnpinned), ['cara-all']);
  assert.deepEqual(await who(carasPinned), ['cara-all', 'josh-pinned']);
  // A pin left behind in a scheme Josh is no longer in sends nothing.
  assert.deepEqual(await who(leftScheme), ['cara-all']);
  // The Taskmaster can't be pinned, so it always reaches a pinned-only device.
  assert.deepEqual(await who(mk(p.id, 'Taskmaster', 'Cara', 'coordinator')), ['cara-all', 'josh-pinned']);

  // Unpinning stops it; a browser someone else signs in on starts back at every minion.
  store.setTicketPinned('Josh', ownPinned.id, false);
  assert.deepEqual(await who(ownPinned), ['cara-all']);
  store.savePushSubscription('Cara', pinned.endpoint, pinned.p256dh, pinned.auth);
  assert.equal(store.getPushSubscription(pinned.endpoint)!.only_pinned, 0);
});

test('a scheme someone hid sends them no pushes, and Unhide brings them back (#226)', async () => {
  const store = new Store(join(root, 'hidden.db'));
  const cara = store.createUser({ name: 'Cara', login: 'cara', admin: true });
  const josh = store.createUser({ name: 'Josh', login: 'josh' });
  const p = store.createProject('Obsidian', null, josh.id);
  store.addMember(p.id, cara.id); // a member: admin reach alone sends no pushes (#674)
  const t = store.createTicket({ project_id: p.id, title: 'Ready', permission_mode: 'default', created_by: 'Josh', kind: 'ticket' });
  const coordinator = store.createTicket({ project_id: p.id, title: 'Coordinator', permission_mode: 'default', created_by: 'Josh', kind: 'coordinator' });
  for (const name of ['Cara', 'Josh']) {
    const b = browser(`https://push.example/${name}`);
    store.savePushSubscription(name, b.endpoint, b.p256dh, b.auth);
  }
  const sent: string[] = [];
  const fakeFetch = (async (url: string) => (sent.push(url), new Response('', { status: 201 }))) as unknown as typeof fetch;
  const pusher = new Pusher(store, loadVapidKeys(root), fakeFetch);
  const who = async (ticket: Ticket) => {
    sent.length = 0;
    await pusher.notify(ticket, { kind: 'state', state: 'blocked', note: 'stuck' });
    return sent.map((url) => url.split('/').pop()).sort();
  };
  store.setProjectHidden(cara.id, p.id, true);
  // Cara's hide is hers: Josh still hears, and the Taskmaster's news skips her too.
  assert.deepEqual(await who(t), ['Josh']);
  assert.deepEqual(await who(coordinator), ['Josh']);
  store.setProjectHidden(cara.id, p.id, false);
  assert.deepEqual(await who(t), ['Cara', 'Josh']);
  store.db.close();
});

test("admin reach sends no pushes: only a scheme's owner and members hear about it (#674)", async () => {
  // Cara, 2026-11-14, on #674's card: pushes follow real membership, "Members only".
  const store = new Store(join(root, 'members-only.db'));
  const cara = store.createUser({ name: 'Cara', login: 'cara', admin: true });
  const alex = store.createUser({ name: 'Alex', login: 'alex' });
  const josh = store.createUser({ name: 'Josh', login: 'josh' });
  for (const name of ['Delve', 'Citadel']) store.createProject(name, null, cara.id);
  assert.ok(store.getProject(GLOBAL_OWNER), 'the second scheme is the Citadel scheme');
  store.addMember(GLOBAL_OWNER, alex.id); // admin reach, by Citadel membership
  const threadspace = store.createProject('Threadspace', null, josh.id);
  const t = store.createTicket({ project_id: threadspace.id, title: 'Ready', permission_mode: 'default', created_by: 'Josh', kind: 'ticket' });
  for (const name of ['Cara', 'Alex', 'Josh']) {
    const b = browser(`https://push.example/${name}`);
    store.savePushSubscription(name, b.endpoint, b.p256dh, b.auth);
  }
  const sent: string[] = [];
  const fakeFetch = (async (url: string) => (sent.push(url), new Response('', { status: 201 }))) as unknown as typeof fetch;
  const pusher = new Pusher(store, loadVapidKeys(root), fakeFetch);
  await pusher.notify(t, { kind: 'state', state: 'blocked', note: 'stuck' });
  assert.deepEqual(
    sent.map((url) => url.split('/').pop()),
    ['Josh'],
    'neither the admin flag nor Citadel membership makes you a member',
  );
  sent.length = 0;
  store.addMember(threadspace.id, alex.id);
  await pusher.notify(t, { kind: 'state', state: 'blocked', note: 'stuck' });
  assert.deepEqual(sent.map((url) => url.split('/').pop()).sort(), ['Alex', 'Josh'], 'added to it: he hears');
  store.db.close();
});

test('a card addressed to one person pings only their devices (#687)', async () => {
  const store = new Store(join(root, 'direct.db'));
  const cara = store.createUser({ name: 'Cara', login: 'cara' });
  const project = store.createProject('P', null, cara.id);
  for (const name of ['Josh', 'Cody']) store.addMember(project.id, store.createUser({ name, login: name.toLowerCase() }).id);
  const t = store.createTicket({ project_id: project.id, title: 'Ask', permission_mode: 'default', created_by: 'Cara' });
  for (const name of ['Cara', 'Josh', 'Cody']) {
    const b = browser(`https://push.example/${name}`);
    store.savePushSubscription(name, b.endpoint, b.p256dh, b.auth);
  }
  const sent: string[] = [];
  const fakeFetch = (async (url: string) => (sent.push(url), new Response('', { status: 201 }))) as unknown as typeof fetch;
  const pusher = new Pusher(store, loadVapidKeys(root), fakeFetch);
  await pusher.notify(t, { kind: 'question', questions: [{ question: 'Three slots?' }], to: 'Josh' });
  await pusher.notify(t, { kind: 'plan', summary: 'Three slots', to: 'josh' });
  assert.deepEqual(
    sent.map((url) => url.split('/').pop()),
    ['Josh', 'Josh'],
  );
  sent.length = 0;
  await pusher.notify(t, { kind: 'question', questions: [{ question: 'Anyone?' }] });
  assert.deepEqual(sent.map((url) => url.split('/').pop()).sort(), ['Cara', 'Cody', 'Josh'], 'a card to everyone still pings everyone');
  store.db.close();
});

test('a minion with an owner pings its owner, whoever pinned it and devices set to everything; no owner pings everyone (#690)', async () => {
  // Cara, 2026-11-14: "Owner only, switch for all".
  const store = new Store(join(root, 'owner.db'));
  const cara = store.createUser({ name: 'Cara', login: 'cara' });
  const p = store.createProject('P', null, cara.id);
  const q = store.createProject('Q', null, cara.id);
  for (const name of ['Josh', 'Cody', 'Ada']) {
    const u = store.createUser({ name, login: name.toLowerCase() });
    store.addMember(p.id, u.id);
    store.addMember(q.id, u.id);
  }
  const mk = (title: string, assigned?: string, kind: 'ticket' | 'coordinator' = 'ticket') => {
    const t = store.createTicket({ project_id: p.id, title, permission_mode: 'default', created_by: 'Cara', kind });
    if (assigned) store.props.set('minion', t.id, p.id, { assigned }, 'Cara');
    return t;
  };
  for (const name of ['Cara', 'Josh', 'Cody', 'Ada']) {
    const b = browser(`https://push.example/${name}`);
    store.savePushSubscription(name, b.endpoint, b.p256dh, b.auth);
  }
  store.setPushEverything('https://push.example/Cody', [p.id]);
  store.setPushEverything('https://push.example/Ada', [q.id]); // everything, but in another scheme
  const sent: string[] = [];
  const fakeFetch = (async (url: string) => (sent.push(url), new Response('', { status: 201 }))) as unknown as typeof fetch;
  const pusher = new Pusher(store, loadVapidKeys(root), fakeFetch);
  const who = async (t: Ticket, trigger: PushTrigger = { kind: 'state', state: 'ready', note: 'done' }) => {
    sent.length = 0;
    await pusher.notify(t, trigger);
    return sent.map((url) => url.split('/').pop()).sort();
  };

  const joshs = mk("Josh's", 'Josh');
  assert.deepEqual(await who(joshs), ['Cody', 'Josh'], 'the owner and the everything device');
  assert.deepEqual(await who(joshs, { kind: 'error', text: 'boom' }), ['Cody', 'Josh'], 'a failed turn too');
  assert.deepEqual(await who(joshs, { kind: 'question', questions: [{ question: 'Which?' }] }), ['Cody', 'Josh'], 'a card to no one in particular too');
  assert.deepEqual(await who(joshs, { kind: 'question', questions: [{ question: 'Ada?' }], to: 'Ada' }), ['Ada'], 'a card to Ada goes to her alone');
  // A spend alert (#723) also reaches the turn's person, here Ada, on top of the usual people.
  assert.deepEqual(await who(joshs, { kind: 'spend', text: 'This turn has used about $30 in 70 min.', also: 'ada' }), ['Ada', 'Cody', 'Josh']);
  store.setTicketPinned('Ada', joshs.id, true);
  assert.deepEqual(await who(joshs), ['Ada', 'Cody', 'Josh'], 'pinning follows a minion');
  // Stored by login, any case, it still finds him.
  assert.deepEqual(await who(mk('By login', 'JOSH')), ['Cody', 'Josh']);
  // No owner and the Taskmaster: everyone, as before.
  const all = ['Ada', 'Cara', 'Cody', 'Josh'];
  assert.deepEqual(await who(mk("Nobody's")), all);
  const tm = mk('Taskmaster', 'Josh', 'coordinator');
  assert.deepEqual(await who(tm), all);
  // A split scheme's own Taskmasters (#919) ping their person, as their cards are in that person's Needs you alone.
  const joshTm = store.splitScheme(p.id, store.findUser('name', 'Josh')!.id);
  assert.deepEqual(await who(joshTm), ['Cody', 'Josh'], "Josh's Taskmaster");
  assert.deepEqual(await who(store.getTicket(tm.id)!), ['Cara', 'Cody'], "the old row is Cara's now");
  assert.deepEqual(await who(store.getOverlord(p.id)!), all, "the Overlord is everyone's");
  assert.deepEqual(await who(joshTm, { kind: 'question', questions: [{ question: 'Ada?' }], to: 'Ada' }), ['Ada'], 'a card to Ada still goes to her');
  // An assignee who is nobody here, or who left the scheme, hands it to the scheme's owner, not everyone (#1449).
  assert.deepEqual(await who(mk('Gone', 'Someone')), ['Cara', 'Cody'], 'an owner who is nobody here');
  const leaving = mk('Leaving', 'Josh');
  store.removeMember(p.id, store.findUser('name', 'Josh')!.id);
  assert.deepEqual(await who(leaving), ['Cara', 'Cody']);
  // The everything switch is per scheme and resets when someone else signs in on the device.
  store.addMember(p.id, store.findUser('name', 'Josh')!.id);
  store.setPushEverything('https://push.example/Cody', []);
  assert.deepEqual(await who(joshs), ['Ada', 'Josh']);
  store.setPushEverything('https://push.example/Josh', [p.id]);
  const b = browser('https://push.example/Josh');
  store.savePushSubscription('Cara', b.endpoint, b.p256dh, b.auth);
  assert.equal(store.getPushSubscription(b.endpoint)!.everything, '[]');
  store.db.close();
});

test("a desktop app's device hears through its page, never a push service, and is kept when nobody is listening (#1186)", async () => {
  const store = new Store(join(root, 'desktop.db'));
  const cara = store.createUser({ name: 'Cara', login: 'cara', admin: true });
  const project = store.createProject('P', null, cara.id);
  const t = store.createTicket({ project_id: project.id, title: 'Fix it', permission_mode: 'default', created_by: 'Cara' });
  const web = browser('https://push.example/cara');
  store.savePushSubscription('Cara', web.endpoint, web.p256dh, web.auth);
  store.savePushSubscription('Cara', 'desktop:5f0c2a7e-1b9d-4c1e-9a3f-2d6b8e7c4a10', '', '');
  const fetched: string[] = [];
  const pusher = new Pusher(store, loadVapidKeys(root), (async (url: string) => (fetched.push(url), new Response('', { status: 201 }))) as unknown as typeof fetch);
  await pusher.notify(t, { kind: 'state', state: 'ready', note: 'Done' });
  assert.deepEqual(fetched, [web.endpoint]);
  const local: [string, string, string][] = [];
  pusher.local = (sub, msg) => local.push([sub.name, sub.endpoint, msg.body]);
  await pusher.notify(t, { kind: 'state', state: 'ready', note: 'Again' });
  assert.deepEqual(local, [['Cara', 'desktop:5f0c2a7e-1b9d-4c1e-9a3f-2d6b8e7c4a10', 'Again']]);
  assert.equal(store.listPushSubscriptions().length, 2);
  assert.equal(desktopId('5f0c2a7e-1b9d-4c1e-9a3f-2d6b8e7c4a10'), '5f0c2a7e-1b9d-4c1e-9a3f-2d6b8e7c4a10');
  for (const bad of ['', 'https://push.example/x', '../5f0c2a7e', 5]) assert.equal(desktopId(bad), null);
});
