import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { createErrorResponseFromUnknown } from "@/lib/api/errorResponse";
import { getDbInstance } from "@/lib/db/core";

export async function GET(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  try {
    const db = getDbInstance();
    const rows = db
      .prepare(
        `SELECT p.id, p.name, p.type, p.host, p.port, p.status, p.quality_score, p.latency_ms,
                fp.test_count AS test_count, fp.success_count AS success_count
         FROM proxy_registry p
         JOIN proxy_assignments pa ON pa.proxy_id = p.id
         LEFT JOIN free_proxies fp ON fp.pool_proxy_id = p.id
         WHERE pa.scope = 'global' AND pa.scope_id LIKE '__global__%'
         ORDER BY CAST(SUBSTR(pa.scope_id, 11) AS INTEGER) ASC`
      )
      .all() as Array<Record<string, unknown>>;

    const items = rows.map((r) => ({
      id: String(r.id || ""),
      name: String(r.name || ""),
      type: String(r.type || "http"),
      host: String(r.host || ""),
      port: Number(r.port || 0),
      status: String(r.status || "active"),
      qualityScore: r.quality_score != null ? Number(r.quality_score) : null,
      latencyMs: r.latency_ms != null ? Number(r.latency_ms) : null,
      testCount: r.test_count != null ? Number(r.test_count) : null,
      successCount: r.success_count != null ? Number(r.success_count) : null,
      alive: !["inactive", "error", "disabled", "dead", "down"].includes(
        String(r.status || "").toLowerCase()
      ),
    }));

    return Response.json({ items });
  } catch (error) {
    return createErrorResponseFromUnknown(error, "Failed to list global proxy pool");
  }
}
