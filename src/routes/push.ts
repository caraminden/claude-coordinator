// Push notifications: each signed-in person turns them on per browser, and can mute schemes there
// or keep it to the minions they pinned.
import { validSubscription } from '../push.ts';
import { HttpError, json, readJson, type App, type Ctx, type Route } from '../http.ts';

/** This browser's subscription as the account panel needs it. */
const pushView = (app: App, endpoint: string) => {
  const row = app.store.getPushSubscription(endpoint);
  return { subscribed: !!row, muted: row ? JSON.parse(row.muted) as number[] : [], everything: row ? JSON.parse(row.everything) as number[] : [], onlyPinned: !!row?.only_pinned };
};

/** The subscription a request names, unless it is someone else's (only its own person may see or change it). */
async function named({ req, app, session }: Ctx) {
  const body = await readJson(req, 10_000);
  const endpoint = typeof body.endpoint === 'string' ? body.endpoint : '';
  const row = app.store.getPushSubscription(endpoint);
  return { body, endpoint, row, theirs: !!row && row.name !== session.name };
}

const notTheirs = { subscribed: false, muted: [], everything: [], onlyPinned: false };
const people = { who: ['person'], refuse: 'Only people get notifications' } as const;

export const pushRoutes: Route[] = [
  { method: 'GET', path: '/api/push/key', ...people, handler: ({ res, app }) => json(res, 200, { publicKey: app.pusher.publicKey }) },
  {
    method: 'PUT', path: '/api/push/subscription', ...people,
    async handler({ req, res, app, session }) {
      const body = await readJson(req, 10_000);
      if (!validSubscription(body.subscription)) throw new HttpError(400, 'Not a usable push subscription');
      const { endpoint, keys } = body.subscription;
      app.store.savePushSubscription(session.name, endpoint, keys.p256dh, keys.auth);
      if (!process.env.PUSH_SUBJECT && !app.store.getSetting('push_subject')) {
        const host = req.headers['x-forwarded-host'] ?? req.headers.host;
        app.pusher.subject = `https://${host}`;
        app.store.setSetting('push_subject', app.pusher.subject);
      }
      return json(res, 200, pushView(app, endpoint));
    },
  },
  {
    method: 'POST', path: '/api/push/subscription', ...people,
    async handler(ctx) {
      const { endpoint, theirs } = await named(ctx);
      return json(ctx.res, 200, theirs ? notTheirs : pushView(ctx.app, endpoint));
    },
  },
  {
    method: 'PATCH', path: '/api/push/subscription', ...people,
    async handler(ctx) {
      const { app, res } = ctx;
      const { body, endpoint, row, theirs } = await named(ctx);
      if (theirs) return json(res, 200, notTheirs);
      if (!row) throw new HttpError(404, 'This browser is not subscribed');
      // The device's pinned-only choice, its everything-in-this-scheme choice (#690), or a mute for one scheme.
      if (typeof body.onlyPinned === 'boolean') {
        app.store.setPushOnlyPinned(endpoint, body.onlyPinned);
        return json(res, 200, pushView(app, endpoint));
      }
      const projectId = Number(body.projectId);
      if (typeof body.everything === 'boolean') {
        const all = new Set<number>(JSON.parse(row.everything));
        if (body.everything) all.add(projectId);
        else all.delete(projectId);
        app.store.setPushEverything(endpoint, [...all].filter((id) => app.store.getProject(id)));
        return json(res, 200, pushView(app, endpoint));
      }
      const muted = new Set<number>(JSON.parse(row.muted));
      if (body.muted) muted.add(projectId);
      else muted.delete(projectId);
      app.store.setPushMuted(endpoint, [...muted].filter((id) => app.store.getProject(id)));
      return json(res, 200, pushView(app, endpoint));
    },
  },
  {
    method: 'DELETE', path: '/api/push/subscription', ...people,
    async handler(ctx) {
      const { endpoint, row, theirs } = await named(ctx);
      if (theirs) return json(ctx.res, 200, notTheirs);
      if (row) ctx.app.store.deletePushSubscription(endpoint);
      return json(ctx.res, 200, pushView(ctx.app, endpoint));
    },
  },
];
