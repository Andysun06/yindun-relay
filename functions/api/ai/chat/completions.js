// 隐盾安全智能体 · 演示用 AI 中转站（Cloudflare Pages Function）
// 路由：POST /api/ai/chat/completions（客户端 Base URL 配 https://<项目>.pages.dev/api/ai）
//
// 凭据：只读环境变量 OPENCODE_API_KEY（Pages → Settings → Environment variables，密钥类型）。
//       本仓库任何文件都不包含可用 key，客户端也不接触 key。
//
// 安全设计：
//   1. 上游为代码字面量常量（仅 https + opencode.ai），不含任何运行时可变目标，杜绝 SSRF。
//   2. 模型白名单：名单外一律替换为默认模型，防止被刷昂贵模型。
//   3. max_tokens 上限 8192：防止超大输出消耗额度。
//   4. Origin 白名单 CORS（绝不使用 *）；IP 滑窗限流 20 次/分；请求体 ≤1MB；
//      redirect: 'manual' 且显式拒绝 3xx，杜绝重定向把请求带去其它主机；日志只记状态码。
//   5. 上游硬要求：必须带 x-opencode-session（随机 UUID），否则 400 MissingSessionID；
//      必须带常规浏览器 User-Agent，否则 Cloudflare 返回 403 error code 1010。
//   6. 客户端门禁：只接受隐盾客户端，需同时满足
//        x-yindun-client: yindun-desktop
//        x-yindun-token:  <门禁令牌，随客户端分发>
//        user-agent:      Yindun/<版本> 开头
//      三者缺一即 403。门禁令牌不是模型 Key（可被逆向提取，泄露后最坏结果是「别人能用这个
//      限流的演示中转」），真正的 OPENCODE_API_KEY 只存在服务端环境变量里。
//      注意：Yindun/ UA 只用于「客户端 → 中转站」这一跳，转发上游时仍使用浏览器 UA（见 BROWSER_UA）。

import { recordLog, requestMeta, extractQuestion, extractAnswer, extractUsage, clientVersion, truncate } from '../../../_lib/logs.js';

const UPSTREAM_URL = 'https://opencode.ai/zen/go/v1/chat/completions'; // 固定字面量：https + 公开主机
const DEFAULT_MODEL = 'deepseek-v4.1-flash';
const MAX_TOKENS_CAP = 8192;
const DEFAULT_REASONING_EFFORT = 'none'; // 演示优先速度
const RATE_LIMIT = 20; // 每 IP 每分钟
const RATE_WINDOW_MS = 60_000;
const MAX_BODY = 1024 * 1024; // 1MB
// 门禁（非密钥）：随客户端分发，可被逆向提取；只用于挡掉「非隐盾客户端」的顺手调用。
const CLIENT_ID_HEADER = 'x-yindun-client';
const CLIENT_ID_VALUE = 'yindun-desktop';
const CLIENT_TOKEN_HEADER = 'x-yindun-token';
const CLIENT_TOKEN_VALUE = 'yd_demo_7f3a9c1e5b2d4f6081a3c5e7d9b0f2a4';
const CLIENT_UA_PREFIX = 'Yindun/';
// Cloudflare 会拦截非浏览器 UA（403 error code 1010），这里固定使用常规桌面浏览器 UA。
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/131.0.0.0 Safari/537.36';

// 客户端门禁：两个请求头 + 客户端 UA。任一项不满足即拒绝（403）。
function isYindunClient(request) {
  const clientId = String(request.headers.get(CLIENT_ID_HEADER) || '').trim();
  const token = String(request.headers.get(CLIENT_TOKEN_HEADER) || '').trim();
  const ua = String(request.headers.get('user-agent') || '').trim();
  return clientId === CLIENT_ID_VALUE && token === CLIENT_TOKEN_VALUE && ua.startsWith(CLIENT_UA_PREFIX);
}

function allowedModels(env) {
  const raw = String((env && env.ALLOWED_MODELS) || DEFAULT_MODEL);
  const set = new Set(raw.split(',').map((s) => s.trim()).filter(Boolean));
  return set.size ? set : new Set([DEFAULT_MODEL]);
}

// 显式白名单（ALLOWED_ORIGINS）＋ *.pages.dev ＋ localhost（任意端口）。不使用通配符响应头。
function allowedOrigins(env) {
  const raw = String((env && env.ALLOWED_ORIGINS) || '');
  return new Set(raw.split(',').map((s) => s.trim()).filter(Boolean));
}

function isAllowedOrigin(origin, env) {
  if (!origin) return false;
  if (allowedOrigins(env).has(origin)) return true;
  if (/^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.pages\.dev$/i.test(origin)) return true;
  if (/^https?:\/\/localhost(:\d{1,5})?$/i.test(origin)) return true;
  if (/^https?:\/\/127\.0\.0\.1(:\d{1,5})?$/i.test(origin)) return true;
  return false;
}

function corsHeaders(request, env) {
  const origin = String(request.headers.get('origin') || '');
  const h = {
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-yindun-client, x-yindun-token',
    'Access-Control-Max-Age': '600',
  };
  if (isAllowedOrigin(origin, env)) {
    h['Access-Control-Allow-Origin'] = origin;
    h['Vary'] = 'Origin';
  }
  return h;
}

// 实例内存级滑窗限流（Workers 每个 isolate 独立计数；对演示额度防滥用足够）
const rateBuckets = new Map();
function isRateLimited(clientIp) {
  const ip = String(clientIp || 'unknown');
  const now = Date.now();
  let arr = rateBuckets.get(ip);
  if (!arr) {
    arr = [];
    rateBuckets.set(ip, arr);
  }
  while (arr.length && now - arr[0] > RATE_WINDOW_MS) arr.shift();
  if (arr.length >= RATE_LIMIT) return true;
  arr.push(now);
  if (rateBuckets.size > 5000) {
    for (const [k, v] of rateBuckets) if (!v.length) rateBuckets.delete(k);
  }
  return false;
}

function jsonRes(status, obj, h) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...h },
  });
}

function newSessionId() {
  try {
    return crypto.randomUUID();
  } catch {
    // 极老运行时兜底：仍保证每次请求不同
    return 'sess-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }
}

export async function onRequestOptions(context) {
  const { request, env } = context;
  return new Response(null, { status: 204, headers: corsHeaders(request, env) });
}

// 只开放 POST：其它方法显式 405，避免被当成通用代理使用。
export async function onRequestGet(context) {
  const { request, env } = context;
  return jsonRes(405, { error: { message: 'Method Not Allowed' } }, corsHeaders(request, env));
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const h = corsHeaders(request, env);
  const started = Date.now();
  const meta = requestMeta(request);
  const version = clientVersion(meta.ua);
  let question = "";

  // 审计：不阻塞响应（Pages/Worker 的 waitUntil 会在响应后继续写 D1）。
  const audit = (fields) => recordLog(env, {
    ts: Date.now(),
    meta,
    question,
    clientVersion: version,
    latencyMs: Date.now() - started,
    ...fields,
  }, context);

  // 先限流再验门禁：避免门禁令牌被无成本穷举
  if (isRateLimited(request.ip)) {
    // 未通过门禁的请求只写 console，不写 D1：避免被公网刷日志、把审计库撑满。
    console.log('[yindun-relay] rate_limited');
    return jsonRes(429, { error: { message: '请求过于频繁，请稍后再试' } }, h);
  }

  // 只接受隐盾客户端（两个头 + 客户端 UA，缺一即 403）
  if (!isYindunClient(request)) {
    console.log('[yindun-relay] client_gate_rejected');
    return jsonRes(403, { error: { message: '仅限隐盾客户端' } }, h);
  }

  const apiKey = env && env.OPENCODE_API_KEY;
  if (!apiKey) {
    audit({ status: 500, ok: false, error: 'OPENCODE_API_KEY missing' });
    return jsonRes(500, { error: { message: 'Relay not configured: OPENCODE_API_KEY missing' } }, h);
  }

  const declaredLen = Number(request.headers.get('content-length') || 0);
  if (declaredLen > MAX_BODY) {
    audit({ status: 413, ok: false, error: 'request_too_large' });
    return jsonRes(413, { error: { message: 'Request body too large' } }, h);
  }

  let rawBody;
  try {
    rawBody = await request.text();
  } catch {
    audit({ status: 400, ok: false, error: 'invalid_body' });
    return jsonRes(400, { error: { message: 'Invalid request body' } }, h);
  }
  // content-length 可能缺失，按实际字节数再卡一次（UTF-8）
  if (new TextEncoder().encode(rawBody).length > MAX_BODY) {
    audit({ status: 413, ok: false, error: 'request_too_large' });
    return jsonRes(413, { error: { message: 'Request body too large' } }, h);
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    audit({ status: 400, ok: false, error: 'invalid_json' });
    return jsonRes(400, { error: { message: 'Invalid JSON body' } }, h);
  }
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.messages)) {
    audit({ status: 400, ok: false, error: 'messages_required' });
    return jsonRes(400, { error: { message: 'messages required' } }, h);
  }

  // 只记最后一条用户消息（截断 2000 字），用于管理员回看“评委问了什么”。
  question = extractQuestion(payload.messages);

  // 模型白名单：名单外一律替换为默认模型（不报错，体验平滑）
  const models = allowedModels(env);
  if (!models.has(payload.model)) payload.model = models.values().next().value;

  // 输出上限：防超大 tokens 消耗额度
  const mt = payload.max_tokens;
  if (typeof mt !== 'number' || !Number.isFinite(mt) || mt <= 0 || mt > MAX_TOKENS_CAP) {
    payload.max_tokens = MAX_TOKENS_CAP;
  }

  // 客户端未指定思考强度时默认注入 none（演示优先速度）
  if (payload.reasoning_effort === undefined || payload.reasoning_effort === null || payload.reasoning_effort === '') {
    payload.reasoning_effort = DEFAULT_REASONING_EFFORT;
  }

  try {
    const upstream = await fetch(UPSTREAM_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'User-Agent': BROWSER_UA,
        'x-opencode-session': newSessionId(),
        Accept: payload.stream === true ? 'text/event-stream' : 'application/json',
      },
      body: JSON.stringify(payload),
      // Workers 不支持 redirect:'error'；manual + 手动拒绝 3xx，杜绝重定向改写目标主机
      redirect: 'manual',
    });

    if (upstream.status >= 300 && upstream.status < 400) {
      console.log('[yindun-relay] upstream_redirect_rejected');
      audit({ status: 502, ok: false, model: payload.model, stream: !!payload.stream, error: 'upstream_redirect' });
      return jsonRes(502, { error: { message: 'Upstream request failed' } }, h);
    }
    console.log(`[yindun-relay] status=${upstream.status}`); // 只记状态码，不记请求内容

    const contentType = upstream.headers.get('content-type') || 'application/json';
    // 流式请求：直接透传上游 body，避免缓冲破坏 SSE
    if (payload.stream === true && upstream.body) {
      // 流式不缓冲响应体，因此只记状态/耗时/问题；回答内容无法在不破坏 SSE 的前提下入库。
      audit({
        status: upstream.status,
        ok: upstream.ok,
        model: payload.model,
        stream: true,
        error: upstream.ok ? '' : `upstream_http_${upstream.status}`,
      });
      return new Response(upstream.body, {
        status: upstream.status,
        headers: { 'Content-Type': contentType, 'Cache-Control': 'no-store', ...h },
      });
    }
    const text = await upstream.text();
    const usage = extractUsage(text);
    audit({
      status: upstream.status,
      ok: upstream.ok,
      model: payload.model,
      stream: false,
      answer: upstream.ok ? extractAnswer(text) : '',
      usage,
      error: upstream.ok ? '' : truncate(text, 300),
    });
    return new Response(text, {
      status: upstream.status,
      headers: { 'Content-Type': contentType, ...h },
    });
  } catch (err) {
    console.log(`[yindun-relay] upstream_error=${err && err.name}`);
    audit({ status: 502, ok: false, model: payload.model, stream: !!payload.stream, error: `upstream_error_${err && err.name}` });
    return jsonRes(502, { error: { message: 'Upstream request failed' } }, h);
  }
}
