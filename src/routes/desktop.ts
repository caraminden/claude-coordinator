// Desktop apps' feeds (#1148, src/desktop-feed.ts). The launcher on a PC reads them with no login, like /api/health:
// Citadel is reachable only over the tailnet, and a build holds nothing a scheme's members couldn't already share.
// Publishing takes a scheme's minion, Taskmaster or member.
import { lstat } from 'node:fs/promises';
import { DesktopError, DesktopFeeds, type PublishAsk } from '../desktop-feed.ts';
import { HttpError, isInt, json, publicOrigin, readJson, sendFile, type App, type Ctx, type Route } from '../http.ts';
import { resolveTicketFile } from './files.ts';

function desktop(app: App) {
  if (!app.desktop) throw new HttpError(404, 'Desktop feeds are off on this server');
  return app.desktop;
}

/** Citadel's public address (publicOrigin): a PC's launcher reads the feed back at it. */
export function origin(req: Ctx['req'], preview = false): string {
  return publicOrigin(req, preview);
}

async function send(ctx: Ctx, file: string | null, type: string, name: string) {
  // lstat: a link planted in the desktop folder (it sits on a writable mount) is never followed.
  const size = file
    ? await lstat(file).then(
        (s) => (s.isFile() ? s.size : null),
        () => null,
      )
    : null;
  if (!file || size === null) throw new HttpError(404, 'Not found');
  await sendFile(ctx.req, ctx.res, file, size, {
    'Content-Type': type,
    'Cache-Control': 'no-cache',
    'Content-Disposition': `attachment; filename="${name}"`,
  });
}

export const desktopRoutes: Route[] = [
  {
    // feed.json, launcher.exe, install.zip and the builds' <app>-<n>.zip.
    method: ['GET', 'HEAD'],
    path: '/api/desktop/:project/:app/:file',
    who: 'anyone',
    async handler(ctx) {
      const { app, res, params } = ctx;
      const d = desktop(app);
      const projectId = /^\d+$/.test(params.project) ? Number(params.project) : NaN;
      if (!app.store.getProject(projectId)) throw new HttpError(404, 'Not found');
      let index;
      try {
        index = await d.feeds.index(projectId, params.app);
      } catch (err) {
        if (err instanceof DesktopError) throw new HttpError(404, 'Not found');
        throw err;
      }
      if (!index?.builds.length) throw new HttpError(404, `No builds of ${params.app} yet`);
      if (params.file === 'feed.json') {
        const feed = DesktopFeeds.feed(index, await d.launchers.get());
        if (!feed) throw new HttpError(404, `No builds of ${params.app} yet`);
        return json(res, 200, feed, { 'Cache-Control': 'no-store' });
      }
      if (params.file === 'launcher.exe') return send(ctx, (await d.launchers.get())?.path ?? null, 'application/octet-stream', 'launcher.exe');
      if (params.file === 'install.zip') {
        const launcher = await d.launchers.get();
        if (!launcher) throw new HttpError(503, "The launcher can't be built on this server right now");
        const feedUrl = `${origin(ctx.req, ctx.app.preview)}/api/desktop/${projectId}/${params.app}/feed.json`;
        return send(ctx, await d.feeds.install(projectId, params.app, feedUrl, launcher), 'application/zip', `${params.app}.zip`);
      }
      return send(ctx, await d.feeds.zip(projectId, params.app, params.file), 'application/zip', params.file);
    },
  },
  {
    // A build a minion made, or one in the scheme's CI store, published by hand (the publish_desktop tool).
    method: 'POST',
    path: '/api/projects/:project/desktop/publish',
    who: ['person', 'minion', 'taskmaster'],
    refuse: "Only a scheme's members, its minions and its Taskmaster publish its desktop builds",
    async handler(ctx) {
      const { app, res, project, caller, session } = ctx;
      const d = desktop(app);
      if (app.preview) throw new HttpError(403, 'Desktop builds are published on the live app, not a preview');
      const b = await readJson(ctx.req);
      const str = (k: string) => (typeof b?.[k] === 'string' && b[k].trim() ? (b[k] as string).trim() : undefined);
      let file: string | null = null;
      let commit = str('commit');
      let source: string | undefined;
      if (b?.ci_file != null) {
        const f = isInt(b.ci_file) ? app.store.getCiFile(b.ci_file) : undefined;
        if (!f || f.project_id !== project.id) throw new HttpError(404, `No file ${b.ci_file} in this scheme's CI store`);
        file = await app.ciStore.plain(f).catch(() => null);
        commit ??= f.sha;
        source = `ci:${f.run_id}`;
      } else if (str('path')) {
        if (!caller) throw new HttpError(400, 'Give ci_file: the CI store file to publish');
        const found = await resolveTicketFile(app, caller, str('path')!);
        file = found?.file ?? null;
      } else throw new HttpError(400, 'Give path (a build you made) or ci_file (a file in the CI store)');
      if (!file) throw new HttpError(404, "That file isn't there, or is outside the folders you can share from");
      const ask: PublishAsk = {
        projectId: project.id,
        app: str('app') ?? '',
        file,
        exe: str('exe'),
        started: str('started') as PublishAsk['started'],
        title: str('title'),
        version: str('version'),
        commit,
        source,
        by: caller ? `#${caller.number ?? caller.id}` : session.name,
      };
      try {
        const out = await d.feeds.publish(ask);
        const base = origin(ctx.req, ctx.app.preview);
        const said = out.already
          ? `${ask.app} build ${out.build.build} was already published from that run; the feed names it again.${out.ignored ? ` Its ${out.ignored.join(', ')} can't change on a build that's already made, so they stay as they were: publish a new build to change them.` : ''}`
          : `Published ${ask.app} build ${out.build.build} (${out.build.size} bytes, sha256 ${out.build.sha256.slice(0, 12)}…). PCs running it get it on their next start but one.`;
        return json(res, 200, { ...out, feed_url: base + out.feed, install_url: base + out.install, said: `${said} Feed: ${base}${out.feed} First install: ${base}${out.install}` });
      } catch (err) {
        if (err instanceof DesktopError) throw new HttpError(400, err.message);
        throw err;
      }
    },
  },
];
