// The one table of Settings and Orders pages (#1308). A page is one row: its URL kind, label, icon, one-line blurb and
// the module and export that draw it. The side menus, the phone's list, the route regex (core.js), the breadcrumb and
// dispatch (project.js) and the scheme-switch sets (scheme-switch.js) all read this table, so a new page is one row here
// plus its module. Pure data, no imports, so scheme-switch.js and the tests can load it without a browser;
// settings.js re-exports both lists as ORDERS_GROUPS and SETTINGS_GROUPS.
//
// A row: { kind, label, icon, blurb, module, page, crumb?, own?, item? }
//   crumb  the breadcrumb's last part when it differs from the label.
//   own    the page has its own route and breadcrumb (Orders' list, Schedules with its one-schedule page): the
//          generic route, breadcrumb and dispatch skip it, but its menu entry and scheme switch still come from here.
//   item   a page whose URL can name one item (a memory file): switching scheme opens that page's list.
// A group: [label, hue, rows, adminOnly?]. Admin-only groups are hidden from, and refused to, non-admins.
/** @typedef {{ kind: string, label: string, icon: string, blurb: string, module: string, page: string, crumb?: string, own?: boolean, item?: boolean }} PageRow */
/** @typedef {[string, string, PageRow[], boolean?]} PageGroup */

/**
 * @param {string} kind
 * @param {string} label
 * @param {string} icon
 * @param {string} blurb
 * @param {string} module
 * @param {string} page
 * @param {{ crumb?: string, own?: boolean, item?: boolean }} [extra]
 * @returns {PageRow}
 */
const row = (kind, label, icon, blurb, module, page, extra = {}) => ({ kind, label, icon, blurb, module, page, ...extra });

/** @type {PageGroup[]} */
export const ORDERS_GROUPS = [
  [
    'What minions read',
    'running',
    [
      row('instructions', 'Instructions', 'doc', 'What every minion reads', 'settings.js', 'instructionsEditor'),
      row('approvals', 'Minion rules', 'shield', 'Approvals, plugins, list groups and CI', 'settings.js', 'approvalsEditor'),
      row('skills', 'Skills', 'spark', 'What minions know how to do, and when', 'skills.js', 'skillsPage', { item: true }),
      row('memory', 'Memory', 'doc', 'What the Taskmaster and minions remember', 'memory.js', 'memoryPage', { item: true }),
      row('reviews', 'Reviewers and critics', 'check', 'What judges work: critics, reviewers, audits', 'reviews.js', 'reviewsPage', { item: true }),
      row('decisions', 'Decisions', 'check', "Who decided what, and what's reversed", 'decisions.js', 'decisionsPage', { item: true }),
      row('ideas', 'Ideas', 'spark', 'Every idea shown, its pick, handoff and minion', 'ideas.js', 'ideasPage'),
    ],
  ],
  ['How work runs', 'teal', [row('properties', 'Properties', 'tag', 'Type, stage and your own keys', 'properties.js', 'propertiesPage'), row('schedules', 'Schedules', 'rows', 'Minions that start on a timer', 'schedules.js', 'schedulesPage', { own: true })]],
];

/** @type {PageGroup[]} */
export const SETTINGS_GROUPS = [
  ['Scheme', 'running', [row('members', 'Members', 'users', 'Who works in this scheme', 'people.js', 'membersPage'), row('orders', 'Orders', 'rows', 'Instructions, rules, skills, memory, properties: the tab beside Minions', 'settings.js', 'settingsHome', { own: true })]],
  [
    'You',
    'held',
    [
      row('my-instructions', 'My instructions', 'pen', 'Yours, in every scheme', 'settings.js', 'myInstructionsEditor'),
      row('account', 'Your account', 'user', 'Password, Claude and GitHub logins', 'people.js', 'accountPage'),
      row('machines', 'Machines', 'monitor', 'Computers you lend to minions', 'settings-machines.js', 'machinesPage'),
      row('notifications', 'Notifications', 'bell', 'Push, and what pings you', 'settings.js', 'notificationsPage'),
      row('usage', 'Usage', 'chart', 'Claude and Codex spend', 'where.js', 'usagePage'),
      row('help', 'How Citadel works', 'doc', 'Schemes, minions, cards and shipping in two minutes', 'help.js', 'helpPage'),
    ],
  ],
  [
    'Admin',
    'teal',
    [
      row('app-instructions', 'Citadel-wide', 'globe', 'Rules every scheme follows', 'settings.js', 'appInstructionsEditor', { crumb: 'Citadel-wide instructions' }),
      row('people', 'People', 'people', 'Who can sign in', 'people.js', 'peoplePage'),
      row('unused', 'Unused', 'chart', 'What nobody has used in 30 days', 'unused.js', 'unusedPage'),
      row('contraptions', 'Contraptions', 'box', 'Apps that run inside Citadel', 'contraptions.js', 'contraptionsPage'),
      row('units', 'Units', 'shield', 'Which deploy/ units are installed on this host', 'units.js', 'unitsPage'),
    ],
    true,
  ],
];

/** Every page row with its group's kind of home: { ...row, orders, admin }. */
export const PAGES = [...ORDERS_GROUPS.flatMap(([, , rows, admin]) => rows.map((r) => ({ ...r, orders: true, admin: !!admin }))), ...SETTINGS_GROUPS.flatMap(([, , rows, admin]) => rows.map((r) => ({ ...r, orders: false, admin: !!admin })))];
const BY_KIND = new Map(PAGES.map((p) => [p.kind, p]));

/** The row for a URL kind, or undefined for a page that isn't a Settings or Orders page. */
export const pageRow = (/** @type {string} */ kind) => BY_KIND.get(kind);
/** True for a page that lives in Orders, not Settings. */
export const isOrdersPage = (/** @type {string} */ kind) => !!BY_KIND.get(kind)?.orders;
/** The kinds the route regex matches on their own: every row but the ones with a route of their own. */
export const plainKinds = () => PAGES.filter((p) => !p.own).map((p) => p.kind);
