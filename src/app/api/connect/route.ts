import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/pg";
import { pingRest } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  projectUrl: z.string().trim().url(),
  serviceRoleKey: z.string().trim().min(10),
  connectionString: z.string().trim().min(10),
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
    return NextResponse.json(
      { ok: false, error: "Validation failed", issues: parsed.error.issues },
      { status: 400 }
    );
  }

  const { projectUrl, serviceRoleKey, connectionString } = parsed.data;

  const rest = await pingRest(projectUrl, serviceRoleKey);

  let pg: { ok: boolean; message: string; version?: string } = { ok: false, message: "Not tested" };
  const client = createClient(connectionString);
  try {
    await client.connect();
    const v = await client.query<{ version: string }>("SELECT version()");
    pg = { ok: true, message: "Connected", version: v.rows[0]?.version };
  } catch (err: unknown) {
    pg = { ok: false, message: err instanceof Error ? err.message : "Unknown pg error" };
  } finally {
    await client.end().catch(() => {});
  }

  return NextResponse.json({
    ok: rest.ok && pg.ok,
    rest,
    pg,
  });
}
