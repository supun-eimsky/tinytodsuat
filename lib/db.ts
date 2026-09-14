import mysql from "mysql2/promise";
import { getCloudflareContext } from "@opennextjs/cloudflare";

type QueryParameter = string | number | boolean | null | Buffer | Date;

/**
 * A single shared connection pool for the whole app. In Next.js dev mode,
 * modules can be re-evaluated on every hot reload, which would otherwise
 * create a fresh pool (and fresh TCP connections) on every file save —
 * so the pool is cached on `globalThis`, the same pattern commonly used
 * for Prisma clients in Next.js apps.
 */
declare global {
  // eslint-disable-next-line no-var
  var __tinytodsPool: mysql.Pool | undefined;
}

/**
 * Resolves the MySQL connection string.
 *
 * On Cloudflare (production/preview builds), the connection comes from
 * the Hyperdrive binding. Hyperdrive terminates TLS to RDS on its side,
 * so no SSL config or CA bundle is needed here — passing one (or trying
 * to read one from disk) will fail, since Workers has no real filesystem
 * at runtime.
 *
 * In plain local Node.js dev (`next dev`, no Cloudflare context), this
 * falls back to DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME from
 * .env.local instead.
 */
function getConnectionString(): string {
  try {
    const { env } = getCloudflareContext();
    if (env.HYPERDRIVE?.connectionString) {
      return env.HYPERDRIVE.connectionString;
    }
  } catch {
    // Not running inside a Cloudflare context (e.g. plain `next dev`) — fall through.
  }

  const {
    DB_HOST = "localhost",
    DB_PORT = "3306",
    DB_USER,
    DB_PASSWORD = "",
    DB_NAME,
  } = process.env;

  if (!DB_USER || !DB_NAME) {
    throw new Error(
      "Missing database configuration. Set DB_HOST, DB_PORT, DB_USER, DB_PASSWORD and DB_NAME in your .env.local (see .env.example), or configure the HYPERDRIVE binding for Cloudflare."
    );
  }

  return `mysql://${DB_USER}:${encodeURIComponent(DB_PASSWORD)}@${DB_HOST}:${DB_PORT}/${DB_NAME}`;
}

function createPool(): mysql.Pool {
  return mysql.createPool({
    uri: getConnectionString(),
    waitForConnections: true,
    // Hyperdrive already pools connections on Cloudflare's side, so keep this low.
    connectionLimit: 5,
    maxIdle: 5,
    idleTimeout: 60000,
    dateStrings: true,
    disableEval: true,
  });
}

export function getPool(): mysql.Pool {
  if (!global.__tinytodsPool) {
    global.__tinytodsPool = createPool();
  }
  return global.__tinytodsPool;
}

/**
 * Thin query helper so the rest of the app never touches the mysql2 API
 * directly — services just call `query<Row>(sql, params)`.
 */
export async function query<T = unknown>(sql: string, params: QueryParameter[] = []): Promise<T[]> {
  const pool = getPool();
  const [rows] = await pool.query(sql, params);
  return rows as T[];
}

/** For INSERT/UPDATE/DELETE, where you need affectedRows/insertId instead of row data. */
export async function execute(
  sql: string,
  params: QueryParameter[] = []
): Promise<mysql.ResultSetHeader> {
  const pool = getPool();
  const [result] = await pool.execute(sql, params);
  return result as mysql.ResultSetHeader;
}