import { z } from "zod";
import { createClient, createPool, quoteQualified, quoteIdent } from "@/lib/pg";
import {
  buildCreateTableStatement,
  buildInsertSql,
  buildSelectSql,
  fetchExtensions,
  fetchEnums,
  fetchForeignKeys,
  fetchFunctions,
  fetchIndexes,
  fetchPrimaryKey,
  fetchRlsPolicies,
  fetchSchema,
  fetchSequences,
  fetchTriggers,
  fetchViews,
  filterTables,
} from "@/lib/migration";
import type { MigrationConfig, SSEEvent, TableInfo } from "@/lib/types";
import type { PoolClient } from "pg";

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
  }),
  conflictStrategy: z.enum(["SKIP", "UPSERT", "OVERWRITE"]),
  batchSize: z.number().int().min(1).max(10_000),
});

const bodySchema = z.object({
  source: z.object({ connectionString: z.string().min(10) }),
  destination: z.object({ connectionString: z.string().min(10) }),
  config: configSchema,
});

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return new Response(JSON.stringify({ error: "Validation failed", issues: parsed.error.issues }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const signal = request.signal;
  const { source, destination, config } = parsed.data;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      let closed = false;
      const sendRaw = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          closed = true;
        }
      };
      const send = (event: SSEEvent) => {
        sendRaw(`data: ${JSON.stringify(event)}\n\n`);
      };
      const close = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          /* ignore */
        }
      };

      // Force an initial flush through any upstream buffers (Next.js, proxies,
      // browser buffer thresholds) and open the event stream visibly.
      sendRaw(`: ${" ".repeat(2048)}\n\n`);
      sendRaw(`: connected\n\n`);

      const heartbeat = setInterval(() => sendRaw(`: ping\n\n`), 5_000);

      const startedAt = Date.now();
      const srcClient = createClient(source.connectionString);
      const dstPool = createPool(destination.connectionString, 4);

      try {
        send({ type: "log", message: "Connecting to source database…" });
        await srcClient.connect();
        send({ type: "log", message: "Connected to source. Introspecting schema…" });

        const fullSchema = await fetchSchema(srcClient);
        const selectedTables = filterTables(fullSchema.tables, config);
        const selectedSchemas = Array.from(new Set(selectedTables.map((t) => t.schema)));

        send({ type: "start", totalTables: selectedTables.length, startedAt });
        send({ type: "log", message: `Planning migration for ${selectedTables.length} tables` });

        const wantSchema = config.scopeMode !== "data_only";
        const wantData = config.scopeMode !== "schema_only";

        if (signal.aborted) throw new AbortError();

        if (wantSchema) {
          await runDDL(dstPool, send, signal, async (runStmt) => {
            let schemasOk = 0;
            for (const s of selectedSchemas) {
              if (await runStmt(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(s)}`, `schema ${s}`)) schemasOk += 1;
            }
            send({ type: "log", message: `Schemas: ${schemasOk}/${selectedSchemas.length} created` });

            if (!config.tablesOnly && config.objectTypes.extensions) {
              const ext = await fetchExtensions(srcClient).catch(() => []);
              let ok = 0;
              for (const stmt of ext) if (await runStmt(stmt, "extension")) ok += 1;
              if (ext.length) send({ type: "log", message: `Extensions: ${ok}/${ext.length} installed` });
            }
            if (!config.tablesOnly && config.objectTypes.enums && selectedSchemas.length) {
              const enums = await fetchEnums(srcClient, selectedSchemas).catch(() => []);
              let ok = 0;
              for (const stmt of enums) if (await runStmt(stmt, "enum")) ok += 1;
              if (enums.length) send({ type: "log", message: `Enums: ${ok}/${enums.length} created` });
            }
            if (!config.tablesOnly && config.objectTypes.sequences && selectedSchemas.length) {
              const seqs = await fetchSequences(srcClient, selectedSchemas).catch(() => []);
              let ok = 0;
              for (const stmt of seqs) if (await runStmt(stmt, "sequence")) ok += 1;
              if (seqs.length) send({ type: "log", message: `Sequences: ${ok}/${seqs.length} created` });
            }

            if (config.objectTypes.tables) {
              let ok = 0;
              for (const t of selectedTables) {
                if (await runStmt(buildCreateTableStatement(t), `table ${t.schema}.${t.name}`)) ok += 1;
              }
              send({ type: "log", message: `Tables: ${ok}/${selectedTables.length} created` });
            }
          });
        }

        let tablesDone = 0;
        let tablesFailed = 0;
        let totalRows = 0;

        if (wantData && config.objectTypes.tables) {
          for (const t of selectedTables) {
            if (signal.aborted) {
              send({ type: "aborted", message: "Migration aborted by user" });
              close();
              return;
            }
            const qn = `${t.schema}.${t.name}`;
            const tableStart = Date.now();
            send({ type: "table_start", table: qn });

            const dstClient = await dstPool.connect();
            try {
              await dstClient.query("BEGIN");
              // Best-effort: skip FK + trigger enforcement during bulk load.
              // Requires superuser (Supabase `postgres` role usually has it).
              await dstClient
                .query("SET LOCAL session_replication_role = 'replica'")
                .catch(() => {});

              if (config.conflictStrategy === "OVERWRITE") {
                await dstClient.query(`TRUNCATE ${quoteQualified(t.schema, t.name)} RESTART IDENTITY CASCADE`);
              }

              const rowsCopied = await streamTable(
                srcClient,
                dstClient,
                t,
                config,
                signal,
                (n) => send({ type: "table_progress", table: qn, rowsCopied: n })
              );

              await dstClient.query("COMMIT");
              totalRows += rowsCopied;
              tablesDone += 1;
              send({
                type: "table_done",
                table: qn,
                rowsCopied,
                durationMs: Date.now() - tableStart,
              });
            } catch (err: unknown) {
              await dstClient.query("ROLLBACK").catch(() => {});
              tablesFailed += 1;
              const msg = err instanceof Error ? err.message : "Unknown error";
              send({ type: "table_error", table: qn, error: msg });
            } finally {
              dstClient.release();
            }
          }
        }

        if (wantSchema && !config.tablesOnly) {
          await runDDL(dstPool, send, signal, async (runStmt) => {
            if (config.objectTypes.indexes) {
              let total = 0;
              let ok = 0;
              for (const t of selectedTables) {
                const idx = await fetchIndexes(srcClient, t.schema, t.name).catch(() => []);
                for (const stmt of idx) {
                  total += 1;
                  if (await runStmt(stmt, `index ${t.schema}.${t.name}`)) ok += 1;
                }
              }
              send({ type: "log", message: `Indexes: ${ok}/${total} installed` });
            }
            if (config.objectTypes.foreignKeys) {
              let total = 0;
              let ok = 0;
              for (const t of selectedTables) {
                const fks = await fetchForeignKeys(srcClient, t.schema, t.name).catch(() => []);
                for (const stmt of fks) {
                  total += 1;
                  if (await runStmt(stmt, `fk ${t.schema}.${t.name}`)) ok += 1;
                }
              }
              send({ type: "log", message: `Foreign keys: ${ok}/${total} installed` });
            }
            if (config.objectTypes.views && selectedSchemas.length) {
              const views = await fetchViews(srcClient, selectedSchemas).catch(() => []);
              let ok = 0;
              for (const stmt of views) if (await runStmt(stmt, "view")) ok += 1;
              if (views.length) send({ type: "log", message: `Views: ${ok}/${views.length} created` });
            }
            if (config.objectTypes.functions && selectedSchemas.length) {
              const fns = await fetchFunctions(srcClient, selectedSchemas).catch(() => []);
              let ok = 0;
              for (const stmt of fns) if (await runStmt(stmt, "function")) ok += 1;
              if (fns.length) send({ type: "log", message: `Functions: ${ok}/${fns.length} created` });
            }
            if (config.objectTypes.triggers) {
              let total = 0;
              let ok = 0;
              for (const t of selectedTables) {
                const trigs = await fetchTriggers(srcClient, t.schema, t.name).catch(() => []);
                for (const stmt of trigs) {
                  total += 1;
                  if (await runStmt(stmt, `trigger ${t.schema}.${t.name}`)) ok += 1;
                }
              }
              send({ type: "log", message: `Triggers: ${ok}/${total} installed` });
            }
            if (config.objectTypes.rlsPolicies) {
              let total = 0;
              let ok = 0;
              for (const t of selectedTables) {
                const pols = await fetchRlsPolicies(srcClient, t.schema, t.name).catch(() => []);
                for (const stmt of pols) {
                  total += 1;
                  if (await runStmt(stmt, `rls ${t.schema}.${t.name}`)) ok += 1;
                }
              }
              send({ type: "log", message: `RLS: ${ok}/${total} applied` });
            }
          });
        }

        send({
          type: "done",
          tablesDone,
          tablesFailed,
          totalRows,
          durationMs: Date.now() - startedAt,
        });
      } catch (err: unknown) {
        if (err instanceof AbortError) {
          send({ type: "aborted", message: "Migration aborted" });
        } else {
          const msg = err instanceof Error ? err.message : "Unknown error";
          send({ type: "log", message: `Fatal: ${msg}` });
          send({ type: "done", tablesDone: 0, tablesFailed: 0, totalRows: 0, durationMs: Date.now() - startedAt });
        }
      } finally {
        clearInterval(heartbeat);
        await srcClient.end().catch(() => {});
        await dstPool.end().catch(() => {});
        close();
      }
    },
    cancel() {
      /* client aborted */
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

class AbortError extends Error {
  constructor() {
    super("Aborted");
    this.name = "AbortError";
  }
}

type RunStmt = (stmt: string, label?: string) => Promise<boolean>;

async function runDDL(
  pool: { connect: () => Promise<PoolClient> },
  send: (e: SSEEvent) => void,
  signal: AbortSignal,
  fn: (runStmt: RunStmt) => Promise<void>
) {
  if (signal.aborted) throw new AbortError();
  const c = await pool.connect();
  const runStmt: RunStmt = async (stmt, label) => {
    if (signal.aborted) throw new AbortError();
    try {
      await c.query(stmt);
      return true;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "unknown";
      send({ type: "log", message: `DDL skip${label ? ` ${label}` : ""}: ${msg}` });
      return false;
    }
  };
  try {
    await fn(runStmt);
  } finally {
    c.release();
  }
}

async function streamTable(
  srcClient: import("pg").Client,
  dstClient: PoolClient,
  t: TableInfo,
  config: MigrationConfig,
  signal: AbortSignal,
  onProgress: (rowsCopied: number) => void
): Promise<number> {
  const qn = `${t.schema}.${t.name}`;
  const pk = await fetchPrimaryKey(srcClient, t.schema, t.name).catch(() => []);
  const filter = config.rowFilters[qn];

  const countSelect = `SELECT count(*)::bigint AS c FROM ${quoteQualified(t.schema, t.name)}${
    filter?.whereClause ? ` WHERE ${filter.whereClause}` : ""
  }${filter?.rowLimit ? ` LIMIT ${filter.rowLimit}` : ""}`;

  let _unused: unknown = null;
  _unused = countSelect;
  void _unused;

  const baseSelect = buildSelectSql(t, filter);
  const batchSize = config.batchSize;
  let offset = 0;
  let rowsCopied = 0;

  for (;;) {
    if (signal.aborted) throw new AbortError();
    const pageSql = `${baseSelect} OFFSET ${offset} LIMIT ${batchSize}`;
    const page = await srcClient.query<Record<string, unknown>>(pageSql);
    if (page.rows.length === 0) break;

    const insertSql = buildInsertSql(t, page.rows, config.conflictStrategy, pk);
    if (insertSql) await dstClient.query(insertSql);

    rowsCopied += page.rows.length;
    onProgress(rowsCopied);

    if (page.rows.length < batchSize) break;
    offset += batchSize;

    if (filter?.rowLimit && rowsCopied >= filter.rowLimit) break;
  }

  return rowsCopied;
}
