import { json, requireAdmin } from "../../_lib/admin.js";

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

export async function onRequestGet({ request, env }) {
  const session = await requireAdmin(request, env);
  if (!session) return json({ ok: false, error: "未登录" }, 401);
  if (!env || !env.DB) return json({ ok: false, error: "D1 未绑定" }, 500);

  const url = new URL(request.url);
  const hours = Math.min(24 * 30, Math.max(1, Number(url.searchParams.get("hours")) || 24));
  const since = Date.now() - hours * 3600 * 1000;
  const ips = String(url.searchParams.get("ips") || "")
    .split(",").map((v) => v.trim()).filter(Boolean).slice(0, 50);
  const ipSql = ips.length ? ` AND ip IN (${ips.map(() => "?").join(",")})` : "";
  const ipParams = ips;
  const tzOffset = 8 * 3600 * 1000; // 展示用北京时间
  const localDayStart = Math.floor((Date.now() + tzOffset) / 86400000) * 86400000 - tzOffset;

  try {
    const summary = await env.DB.prepare(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(ok), 0) AS ok_count,
              COALESCE(AVG(latency_ms), 0) AS avg_latency,
              COUNT(DISTINCT ip) AS unique_ips,
              COALESCE(SUM(CASE WHEN ts >= ? THEN 1 ELSE 0 END), 0) AS today_count,
              COALESCE(SUM(COALESCE(prompt_tokens, 0)), 0) AS prompt_tokens,
              COALESCE(SUM(COALESCE(completion_tokens, 0)), 0) AS completion_tokens,
              COALESCE(SUM(COALESCE(total_tokens, 0)), 0) AS total_tokens,
              COALESCE(SUM(CASE WHEN stream = 1 THEN 1 ELSE 0 END), 0) AS stream_count
         FROM relay_logs WHERE ts >= ?${ipSql}`
    ).bind(localDayStart, since, ...ipParams).first();

    const latencyRows = await env.DB.prepare(
      `SELECT latency_ms FROM relay_logs
        WHERE ts >= ? AND ok = 1 AND latency_ms IS NOT NULL${ipSql}
        ORDER BY latency_ms ASC LIMIT 10000`
    ).bind(since, ...ipParams).all();
    const latencies = ((latencyRows && latencyRows.results) || [])
      .map((r) => Number(r.latency_ms))
      .filter((n) => Number.isFinite(n));

    const hourlyRows = await env.DB.prepare(
      `SELECT ts, ok, prompt_tokens, completion_tokens, total_tokens
         FROM relay_logs WHERE ts >= ?${ipSql} ORDER BY ts ASC`
    ).bind(since, ...ipParams).all();
    const buckets = new Map();
    for (const row of (hourlyRows && hourlyRows.results) || []) {
      const hour = Math.floor((Number(row.ts) + tzOffset) / 3600000) * 3600000 - tzOffset;
      const item = buckets.get(hour) || {
        hour, total: 0, ok: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0,
      };
      item.total += 1;
      item.ok += Number(row.ok) ? 1 : 0;
      item.promptTokens += Number(row.prompt_tokens || 0);
      item.completionTokens += Number(row.completion_tokens || 0);
      item.totalTokens += Number(row.total_tokens || 0);
      buckets.set(hour, item);
    }
    // 补齐没有请求的小时（0 值），图表才不会因为只有一个桶而变成一根满宽柱子。
    const startHour = Math.floor((since + tzOffset) / 3600000) * 3600000 - tzOffset;
    const endHour = Math.floor((Date.now() + tzOffset) / 3600000) * 3600000 - tzOffset;
    for (let hour = startHour; hour <= endHour; hour += 3600000) {
      if (!buckets.has(hour)) {
        buckets.set(hour, {
          hour, total: 0, ok: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0,
        });
      }
    }
    const series = [...buckets.values()].sort((a, b) => a.hour - b.hour);

    const modelRows = await env.DB.prepare(
      `SELECT COALESCE(NULLIF(model, ''), '未指定') AS model, COUNT(*) AS n,
              COALESCE(SUM(COALESCE(prompt_tokens, 0)), 0) AS prompt_tokens,
              COALESCE(SUM(COALESCE(completion_tokens, 0)), 0) AS completion_tokens,
              COALESCE(SUM(COALESCE(total_tokens, 0)), 0) AS total_tokens
         FROM relay_logs WHERE ts >= ?${ipSql} GROUP BY model ORDER BY n DESC LIMIT 6`
    ).bind(since, ...ipParams).all();

    const statusRows = await env.DB.prepare(
      `SELECT status, COUNT(*) AS n FROM relay_logs
        WHERE ts >= ?${ipSql} GROUP BY status ORDER BY n DESC LIMIT 12`
    ).bind(since, ...ipParams).all();

    const ipRows = await env.DB.prepare(
      `SELECT COALESCE(NULLIF(ip, ''), '未知') AS ip, COUNT(*) AS n,
              COALESCE(SUM(COALESCE(total_tokens, 0)), 0) AS tokens
         FROM relay_logs WHERE ts >= ?${ipSql} GROUP BY ip ORDER BY n DESC LIMIT 8`
    ).bind(since, ...ipParams).all();

    const total = Number((summary && summary.total) || 0);
    const okCount = Number((summary && summary.ok_count) || 0);
    return json({
      ok: true,
      stats: {
        hours,
        selectedIps: ips,
        total,
        okCount,
        errorCount: Math.max(0, total - okCount),
        successRate: total ? okCount / total : 0,
        avgLatency: Number((summary && summary.avg_latency) || 0),
        p50: percentile(latencies, 50),
        p95: percentile(latencies, 95),
        uniqueIps: Number((summary && summary.unique_ips) || 0),
        todayCount: Number((summary && summary.today_count) || 0),
        promptTokens: Number((summary && summary.prompt_tokens) || 0),
        completionTokens: Number((summary && summary.completion_tokens) || 0),
        totalTokens: Number((summary && summary.total_tokens) || 0),
        avgTokens: total ? Number((summary && summary.total_tokens) || 0) / total : 0,
        streamCount: Number((summary && summary.stream_count) || 0),
        series,
        models: (modelRows && modelRows.results) || [],
        statuses: (statusRows && statusRows.results) || [],
        topIps: (ipRows && ipRows.results) || [],
      },
    });
  } catch (err) {
    console.log(`[yindun-relay] stats_query_failed=${err && err.name}`);
    return json({ ok: false, error: "统计查询失败" }, 500);
  }
}
