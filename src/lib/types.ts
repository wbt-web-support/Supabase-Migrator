export type ConnectionCreds = {
  projectUrl: string;
  serviceRoleKey: string;
  connectionString: string;
};

export type ColumnInfo = {
  column_name: string;
  data_type: string;
  is_nullable: "YES" | "NO";
  column_default: string | null;
  udt_name: string;
  character_maximum_length: number | null;
  numeric_precision: number | null;
  numeric_scale: number | null;
};

export type TableInfo = {
  schema: string;
  name: string;
  rowEstimate: number;
  sizeBytes: number;
  columns: ColumnInfo[];
};

export type SchemaResponse = {
  schemas: string[];
  tables: TableInfo[];
};

export type ObjectTypeFlags = {
  tables: boolean;
  views: boolean;
  indexes: boolean;
  sequences: boolean;
  foreignKeys: boolean;
  rlsPolicies: boolean;
  functions: boolean;
  triggers: boolean;
  extensions: boolean;
  enums: boolean;
  storage: boolean;
};

export type ScopeMode = "schema_and_data" | "schema_only" | "data_only";

export type ConflictStrategy = "SKIP" | "UPSERT" | "OVERWRITE";

export type TableRowFilter = {
  whereClause?: string;
  rowLimit?: number;
};

export type MigrationConfig = {
  scopeMode: ScopeMode;
  tablesOnly: boolean;
  selectedSchemas: string[];
  selectedTables: string[]; // format: "schema.name"
  rowFilters: Record<string, TableRowFilter>;
  objectTypes: ObjectTypeFlags;
  conflictStrategy: ConflictStrategy;
  batchSize: number;
};

export type PreviewResponse = {
  sql: string;
  plan: Array<{
    qualifiedName: string;
    estimatedRows: number;
    sizeBytes: number;
    warnings: string[];
  }>;
  warnings: string[];
};

export type SSEEvent =
  | { type: "start"; totalTables: number; startedAt: number }
  | { type: "table_start"; table: string }
  | { type: "table_progress"; table: string; rowsCopied: number }
  | { type: "table_done"; table: string; rowsCopied: number; durationMs: number }
  | { type: "table_error"; table: string; error: string }
  | { type: "log"; message: string }
  | { type: "done"; tablesDone: number; tablesFailed: number; totalRows: number; durationMs: number }
  | { type: "aborted"; message: string };
