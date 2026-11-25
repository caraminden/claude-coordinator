// The scheme page keeps its side panel and the build headings' counts (#1861, HP3 and HP4). Citadel's real front end in
// headless Chromium (test/browser.ts), with fetch answered in the page.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chromium, launch, waitFor, type Browser, serveApp, skipMessage, type App } from './browser.ts';
import { pageStub } from './page-stub.ts';

const bin = chromium();
const skip = !bin && skipMessage;

const STUB = pageStub(`
  window.ready = true;
  const mk = (id, number, title) => ({ id, project_id: 1, kind: 'ticket', number, title, status: 'idle', build: 3, updated_at: now, created_at: now - 1000 });
  const tickets = [mk(101, 7, 'First minion'), mk(102, 8, 'Second minion')];
  function route(path) {
    if (path === 'api/projects') return reply(200, [{ id: 1, name: 'Alpha', inbox: 0, icon: null }]);
    if (path === 'api/projects/1') return reply(200, { project: { id: 1, name: 'Alpha', instructions: '' }, coordinator: { id: 100, project_id: 1, kind: 'coordinator', number: 0, title: 'Taskmaster', status: 'idle', updated_at: 0 }, tickets, seen: {}, person_notes: {}, pins: [], builds: [{ build: 3, merged: 4, open: 2, behind: 1 }], build_previews: true });
    if (/^api\\/projects\\/\\d+\\/properties$/.test(path)) return reply(200, { keys: [], values: {} });
    if (/^api\\/tickets\\/\\d+\\/events$/.test(path)) return reply(200, { events: [], more: false, tasks: [] });
    if (path === 'api/home') return reply(200, { items: [], tickets: [], schemes: [{ id: 1, name: 'Alpha', waiting: 0, working: 0, shipped: 0, daily: [] }], seen: {}, days: [], me: 'Cara' });
  }
`);

let app: App;
let browser: Browser;
before(async () => {
  if (skip) return;
  app = await serveApp({ stub: STUB });
  browser = await launch(bin!);
});
after(async () => {
  await browser?.close();
  await app?.close();
});

const counts = `document.querySelector('.build-counts')?.textContent ?? ''`;

test('a chat click in a scheme with a build keeps its heading counts and Preview link', { skip }, async () => {
  const page = await browser.page(`${app.base}#/p/1/t/7`, { width: 1280, height: 800 });
  await waitFor(page, 'the counts', `(${counts}).includes('4 merged in')`);
  await page.eval(`location.hash = '#/p/1/t/8'`);
  await waitFor(page, 'the second chat', `document.title.length > 0 && location.hash === '#/p/1/t/8'`);
  await waitFor(page, 'the counts to stay', `(${counts}).includes('2 open') && !!document.querySelector('.build-counts a')`);
});

test('Releases opened from Home gives the scheme its own side panel', { skip }, async () => {
  const page = await browser.page(`${app.base}#/home/p/1/t/7`, { width: 1280, height: 800 });
  await waitFor(page, 'Home panel', `!!document.querySelector('.sidebar.home-mode')`);
  await page.eval(`import('/project.js').then((m) => m.showReleases(1, { scope: 'all', tab: 'releases' }))`);
  await waitFor(page, 'the releases page', `!!document.querySelector('.sidebar') && !document.querySelector('.sidebar.home-mode')`);
});
