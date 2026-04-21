"use client";

import { useMemo, useState } from "react";
import type { SchemaResponse, MigrationConfig } from "@/lib/types";

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

type Props = {
  schema: SchemaResponse;
  config: MigrationConfig;
  onChange: (c: MigrationConfig) => void;
};

export function TableSelector({ schema, config, onChange }: Props) {
  const [search, setSearch] = useState("");
  const [openFilterFor, setOpenFilterFor] = useState<string | null>(null);

  const activeSchemas = new Set(config.selectedSchemas);
  const selectedTableSet = new Set(config.selectedTables);

  const visibleTables = useMemo(
    () =>
      schema.tables.filter((t) => {
        if (activeSchemas.size > 0 && !activeSchemas.has(t.schema)) return false;
        if (search && !(`${t.schema}.${t.name}`.toLowerCase().includes(search.toLowerCase()))) {
          return false;
        }
        return true;
      }),
    [schema.tables, activeSchemas, search]
  );

  function toggleSchema(s: string) {
    const next = new Set(config.selectedSchemas);
    if (next.has(s)) next.delete(s);
    else next.add(s);
    onChange({ ...config, selectedSchemas: Array.from(next) });
  }

  function toggleTable(qn: string) {
    const next = new Set(config.selectedTables);
    if (next.has(qn)) next.delete(qn);
    else next.add(qn);
    onChange({ ...config, selectedTables: Array.from(next) });
  }

  function selectAllVisible() {
    const next = new Set(config.selectedTables);
    for (const t of visibleTables) next.add(`${t.schema}.${t.name}`);
    onChange({ ...config, selectedTables: Array.from(next) });
  }

  function clearSelection() {
    onChange({ ...config, selectedTables: [] });
  }

  function updateFilter(qn: string, patch: { whereClause?: string; rowLimit?: number }) {
    const prev = config.rowFilters[qn] ?? {};
    const merged = { ...prev, ...patch };
    if ((!merged.whereClause || !merged.whereClause.trim()) && !merged.rowLimit) {
      const { [qn]: _removed, ...rest } = config.rowFilters;
      void _removed;
      onChange({ ...config, rowFilters: rest });
    } else {
      onChange({ ...config, rowFilters: { ...config.rowFilters, [qn]: merged } });
    }
  }

  return (
    <div className="sm-card p-5">
      <div className="flex items-center justify-between gap-4 mb-4">
        <div>
          <h3 className="text-sm font-semibold">Schemas & Tables</h3>
          <p className="text-xs text-[var(--muted)] mt-0.5">
            Select which to migrate. Leave tables empty to include all tables in chosen schemas.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button className="sm-btn text-xs" onClick={selectAllVisible}>
            Select visible
          </button>
          <button className="sm-btn text-xs" onClick={clearSelection}>
            Clear
          </button>
        </div>
      </div>

      <div className="flex flex-wrap gap-2 mb-4">
        {schema.schemas.map((s) => {
          const on = activeSchemas.has(s);
          return (
            <button
              key={s}
              onClick={() => toggleSchema(s)}
              className={`px-3 py-1 rounded-full text-xs border transition-colors ${
                on
                  ? "bg-emerald-500/15 border-emerald-500/40 text-emerald-300"
                  : "border-[var(--border)] text-slate-400 hover:border-slate-500"
              }`}
            >
              {s}
            </button>
          );
        })}
      </div>

      <input
        type="text"
        className="sm-input mb-3"
        placeholder="Filter tables…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />

      <div className="border border-[var(--border)] rounded-lg overflow-hidden">
        <div className="grid grid-cols-12 gap-2 px-3 py-2 text-[11px] uppercase tracking-wide text-slate-500 bg-[#0a101a] border-b border-[var(--border)]">
          <div className="col-span-5">Table</div>
          <div className="col-span-2 text-right">Rows (est.)</div>
          <div className="col-span-2 text-right">Size</div>
          <div className="col-span-3 text-right">Row Filter</div>
        </div>
        <div className="max-h-[420px] overflow-auto">
          {visibleTables.length === 0 ? (
            <div className="py-12 text-center text-sm text-slate-500">
              No tables match current filters.
            </div>
          ) : (
            visibleTables.map((t) => {
              const qn = `${t.schema}.${t.name}`;
              const checked = selectedTableSet.has(qn);
              const filter = config.rowFilters[qn];
              const hasFilter = Boolean(filter?.whereClause || filter?.rowLimit);
              const isOpen = openFilterFor === qn;
              return (
                <div key={qn} className="border-b border-[var(--border)] last:border-b-0">
                  <div className="grid grid-cols-12 gap-2 px-3 py-2 items-center hover:bg-white/[0.02]">
                    <label className="col-span-5 flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleTable(qn)}
                        className="accent-emerald-500"
                      />
                      <span className="font-mono text-xs text-slate-200">{qn}</span>
                    </label>
                    <div className="col-span-2 text-right font-mono text-xs text-slate-400">
                      {t.rowEstimate.toLocaleString()}
                    </div>
                    <div className="col-span-2 text-right font-mono text-xs text-slate-400">
                      {formatBytes(t.sizeBytes)}
                    </div>
                    <div className="col-span-3 text-right">
                      <button
                        className={`text-[11px] px-2 py-1 rounded border transition-colors ${
                          hasFilter
                            ? "border-emerald-500/40 text-emerald-300 bg-emerald-500/10"
                            : "border-[var(--border)] text-slate-400 hover:text-slate-200"
                        }`}
                        onClick={() => setOpenFilterFor(isOpen ? null : qn)}
                      >
                        {hasFilter ? "Filter active" : "Add filter"}
                      </button>
                    </div>
                  </div>
                  {isOpen && (
                    <div className="px-3 pb-3 bg-[#0a101a] grid grid-cols-12 gap-2">
                      <div className="col-span-8">
                        <label className="text-[11px] text-slate-400 mb-1 block">
                          WHERE clause (SQL, applied on source)
                        </label>
                        <input
                          type="text"
                          className="sm-input font-mono text-xs"
                          placeholder="created_at > '2024-01-01'"
                          value={filter?.whereClause ?? ""}
                          onChange={(e) => updateFilter(qn, { whereClause: e.target.value })}
                        />
                      </div>
                      <div className="col-span-4">
                        <label className="text-[11px] text-slate-400 mb-1 block">
                          Row limit
                        </label>
                        <input
                          type="number"
                          min={0}
                          className="sm-input font-mono text-xs"
                          placeholder="0 = no limit"
                          value={filter?.rowLimit ?? ""}
                          onChange={(e) =>
                            updateFilter(qn, {
                              rowLimit: e.target.value ? Number(e.target.value) : undefined,
                            })
                          }
                        />
                      </div>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
      <div className="mt-3 text-xs text-slate-500">
        {visibleTables.length} visible · {config.selectedTables.length} selected
      </div>
    </div>
  );
}
