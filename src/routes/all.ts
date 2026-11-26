// The people's API as one table, in the order the main thread matches it; the reader threads (src/reader.ts) match the
// same table, so a path a reader takes is the route main would run (#1628).
import { usageRoutes } from './usage.ts';
import { appRoutes } from './app.ts';
import { peopleRoutes } from './people.ts';
import { projectRoutes } from './projects.ts';
import { reviewRoutes } from './reviews.ts';
import { ticketRoutes } from './tickets.ts';
import { proposalRoutes } from './proposals.ts';
import { memoryCuratorRoutes } from './memory-curator.ts';
import { fileRoutes } from './files.ts';
import { machineRoutes } from './machines.ts';
import { jobRoutes } from './jobs.ts';
import { minionJobRoutes } from './minion-jobs.ts';
import { ciStoreRoutes } from './ci-store.ts';
import { desktopRoutes } from './desktop.ts';
import { pushRoutes } from './push.ts';
import { timeLogRoutes } from './time-log.ts';
import { dayStripsRoutes } from './day-strips.ts';
import { unitRoutes } from './units.ts';
import { contraptionRoutes } from './contraptions.ts';
import { skillRoutes } from './skills.ts';
import { urgentRoutes } from './urgent.ts';
import { workerRoutes } from './workers.ts';
import { roleSetupRoutes } from './role-setup.ts';

export const apiRoutes = [
  ...usageRoutes,
  ...appRoutes,
  ...peopleRoutes,
  ...projectRoutes,
  ...reviewRoutes,
  ...ticketRoutes,
  ...timeLogRoutes,
  ...dayStripsRoutes,
  ...proposalRoutes,
  ...memoryCuratorRoutes,
  ...fileRoutes,
  ...machineRoutes,
  ...jobRoutes,
  ...minionJobRoutes,
  ...ciStoreRoutes,
  ...desktopRoutes,
  ...pushRoutes,
  ...unitRoutes,
  ...contraptionRoutes,
  ...skillRoutes,
  ...workerRoutes,
  ...roleSetupRoutes,
  ...urgentRoutes,
];
