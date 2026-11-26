// The CI store's routes (#658, src/ci-store.ts): a runner's job uploads, and reads its own commit's files (#1266), on
// the machines listener; a scheme's members, minions, Taskmaster and contraptions list and read its files on the app's
// own address.
import { stat } from 'node:fs/promises';
import { LIMITS } from '../ci-numbers.ts';
import { KINDS, uploadAsk } from '../ci-store.ts';
import type { CiFile } from '../db.ts';
import { LastGreen } from '../last-green.ts';
import { HttpError, json, readJson, sendFile, type App, type Ctx, type Route } from '../http.ts';

/**
 * PUT /api/ci-store/<name>?kind=build|report|release[&target=<name>], the body the file, Authorization: Bearer <the
 * job's GitHub run token>. The scheme, workflow, run and commit come from the token, never from the caller.
 */
export const ciUploadRoute: Route = {
  method: 'PUT',
  path: '/api/ci-store/:name',
  who: 'machine',
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

/**
 * POST /api/ci-numbers, `{ "numbers": [{ "name", "value", "unit" }] }`, Authorization: Bearer <the job's GitHub run token>
 * (#1369, src/ci-numbers.ts): a run's bench timings and sizes, kept per commit for months. As with an upload, the
 * scheme, workflow, run, commit and ref come from the token.
 */
export const ciNumbersRoute: Route = {
  method: 'POST',
  path: '/api/ci-numbers',
  who: 'machine',
  async handler({ req, res, app }) {
    if (app.preview) throw new HttpError(403, 'CI numbers go to the live app, not a preview');
    const { project, claims } = await app.ciStore.caller(req);
    const { stored, steps } = app.ciNumbers.take(project, claims, await readJson(req, LIMITS.bodyBytes));
    return json(res, 201, { stored, steps: steps.map((s) => s.name) });
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
    id: f.id,
    workflow: f.workflow,
    run_id: f.run_id,
    run_attempt: f.run_attempt,
    sha: f.sha,
    ref: f.ref,
    name: f.name,
    kind: f.kind,
    target: f.target,
    size: f.size,
    sha256: f.sha256,
    created_at: f.created_at,
    published_to: f.published_to,
    /** The stable URL, and where it is on perigee for a turn that runs there. */
    url: `/api/projects/${f.project_id}/ci-files/${f.id}/${encodeURIComponent(f.name)}`,
    path: app.ciStore.path(f),
  };
}

/** A scheme's files matching the query's workflow, kind, target, name, run and commit (a prefix), newest first. */
function matching({ app, project, url }: Pick<Ctx, 'app' | 'project' | 'url'>): CiFile[] {
  const q = (k: string) => url.searchParams.get(k) ?? '';
  if (q('kind') && !(KINDS as readonly string[]).includes(q('kind'))) throw new HttpError(400, `kind must be one of ${KINDS.join(', ')}`);
  if (q('run') && !/^\d+$/.test(q('run'))) throw new HttpError(400, 'run must be a run id');
  return app.store
    .ciFiles(project.id)
    .filter((f) => (!q('workflow') || f.workflow === q('workflow')) && (!q('kind') || f.kind === q('kind')) && (!q('target') || f.target === q('target')) && (!q('name') || f.name === q('name')) && (!q('run') || f.run_id === Number(q('run'))) && (!q('commit') || f.sha.startsWith(q('commit').toLowerCase())));
}

// A contraption reads its home scheme's too (#665: Peek's app updates players from its newest build), with its key.
const readers = { who: ['person', 'minion', 'taskmaster'], homeContraption: true, refuse: "Only a scheme's members, its minions, its Taskmaster and its contraptions read its CI files" } as const;

export const ciStoreRoutes: Route[] = [
  {
    method: 'GET',
    path: '/api/projects/:project/ci-files',
    ...readers,
    handler(ctx) {
      const { app, res, project } = ctx;
      return json(res, 200, { files: matching(ctx).map((f) => ciFileView(app, f)), usage: app.ciStore.usage(project.id), rules: app.ciStore.rules });
    },
  },
  {
    // The newest match: a redirect to its stable URL, or with ?json=1 its details.
    method: 'GET',
    path: '/api/projects/:project/ci-files/latest',
    ...readers,
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
    method: 'GET',
    path: '/api/projects/:project/ci-files/pins',
    ...readers,
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
    // The scheme's CI numbers for the CI page's Numbers tab (#1369): each series' points with their commits, and its steps up.
    method: 'GET',
    path: '/api/projects/:project/ci-numbers',
    ...readers,
    handler({ app, res, project }) {
      return json(res, 200, app.ciNumbers.view(project.id));
    },
  },
  {
    // The scheme's Code tab (#1988): the last daily count of its files, and which of them an open minion is splitting. Reads no git.
    method: 'GET',
    path: '/api/projects/:project/code-counts',
    ...readers,
    async handler({ app, res, project }) {
      return json(res, 200, await app.codeCounts.view(project.id));
    },
  },
  {
    method: 'GET',
    path: '/api/projects/:project/ci-files/:file/:name',
    ...readers,
    async handler({ app, req, res, project, params }) {
      const f = named(app, params);
      if (!f || f.project_id !== project.id) throw new HttpError(404, 'No such file in the CI store');
      await send(app, req, res, f);
    },
  },
];

/** The row a download URL's id names, if its name is the file's: the name is in the URL only so a download is called what it is. */
function named(app: App, params: Record<string, string>): CiFile | undefined {
  const f = /^\d+$/.test(params.file) ? app.store.getCiFile(Number(params.file)) : undefined;
  return f && f.name === decoded(params.name) ? f : undefined;
}

async function send(app: App, req: Ctx['req'], res: Ctx['res'], f: CiFile) {
  // Turns can write the scheme's folder: serve only a plain file that is still the store's own.
  const file = await app.ciStore.plain(f).catch(() => null);
  const size = file
    ? await stat(file).then(
        (s) => s.size,
        () => null,
      )
    : null;
  if (!file || size === null) throw new HttpError(404, 'That file is no longer there');
  await sendFile(req, res, file, size, {
    'Content-Type': 'application/octet-stream',
    'Cache-Control': 'private, no-cache',
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(f.name)}`,
  });
}

/**
 * A CI job's reads, beside its upload on the machines listener (#1266; Josh's pick on Peek Auras #704, 2026-11-20: a
 * desktop e2e job takes the build windows.yml made of the same commit). Its run token names its scheme and commit, and
 * it reads only those: its scheme's files of its own commit, from any workflow.
 */
export const ciJobReadRoutes: Route[] = [
  {
    // GET /api/ci-store?commit=<its own SHA, or a prefix>&workflow=&kind=&target=&name=&run=: the matches, newest first.
    method: 'GET',
    path: '/api/ci-store',
    who: 'machine',
    async handler({ app, req, res, url }) {
      const { project, claims } = await app.ciStore.caller(req);
      const commit = (url.searchParams.get('commit') ?? '').toLowerCase();
      if (commit && !claims.sha.startsWith(commit)) throw new HttpError(403, `A job reads only its own commit's files (${claims.sha}), not ${commit}`);
      const files = matching({ app, project, url }).filter((f) => f.sha === claims.sha);
      return json(res, 200, { files: files.map((f) => ({ ...ciFileView(app, f), url: `/api/ci-store/${f.id}/${encodeURIComponent(f.name)}` })) });
    },
  },
  {
    method: 'GET',
    path: '/api/ci-store/:file/:name',
    who: 'machine',
    async handler({ app, req, res, params }) {
      const { project, claims } = await app.ciStore.caller(req);
      const f = named(app, params);
      if (!f) throw new HttpError(404, 'No such file in the CI store');
      if (f.project_id !== project.id) throw new HttpError(403, `A job reads only its own scheme's files (${project.name})`);
      if (f.sha !== claims.sha) throw new HttpError(403, `A job reads only its own commit's files (${claims.sha}); that one is ${f.sha}'s`);
      await send(app, req, res, f);
    },
  },
];
