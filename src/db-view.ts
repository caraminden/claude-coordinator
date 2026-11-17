// One read-only query on Citadel's database with its secrets masked (#621), for the host_check tool: a turn in a
// person's container can't open the live file, and a raw mount would hand it the credentials table.
// Run as a child (src/host-check.ts), so a slow query never stalls the server: `node db-view.ts <db file>`, the SQL on stdin.
import { constants, DatabaseSync } from 'node:sqlite';

/** Columns no turn reads: password and invite hashes, machine and contraption keys, linked logins, saved secrets, push keys. */
export const SECRET: Record<string, string[]> = {
  users: ['password_hash', 'invite_hash'],
  machines: ['token_hash'],
  contraptions: ['key_hash', 'identity_private'],
  credentials: ['secret', 'meta'],
  stored_secrets: ['value'],
  machine_jobs: ['input_token_hash', 'kind_hash'],
  machine_job_kinds: ['hash'],
  push_subscriptions: ['endpoint', 'p256dh', 'auth'],
};
/** Settings rows whose value is a secret: turn-token nonces. */
const SECRET_SETTINGS = "key LIKE 'agent-nonce:%'";
const HIDDEN = "'[hidden]'";
/** Pragmas that only describe the schema. */
const PRAGMAS = new Set(['table_info', 'table_xinfo', 'table_list', 'index_list', 'index_info', 'index_xinfo', 'foreign_key_list']);
export const MAX_ROWS = 1000;

/**
 * Open `file` read-only with every table that holds a secret shadowed by a temp view of the same name (unqualified
 * names find temp first) that masks it, and an authorizer that allows only reads and refuses any other read of a
 * secret: `main.users`, an ATTACH, a write or a pragma that sets something all fail with "not authorized".
 * Settings, whose secrets are rows, not a column, is a masked temp copy made before the authorizer is on, since a
 * CTE named like a view passes for it in the authorizer: so nothing reads main.settings.value at all.
 */
export function openMasked(file: string): DatabaseSync {
  const db = new DatabaseSync(file, { readOnly: true });
  for (const table of [...Object.keys(SECRET), 'settings']) {
    const cols = (db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all() as { name: string }[]).map((c) => c.name);
    if (!cols.length) continue;
    const pick = cols.map((c) => (SECRET[table]?.includes(c) ? `${HIDDEN} AS "${c}"`
      : table === 'settings' && c === 'value' ? `CASE WHEN ${SECRET_SETTINGS} THEN ${HIDDEN} ELSE value END AS value` : `"${c}"`));
    db.exec(`CREATE TEMP ${table === 'settings' ? 'TABLE' : 'VIEW'} "${table}" AS SELECT ${pick.join(', ')} FROM main."${table}"`);
  }
  db.setAuthorizer((action, a, b, dbName) => {
    if (action === constants.SQLITE_SELECT || action === constants.SQLITE_FUNCTION || action === constants.SQLITE_RECURSIVE) return constants.SQLITE_OK;
    // These pragmas only describe; their argument is a table or index name.
    if (action === constants.SQLITE_PRAGMA) return a && PRAGMAS.has(a.toLowerCase()) ? constants.SQLITE_OK : constants.SQLITE_DENY;
    if (action !== constants.SQLITE_READ) return constants.SQLITE_DENY;
    // The masked copies (temp) are safe; of the real tables (main), nothing reads a secret column or settings.value.
    if (dbName !== 'main') return constants.SQLITE_OK;
    return a && b && (SECRET[a]?.includes(b) || (a === 'settings' && b === 'value')) ? constants.SQLITE_DENY : constants.SQLITE_OK;
  });
  return db;
}

/** Run one statement, as sqlite3's default output: a header line, then rows with `|` between values. */
export function query(db: DatabaseSync, sql: string): string {
  const stmt = db.prepare(sql);
  const lines: string[] = [];
  let header = false;
  for (const row of stmt.iterate() as Iterable<Record<string, unknown>>) {
    if (!header) lines.push(Object.keys(row).join('|')), header = true;
    if (lines.length > MAX_ROWS) {
      lines.push(`… stopped at ${MAX_ROWS} rows: add a LIMIT or narrow the WHERE`);
      break;
    }
    lines.push(Object.values(row).map((v) => (v === null ? '' : v instanceof Uint8Array ? `<blob ${v.length} bytes>` : String(v))).join('|'));
  }
  return lines.length ? lines.join('\n') : '(no rows)';
}

if (import.meta.main) {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  try {
    process.stdout.write(query(openMasked(process.argv[2]), Buffer.concat(chunks).toString()) + '\n');
  } catch (err: any) {
    process.stderr.write(`${err.message}\n`);
    process.exitCode = 1;
  }
}
