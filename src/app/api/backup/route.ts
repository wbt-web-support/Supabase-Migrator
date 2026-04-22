import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/pg";
import {
  buildCreatePrimaryKeyStatement,
  buildCreateTableStatement,
  buildSelectSql,
  fetchPrimaryKey,
  fetchSchema,
  filterTables,
} from "@/lib/migration";
import type { MigrationConfig } from "@/lib/types";
import { quoteIdent, quoteLiteral, quoteQualified } from "@/lib/pg";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const configSchema: z.ZodType<MigrationConfig> = z.object({
  scopeMode: z.enum(["schema_and_data", "schema_only", "data_only"]),
  tablesOnly: z.boolean(),
  selectedSchemas: z.array(z.string()),
  selectedTables: z.array(z.string()),
  rowFilters: z.record(
    z.string(),
    z.object({ whereClause: z.string().optional(), rowLimit: z.number().optional() })
  ),
  objectTypes: z.object({
    tables: z.boolean(),
    views: z.boolean(),
    indexes: z.boolean(),
    sequences: z.boolean(),
    foreignKeys: z.boolean(),
    rlsPolicies: z.boolean(),
    functions: z.boolean(),
    triggers: z.boolean(),
    extensions: z.boolean(),
    enums: z.boolean(),
  }),
  conflictStrategy: z.enum(["SKIP", "UPSERT", "OVERWRITE"]),
  batchSize: z.number().int().min(1).max(10_000),
});

const bodySchema = z.object({
  source: z.object({ connectionString: z.string().min(10) }),
  config: configSchema,
});

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: "Validation failed", issues: parsed.error.issues },
      { status: 400 }
    );
  }

  const { source, config } = parsed.data;
  const client = createClient(source.connectionString);

  try {
    await client.connect();
    const schema = await fetchSchema(client);
    const selectedTables = filterTables(schema.tables, config);
    const selectedSchemas = Array.from(new Set(selectedTables.map((t) => t.schema)));
    const lines: string[] = [];

    lines.push("-- Supabase Migrator backup");
    lines.push(`-- Created at: ${new Date().toISOString()}`);
    lines.push(`-- Tables: ${selectedTables.length}`);
    lines.push("");
    lines.push("BEGIN;");
    lines.push("");

    for (const s of selectedSchemas) {
      lines.push(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(s)};`);
    }
    if (selectedSchemas.length) lines.push("");

    for (const t of selectedTables) {
      const qn = `${t.schema}.${t.name}`;
      lines.push(`-- Table ${qn}`);
      lines.push(buildCreateTableStatement(t));
      const pk = await fetchPrimaryKey(client, t.schema, t.name).catch(() => []);
      if (pk.length) {
        lines.push(buildCreatePrimaryKeyStatement(t.schema, t.name, pk));
      }

      const filter = config.rowFilters[qn];
      const baseSelect = buildSelectSql(t, filter);
      const batchSize = Math.min(Math.max(config.batchSize || 1000, 1), 10_000);
      let offset = 0;

      for (;;) {
        const pageSql = `${baseSelect} OFFSET ${offset} LIMIT ${batchSize}`;
        const page = await client.query<Record<string, unknown>>(pageSql);
        if (page.rows.length === 0) break;

        const cols = t.columns.map((c) => c.column_name);
        const valuesSql = page.rows
          .map((row) => `(${cols.map((c) => quoteLiteral(row[c])).join(", ")})`)
          .join(",\n  ");
        lines.push(
          `INSERT INTO ${quoteQualified(t.schema, t.name)} (${cols.map(quoteIdent).join(
            ", "
          )}) VALUES\n  ${valuesSql};`
        );

        if (page.rows.length < batchSize) break;
        offset += batchSize;
      }

      lines.push("");
    }

    lines.push("COMMIT;");
    lines.push("");

    const sql = lines.join("\n");
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const fileName = `supabase-backup-${timestamp}.sql`;

    return new NextResponse(sql, {
      headers: {
        "Content-Type": "text/sql; charset=utf-8",
        "Content-Disposition": `attachment; filename="${fileName}"`,
      },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Backup generation failed";
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  } finally {
    await client.end().catch(() => {});
  }
}
