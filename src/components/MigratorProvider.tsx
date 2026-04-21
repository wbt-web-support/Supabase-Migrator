"use client";

import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import type {
  ConnectionCreds,
  MigrationConfig,
  PreviewResponse,
  SchemaResponse,
} from "@/lib/types";

type Store = {
  source: ConnectionCreds;
  destination: ConnectionCreds;
  setSource: (c: ConnectionCreds) => void;
  setDestination: (c: ConnectionCreds) => void;

  sourceSchema: SchemaResponse | null;
  setSourceSchema: (s: SchemaResponse | null) => void;

  config: MigrationConfig;
  setConfig: (c: MigrationConfig) => void;

  preview: PreviewResponse | null;
  setPreview: (p: PreviewResponse | null) => void;
};

const emptyCreds: ConnectionCreds = {
  projectUrl: "",
  serviceRoleKey: "",
  connectionString: "",
};

export const defaultConfig: MigrationConfig = {
  scopeMode: "schema_and_data",
  tablesOnly: false,
  selectedSchemas: ["public"],
  selectedTables: [],
  rowFilters: {},
  objectTypes: {
    tables: true,
    views: true,
    indexes: true,
    sequences: true,
    foreignKeys: true,
    rlsPolicies: true,
    functions: false,
    triggers: false,
    extensions: false,
    enums: true,
  },
  conflictStrategy: "SKIP",
  batchSize: 1000,
};

const StoreContext = createContext<Store | null>(null);

export function MigratorProvider({ children }: { children: ReactNode }) {
  const [source, setSource] = useState<ConnectionCreds>(emptyCreds);
  const [destination, setDestination] = useState<ConnectionCreds>(emptyCreds);
  const [sourceSchema, setSourceSchema] = useState<SchemaResponse | null>(null);
  const [config, setConfig] = useState<MigrationConfig>(defaultConfig);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);

  const value = useMemo<Store>(
    () => ({
      source,
      destination,
      setSource,
      setDestination,
      sourceSchema,
      setSourceSchema,
      config,
      setConfig,
      preview,
      setPreview,
    }),
    [source, destination, sourceSchema, config, preview]
  );

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useMigrator(): Store {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error("useMigrator must be used within MigratorProvider");
  return ctx;
}
