import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/pg";
import { fetchSchema } from "@/lib/migration";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  connectionString: z.string().min(10),
});

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "Validation failed" }, { status: 400 });
  }

  const client = createClient(parsed.data.connectionString);
  try {
    await client.connect();
    const result = await fetchSchema(client);
    return NextResponse.json({ ok: true, ...result });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  } finally {
    await client.end().catch(() => {});
  }
}
