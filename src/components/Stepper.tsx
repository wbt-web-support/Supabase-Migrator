"use client";

import Link from "next/link";

const steps = [
  { id: 1, label: "Connect", href: "/" },
  { id: 2, label: "Configure", href: "/migrate" },
  { id: 3, label: "Preview", href: "/migrate/preview" },
  { id: 4, label: "Run", href: "/migrate/run" },
];

export function Stepper({ current }: { current: number }) {
  return (
    <nav className="w-full border-b border-[var(--border)] bg-[var(--panel)]">
      <div className="mx-auto max-w-6xl px-6 py-4 flex items-center gap-2">
        <div className="flex items-center gap-2 mr-6">
          <div className="w-8 h-8 rounded-lg bg-emerald-500/15 border border-emerald-500/40 flex items-center justify-center">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="w-4 h-4 text-emerald-400"
            >
              <ellipse cx="12" cy="5" rx="9" ry="3" />
              <path d="M3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5" />
              <path d="M3 12c0 1.66 4.03 3 9 3s9-1.34 9-3" />
            </svg>
          </div>
          <span className="font-semibold tracking-tight">Supabase Migrator</span>
        </div>
        <div className="flex items-center gap-1 flex-1 flex-wrap">
          {steps.map((s, i) => {
            const active = s.id === current;
            const passed = s.id < current;
            return (
              <div key={s.id} className="flex items-center gap-1">
                <Link
                  href={s.href}
                  className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-sm transition-colors ${
                    active
                      ? "bg-emerald-500/15 text-emerald-300 border border-emerald-500/40"
                      : passed
                      ? "text-emerald-400 hover:bg-white/5"
                      : "text-slate-500 hover:bg-white/5"
                  }`}
                >
                  <span
                    className={`w-5 h-5 rounded-full flex items-center justify-center text-[11px] font-semibold ${
                      active
                        ? "bg-emerald-500 text-black"
                        : passed
                        ? "bg-emerald-500/30 text-emerald-200"
                        : "bg-slate-700 text-slate-300"
                    }`}
                  >
                    {s.id}
                  </span>
                  {s.label}
                </Link>
                {i < steps.length - 1 && <span className="text-slate-700">›</span>}
              </div>
            );
          })}
        </div>
      </div>
    </nav>
  );
}
