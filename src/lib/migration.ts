import type { Client } from "pg";
import type { ColumnInfo, MigrationConfig, TableInfo } from "./types";
import { quoteIdent, quoteLiteral, quoteQualified } from "./pg";

export const SYSTEM_SCHEMAS = new Set([
  "pg_catalog",
  "information_schema",
  "pg_toast",
  "extensions",
  "graphql",
  "graphql_public",
  "pgsodium",
  "pgsodium_masks",
  "vault",
  "net",
  "supabase_functions",
  "realtime",
  "_realtime",
  "_analytics",
  "auth",
  "storage",
  "pgbouncer",
  "supabase_migrations",
]);

export async function fetchSchema(client: Client): Promise<{ schemas: string[]; tables: TableInfo[] }> {
  const schemaRes = await client.query<{ schema_name: string }>(
    `SELECT schema_name FROM information_schema.schemata ORDER BY schema_name`
  );
  const schemas = schemaRes.rows
    .map((r) => r.schema_name)
    .filter((s) => !SYSTEM_SCHEMAS.has(s) && !s.startsWith("pg_"));

  if (schemas.length === 0) {
    return { schemas: [], tables: [] };
  }

  const tablesRes = await client.query<{
    table_schema: string;
    table_name: string;
    row_estimate: string | number | null;
    size_bytes: string | number | null;
  }>(
    `SELECT
       n.nspname AS table_schema,
       c.relname AS table_name,
       c.reltuples::bigint AS row_estimate,
       pg_total_relation_size(c.oid)::bigint AS size_bytes
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind = 'r'
       AND n.nspname = ANY($1::text[])
     ORDER BY n.nspname, c.relname`,
    [schemas]
  );

  const colsRes = await client.query<ColumnInfo & { table_schema: string; table_name: string; ordinal_position: number }>(
    `SELECT
       table_schema, table_name, ordinal_position,
       column_name, data_type, is_nullable, column_default, udt_name,
       character_maximum_length, numeric_precision, numeric_scale
     FROM information_schema.columns
     WHERE table_schema = ANY($1::text[])
     ORDER BY table_schema, table_name, ordinal_position`,
    [schemas]
  );

  const colsByTable = new Map<string, ColumnInfo[]>();
  for (const row of colsRes.rows) {
    const key = `${row.table_schema}.${row.table_name}`;
    const list = colsByTable.get(key) ?? [];
    list.push({
      column_name: row.column_name,
      data_type: row.data_type,
      is_nullable: row.is_nullable,
      column_default: row.column_default,
      udt_name: row.udt_name,
      character_maximum_length: row.character_maximum_length,
      numeric_precision: row.numeric_precision,
      numeric_scale: row.numeric_scale,
    });
    colsByTable.set(key, list);
  }

  const tables: TableInfo[] = tablesRes.rows.map((r) => ({
    schema: r.table_schema,
    name: r.table_name,
    rowEstimate: Number(r.row_estimate ?? 0),
    sizeBytes: Number(r.size_bytes ?? 0),
    columns: colsByTable.get(`${r.table_schema}.${r.table_name}`) ?? [],
  }));

  return { schemas, tables };
}

export async function fetchPrimaryKey(client: Client, schema: string, name: string): Promise<string[]> {
  const res = await client.query<{ attname: string }>(
    `SELECT a.attname
     FROM pg_index i
     JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
     JOIN pg_class c ON c.oid = i.indrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE i.indisprimary AND n.nspname = $1 AND c.relname = $2
     ORDER BY array_position(i.indkey, a.attnum)`,
    [schema, name]
  );
  return res.rows.map((r) => r.attname);
}

export async function fetchForeignKeys(client: Client, schema: string, name: string): Promise<string[]> {
  const res = await client.query<{ def: string; conname: string }>(
    `SELECT conname, pg_get_constraintdef(c.oid) AS def
     FROM pg_constraint c
     JOIN pg_class cl ON cl.oid = c.conrelid
     JOIN pg_namespace n ON n.oid = cl.relnamespace
     WHERE c.contype = 'f' AND n.nspname = $1 AND cl.relname = $2`,
    [schema, name]
  );
  return res.rows.map(
    (r) => `ALTER TABLE ${quoteQualified(schema, name)} ADD CONSTRAINT ${quoteIdent(r.conname)} ${r.def};`
  );
}

export async function fetchIndexes(client: Client, schema: string, name: string): Promise<string[]> {
  const res = await client.query<{ indexdef: string }>(
    `SELECT indexdef FROM pg_indexes
     WHERE schemaname = $1 AND tablename = $2
       AND indexname NOT IN (
         SELECT conname FROM pg_constraint WHERE conrelid = ($1 || '.' || $2)::regclass AND contype IN ('p','u')
       )`,
    [schema, name]
  );
  return res.rows.map((r) => `${r.indexdef};`);
}

export async function fetchRlsPolicies(client: Client, schema: string, name: string): Promise<string[]> {
  const flags = await client.query<{ rls_enabled: boolean; rls_forced: boolean }>(
    `SELECT c.relrowsecurity AS rls_enabled, c.relforcerowsecurity AS rls_forced
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1 AND c.relname = $2`,
    [schema, name]
  );
  const lines: string[] = [];
  const qn = quoteQualified(schema, name);
  if (flags.rows[0]?.rls_enabled) {
    lines.push(`ALTER TABLE ${qn} ENABLE ROW LEVEL SECURITY;`);
  }
  if (flags.rows[0]?.rls_forced) {
    lines.push(`ALTER TABLE ${qn} FORCE ROW LEVEL SECURITY;`);
  }

  const res = await client.query<{ stmt: string }>(
    `SELECT
       'CREATE POLICY ' || quote_ident(pol.polname) ||
       ' ON ' || quote_ident(n.nspname) || '.' || quote_ident(c.relname) ||
       CASE WHEN pol.polpermissive THEN ' AS PERMISSIVE' ELSE ' AS RESTRICTIVE' END ||
       CASE pol.polcmd WHEN 'r' THEN ' FOR SELECT' WHEN 'a' THEN ' FOR INSERT'
                       WHEN 'w' THEN ' FOR UPDATE' WHEN 'd' THEN ' FOR DELETE'
                       WHEN '*' THEN ' FOR ALL' ELSE '' END ||
       CASE WHEN pol.polroles <> '{0}'::oid[] THEN ' TO ' || array_to_string(
         ARRAY(SELECT quote_ident(rolname) FROM pg_roles WHERE oid = ANY(pol.polroles)), ', ')
         ELSE ' TO public' END ||
       CASE WHEN pol.polqual IS NOT NULL THEN ' USING (' || pg_get_expr(pol.polqual, pol.polrelid) || ')' ELSE '' END ||
       CASE WHEN pol.polwithcheck IS NOT NULL THEN ' WITH CHECK (' || pg_get_expr(pol.polwithcheck, pol.polrelid) || ')' ELSE '' END ||
       ';' AS stmt
     FROM pg_policy pol
     JOIN pg_class c ON c.oid = pol.polrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1 AND c.relname = $2
     ORDER BY pol.polname`,
    [schema, name]
  );
  for (const r of res.rows) lines.push(r.stmt);
  return lines;
}

export async function fetchTriggers(client: Client, schema: string, name: string): Promise<string[]> {
  const res = await client.query<{ def: string }>(
    `SELECT pg_get_triggerdef(t.oid, true) || ';' AS def
     FROM pg_trigger t
     JOIN pg_class c ON c.oid = t.tgrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE NOT t.tgisinternal AND n.nspname = $1 AND c.relname = $2`,
    [schema, name]
  );
  return res.rows.map((r) => r.def);
}

export async function fetchEnums(client: Client, schemas: string[]): Promise<string[]> {
  const res = await client.query<{ schema: string; name: string; labels: string[] }>(
    `SELECT n.nspname AS schema, t.typname AS name,
            ARRAY(SELECT e.enumlabel FROM pg_enum e WHERE e.enumtypid = t.oid ORDER BY e.enumsortorder) AS labels
     FROM pg_type t
     JOIN pg_namespace n ON n.oid = t.typnamespace
     WHERE t.typtype = 'e' AND n.nspname = ANY($1::text[])`,
    [schemas]
  );
  return res.rows.map(
    (r) =>
      `CREATE TYPE ${quoteQualified(r.schema, r.name)} AS ENUM (${r.labels
        .map((l) => quoteLiteral(l))
        .join(", ")});`
  );
}

export async function fetchSequences(client: Client, schemas: string[]): Promise<string[]> {
  const res = await client.query<{ schema: string; name: string }>(
    `SELECT sequence_schema AS schema, sequence_name AS name
     FROM information_schema.sequences
     WHERE sequence_schema = ANY($1::text[])`,
    [schemas]
  );
  return res.rows.map((r) => `CREATE SEQUENCE IF NOT EXISTS ${quoteQualified(r.schema, r.name)};`);
}

export async function fetchViews(client: Client, schemas: string[]): Promise<string[]> {
  const res = await client.query<{ schema: string; name: string; def: string }>(
    `SELECT schemaname AS schema, viewname AS name, definition AS def
     FROM pg_views WHERE schemaname = ANY($1::text[])`,
    [schemas]
  );
  return res.rows.map(
    (r) => `CREATE OR REPLACE VIEW ${quoteQualified(r.schema, r.name)} AS\n${r.def}`
  );
}

export async function fetchExtensions(client: Client): Promise<string[]> {
  const res = await client.query<{ extname: string }>(
    `SELECT extname FROM pg_extension WHERE extname NOT IN ('plpgsql')`
  );
  return res.rows.map((r) => `CREATE EXTENSION IF NOT EXISTS ${quoteIdent(r.extname)};`);
}

export async function fetchFunctions(client: Client, schemas: string[]): Promise<string[]> {
  const res = await client.query<{ def: string }>(
    `SELECT pg_get_functiondef(p.oid) || ';' AS def
     FROM pg_proc p
     JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = ANY($1::text[]) AND p.prokind = 'f'`,
    [schemas]
  );
  return res.rows.map((r) => r.def);
}

export function buildCreateTableStatement(t: TableInfo): string {
  const cols = t.columns.map((c) => {
    let type = c.data_type;
    if (type === "USER-DEFINED") type = c.udt_name;
    else if (type === "ARRAY") type = `${c.udt_name.replace(/^_/, "")}[]`;
    else if (type === "character varying" && c.character_maximum_length) {
      type = `varchar(${c.character_maximum_length})`;
    } else if (type === "character" && c.character_maximum_length) {
      type = `char(${c.character_maximum_length})`;
    } else if (type === "numeric" && c.numeric_precision) {
      type = `numeric(${c.numeric_precision}${c.numeric_scale ? "," + c.numeric_scale : ""})`;
    }
    const nullable = c.is_nullable === "NO" ? " NOT NULL" : "";
    const dflt = c.column_default ? ` DEFAULT ${c.column_default}` : "";
    return `  ${quoteIdent(c.column_name)} ${type}${nullable}${dflt}`;
  });
  return `CREATE TABLE IF NOT EXISTS ${quoteQualified(t.schema, t.name)} (\n${cols.join(",\n")}\n);`;
}

type PreviewOutput = {
  sql: string;
  plan: Array<{ qualifiedName: string; estimatedRows: number; sizeBytes: number; warnings: string[] }>;
  warnings: string[];
};

export async function generatePreview(
  srcClient: Client,
  dstClient: Client,
  config: MigrationConfig,
  schema: { schemas: string[]; tables: TableInfo[] }
): Promise<PreviewOutput> {
  const parts: string[] = [];
  const warnings: string[] = [];
  const plan: PreviewOutput["plan"] = [];

  const selectedTables = filterTables(schema.tables, config);
  const selectedSchemas = Array.from(new Set(selectedTables.map((t) => t.schema)));

  parts.push(`-- Supabase Migrator generated SQL`);
  parts.push(`-- Scope: ${config.scopeMode}`);
  parts.push(`-- Conflict strategy: ${config.conflictStrategy}`);
  parts.push("");

  const wantSchema = config.scopeMode !== "data_only";
  const wantData = config.scopeMode !== "schema_only";

  if (wantSchema) {
    for (const s of selectedSchemas) {
      parts.push(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(s)};`);
    }
    parts.push("");

    if (!config.tablesOnly && config.objectTypes.extensions) {
      const ext = await fetchExtensions(srcClient).catch(() => []);
      if (ext.length) {
        parts.push("-- Extensions");
        parts.push(...ext, "");
      }
    }

    if (!config.tablesOnly && config.objectTypes.enums && selectedSchemas.length) {
      const enums = await fetchEnums(srcClient, selectedSchemas).catch(() => []);
      if (enums.length) {
        parts.push("-- Enums");
        parts.push(...enums, "");
      }
    }

    if (!config.tablesOnly && config.objectTypes.sequences && selectedSchemas.length) {
      const seqs = await fetchSequences(srcClient, selectedSchemas).catch(() => []);
      if (seqs.length) {
        parts.push("-- Sequences");
        parts.push(...seqs, "");
      }
    }

    if (config.objectTypes.tables) {
      parts.push("-- Tables");
      for (const t of selectedTables) {
        parts.push(buildCreateTableStatement(t));
      }
      parts.push("");
    }

    if (!config.tablesOnly && config.objectTypes.indexes) {
      const allIdx: string[] = [];
      for (const t of selectedTables) {
        const idx = await fetchIndexes(srcClient, t.schema, t.name).catch(() => []);
        allIdx.push(...idx);
      }
      if (allIdx.length) {
        parts.push("-- Indexes");
        parts.push(...allIdx, "");
      }
    }

    if (!config.tablesOnly && config.objectTypes.foreignKeys) {
      const fks: string[] = [];
      for (const t of selectedTables) {
        const items = await fetchForeignKeys(srcClient, t.schema, t.name).catch(() => []);
        fks.push(...items);
      }
      if (fks.length) {
        parts.push("-- Foreign Keys");
        parts.push(...fks, "");
      }
    }

    if (!config.tablesOnly && config.objectTypes.views && selectedSchemas.length) {
      const views = await fetchViews(srcClient, selectedSchemas).catch(() => []);
      if (views.length) {
        parts.push("-- Views");
        parts.push(...views.map((v) => v + ";"), "");
      }
    }

    if (!config.tablesOnly && config.objectTypes.functions && selectedSchemas.length) {
      const fns = await fetchFunctions(srcClient, selectedSchemas).catch(() => []);
      if (fns.length) {
        parts.push("-- Functions");
        parts.push(...fns, "");
      }
    }

    if (!config.tablesOnly && config.objectTypes.triggers) {
      const trigs: string[] = [];
      for (const t of selectedTables) {
        const items = await fetchTriggers(srcClient, t.schema, t.name).catch(() => []);
        trigs.push(...items);
      }
      if (trigs.length) {
        parts.push("-- Triggers");
        parts.push(...trigs, "");
      }
    }

    if (!config.tablesOnly && config.objectTypes.rlsPolicies) {
      const pols: string[] = [];
      for (const t of selectedTables) {
        const items = await fetchRlsPolicies(srcClient, t.schema, t.name).catch(() => []);
        pols.push(...items);
      }
      if (pols.length) {
        parts.push("-- RLS Policies");
        parts.push(...pols, "");
      }
    }
  }

  if (wantData) {
    parts.push("-- Data migration is streamed row-by-row at execute time.");
    parts.push(
      `-- For each selected table, rows are copied using batched INSERTs with conflict strategy: ${config.conflictStrategy}.`
    );
    parts.push("");
  }

  for (const t of selectedTables) {
    const qn = `${t.schema}.${t.name}`;
    const w: string[] = [];
    if (wantData) {
      const existsRes = await dstClient
        .query<{ exists: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM information_schema.tables
             WHERE table_schema = $1 AND table_name = $2
           ) AS exists`,
          [t.schema, t.name]
        )
        .catch(() => ({ rows: [{ exists: false }] }));
      if (existsRes.rows[0]?.exists) {
        const countRes = await dstClient
          .query<{ count: string }>(`SELECT count(*)::text AS count FROM ${quoteQualified(t.schema, t.name)}`)
          .catch(() => ({ rows: [{ count: "0" }] }));
        const cnt = Number(countRes.rows[0]?.count ?? 0);
        if (cnt > 0) {
          w.push(`Target already has ${cnt} rows — strategy: ${config.conflictStrategy}`);
        }
      }
    }
    plan.push({
      qualifiedName: qn,
      estimatedRows: t.rowEstimate,
      sizeBytes: t.sizeBytes,
      warnings: w,
    });
  }

  if (selectedTables.length === 0) {
    warnings.push("No tables selected — migration will be a no-op");
  }

  return { sql: parts.join("\n"), plan, warnings };
}

export function filterTables(tables: TableInfo[], config: MigrationConfig): TableInfo[] {
  const selectedSchemas = new Set(config.selectedSchemas);
  const selectedTables = new Set(config.selectedTables);

  return tables.filter((t) => {
    const qn = `${t.schema}.${t.name}`;
    const schemaOk = selectedSchemas.size === 0 || selectedSchemas.has(t.schema);
    const tableOk = selectedTables.size === 0 || selectedTables.has(qn);
    return schemaOk && tableOk;
  });
}

export function buildSelectSql(t: TableInfo, filter: { whereClause?: string; rowLimit?: number } | undefined): string {
  const cols = t.columns.map((c) => quoteIdent(c.column_name)).join(", ");
  let sql = `SELECT ${cols} FROM ${quoteQualified(t.schema, t.name)}`;
  if (filter?.whereClause && filter.whereClause.trim()) {
    sql += ` WHERE ${filter.whereClause}`;
  }
  if (filter?.rowLimit && filter.rowLimit > 0) {
    sql += ` LIMIT ${Math.floor(filter.rowLimit)}`;
  }
  return sql;
}

export function buildInsertSql(
  t: TableInfo,
  rows: Record<string, unknown>[],
  strategy: "SKIP" | "UPSERT" | "OVERWRITE",
  pkColumns: string[]
): string {
  if (rows.length === 0) return "";
  const cols = t.columns.map((c) => c.column_name);
  const valuesSql = rows
    .map(
      (row) =>
        `(${cols.map((c) => quoteLiteral(row[c] as unknown)).join(", ")})`
    )
    .join(",\n  ");

  let conflict = "";
  if (strategy === "SKIP" && pkColumns.length) {
    conflict = ` ON CONFLICT (${pkColumns.map(quoteIdent).join(", ")}) DO NOTHING`;
  } else if (strategy === "UPSERT" && pkColumns.length) {
    const updates = cols
      .filter((c) => !pkColumns.includes(c))
      .map((c) => `${quoteIdent(c)} = EXCLUDED.${quoteIdent(c)}`)
      .join(", ");
    conflict = updates
      ? ` ON CONFLICT (${pkColumns.map(quoteIdent).join(", ")}) DO UPDATE SET ${updates}`
      : ` ON CONFLICT (${pkColumns.map(quoteIdent).join(", ")}) DO NOTHING`;
  }

  return `INSERT INTO ${quoteQualified(t.schema, t.name)} (${cols
    .map(quoteIdent)
    .join(", ")}) VALUES\n  ${valuesSql}${conflict};`;
}
