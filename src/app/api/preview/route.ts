import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/pg";
import { fetchSchema, generatePreview } from "@/lib/migration";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const configSchema = z.object({
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
    storage: z.boolean(),
  }),
  conflictStrategy: z.enum(["SKIP", "UPSERT", "OVERWRITE"]),
  batchSize: z.number().int().min(1).max(10_000),
});

const schema = z.object({
  source: z.object({ connectionString: z.string().min(10) }),
  destination: z.object({ connectionString: z.string().min(10) }),
  config: configSchema,
});

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "Validation failed", issues: parsed.error.issues }, { status: 400 });
  }

  const src = createClient(parsed.data.source.connectionString);
  const dst = createClient(parsed.data.destination.connectionString);
  try {
    await src.connect();
    await dst.connect();
    const srcSchema = await fetchSchema(src);
    const preview = await generatePreview(src, dst, parsed.data.config, srcSchema);
    return NextResponse.json({ ok: true, ...preview });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  } finally {
    await src.end().catch(() => {});
    await dst.end().catch(() => {});
  }
}
