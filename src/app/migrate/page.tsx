"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Stepper } from "@/components/Stepper";
import { TableSelector } from "@/components/TableSelector";
import { FilterConfig } from "@/components/FilterConfig";
import { useMigrator } from "@/components/MigratorProvider";
import type { SchemaResponse } from "@/lib/types";

const POLL_INTERVAL_MS = 30_000;

export default function MigratePage() {
  const router = useRouter();
  const { source, sourceSchema, setSourceSchema, config, setConfig } = useMigrator();
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadSchema = useCallback(
    async (silent = false) => {
      if (!source.connectionString) return;
      if (silent) setRefreshing(true);
      else setLoading(true);
      setError(null);
      try {
        const res = await fetch("/api/schema", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ connectionString: source.connectionString }),
        });
        const json = (await res.json()) as SchemaResponse & { ok: boolean; error?: string };
        if (!json.ok) throw new Error(json.error ?? "Failed to fetch schema");
        setSourceSchema({ schemas: json.schemas, tables: json.tables });
        setLastUpdated(new Date());
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : "Unknown error");
      } finally {
        if (silent) setRefreshing(false);
        else setLoading(false);
      }
    },
    [source.connectionString, setSourceSchema]
  );

  useEffect(() => {
    if (!source.connectionString) {
      router.replace("/");
      return;
    }
    loadSchema(false);

    pollRef.current = setInterval(() => loadSchema(true), POLL_INTERVAL_MS);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source.connectionString]);

  const hasSelection =
    config.selectedSchemas.length > 0 || config.selectedTables.length > 0;

  return (
    <div className="min-h-screen flex flex-col">
      <Stepper current={2} />
      <main className="flex-1 mx-auto max-w-6xl w-full px-6 py-10">
        <header className="mb-8 flex items-start justify-between gap-4">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight">Configure Migration</h1>
            <p className="text-[var(--muted)] mt-2 max-w-2xl">
              Choose what to copy from the source. Combine scope filters, row-level WHERE clauses,
              and object-type flags.
            </p>
          </div>
          <div className="flex flex-col items-end gap-1 shrink-0 mt-1">
            <button
              className="sm-btn text-xs flex items-center gap-1.5"
              disabled={loading || refreshing}
              onClick={() => loadSchema(true)}
            >
              <svg
                className={`w-3 h-3 ${refreshing ? "animate-spin" : ""}`}
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2.5}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                />
              </svg>
              {refreshing ? "Refreshing…" : "Refresh tables"}
            </button>
            {lastUpdated && (
              <span className="text-[10px] text-slate-500">
                Updated {lastUpdated.toLocaleTimeString()}
              </span>
            )}
          </div>
        </header>

        {loading && (
          <div className="sm-card p-6 text-center text-sm text-slate-400">
            Loading schema from source…
          </div>
        )}

        {error && (
          <div className="sm-card p-4 border-red-500/40 bg-red-500/5 text-sm text-red-300">
            Failed to load schema: {error}
          </div>
        )}

        {sourceSchema && !loading && (
          <div className="grid grid-cols-1 xl:grid-cols-[1.2fr_1fr] gap-5">
            <TableSelector schema={sourceSchema} config={config} onChange={setConfig} />
            <FilterConfig config={config} onChange={setConfig} />
          </div>
        )}

        <div className="flex justify-between items-center mt-8">
          <button className="sm-btn" onClick={() => router.push("/")}>
            ← Back
          </button>
          <button
            className="sm-btn sm-btn-primary"
            disabled={!sourceSchema || !hasSelection}
            onClick={() => router.push("/migrate/preview")}
          >
            Generate Preview →
          </button>
        </div>
      </main>
    </div>
  );
}
