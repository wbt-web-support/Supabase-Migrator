import { z } from "zod";
import { createClient, createPool, quoteQualified, quoteIdent } from "@/lib/pg";
import { copySupabaseStorage } from "@/lib/storage";
import { pLimit } from "@/lib/concurrency";
import {
  buildAddPrimaryKeyStatement,
  buildCreateTableStatement,
  fetchExtensions,
  fetchEnums,
  fetchForeignKeysBatch,
  fetchFunctions,
  fetchIndexesBatch,
  fetchPrimaryKey,
  fetchRlsPoliciesBatch,
  fetchSchema,
  fetchSequences,
  fetchTriggersBatch,
  fetchViews,
  filterTables,
} from "@/lib/migration";
import type { MigrationConfig, SSEEvent, TableInfo } from "@/lib/types";
import type { Pool, PoolClient } from "pg";
import { from as copyFrom, to as copyTo } from "pg-copy-streams";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TABLE_CONCURRENCY = 6;
const DDL_CONCURRENCY = 10;
const SRC_POOL_SIZE = 10;
const DST_POOL_SIZE = 20;
const PROGRESS_INTERVAL_MS = 500;

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

const bodySchema = z.object({
  source: z.object({
    connectionString: z.string().min(10),
    projectUrl: z.string().optional(),
    serviceRoleKey: z.string().optional(),
  }),
  destination: z.object({
    connectionString: z.string().min(10),
    projectUrl: z.string().optional(),
    serviceRoleKey: z.string().optional(),
  }),
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

      sendRaw(`: ${" ".repeat(2048)}\n\n`);
      sendRaw(`: connected\n\n`);

      const heartbeat = setInterval(() => sendRaw(`: ping\n\n`), 5_000);

      const startedAt = Date.now();
      const srcClient = createClient(source.connectionString);
      const srcDataPool = createPool(source.connectionString, SRC_POOL_SIZE);
      const dstPool = createPool(destination.connectionString, DST_POOL_SIZE);

      try {
        send({ type: "log", message: "Connecting to source database…" });
        await srcClient.connect();
        send({ type: "log", message: "Connected to source. Introspecting schema…" });

        const fullSchema = await fetchSchema(srcClient);
        const selectedTables = filterTables(fullSchema.tables, config);
        const selectedSchemas = Array.from(new Set(selectedTables.map((t) => t.schema)));

        send({ type: "start", totalTables: selectedTables.length, startedAt });
        send({
          type: "log",
          message: `Planning migration for ${selectedTables.length} tables (parallel=${TABLE_CONCURRENCY})`,
        });

        const wantSchema = config.scopeMode !== "data_only";
        const wantData = config.scopeMode !== "schema_only";

        if (signal.aborted) throw new AbortError();

        // Pre-fetch primary keys once; used for DDL phase 1 AND data phase conflict handling.
        const pkMap = new Map<string, string[]>();
        if (config.objectTypes.tables) {
          for (const t of selectedTables) {
            const pk = await fetchPrimaryKey(srcClient, t.schema, t.name).catch(() => []);
            pkMap.set(`${t.schema}.${t.name}`, pk);
          }
        }

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

          });

          // Tables + primary keys: parallelized across the destination pool so 339
          // tables don't serialize 339×2 round trips on one connection.
          if (config.objectTypes.tables && selectedTables.length > 0) {
            const ok = await runParallelTableDDL(
              dstPool,
              selectedTables,
              pkMap,
              DDL_CONCURRENCY,
              signal,
              send
            );
            send({ type: "log", message: `Tables: ${ok}/${selectedTables.length} created` });
          }
        }

        let tablesDone = 0;
        let tablesFailed = 0;
        let totalRows = 0;

        if (wantData && config.objectTypes.tables) {
          const limit = pLimit(TABLE_CONCURRENCY);
          await Promise.all(
            selectedTables.map((t) =>
              limit(async () => {
                if (signal.aborted) return;
                const qn = `${t.schema}.${t.name}`;
                const tableStart = Date.now();
                send({ type: "table_start", table: qn });

                const srcC = await srcDataPool.connect();
                const dstC = await dstPool.connect();
                try {
                  await dstC.query("BEGIN");
                  // Fix 7: session tuning. Best-effort; falls back silently if role lacks privilege.
                  await dstC
                    .query("SET LOCAL session_replication_role = 'replica'")
                    .catch(() => {});
                  await dstC.query("SET LOCAL synchronous_commit = OFF").catch(() => {});

                  if (config.conflictStrategy === "OVERWRITE") {
                    await dstC.query(
                      `TRUNCATE ${quoteQualified(t.schema, t.name)} RESTART IDENTITY CASCADE`
                    );
                  }

                  const pk = pkMap.get(qn) ?? [];
                  const rowsCopied = await streamTableViaCopy(
                    srcC,
                    dstC,
                    t,
                    config,
                    pk,
                    signal,
                    makeThrottledProgress(send, qn)
                  );

                  await dstC.query("COMMIT");
                  totalRows += rowsCopied;
                  tablesDone += 1;
                  // Final progress so UI lands on the exact row count.
                  send({ type: "table_progress", table: qn, rowsCopied });
                  send({
                    type: "table_done",
                    table: qn,
                    rowsCopied,
                    durationMs: Date.now() - tableStart,
                  });
                } catch (err: unknown) {
                  await dstC.query("ROLLBACK").catch(() => {});
                  if (err instanceof AbortError || signal.aborted) {
                    send({ type: "log", message: `Aborted during ${qn}` });
                  } else {
                    tablesFailed += 1;
                    const msg = err instanceof Error ? err.message : "Unknown error";
                    send({ type: "table_error", table: qn, error: msg });
                  }
                } finally {
                  srcC.release();
                  dstC.release();
                }
              })
            )
          );
          if (signal.aborted) throw new AbortError();
        }

        if (wantSchema && !config.tablesOnly) {
          // Pre-fetch ALL per-table introspection in one round trip each, in parallel.
          // Replaces N×4 sequential source queries with 4 batched ones.
          const tableKeys = selectedTables.map((t) => ({ schema: t.schema, name: t.name }));
          const [indexMap, fkMap, trigMap, rlsMap, viewsRes, fnsRes] = await Promise.all([
            config.objectTypes.indexes
              ? fetchIndexesBatch(srcClient, tableKeys).catch(() => new Map<string, string[]>())
              : Promise.resolve(new Map<string, string[]>()),
            config.objectTypes.foreignKeys
              ? fetchForeignKeysBatch(srcClient, tableKeys).catch(() => new Map<string, string[]>())
              : Promise.resolve(new Map<string, string[]>()),
            config.objectTypes.triggers
              ? fetchTriggersBatch(srcClient, tableKeys).catch(() => new Map<string, string[]>())
              : Promise.resolve(new Map<string, string[]>()),
            config.objectTypes.rlsPolicies
              ? fetchRlsPoliciesBatch(srcClient, tableKeys).catch(() => new Map<string, string[]>())
              : Promise.resolve(new Map<string, string[]>()),
            config.objectTypes.views && selectedSchemas.length
              ? fetchViews(srcClient, selectedSchemas).catch(() => [] as string[])
              : Promise.resolve([] as string[]),
            config.objectTypes.functions && selectedSchemas.length
              ? fetchFunctions(srcClient, selectedSchemas).catch(() => [] as string[])
              : Promise.resolve([] as string[]),
          ]);

          if (config.objectTypes.indexes) {
            const [total, ok] = await runParallelStatements(
              dstPool,
              flattenMap(indexMap, "index"),
              DDL_CONCURRENCY,
              signal,
              send
            );
            send({ type: "log", message: `Indexes: ${ok}/${total} installed` });
          }
          if (config.objectTypes.foreignKeys) {
            const [total, ok] = await runParallelStatements(
              dstPool,
              flattenMap(fkMap, "fk"),
              DDL_CONCURRENCY,
              signal,
              send
            );
            send({ type: "log", message: `Foreign keys: ${ok}/${total} installed` });
          }
          if (config.objectTypes.views && viewsRes.length) {
            const [total, ok] = await runParallelStatements(
              dstPool,
              viewsRes.map((stmt) => ({ stmt, label: "view" })),
              DDL_CONCURRENCY,
              signal,
              send
            );
            send({ type: "log", message: `Views: ${ok}/${total} created` });
          }
          if (config.objectTypes.functions && fnsRes.length) {
            const [total, ok] = await runParallelStatements(
              dstPool,
              fnsRes.map((stmt) => ({ stmt, label: "function" })),
              DDL_CONCURRENCY,
              signal,
              send
            );
            send({ type: "log", message: `Functions: ${ok}/${total} created` });
          }
          if (config.objectTypes.triggers) {
            const [total, ok] = await runParallelStatements(
              dstPool,
              flattenMap(trigMap, "trigger"),
              DDL_CONCURRENCY,
              signal,
              send
            );
            send({ type: "log", message: `Triggers: ${ok}/${total} installed` });
          }
          if (config.objectTypes.rlsPolicies) {
            const [total, ok] = await runParallelStatements(
              dstPool,
              flattenMap(rlsMap, "rls"),
              DDL_CONCURRENCY,
              signal,
              send
            );
            send({ type: "log", message: `RLS: ${ok}/${total} applied` });
          }
        }

        if (config.objectTypes.storage) {
          if (
            !source.projectUrl ||
            !source.serviceRoleKey ||
            !destination.projectUrl ||
            !destination.serviceRoleKey
          ) {
            send({
              type: "log",
              message: "Storage: skipped (missing project URL or service role key on source/destination)",
            });
          } else {
            send({ type: "log", message: "Storage: starting bucket/file sync…" });
            const storageResult = await copySupabaseStorage({
              sourceUrl: source.projectUrl,
              sourceServiceKey: source.serviceRoleKey,
              destinationUrl: destination.projectUrl,
              destinationServiceKey: destination.serviceRoleKey,
              onLog: (message) => send({ type: "log", message }),
            });
            send({
              type: "log",
              message: `Storage: done (${storageResult.buckets} buckets, ${storageResult.files} files synced)`,
            });
          }
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
        await srcDataPool.end().catch(() => {});
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

// Parallel CREATE TABLE (+ primary key) across the destination pool.
// Tables don't reference each other at creation time (FKs are added post-data),
// so independent tables can be created concurrently.
async function runParallelTableDDL(
  dstPool: Pool,
  selectedTables: TableInfo[],
  pkMap: Map<string, string[]>,
  concurrency: number,
  signal: AbortSignal,
  send: (e: SSEEvent) => void
): Promise<number> {
  const limit = pLimit(concurrency);
  let ok = 0;
  await Promise.all(
    selectedTables.map((t) =>
      limit(async () => {
        if (signal.aborted) return;
        const c = await dstPool.connect();
        try {
          const label = `table ${t.schema}.${t.name}`;
          let createdOk = false;
          try {
            await c.query(buildCreateTableStatement(t));
            createdOk = true;
            ok += 1;
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : "unknown";
            send({ type: "log", message: `DDL skip ${label}: ${msg}` });
          }
          const pk = pkMap.get(`${t.schema}.${t.name}`) ?? [];
          if (createdOk && pk.length) {
            try {
              await c.query(buildAddPrimaryKeyStatement(t.schema, t.name, pk));
            } catch (err: unknown) {
              const msg = err instanceof Error ? err.message : "unknown";
              send({
                type: "log",
                message: `DDL skip primary key ${t.schema}.${t.name}: ${msg}`,
              });
            }
          }
        } finally {
          c.release();
        }
      })
    )
  );
  return ok;
}

// Generic parallel DDL runner: runs each {stmt, label} across the pool, reports
// per-statement errors as log events (non-fatal). Returns [total, okCount].
async function runParallelStatements(
  dstPool: Pool,
  items: Array<{ stmt: string; label: string }>,
  concurrency: number,
  signal: AbortSignal,
  send: (e: SSEEvent) => void
): Promise<[number, number]> {
  if (items.length === 0) return [0, 0];
  const limit = pLimit(concurrency);
  let ok = 0;
  await Promise.all(
    items.map((it) =>
      limit(async () => {
        if (signal.aborted) return;
        const c = await dstPool.connect();
        try {
          await c.query(it.stmt);
          ok += 1;
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : "unknown";
          send({ type: "log", message: `DDL skip ${it.label}: ${msg}` });
        } finally {
          c.release();
        }
      })
    )
  );
  return [items.length, ok];
}

function flattenMap(
  m: Map<string, string[]>,
  kind: string
): Array<{ stmt: string; label: string }> {
  const out: Array<{ stmt: string; label: string }> = [];
  for (const [qn, stmts] of m) {
    for (const stmt of stmts) out.push({ stmt, label: `${kind} ${qn}` });
  }
  return out;
}

// Fix 6: throttle progress so we don't flood SSE on fast streams.
function makeThrottledProgress(
  send: (e: SSEEvent) => void,
  qn: string
): (rowsCopied: number) => void {
  let lastEmit = 0;
  return (rowsCopied: number) => {
    const now = Date.now();
    if (now - lastEmit >= PROGRESS_INTERVAL_MS) {
      lastEmit = now;
      send({ type: "table_progress", table: qn, rowsCopied });
    }
  };
}

// Fixes 1, 4, 5: stream the table via COPY TO STDOUT → COPY FROM STDIN.
// No OFFSET pagination (server-side cursor inside COPY); no row-by-row INSERT; no buffering.
// SKIP/UPSERT route through a TEMP staging table so ON CONFLICT can apply.
async function streamTableViaCopy(
  srcC: PoolClient,
  dstC: PoolClient,
  t: TableInfo,
  config: MigrationConfig,
  pk: string[],
  signal: AbortSignal,
  onProgress: (rowsCopied: number) => void
): Promise<number> {
  const qn = quoteQualified(t.schema, t.name);
  const cols = t.columns.map((c) => c.column_name);
  const colList = cols.map(quoteIdent).join(", ");
  const filter = config.rowFilters[`${t.schema}.${t.name}`];

  let innerSelect = `SELECT ${colList} FROM ${qn}`;
  if (filter?.whereClause && filter.whereClause.trim()) {
    innerSelect += ` WHERE ${filter.whereClause}`;
  }
  if (filter?.rowLimit && filter.rowLimit > 0) {
    innerSelect += ` LIMIT ${Math.floor(filter.rowLimit)}`;
  }
  const copyToSql = `COPY (${innerSelect}) TO STDOUT`;

  const useStaging =
    (config.conflictStrategy === "SKIP" || config.conflictStrategy === "UPSERT") && pk.length > 0;
  let stagingIdent: string | null = null;
  let copyFromSql: string;

  if (useStaging) {
    const safeBase = t.name.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 40);
    const rnd = Math.random().toString(36).slice(2, 8);
    stagingIdent = quoteIdent(`_stg_${safeBase}_${rnd}`);
    await dstC.query(`CREATE TEMP TABLE ${stagingIdent} (LIKE ${qn}) ON COMMIT DROP`);
    copyFromSql = `COPY ${stagingIdent} (${colList}) FROM STDIN`;
  } else {
    // OVERWRITE (post-TRUNCATE) or no PK available: stream straight into target.
    copyFromSql = `COPY ${qn} (${colList}) FROM STDIN`;
  }

  let rowsCopied = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      // Postgres COPY text format: rows are separated by 0x0a. Binary data is hex-escaped
      // and embedded newlines are escaped as "\n", so raw 0x0a bytes only appear at row ends.
      for (let i = 0; i < chunk.length; i++) {
        if (chunk[i] === 0x0a) rowsCopied += 1;
      }
      onProgress(rowsCopied);
      cb(null, chunk);
    },
  });

  const reader = srcC.query(copyTo(copyToSql));
  const writer = dstC.query(copyFrom(copyFromSql));

  const onAbort = () => {
    reader.destroy(new AbortError());
    writer.destroy(new AbortError());
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    await pipeline(reader, counter, writer);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }

  if (signal.aborted) throw new AbortError();

  if (useStaging && stagingIdent) {
    const pkCols = pk.map(quoteIdent).join(", ");
    const updates = cols
      .filter((c) => !pk.includes(c))
      .map((c) => `${quoteIdent(c)} = EXCLUDED.${quoteIdent(c)}`)
      .join(", ");
    const conflictClause =
      config.conflictStrategy === "SKIP" || !updates
        ? `ON CONFLICT (${pkCols}) DO NOTHING`
        : `ON CONFLICT (${pkCols}) DO UPDATE SET ${updates}`;
    await dstC.query(
      `INSERT INTO ${qn} (${colList}) SELECT ${colList} FROM ${stagingIdent} ${conflictClause}`
    );
  }

  return rowsCopied;
}
