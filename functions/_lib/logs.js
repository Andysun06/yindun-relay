// 隐盾中转站 · 请求审计写入
//
// 设计原则：
//   · 记录失败绝不影响转发（try/catch + waitUntil，不让日志拖慢/打断模型响应）；
//   · 只存管理员排查需要的最小集合：时间、IP/地区、客户端版本、模型、状态、耗时、
//     问题与回答（截断 2000 字）、token 用量、错误原因；
//   · 流式请求不缓冲响应体（否则破坏 SSE），因此 answer 为空、只记状态与耗时。

const MAX_QUESTION = 2000;
const MAX_ANSWER = 2000;
const MAX_ERROR = 300;
const MAX_UA = 300;

export function truncate(value, limit) {
  const text = String(value == null ? "" : value);
  return text.length > limit ? text.slice(0, limit) + "…" : text;
}

export function extractQuestion(messages) {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message || message.role !== "user") continue;
    const content = message.content;
    if (typeof content === "string") return truncate(content, MAX_QUESTION);
    try {
      return truncate(JSON.stringify(content), MAX_QUESTION);
    } catch {
      return "";
    }
  }
  return "";
}

export function extractAnswer(text) {
  try {
    const data = JSON.parse(text);
    const content = data && data.choices && data.choices[0] &&
      data.choices[0].message && data.choices[0].message.content;
    if (typeof content === "string") return truncate(content, MAX_ANSWER);
    if (content != null) return truncate(JSON.stringify(content), MAX_ANSWER);
  } catch {
    // 非 JSON（上游异常页等）：不把整段 HTML 写进库
  }
  return "";
}

export function extractUsage(text) {
  try {
    const usage = (JSON.parse(text) || {}).usage || {};
    const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
    return {
      prompt: num(usage.prompt_tokens),
      completion: num(usage.completion_tokens),
      total: num(usage.total_tokens),
    };
  } catch {
    return { prompt: null, completion: null, total: null };
  }
}

export function clientVersion(ua) {
  const match = String(ua || "").match(/Yindun\/([0-9A-Za-z._-]+)/);
  return match ? match[1] : "";
}

export function requestMeta(request) {
  const cf = request.cf || {};
  return {
    ip: String(request.ip || request.headers.get("CF-Connecting-IP") || "unknown"),
    country: String(cf.country || ""),
    city: String(cf.city || ""),
    colo: String(cf.colo || ""),
    ua: truncate(request.headers.get("user-agent") || "", MAX_UA),
  };
}

/**
 * 写入一条审计记录。ctx 可为 Pages/Worker 的 context（用 waitUntil 异步写）。
 * 返回 Promise，便于本地测试直接 await。
 */
export async function recordLog(env, entry, ctx) {
  const db = env && env.DB;
  if (!db) {
    console.log("[yindun-relay] DB binding missing; skip audit log");
    return false;
  }
  const e = entry || {};
  const meta = e.meta || {};
  const usage = e.usage || {};
  const sql = `INSERT INTO relay_logs
    (ts, ip, country, city, colo, ua, client_version, model, status, ok, latency_ms,
     stream, question, answer, error, prompt_tokens, completion_tokens, total_tokens)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
  const task = db.prepare(sql).bind(
    Number(e.ts || Date.now()),
    meta.ip || "",
    meta.country || "",
    meta.city || "",
    meta.colo || "",
    meta.ua || "",
    e.clientVersion || "",
    e.model || "",
    Number(e.status || 0),
    e.ok ? 1 : 0,
    Number(e.latencyMs || 0),
    e.stream ? 1 : 0,
    truncate(e.question || "", MAX_QUESTION),
    truncate(e.answer || "", MAX_ANSWER),
    truncate(e.error || "", MAX_ERROR),
    usage.prompt == null ? null : Number(usage.prompt),
    usage.completion == null ? null : Number(usage.completion),
    usage.total == null ? null : Number(usage.total)
  ).run();
  const guarded = Promise.resolve(task).catch((err) => {
    console.log(`[yindun-relay] audit_write_failed=${err && err.name}`);
    return null;
  });
  try {
    if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(guarded);
  } catch {
    // waitUntil 不可用时也让它自己跑完
  }
  return guarded;
}
