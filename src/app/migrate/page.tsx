"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Stepper } from "@/components/Stepper";
import { TableSelector } from "@/components/TableSelector";
import { FilterConfig } from "@/components/FilterConfig";
import { useMigrator } from "@/components/MigratorProvider";
import type { SchemaResponse } from "@/lib/types";

export default function MigratePage() {
  const router = useRouter();
  const { source, sourceSchema, setSourceSchema, config, setConfig } = useMigrator();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!source.connectionString) {
      router.replace("/");
      return;
    }
    if (sourceSchema) return;
    (async () => {
      setLoading(true);
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
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : "Unknown error");
      } finally {
        setLoading(false);
      }
    })();
  }, [source.connectionString, sourceSchema, setSourceSchema, router]);

  const hasSelection =
    config.selectedSchemas.length > 0 || config.selectedTables.length > 0;

  return (
    <div className="min-h-screen flex flex-col">
      <Stepper current={2} />
      <main className="flex-1 mx-auto max-w-6xl w-full px-6 py-10">
        <header className="mb-8">
          <h1 className="text-3xl font-semibold tracking-tight">Configure Migration</h1>
          <p className="text-[var(--muted)] mt-2 max-w-2xl">
            Choose what to copy from the source. Combine scope filters, row-level WHERE clauses,
            and object-type flags.
          </p>
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
