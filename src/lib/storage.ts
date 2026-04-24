import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseAdmin } from "@/lib/supabase";
import { pLimit } from "@/lib/concurrency";

type BucketInfo = {
  id: string;
  name: string;
  public: boolean;
  fileSizeLimit: number | null;
  allowedMimeTypes: string[] | null;
};

type CopyStorageInput = {
  sourceUrl: string;
  sourceServiceKey: string;
  destinationUrl: string;
  destinationServiceKey: string;
  onLog?: (message: string) => void;
  fileConcurrency?: number;
};

export type StorageCopyResult = {
  buckets: number;
  bucketsFailed: number;
  files: number;
  filesFailed: number;
};

const DEFAULT_FILE_CONCURRENCY = 8;
const PROGRESS_EVERY_N = 25;

export async function copySupabaseStorage(input: CopyStorageInput): Promise<StorageCopyResult> {
  const src = createSupabaseAdmin(input.sourceUrl, input.sourceServiceKey);
  const dst = createSupabaseAdmin(input.destinationUrl, input.destinationServiceKey);
  const concurrency = input.fileConcurrency ?? DEFAULT_FILE_CONCURRENCY;

  let buckets: BucketInfo[];
  try {
    buckets = await listBuckets(src);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown";
    input.onLog?.(`Storage: failed to list source buckets — ${msg}`);
    return { buckets: 0, bucketsFailed: 0, files: 0, filesFailed: 0 };
  }

  if (buckets.length === 0) {
    input.onLog?.("Storage: no buckets on source");
    return { buckets: 0, bucketsFailed: 0, files: 0, filesFailed: 0 };
  }

  input.onLog?.(`Storage: found ${buckets.length} bucket(s) on source`);

  let bucketsOk = 0;
  let bucketsFailed = 0;
  let totalFiles = 0;
  let totalFailed = 0;

  for (const b of buckets) {
    input.onLog?.(`Storage: syncing bucket "${b.name}"`);
    try {
      await ensureBucket(dst, b);
    } catch (err) {
      bucketsFailed += 1;
      const msg = err instanceof Error ? err.message : "unknown";
      input.onLog?.(`Storage: bucket "${b.name}" skipped — ${msg}`);
      continue;
    }

    let objects: string[];
    try {
      objects = await listAllObjectsRecursive(src, b.name, "", 500);
    } catch (err) {
      bucketsFailed += 1;
      const msg = err instanceof Error ? err.message : "unknown";
      input.onLog?.(`Storage: failed to list "${b.name}" — ${msg}`);
      continue;
    }

    if (objects.length === 0) {
      input.onLog?.(`Storage: "${b.name}" is empty, bucket created`);
      bucketsOk += 1;
      continue;
    }

    input.onLog?.(
      `Storage: "${b.name}" has ${objects.length} file(s), copying with concurrency=${concurrency}`
    );

    const limit = pLimit(concurrency);
    let copied = 0;
    let failed = 0;
    let lastLogged = 0;

    await Promise.all(
      objects.map((path) =>
        limit(async () => {
          try {
            const data = await downloadObject(src, b.name, path);
            await uploadObject(dst, b.name, path, data);
            copied += 1;
          } catch (err) {
            failed += 1;
            const msg = err instanceof Error ? err.message : "unknown";
            input.onLog?.(`Storage: file failed "${b.name}/${path}" — ${msg}`);
          }
          const done = copied + failed;
          if (done - lastLogged >= PROGRESS_EVERY_N || done === objects.length) {
            lastLogged = done;
            input.onLog?.(
              `Storage: "${b.name}" ${done}/${objects.length} (${copied} ok, ${failed} failed)`
            );
          }
        })
      )
    );

    totalFiles += copied;
    totalFailed += failed;
    bucketsOk += 1;
    input.onLog?.(
      `Storage: bucket "${b.name}" done — ${copied} copied, ${failed} failed`
    );
  }

  input.onLog?.(
    `Storage: summary — ${bucketsOk}/${buckets.length} buckets, ${totalFiles} files copied, ${totalFailed} failed`
  );

  return {
    buckets: bucketsOk,
    bucketsFailed,
    files: totalFiles,
    filesFailed: totalFailed,
  };
}

async function listBuckets(client: SupabaseClient): Promise<BucketInfo[]> {
  const { data, error } = await client.storage.listBuckets();
  if (error) throw new Error(`Failed to list source buckets: ${error.message}`);
  return (data ?? []).map((b) => ({
    id: b.id,
    name: b.name,
    public: Boolean(b.public),
    fileSizeLimit: b.file_size_limit ?? null,
    allowedMimeTypes: b.allowed_mime_types ?? null,
  }));
}

async function ensureBucket(client: SupabaseClient, bucket: BucketInfo): Promise<void> {
  const { data: existing, error: getErr } = await client.storage.getBucket(bucket.id);
  if (getErr || !existing) {
    const { error: createErr } = await client.storage.createBucket(bucket.name, {
      public: bucket.public,
      fileSizeLimit: bucket.fileSizeLimit ?? undefined,
      allowedMimeTypes: bucket.allowedMimeTypes ?? undefined,
    });
    if (createErr && !/already exists/i.test(createErr.message)) {
      throw new Error(`Failed to create bucket ${bucket.name}: ${createErr.message}`);
    }
    return;
  }

  const { error: updateErr } = await client.storage.updateBucket(bucket.id, {
    public: bucket.public,
    fileSizeLimit: bucket.fileSizeLimit ?? undefined,
    allowedMimeTypes: bucket.allowedMimeTypes ?? undefined,
  });
  if (updateErr) {
    throw new Error(`Failed to update bucket ${bucket.name}: ${updateErr.message}`);
  }
}

async function listAllObjectsRecursive(
  client: SupabaseClient,
  bucket: string,
  prefix: string,
  limit: number
): Promise<string[]> {
  const out: string[] = [];
  let offset = 0;

  for (;;) {
    const { data, error } = await client.storage.from(bucket).list(prefix, {
      limit,
      offset,
      sortBy: { column: "name", order: "asc" },
    });
    if (error) throw new Error(`Failed to list objects in ${bucket}/${prefix}: ${error.message}`);
    const items = data ?? [];

    for (const item of items) {
      if (!item.name) continue;
      if (item.id === null) {
        const nestedPrefix = prefix ? `${prefix}/${item.name}` : item.name;
        const nested = await listAllObjectsRecursive(client, bucket, nestedPrefix, limit);
        out.push(...nested);
      } else {
        const fullPath = prefix ? `${prefix}/${item.name}` : item.name;
        out.push(fullPath);
      }
    }

    if (items.length < limit) break;
    offset += limit;
  }

  return out;
}

async function downloadObject(client: SupabaseClient, bucket: string, path: string): Promise<Blob> {
  const { data, error } = await client.storage.from(bucket).download(path);
  if (error || !data) {
    throw new Error(`Failed to download ${bucket}/${path}: ${error?.message ?? "no data"}`);
  }
  return data;
}

async function uploadObject(client: SupabaseClient, bucket: string, path: string, data: Blob): Promise<void> {
  const { error } = await client.storage.from(bucket).upload(path, data, { upsert: true });
  if (error) throw new Error(`Failed to upload ${bucket}/${path}: ${error.message}`);
}
