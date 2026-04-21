"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Stepper } from "@/components/Stepper";
import { ProgressDashboard } from "@/components/ProgressDashboard";
import { useMigrator } from "@/components/MigratorProvider";

type Summary = {
  totalTables: number;
  tablesDone: number;
  tablesFailed: number;
  totalRows: number;
  durationMs: number;
  logText: string;
};

export default function RunPage() {
  const router = useRouter();
  const { source, destination, config, preview } = useMigrator();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [copyLabel, setCopyLabel] = useState("Copy log");

  useEffect(() => {
    if (!source.connectionString || !destination.connectionString) {
      router.replace("/");
    }
  }, [source.connectionString, destination.connectionString, router]);

  function handleDone(s: {
    tablesDone: number;
    tablesFailed: number;
    totalTables: number;
    totalRows: number;
    startedAt: number | null;
    finishedAt: number | null;
    logs: { ts: number; message: string }[];
  }) {
    const logText = s.logs
      .map((l) => `[${new Date(l.ts).toISOString()}] ${l.message}`)
      .join("\n");
    setSummary({
      totalTables: s.totalTables,
      tablesDone: s.tablesDone,
      tablesFailed: s.tablesFailed,
      totalRows: s.totalRows,
      durationMs: (s.finishedAt ?? Date.now()) - (s.startedAt ?? Date.now()),
      logText,
    });
  }

  async function copyLog() {
    if (!summary) return;
    try {
      await navigator.clipboard.writeText(summary.logText);
      setCopyLabel("Copied!");
      setTimeout(() => setCopyLabel("Copy log"), 1500);
    } catch {
      setCopyLabel("Copy failed");
    }
  }

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

  return (
    <div className="min-h-screen flex flex-col">
      <Stepper current={4} />
      <main className="flex-1 mx-auto max-w-6xl w-full px-6 py-10">
        <header className="mb-8">
          <h1 className="text-3xl font-semibold tracking-tight">Live Migration</h1>
          <p className="text-[var(--muted)] mt-2 max-w-2xl">
            Data streams from source to destination in batches of {config.batchSize.toLocaleString()}.
            Each table runs in its own transaction — one failure won&apos;t abort the rest.
          </p>
        </header>

        <ProgressDashboard
          source={source}
          destination={destination}
          config={config}
          onDone={handleDone}
        />

        {summary && (
          <div className="sm-card p-5 mt-6">
            <div className="flex items-start justify-between gap-4 flex-wrap">
              <div>
                <h3 className="text-sm font-semibold">Summary</h3>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-3">
                  <Stat label="Tables total" value={summary.totalTables.toLocaleString()} />
                  <Stat label="Tables done" value={summary.tablesDone.toLocaleString()} ok />
                  <Stat
                    label="Tables failed"
                    value={summary.tablesFailed.toLocaleString()}
                    warn={summary.tablesFailed > 0}
                  />
                  <Stat label="Rows migrated" value={summary.totalRows.toLocaleString()} />
                </div>
                <div className="text-xs text-slate-400 mt-3">
                  Duration: {(summary.durationMs / 1000).toFixed(1)}s
                </div>
              </div>
              <div className="flex gap-2 flex-wrap">
                <button className="sm-btn" onClick={copyLog}>
                  {copyLabel}
                </button>
                <button className="sm-btn" onClick={downloadSql} disabled={!preview}>
                  Download .sql
                </button>
                <button
                  className="sm-btn sm-btn-primary"
                  onClick={() => router.push("/migrate/preview")}
                >
                  Run another →
                </button>
              </div>
            </div>
          </div>
        )}

        <div className="flex justify-between items-center mt-8">
          <button className="sm-btn" onClick={() => router.push("/migrate/preview")}>
            ← Back to preview
          </button>
        </div>
      </main>
    </div>
  );
}

function Stat({
  label,
  value,
  ok,
  warn,
}: {
  label: string;
  value: string;
  ok?: boolean;
  warn?: boolean;
}) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide text-slate-500">{label}</div>
      <div
        className={`text-xl font-semibold mt-1 ${
          ok ? "text-emerald-300" : warn ? "text-amber-300" : "text-slate-100"
        }`}
      >
        {value}
      </div>
    </div>
  );
}
