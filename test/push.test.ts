import assert from 'node:assert/strict';
import { createDecipheriv, createECDH, createPublicKey, hkdfSync, randomBytes, verify } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store, type Ticket } from '../src/db.ts';
import { Pusher, encryptPayload, loadVapidKeys, notificationFor, validSubscription, vapidJwt } from '../src/push.ts';

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
  assert.equal(
    body.toString('base64url'),
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
  );
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
  assert.deepEqual(q, { title: '#34 Web Push', body: 'Tabs or a list? (+1 more)', tag: 'thread-7', url: '/#/p/2/t/34' });
  assert.equal(notificationFor(ticket(), { kind: 'plan', summary: 'Usage bar in the top bar' })?.body, 'Plan to approve: Usage bar in the top bar');
  assert.equal(notificationFor(ticket(), { kind: 'error', text: 'claude exited with code 1:\nboom' })?.body, 'Turn failed: claude exited with code 1:');
  assert.equal(notificationFor(ticket(), { kind: 'state', state: 'ready', note: 'PR #12 open' })?.body, 'PR #12 open');
  assert.equal(notificationFor(ticket(), { kind: 'state', state: 'try', note: null })?.body, 'Ready for you to try');
  assert.equal(notificationFor(ticket(), { kind: 'state', state: 'blocked', note: 'needs a token' })?.body, 'needs a token');
  for (const state of ['parked', 'outside', null]) assert.equal(notificationFor(ticket(), { kind: 'state', state, note: 'x' }), null);
  const coord = notificationFor(ticket({ kind: 'coordinator', number: null }), { kind: 'question', questions: [{ question: 'Which first?' }] }, 'Coordinator app');
  assert.equal(coord?.title, 'Coordinator app Taskmaster');
  assert.equal(coord?.url, '/#/p/2');
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
  assert.deepEqual(msg, { title: `#${t.number} Fix it`, body: 'Merged', tag: `thread-${t.id}`, url: `/#/p/${project.id}/t/${t.number}` });

  // 404 and 410 mean the browser unsubscribed; anything else may be temporary. Outsiders' browsers stay, unsent.
  assert.deepEqual(store.listPushSubscriptions().map((s) => s.endpoint).sort(),
    [browsers.cara, browsers.cody, browsers.flaky, browsers.josh, browsers.olive, browsers.stranger].map((b) => b.endpoint).sort());

  // Nothing at all for a reply-like state.
  sent.length = 0;
  await pusher.notify(t, { kind: 'state', state: 'parked', note: 'later' });
  assert.equal(sent.length, 0);

  // A browser someone else signs in on becomes theirs, mutes and all reset.
  store.savePushSubscription('Josh', browsers.cody.endpoint, browsers.cody.p256dh, browsers.cody.auth);
  assert.equal(store.getPushSubscription(browsers.cody.endpoint)!.name, 'Josh');
  assert.equal(store.getPushSubscription(browsers.cody.endpoint)!.muted, '[]');
});

test('a pinned-only device hears about the minions its person pinned, anyone\'s, while they can still see the scheme', async () => {
  const store = new Store(join(root, 'pinned.db'));
  const cara = store.createUser({ name: 'Cara', login: 'cara', admin: true });
  const josh = store.createUser({ name: 'Josh', login: 'josh' });
  const p = store.createProject('P', null, cara.id);
  const q = store.createProject('Q', null, cara.id);
  store.addMember(p.id, josh.id);
  store.addMember(q.id, josh.id);
  const mk = (project_id: number, title: string, created_by: string) => store.createTicket({ project_id, title, permission_mode: 'default', created_by });
  const ownPinned = mk(p.id, 'Own, pinned', 'Josh');
  const ownUnpinned = mk(p.id, 'Own, not pinned', 'Josh');
  const carasPinned = mk(p.id, 'Cara\'s, pinned by Josh', 'Cara');
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

  // Unpinning stops it; a browser someone else signs in on starts back at every minion.
  store.setTicketPinned('Josh', ownPinned.id, false);
  assert.deepEqual(await who(ownPinned), ['cara-all']);
  store.savePushSubscription('Cara', pinned.endpoint, pinned.p256dh, pinned.auth);
  assert.equal(store.getPushSubscription(pinned.endpoint)!.only_pinned, 0);
});
