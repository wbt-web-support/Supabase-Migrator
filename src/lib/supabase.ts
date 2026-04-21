import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export function createSupabaseAdmin(url: string, serviceRoleKey: string): SupabaseClient {
  return createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export async function pingRest(url: string, serviceRoleKey: string): Promise<{ ok: boolean; status: number; message: string }> {
  const normalized = url.replace(/\/$/, "");
  const endpoint = `${normalized}/rest/v1/`;
  try {
    const res = await fetch(endpoint, {
      method: "GET",
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok || res.status === 404) {
      return { ok: true, status: res.status, message: "REST API reachable" };
    }
    const text = await res.text().catch(() => "");
    return { ok: false, status: res.status, message: text.slice(0, 200) || `HTTP ${res.status}` };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown network error";
    return { ok: false, status: 0, message };
  }
}
