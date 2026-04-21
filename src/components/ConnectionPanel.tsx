"use client";

import { useState } from "react";
import type { ConnectionCreds } from "@/lib/types";

type TestState =
  | { status: "idle" }
  | { status: "testing" }
  | { status: "ok"; message: string; details: { rest: string; pg: string } }
  | { status: "err"; message: string; details?: { rest: string; pg: string } };

type Props = {
  title: string;
  subtitle: string;
  value: ConnectionCreds;
  onChange: (c: ConnectionCreds) => void;
};

export function ConnectionPanel({ title, subtitle, value, onChange }: Props) {
  const [showKey, setShowKey] = useState(false);
  const [showPg, setShowPg] = useState(false);
  const [test, setTest] = useState<TestState>({ status: "idle" });

  const urlOk = /^https?:\/\/.+/i.test(value.projectUrl);
  const keyOk = value.serviceRoleKey.length > 20;
  const pgOk = /^postgres(ql)?:\/\/.+/i.test(value.connectionString);
  const allOk = urlOk && keyOk && pgOk;

  async function runTest() {
    setTest({ status: "testing" });
    try {
      const res = await fetch("/api/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(value),
      });
      const json = await res.json();
      if (json.ok) {
        setTest({
          status: "ok",
          message: "Both connections succeeded",
          details: {
            rest: json.rest?.message ?? "ok",
            pg: json.pg?.version?.slice(0, 80) ?? json.pg?.message ?? "ok",
          },
        });
      } else {
        setTest({
          status: "err",
          message: json.error ?? "Connection test failed",
          details: {
            rest: json.rest?.message ?? "",
            pg: json.pg?.message ?? "",
          },
        });
      }
    } catch (err: unknown) {
      setTest({
        status: "err",
        message: err instanceof Error ? err.message : "Network error",
      });
    }
  }

  const fieldHintClass = (ok: boolean, touched: boolean) =>
    touched ? (ok ? "text-emerald-400" : "text-red-400") : "text-slate-500";

  return (
    <div className="sm-card p-5 flex flex-col gap-4">
      <div>
        <h3 className="text-base font-semibold tracking-tight">{title}</h3>
        <p className="text-xs text-[var(--muted)] mt-0.5">{subtitle}</p>
      </div>

      <div className="flex flex-col gap-3">
        <div>
          <label className="text-xs font-medium text-slate-300 mb-1 block">Project URL</label>
          <input
            type="url"
            className="sm-input"
            placeholder="https://xxxxx.supabase.co"
            value={value.projectUrl}
            onChange={(e) => onChange({ ...value, projectUrl: e.target.value })}
            autoComplete="off"
          />
          <p
            className={`text-[11px] mt-1 ${fieldHintClass(
              urlOk,
              value.projectUrl.length > 0
            )}`}
          >
            {value.projectUrl.length === 0
              ? "Required"
              : urlOk
              ? "Looks good"
              : "Must start with http(s)://"}
          </p>
        </div>

        <div>
          <label className="text-xs font-medium text-slate-300 mb-1 block">Service Role Key</label>
          <div className="relative">
            <input
              type={showKey ? "text" : "password"}
              className="sm-input pr-20 font-mono"
              placeholder="eyJhbGciOiJI..."
              value={value.serviceRoleKey}
              onChange={(e) => onChange({ ...value, serviceRoleKey: e.target.value })}
              autoComplete="off"
              spellCheck={false}
            />
            <button
              type="button"
              onClick={() => setShowKey((v) => !v)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-[11px] text-slate-400 hover:text-slate-200 px-2 py-1 rounded"
            >
              {showKey ? "Hide" : "Show"}
            </button>
          </div>
          <p
            className={`text-[11px] mt-1 ${fieldHintClass(
              keyOk,
              value.serviceRoleKey.length > 0
            )}`}
          >
            {value.serviceRoleKey.length === 0
              ? "Required — use service_role, not anon"
              : keyOk
              ? "Looks good"
              : "Too short"}
          </p>
        </div>

        <div>
          <label className="text-xs font-medium text-slate-300 mb-1 block">
            PostgreSQL Connection String
          </label>
          <p className="text-[11px] text-amber-300/90 mb-1.5">
            Use the <span className="font-semibold">Transaction pooler</span> string from Supabase
            (Project Settings → Database → Connection string). Direct connection won&apos;t work on
            Vercel / serverless (IPv6 only).
          </p>
          <div className="relative">
            <input
              type={showPg ? "text" : "password"}
              className="sm-input pr-20 font-mono"
              placeholder="postgresql://postgres.xxxx:...@aws-0-<region>.pooler.supabase.com:6543/postgres"
              value={value.connectionString}
              onChange={(e) => onChange({ ...value, connectionString: e.target.value })}
              autoComplete="off"
              spellCheck={false}
            />
            <button
              type="button"
              onClick={() => setShowPg((v) => !v)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-[11px] text-slate-400 hover:text-slate-200 px-2 py-1 rounded"
            >
              {showPg ? "Hide" : "Show"}
            </button>
          </div>
          <p
            className={`text-[11px] mt-1 ${fieldHintClass(
              pgOk,
              value.connectionString.length > 0
            )}`}
          >
            {value.connectionString.length === 0
              ? "Required — use the Transaction pooler URI (port 6543)"
              : pgOk
              ? "Looks good"
              : "Must start with postgres://"}
          </p>
        </div>
      </div>

      <div className="flex items-center justify-between border-t border-[var(--border)] pt-4">
        <button
          className="sm-btn"
          onClick={runTest}
          disabled={!allOk || test.status === "testing"}
        >
          {test.status === "testing" ? "Testing…" : "Test Connection"}
        </button>
        {test.status === "ok" && <span className="sm-badge sm-badge-ok">● Connected</span>}
        {test.status === "err" && <span className="sm-badge sm-badge-err">● Failed</span>}
      </div>

      {test.status === "ok" && (
        <div className="text-[11px] text-slate-400 space-y-0.5 font-mono">
          <div>REST: {test.details.rest}</div>
          <div>PG: {test.details.pg}</div>
        </div>
      )}
      {test.status === "err" && (
        <div className="text-[11px] text-red-300 space-y-0.5">
          <div>{test.message}</div>
          {test.details?.rest && <div className="font-mono text-slate-400">REST: {test.details.rest}</div>}
          {test.details?.pg && <div className="font-mono text-slate-400">PG: {test.details.pg}</div>}
        </div>
      )}
    </div>
  );
}
