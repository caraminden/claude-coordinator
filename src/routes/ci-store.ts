// The CI store's routes (#658, src/ci-store.ts): a runner's job uploads on the machines listener; a scheme's
// members, minions, Taskmaster and contraptions list and read its files on the app's own address.
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { KINDS, uploadAsk } from '../ci-store.ts';
import type { CiFile } from '../db.ts';
import { LastGreen } from '../last-green.ts';
import { HttpError, json, type App, type Ctx, type Route } from '../http.ts';

/**
 * PUT /api/ci-store/<name>?kind=build|report|release[&target=<name>], the body the file, Authorization: Bearer <the
 * job's GitHub run token>. The scheme, workflow, run and commit come from the token, never from the caller.
 */
export const ciUploadRoute: Route = {
  method: 'PUT', path: '/api/ci-store/:name', who: 'machine',
  async handler({ req, res, url, app, params }) {
    if (app.preview) throw new HttpError(403, 'CI uploads go to the live app, not a preview');
    try {
      const f = await app.ciStore.upload(req, uploadAsk(decoded(params.name), url.searchParams));
      return json(res, 201, { file: ciFileView(app, f) });
    } catch (err) {
      // A refusal mid-body leaves the rest unread: don't reuse the connection for it.
      res.setHeader('Connection', 'close');
      throw err;
    }
  },
};

/** A path segment decoded; '' (which no name is) when it isn't valid percent-encoding. */
function decoded(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return '';
  }
}

export function ciFileView(app: App, f: CiFile) {
  return {
    id: f.id, workflow: f.workflow, run_id: f.run_id, run_attempt: f.run_attempt, sha: f.sha, ref: f.ref, name: f.name, kind: f.kind, target: f.target,
    size: f.size, sha256: f.sha256, created_at: f.created_at, published_to: f.published_to,
    /** The stable URL, and where it is on perigee for a turn that runs there. */
    url: `/api/projects/${f.project_id}/ci-files/${f.id}/${encodeURIComponent(f.name)}`,
    path: app.ciStore.path(f),
  };
}

/** A scheme's files matching the query's workflow, kind, target, name, run and commit (a prefix), newest first. */
function matching({ app, project, url }: Ctx): CiFile[] {
  const q = (k: string) => url.searchParams.get(k) ?? '';
  if (q('kind') && !(KINDS as readonly string[]).includes(q('kind'))) throw new HttpError(400, `kind must be one of ${KINDS.join(', ')}`);
  if (q('run') && !/^\d+$/.test(q('run'))) throw new HttpError(400, 'run must be a run id');
  return app.store.ciFiles(project.id).filter((f) =>
    (!q('workflow') || f.workflow === q('workflow')) && (!q('kind') || f.kind === q('kind')) && (!q('target') || f.target === q('target')) &&
    (!q('name') || f.name === q('name')) && (!q('run') || f.run_id === Number(q('run'))) && (!q('commit') || f.sha.startsWith(q('commit').toLowerCase())));
}

// A contraption reads its home scheme's too (#665: Peek's app updates players from its newest build), with its key.
const readers = { who: ['person', 'minion', 'taskmaster'], homeContraption: true, refuse: 'Only a scheme\'s members, its minions, its Taskmaster and its contraptions read its CI files' } as const;

export const ciStoreRoutes: Route[] = [
  {
    method: 'GET', path: '/api/projects/:project/ci-files', ...readers,
    handler(ctx) {
      const { app, res, project } = ctx;
      return json(res, 200, { files: matching(ctx).map((f) => ciFileView(app, f)), usage: app.ciStore.usage(project.id), rules: app.ciStore.rules });
    },
  },
  {
    // The newest match: a redirect to its stable URL, or with ?json=1 its details.
    method: 'GET', path: '/api/projects/:project/ci-files/latest', ...readers,
    handler(ctx) {
      const f = matching(ctx)[0];
      if (!f) throw new HttpError(404, 'No file in the CI store matches');
      const view = ciFileView(ctx.app, f);
      if (ctx.url.searchParams.get('json')) return json(ctx.res, 200, { file: view });
      ctx.res.writeHead(302, { Location: view.url });
      ctx.res.end();
    },
  },
  {
    // The builds a roll back holds this scheme's CI packages at (ADR 0012, "Feed, no rebuild"): an app's updater hands
    // a pinned build out in place of the newest, even though its number is older.
    method: 'GET', path: '/api/projects/:project/ci-files/pins', ...readers,
    handler({ app, res, project }) {
      const files = app.store.ciFiles(project.id);
      const pins = Object.entries(new LastGreen(app.store).pins()).flatMap(([key, p]) => {
        const target = key.slice(key.indexOf('/') + 1);
        if (!key.startsWith(`${project.id}/`) || !p.build) return [];
        return [{ target, workflow: p.build.workflow, run_id: p.build.run, sha: p.build.sha, green: p.sha, from: p.from, by: p.by, at: p.at, files: files.filter((f) => f.run_id === p.build!.run && f.kind !== 'report').map((f) => ciFileView(app, f)) }];
      });
      return json(res, 200, { pins });
    },
  },
  {
    method: 'GET', path: '/api/projects/:project/ci-files/:file/:name', ...readers,
    async handler({ app, req, res, project, params }) {
      const f = /^\d+$/.test(params.file) ? app.store.getCiFile(Number(params.file)) : undefined;
      // The name is part of the URL only so a download is called what it is.
      if (!f || f.project_id !== project.id || f.name !== decoded(params.name)) throw new HttpError(404, 'No such file in the CI store');
      // Turns can write the scheme's folder: serve only a plain file that is still the store's own.
      const file = await app.ciStore.plain(f).catch(() => null);
      const size = file && (await stat(file).then((s) => s.size, () => null));
      if (!file || size === null) throw new HttpError(404, 'That file is no longer there');
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream', 'Content-Length': size, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-cache',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(f.name)}`,
      });
      if (req.method === 'HEAD') return res.end();
      await pipeline(createReadStream(file), res).catch(() => {});
    },
  },
];
