// Settings > Units (#1216): each systemd unit in the live checkout's deploy/ as installed, missing or different on this host.
import { join } from 'node:path';
import { json, type Route } from '../http.ts';
import { checkUnits, summary } from '../unit-drift.ts';

export const DEPLOY_DIR = join(import.meta.dirname, '..', '..', 'deploy');

export const unitRoutes: Route[] = [
  { method: 'GET', path: '/api/units', who: ['person'], access: 'admin', handler: ({ res }) => { const rows = checkUnits(DEPLOY_DIR); json(res, 200, { rows, summary: summary(rows) }); } },
];
