import { json, requireAdmin } from "../../_lib/admin.js";

export async function onRequestGet({ request, env }) {
  const session = await requireAdmin(request, env);
  if (!session) return json({ ok: false, error: "未登录" }, 401);
  if (!env || !env.DB) return json({ ok: false, error: "D1 未绑定" }, 500);

  const url = new URL(request.url);
  const hours = Math.min(24 * 30, Math.max(1, Number(url.searchParams.get("hours")) || 24));
  const since = Date.now() - hours * 3600 * 1000;
  try {
    const rows = await env.DB.prepare(
      `SELECT COALESCE(NULLIF(ip, ''), '未知') AS ip,
              MAX(country) AS country, MAX(city) AS city,
              COUNT(*) AS n,
              COALESCE(SUM(COALESCE(total_tokens, 0)), 0) AS tokens,
              MAX(ts) AS last_ts
         FROM relay_logs
        WHERE ts >= ?
        GROUP BY ip
        ORDER BY last_ts DESC
        LIMIT 200`
    ).bind(since).all();
    return json({ ok: true, hours, ips: (rows && rows.results) || [] });
  } catch (err) {
    console.log(`[yindun-relay] ips_query_failed=${err && err.name}`);
    return json({ ok: false, error: "IP 列表查询失败" }, 500);
  }
}
