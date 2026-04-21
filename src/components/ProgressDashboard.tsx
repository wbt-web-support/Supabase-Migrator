"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { ConnectionCreds, MigrationConfig, SSEEvent } from "@/lib/types";

type TableStatus =
  | { status: "pending" }
  | { status: "running"; rowsCopied: number; startedAt: number }
  | { status: "done"; rowsCopied: number; durationMs: number }
  | { status: "error"; error: string };

type State = {
  running: boolean;
  aborted: boolean;
  startedAt: number | null;
  finishedAt: number | null;
  totalTables: number;
  tablesDone: number;
  tablesFailed: number;
  totalRows: number;
  logs: { ts: number; message: string }[];
  tables: Record<string, TableStatus>;
  order: string[];
};

const initial: State = {
  running: false,
  aborted: false,
  startedAt: null,
  finishedAt: null,
  totalTables: 0,
  tablesDone: 0,
  tablesFailed: 0,
  totalRows: 0,
  logs: [],
  tables: {},
  order: [],
};

type Props = {
  source: ConnectionCreds;
  destination: ConnectionCreds;
  config: MigrationConfig;
  onDone?: (s: State) => void;
};

export function ProgressDashboard({ source, destination, config, onDone }: Props) {
  const [state, setState] = useState<State>(initial);
  const [tick, setTick] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  const startedRef = useRef(false);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 500);
    return () => clearInterval(id);
  }, []);

  const firedDoneRef = useRef(false);
  useEffect(() => {
    if (firedDoneRef.current) return;
    if (state.finishedAt == null) return;
    firedDoneRef.current = true;
    onDoneRef.current?.(state);
  }, [state]);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void start();
    // Intentionally no cleanup-abort: in React Strict Mode the first cleanup
    // would kill the fetch before the remount re-runs, and the guard above
    // prevents a restart. User-initiated aborts still go through abort().
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function start() {
    const controller = new AbortController();
    abortRef.current = controller;
    setState({ ...initial, running: true, startedAt: Date.now() });

    try {
      const res = await fetch("/api/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: { connectionString: source.connectionString },
          destination: { connectionString: destination.connectionString },
          config,
        }),
        signal: controller.signal,
      });
      if (!res.body) throw new Error("No response body");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n\n");
        buffer = lines.pop() ?? "";
        for (const chunk of lines) {
          const line = chunk.split("\n").find((l) => l.startsWith("data: "));
          if (!line) continue;
          try {
            const event = JSON.parse(line.slice(6)) as SSEEvent;
            applyEvent(event);
          } catch {
            /* ignore parse errors */
          }
        }
      }
    } catch (err: unknown) {
      if ((err as Error).name !== "AbortError") {
        setState((s) => ({
          ...s,
          running: false,
          logs: [...s.logs, { ts: Date.now(), message: `Stream error: ${(err as Error).message}` }],
        }));
      }
    }
  }

  function applyEvent(event: SSEEvent) {
    setState((prev) => {
      const next = { ...prev };
      next.logs = [...prev.logs, { ts: Date.now(), message: describe(event) }].slice(-500);
      switch (event.type) {
        case "start":
          next.totalTables = event.totalTables;
          next.startedAt = event.startedAt;
          break;
        case "table_start":
          if (!next.order.includes(event.table)) next.order = [...next.order, event.table];
          next.tables = {
            ...next.tables,
            [event.table]: { status: "running", rowsCopied: 0, startedAt: Date.now() },
          };
          break;
        case "table_progress": {
          const existing = next.tables[event.table];
          next.tables = {
            ...next.tables,
            [event.table]: {
              status: "running",
              rowsCopied: event.rowsCopied,
              startedAt:
                existing?.status === "running"
                  ? existing.startedAt
                  : Date.now(),
            },
          };
          break;
        }
        case "table_done":
          next.tables = {
            ...next.tables,
            [event.table]: {
              status: "done",
              rowsCopied: event.rowsCopied,
              durationMs: event.durationMs,
            },
          };
          next.tablesDone = prev.tablesDone + 1;
          next.totalRows = prev.totalRows + event.rowsCopied;
          break;
        case "table_error":
          next.tables = {
            ...next.tables,
            [event.table]: { status: "error", error: event.error },
          };
          next.tablesFailed = prev.tablesFailed + 1;
          break;
        case "done":
          next.running = false;
          next.finishedAt = Date.now();
          break;
        case "aborted":
          next.running = false;
          next.aborted = true;
          next.finishedAt = Date.now();
          break;
        default:
          break;
      }
      return next;
    });
  }

  function describe(e: SSEEvent): string {
    switch (e.type) {
      case "start":
        return `Migration started · ${e.totalTables} tables queued`;
      case "table_start":
        return `▶ ${e.table}`;
      case "table_progress":
        return `  ${e.table} · ${e.rowsCopied.toLocaleString()} rows`;
      case "table_done":
        return `✓ ${e.table} · ${e.rowsCopied.toLocaleString()} rows in ${(e.durationMs / 1000).toFixed(1)}s`;
      case "table_error":
        return `✗ ${e.table} · ${e.error}`;
      case "log":
        return e.message;
      case "done":
        return `✔ Done · ${e.tablesDone} ok, ${e.tablesFailed} failed · ${e.totalRows.toLocaleString()} rows in ${(e.durationMs / 1000).toFixed(1)}s`;
      case "aborted":
        return `✗ Aborted · ${e.message}`;
    }
  }

  function abort() {
    abortRef.current?.abort();
    setState((s) => ({ ...s, running: false, aborted: true, finishedAt: Date.now() }));
  }

  const elapsed = useMemo(() => {
    void tick;
    if (!state.startedAt) return 0;
    const end = state.finishedAt ?? Date.now();
    return end - state.startedAt;
  }, [state.startedAt, state.finishedAt, tick]);

  const pct =
    state.totalTables > 0
      ? Math.floor(((state.tablesDone + state.tablesFailed) / state.totalTables) * 100)
      : 0;

  return (
    <div className="flex flex-col gap-5">
      <div className="sm-card p-5">
        <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
          <div>
            <h3 className="text-sm font-semibold">Migration progress</h3>
            <p className="text-xs text-slate-500 mt-0.5">
              {state.running
                ? "Streaming live updates from the server"
                : state.aborted
                ? "Migration was aborted"
                : state.finishedAt
                ? "Migration complete"
                : "Starting…"}
            </p>
          </div>
          <div className="flex items-center gap-4 text-xs font-mono">
            <span className="text-slate-400">
              Elapsed: <span className="text-slate-200">{formatDuration(elapsed)}</span>
            </span>
            <span className="text-slate-400">
              Tables: <span className="text-slate-200">{state.tablesDone + state.tablesFailed}/{state.totalTables}</span>
            </span>
            <span className="text-slate-400">
              Rows: <span className="text-slate-200">{state.totalRows.toLocaleString()}</span>
            </span>
            {state.running && (
              <button className="sm-btn sm-btn-danger" onClick={abort}>
                Abort
              </button>
            )}
          </div>
        </div>
        <div className="h-2 w-full bg-[#0a101a] rounded-full overflow-hidden border border-[var(--border)]">
          <div
            className="h-full bg-gradient-to-r from-emerald-500 to-emerald-400 transition-all duration-300"
            style={{ width: `${pct}%` }}
          />
        </div>
        <div className="flex justify-between text-[11px] text-slate-500 mt-1">
          <span>{pct}%</span>
          <span>
            {state.tablesDone} done · {state.tablesFailed} failed
          </span>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1.3fr_1fr] gap-5">
        <div className="sm-card p-5">
          <h3 className="text-sm font-semibold mb-3">Tables</h3>
          <div className="max-h-[50vh] overflow-auto divide-y divide-[var(--border)]">
            {state.order.length === 0 ? (
              <div className="text-sm text-slate-500 text-center py-8">
                Waiting for migration to start…
              </div>
            ) : (
              state.order.map((qn) => {
                const t = state.tables[qn];
                if (!t) return null;
                return <TableRow key={qn} name={qn} state={t} tick={tick} />;
              })
            )}
          </div>
        </div>

        <div className="sm-card p-5">
          <h3 className="text-sm font-semibold mb-3">Log</h3>
          <div className="sm-code text-[11px] max-h-[50vh]">
            {state.logs.length === 0
              ? "No events yet."
              : state.logs
                  .map((l) => `[${new Date(l.ts).toLocaleTimeString()}] ${l.message}`)
                  .join("\n")}
          </div>
        </div>
      </div>
    </div>
  );
}

function TableRow({ name, state, tick }: { name: string; state: TableStatus; tick: number }) {
  void tick;
  const { icon, color, label, detail } = (() => {
    switch (state.status) {
      case "pending":
        return { icon: "⏳", color: "text-slate-500", label: "pending", detail: "" };
      case "running":
        return {
          icon: "🔄",
          color: "text-emerald-300",
          label: "in progress",
          detail: `${state.rowsCopied.toLocaleString()} rows · ${formatDuration(
            Date.now() - state.startedAt
          )}`,
        };
      case "done":
        return {
          icon: "✅",
          color: "text-emerald-400",
          label: "done",
          detail: `${state.rowsCopied.toLocaleString()} rows · ${(state.durationMs / 1000).toFixed(1)}s`,
        };
      case "error":
        return {
          icon: "❌",
          color: "text-red-400",
          label: "error",
          detail: state.error,
        };
    }
  })();

  return (
    <div className="py-2.5 flex items-start gap-3">
      <span className="text-base leading-none pt-0.5">{icon}</span>
      <div className="flex-1 min-w-0">
        <div className="font-mono text-xs text-slate-200 truncate">{name}</div>
        <div className={`text-[11px] ${color}`}>{label} {detail && `· ${detail}`}</div>
      </div>
    </div>
  );
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}
