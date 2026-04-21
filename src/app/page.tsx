"use client";

import { useRouter } from "next/navigation";
import { Stepper } from "@/components/Stepper";
import { ConnectionPanel } from "@/components/ConnectionPanel";
import { useMigrator } from "@/components/MigratorProvider";

export default function Home() {
  const router = useRouter();
  const { source, destination, setSource, setDestination } = useMigrator();

  const ready =
    /^https?:\/\/.+/i.test(source.projectUrl) &&
    source.serviceRoleKey.length > 20 &&
    /^postgres(ql)?:\/\/.+/i.test(source.connectionString) &&
    /^https?:\/\/.+/i.test(destination.projectUrl) &&
    destination.serviceRoleKey.length > 20 &&
    /^postgres(ql)?:\/\/.+/i.test(destination.connectionString);

  return (
    <div className="min-h-screen flex flex-col">
      <Stepper current={1} />
      <main className="flex-1 mx-auto max-w-6xl w-full px-6 py-10">
        <header className="mb-8">
          <h1 className="text-3xl font-semibold tracking-tight">Connect Source and Destination</h1>
          <p className="text-[var(--muted)] mt-2 max-w-2xl">
            Enter credentials for both Supabase projects. Nothing is stored — credentials live
            only in memory for this session and are used solely to run queries server-side.
          </p>
        </header>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          <ConnectionPanel
            title="Source"
            subtitle="The project you're migrating from"
            value={source}
            onChange={setSource}
          />
          <ConnectionPanel
            title="Destination"
            subtitle="The project that will receive the data"
            value={destination}
            onChange={setDestination}
          />
        </div>

        <div className="sm-card p-4 mt-6 flex items-start gap-3">
          <div className="text-emerald-400 mt-0.5">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
              <rect x="3" y="11" width="18" height="11" rx="2" />
              <path d="M7 11V7a5 5 0 0110 0v4" />
            </svg>
          </div>
          <div className="text-sm text-slate-300">
            <div className="font-medium text-white">Credentials are used only for this session.</div>
            <div className="text-[var(--muted)] text-xs mt-0.5">
              Keys stay in React memory. All PostgreSQL queries run server-side inside Next.js API routes. Nothing is written to localStorage, cookies, or any third party.
            </div>
          </div>
        </div>

        <div className="flex justify-end mt-8">
          <button
            className="sm-btn sm-btn-primary"
            disabled={!ready}
            onClick={() => router.push("/migrate")}
          >
            Continue to Schema Explorer →
          </button>
        </div>
      </main>
    </div>
  );
}
