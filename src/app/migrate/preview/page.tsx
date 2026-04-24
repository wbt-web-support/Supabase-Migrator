"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Stepper } from "@/components/Stepper";
import { SqlPreview } from "@/components/SqlPreview";
import { PreviewLoader } from "@/components/PreviewLoader";
import { useMigrator } from "@/components/MigratorProvider";
import type { PreviewResponse } from "@/lib/types";

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export default function PreviewPage() {
  const router = useRouter();
  const { source, destination, config, preview, setPreview, setConfig } = useMigrator();
  const [loading, setLoading] = useState(false);
  const [downloadingBackup, setDownloadingBackup] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!source.connectionString || !destination.connectionString) {
      router.replace("/");
      return;
    }
  }, [source.connectionString, destination.connectionString, router]);

  async function runPreview() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: { connectionString: source.connectionString },
          destination: { connectionString: destination.connectionString },
          config,
        }),
      });
      const json = (await res.json()) as PreviewResponse & { ok: boolean; error?: string };
      if (!json.ok) throw new Error(json.error ?? "Preview failed");
      setPreview({ sql: json.sql, plan: json.plan, warnings: json.warnings });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!preview && !loading && source.connectionString && destination.connectionString) {
      runPreview();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function downloadSql() {
    if (!preview) return;
    const blob = new Blob([preview.sql], { type: "text/sql" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `supabase-migrate-${Date.now()}.sql`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function downloadBackup() {
    setError(null);
    setDownloadingBackup(true);
    try {
      const res = await fetch("/api/backup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: { connectionString: source.connectionString },
          config,
        }),
      });

      if (!res.ok) {
        const json = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(json?.error ?? "Backup download failed");
      }

      const blob = await res.blob();
      const cd = res.headers.get("Content-Disposition") ?? "";
      const match = cd.match(/filename="([^"]+)"/);
      const fileName = match?.[1] ?? `supabase-backup-${Date.now()}.sql`;

      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = fileName;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Backup download failed");
    } finally {
      setDownloadingBackup(false);
    }
  }

  return (
    <div className="min-h-screen flex flex-col">
      <Stepper current={3} />
      <main className="flex-1 mx-auto max-w-6xl w-full px-6 py-10">
        <header className="mb-8 flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight">Review SQL Preview</h1>
            <p className="text-[var(--muted)] mt-2 max-w-2xl">
              Verify the generated SQL and table plan before executing.
              Data migration runs row-by-row at execute time.
            </p>
          </div>
          <div className="flex gap-2">
            <button className="sm-btn" onClick={runPreview} disabled={loading}>
              {loading ? "Generating…" : "Regenerate"}
            </button>
            <button className="sm-btn" onClick={downloadBackup} disabled={loading || downloadingBackup}>
              {downloadingBackup ? "Preparing backup…" : "Backup tables (.sql)"}
            </button>
            <button className="sm-btn" onClick={downloadSql} disabled={!preview}>
              Download .sql
            </button>
          </div>
        </header>

        {error && (
          <div className="sm-card p-4 mb-6 border-red-500/40 bg-red-500/5 text-sm text-red-300">
            {error}
          </div>
        )}

        {loading && <PreviewLoader />}

        {preview && (
          <>
            {preview.warnings.length > 0 && (
              <div className="sm-card p-4 mb-6 border-amber-500/40 bg-amber-500/5">
                <div className="text-amber-300 font-medium text-sm mb-1">Warnings</div>
                <ul className="text-xs text-amber-200 space-y-0.5 list-disc list-inside">
                  {preview.warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              </div>
            )}

            <div className="grid grid-cols-1 lg:grid-cols-[2fr_1fr] gap-5">
              <div className="sm-card p-5">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-sm font-semibold">Generated SQL</h3>
                  <span className="text-xs text-slate-500">
                    {preview.sql.split("\n").length.toLocaleString()} lines
                  </span>
                </div>
                <SqlPreview sql={preview.sql} />
              </div>

              <div className="sm-card p-5">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-sm font-semibold">Table plan</h3>
                  <span className="text-xs text-slate-500">{preview.plan.length} tables</span>
                </div>
                <div className="max-h-[60vh] overflow-auto">
                  {preview.plan.length === 0 ? (
                    <div className="text-sm text-slate-500 text-center py-8">
                      No tables in plan.
                    </div>
                  ) : (
                    <ul className="space-y-2">
                      {preview.plan.map((p) => (
                        <li
                          key={p.qualifiedName}
                          className="border border-[var(--border)] rounded-md px-3 py-2"
                        >
                          <div className="font-mono text-xs text-slate-200">{p.qualifiedName}</div>
                          <div className="flex gap-4 mt-1 text-[11px] text-slate-400 font-mono">
                            <span>{p.estimatedRows.toLocaleString()} rows</span>
                            <span>{formatBytes(p.sizeBytes)}</span>
                          </div>
                          {p.warnings.length > 0 && (
                            <div className="mt-1 text-[11px] text-amber-300">
                              {p.warnings.map((w, i) => (
                                <div key={i}>⚠ {w}</div>
                              ))}
                            </div>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                <div className="border-t border-[var(--border)] mt-4 pt-4">
                  <label className="text-[11px] uppercase tracking-wide text-slate-500 block mb-2">
                    Conflict strategy
                  </label>
                  <select
                    className="sm-input"
                    value={config.conflictStrategy}
                    onChange={(e) =>
                      setConfig({
                        ...config,
                        conflictStrategy: e.target.value as typeof config.conflictStrategy,
                      })
                    }
                  >
                    <option value="SKIP">SKIP (ON CONFLICT DO NOTHING)</option>
                    <option value="UPSERT">UPSERT (ON CONFLICT DO UPDATE)</option>
                    <option value="OVERWRITE">OVERWRITE (TRUNCATE then INSERT)</option>
                  </select>
                </div>
              </div>
            </div>
          </>
        )}

        <div className="flex justify-between items-center mt-8">
          <button className="sm-btn" onClick={() => router.push("/migrate")}>
            ← Back
          </button>
          <button
            className="sm-btn sm-btn-primary"
            disabled={!preview}
            onClick={() => router.push("/migrate/run")}
          >
            Run Migration →
          </button>
        </div>
      </main>
    </div>
  );
}
