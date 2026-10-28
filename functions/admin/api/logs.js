import { json, requireAdmin } from "../../_lib/admin.js";

const MAX_LIMIT = 200;

function intParam(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

export async function onRequestGet({ request, env }) {
  const session = await requireAdmin(request, env);
  if (!session) return json({ ok: false, error: "未登录" }, 401);
  if (!env || !env.DB) return json({ ok: false, error: "D1 未绑定" }, 500);

  const url = new URL(request.url);
  const hours = intParam(url.searchParams.get("hours"), 24, 1, 24 * 30);
  const limit = intParam(url.searchParams.get("limit"), 100, 1, MAX_LIMIT);
  const offset = intParam(url.searchParams.get("offset"), 0, 0, 1_000_000);
  const status = String(url.searchParams.get("status") || "all");
  const query = String(url.searchParams.get("q") || "").trim().slice(0, 200);
  const ips = String(url.searchParams.get("ips") || "")
    .split(",").map((s) => s.trim()).filter(Boolean).slice(0, 50);
  const since = Date.now() - hours * 3600 * 1000;

  const where = ["ts >= ?"];
  const params = [since];
  if (ips.length) {
    where.push(`ip IN (${ips.map(() => "?").join(",")})`);
    params.push(...ips);
  }
  if (status === "ok") {
    where.push("ok = 1");
  } else if (status === "error") {
    where.push("ok = 0");
  } else if (/^[1-5]xx$/.test(status)) {
    const base = Number(status[0]) * 100;
    where.push("status >= ? AND status < ?");
    params.push(base, base + 100);
  } else if (/^\d{3}$/.test(status)) {
    where.push("status = ?");
    params.push(Number(status));
  }
  if (query) {
    where.push("(question LIKE ? OR answer LIKE ? OR ip LIKE ? OR model LIKE ? OR error LIKE ?)");
    const like = `%${query}%`;
    params.push(like, like, like, like, like);
  }
  const whereSql = where.join(" AND ");

  try {
    const totalRow = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM relay_logs WHERE ${whereSql}`
    ).bind(...params).first();
    const rows = await env.DB.prepare(
      `SELECT id, ts, ip, country, city, colo, ua, client_version, model, status, ok,
              latency_ms, stream, question, answer, error,
              prompt_tokens, completion_tokens, total_tokens
         FROM relay_logs
        WHERE ${whereSql}
        ORDER BY ts DESC
        LIMIT ? OFFSET ?`
    ).bind(...params, limit, offset).all();

    return json({
      ok: true,
      total: Number((totalRow && totalRow.n) || 0),
      limit,
      offset,
      hours,
      logs: (rows && rows.results) || [],
    });
  } catch (err) {
    console.log(`[yindun-relay] logs_query_failed=${err && err.name}`);
    return json({ ok: false, error: "日志查询失败" }, 500);
  }
}
