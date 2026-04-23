import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseAdmin } from "@/lib/supabase";

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
};

export async function copySupabaseStorage(input: CopyStorageInput): Promise<{ buckets: number; files: number }> {
  const src = createSupabaseAdmin(input.sourceUrl, input.sourceServiceKey);
  const dst = createSupabaseAdmin(input.destinationUrl, input.destinationServiceKey);

  const buckets = await listBuckets(src);
  let copiedBuckets = 0;
  let copiedFiles = 0;

  for (const b of buckets) {
    input.onLog?.(`Storage: syncing bucket ${b.name}`);
    await ensureBucket(dst, b);
    copiedBuckets += 1;

    const objects = await listAllObjectsRecursive(src, b.name, "", 500);
    input.onLog?.(`Storage: ${b.name} has ${objects.length} files`);
    for (const path of objects) {
      const data = await downloadObject(src, b.name, path);
      await uploadObject(dst, b.name, path, data);
      copiedFiles += 1;
    }
    input.onLog?.(`Storage: bucket ${b.name} synced`);
  }

  return { buckets: copiedBuckets, files: copiedFiles };
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
