import { Client, Pool, type ClientConfig, type PoolConfig } from "pg";
import { parse as parseConn } from "pg-connection-string";

function encodeUserInfo(connectionString: string): string {
  const m = connectionString.match(/^(postgres(?:ql)?:\/\/)([\s\S]*)$/i);
  if (!m) return connectionString;
  const [, proto, rest] = m;
  const lastAt = rest.lastIndexOf("@");
  if (lastAt === -1) return connectionString;
  const userinfo = rest.slice(0, lastAt);
  const hostAndBeyond = rest.slice(lastAt + 1);
  const firstColon = userinfo.indexOf(":");
  const user = firstColon === -1 ? userinfo : userinfo.slice(0, firstColon);
  const password = firstColon === -1 ? "" : userinfo.slice(firstColon + 1);
  const encUser = encodeURIComponent(safeDecode(user));
  const creds =
    firstColon === -1 ? encUser : `${encUser}:${encodeURIComponent(safeDecode(password))}`;
  return `${proto}${creds}@${hostAndBeyond}`;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function toConfig(connectionString: string): ClientConfig {
  const p = parseConn(encodeUserInfo(connectionString));
  return {
    host: p.host ?? undefined,
    port: p.port ? Number(p.port) : undefined,
    database: p.database ?? undefined,
    user: p.user,
    password: p.password,
    ssl: needsSSL(connectionString) ? { rejectUnauthorized: false } : undefined,
  };
}

export function createClient(connectionString: string): Client {
  return new Client({
    ...toConfig(connectionString),
    connectionTimeoutMillis: 10_000,
  });
}

export function createPool(connectionString: string, max = 4): Pool {
  const cfg: PoolConfig = {
    ...toConfig(connectionString),
    max,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
  };
  return new Pool(cfg);
}

function needsSSL(connectionString: string): boolean {
  if (!connectionString) return false;
  if (/sslmode=disable/i.test(connectionString)) return false;
  if (/supabase\.(co|com|net)/i.test(connectionString)) return true;
  if (/sslmode=(require|verify|prefer)/i.test(connectionString)) return true;
  return false;
}

export function quoteIdent(ident: string): string {
  return '"' + String(ident).replace(/"/g, '""') + '"';
}

export function quoteQualified(schema: string, name: string): string {
  return `${quoteIdent(schema)}.${quoteIdent(name)}`;
}

export function quoteLiteral(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (value instanceof Date) return `'${value.toISOString()}'`;
  if (Buffer.isBuffer(value)) return `'\\x${value.toString("hex")}'::bytea`;
  if (typeof value === "object") {
    return `'${JSON.stringify(value).replace(/'/g, "''")}'::jsonb`;
  }
  const s = String(value).replace(/'/g, "''");
  return `'${s}'`;
}

// ─── Human-readable error messages ───────────────────────────────────────────

export function friendlyPgError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const code = (err as NodeJS.ErrnoException).code;
  if (code === "ENOTFOUND") {
    return (
      `DNS resolution failed — host not found. ` +
      `You must use the Supabase connection pooler URL, not the direct DB host. ` +
      `In Supabase Dashboard go to: Project Settings → Database → Connection pooling, ` +
      `copy the Session mode URL (port 5432) and use that as your connection string.`
    );
  }
  if (code === "ECONNREFUSED") {
    return (
      `Connection refused on port 5432. ` +
      `Your environment likely blocks direct PostgreSQL connections. ` +
      `Use the Supabase pooler URL instead (Dashboard → Project Settings → Database → Connection pooling).`
    );
  }
  if (code === "ETIMEDOUT") {
    return (
      `Connection timed out. The host is unreachable from this environment. ` +
      `Try the Supabase pooler URL (Dashboard → Project Settings → Database → Connection pooling).`
    );
  }
  return err.message;
}