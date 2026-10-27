// 健康检查：客户端用它判断「中转站是否可达 / 是否已配置」，可达且 configured=true 才启用 AI 功能。
// 返回 { ok, configured, ts }：configured=false 表示缺 OPENCODE_API_KEY（服务未配好）。

function isAllowedOrigin(origin) {
  if (!origin) return false;
  if (/^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.pages\.dev$/i.test(origin)) return true;
  if (/^https?:\/\/localhost(:\d{1,5})?$/i.test(origin)) return true;
  if (/^https?:\/\/127\.0\.0\.1(:\d{1,5})?$/i.test(origin)) return true;
  return false;
}

function corsHeaders(request, env) {
  const origin = String(request.headers.get('origin') || '');
  const h = {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
  let ok = isAllowedOrigin(origin);
  if (!ok && env && env.ALLOWED_ORIGINS) {
    ok = String(env.ALLOWED_ORIGINS)
      .split(',')
      .map((s) => s.trim())
      .includes(origin);
  }
  if (ok) {
    h['Access-Control-Allow-Origin'] = origin;
    h['Vary'] = 'Origin';
  }
  return h;
}

export async function onRequestOptions(context) {
  const { request, env } = context;
  return new Response(null, { status: 204, headers: corsHeaders(request, env) });
}

export async function onRequestGet(context) {
  const { env, request } = context;
  return new Response(
    JSON.stringify({
      ok: true,
      configured: !!(env && env.OPENCODE_API_KEY),
      ts: Date.now(),
    }),
    { status: 200, headers: corsHeaders(request, env) }
  );
}

// 只开放 GET：其它方法返回 405
export async function onRequestPost(context) {
  const { request, env } = context;
  return new Response(JSON.stringify({ error: { message: 'Method Not Allowed' } }), {
    status: 405,
    headers: corsHeaders(request, env),
  });
}
