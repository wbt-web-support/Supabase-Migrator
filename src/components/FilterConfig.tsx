"use client";

import type { MigrationConfig, ConflictStrategy, ScopeMode, ObjectTypeFlags } from "@/lib/types";

type Props = {
  config: MigrationConfig;
  onChange: (c: MigrationConfig) => void;
};

const scopeModes: { id: ScopeMode; label: string; hint: string }[] = [
  { id: "schema_and_data", label: "Schema + Data", hint: "Full migration: DDL and rows" },
  { id: "schema_only", label: "Schema Only", hint: "DDL only, no rows" },
  { id: "data_only", label: "Data Only", hint: "INSERT rows into existing tables" },
];

const strategies: { id: ConflictStrategy; label: string; hint: string }[] = [
  { id: "SKIP", label: "Skip", hint: "ON CONFLICT DO NOTHING" },
  { id: "UPSERT", label: "Upsert", hint: "ON CONFLICT DO UPDATE (requires PK)" },
  { id: "OVERWRITE", label: "Overwrite", hint: "TRUNCATE target before INSERT" },
];

const objectTypeLabels: Record<keyof ObjectTypeFlags, string> = {
  tables: "Tables",
  views: "Views",
  indexes: "Indexes",
  sequences: "Sequences",
  foreignKeys: "Foreign Keys",
  rlsPolicies: "RLS Policies",
  functions: "Functions",
  triggers: "Triggers",
  extensions: "Extensions",
  enums: "Enums",
  storage: "Storage buckets/files",
};

export function FilterConfig({ config, onChange }: Props) {
  function setObjectType(key: keyof ObjectTypeFlags, value: boolean) {
    onChange({ ...config, objectTypes: { ...config.objectTypes, [key]: value } });
  }

  return (
    <div className="sm-card p-5 flex flex-col gap-5">
      <section>
        <h3 className="text-sm font-semibold mb-3">Scope</h3>
        <div className="grid grid-cols-3 gap-2">
          {scopeModes.map((m) => {
            const active = config.scopeMode === m.id;
            return (
              <button
                key={m.id}
                onClick={() => onChange({ ...config, scopeMode: m.id })}
                className={`text-left p-3 rounded-lg border transition-colors ${
                  active
                    ? "border-emerald-500/60 bg-emerald-500/10"
                    : "border-[var(--border)] hover:border-slate-500"
                }`}
              >
                <div className={`text-sm font-medium ${active ? "text-emerald-300" : "text-slate-200"}`}>
                  {m.label}
                </div>
                <div className="text-[11px] text-slate-500 mt-0.5">{m.hint}</div>
              </button>
            );
          })}
        </div>
        <label className="flex items-center gap-2 mt-3 cursor-pointer text-xs text-slate-300">
          <input
            type="checkbox"
            className="accent-emerald-500"
            checked={config.tablesOnly}
            onChange={(e) => onChange({ ...config, tablesOnly: e.target.checked })}
          />
          Tables only (skip functions, triggers, RLS policies, enums, etc.)
        </label>
      </section>

      <section>
        <h3 className="text-sm font-semibold mb-3">Object types</h3>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
          {(Object.keys(objectTypeLabels) as Array<keyof ObjectTypeFlags>).map((k) => {
            const disabled = config.tablesOnly && k !== "tables";
            return (
              <label
                key={k}
                className={`flex items-center gap-2 px-3 py-2 rounded-md border text-xs cursor-pointer ${
                  disabled ? "opacity-40 cursor-not-allowed border-[var(--border)]" :
                  config.objectTypes[k]
                    ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
                    : "border-[var(--border)] text-slate-300 hover:border-slate-500"
                }`}
              >
                <input
                  type="checkbox"
                  className="accent-emerald-500"
                  checked={config.objectTypes[k]}
                  disabled={disabled}
                  onChange={(e) => setObjectType(k, e.target.checked)}
                />
                {objectTypeLabels[k]}
              </label>
            );
          })}
        </div>
      </section>

      <section>
        <h3 className="text-sm font-semibold mb-3">Conflict strategy</h3>
        <div className="grid grid-cols-3 gap-2">
          {strategies.map((s) => {
            const active = config.conflictStrategy === s.id;
            return (
              <button
                key={s.id}
                onClick={() => onChange({ ...config, conflictStrategy: s.id })}
                className={`text-left p-3 rounded-lg border transition-colors ${
                  active
                    ? "border-emerald-500/60 bg-emerald-500/10"
                    : "border-[var(--border)] hover:border-slate-500"
                }`}
              >
                <div className={`text-sm font-medium ${active ? "text-emerald-300" : "text-slate-200"}`}>
                  {s.label}
                </div>
                <div className="text-[11px] text-slate-500 mt-0.5">{s.hint}</div>
              </button>
            );
          })}
        </div>
      </section>

      <section>
        <h3 className="text-sm font-semibold mb-3">Batch size</h3>
        <input
          type="number"
          min={1}
          max={10000}
          className="sm-input w-40 font-mono text-sm"
          value={config.batchSize}
          onChange={(e) =>
            onChange({ ...config, batchSize: Math.max(1, Math.min(10000, Number(e.target.value) || 1)) })
          }
        />
        <p className="text-[11px] text-slate-500 mt-1">Rows per INSERT batch (max 10,000)</p>
      </section>
    </div>
  );
}
