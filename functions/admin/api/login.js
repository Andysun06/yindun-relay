import {
  json,
  getClientIp,
  verifyPassword,
  signSession,
  sessionCookie,
  loginAllowed,
} from "../../_lib/admin.js";

export async function onRequestPost({ request, env }) {
  const ip = getClientIp(request);
  if (!loginAllowed(ip)) {
    return json({ ok: false, error: "尝试过于频繁，请 10 分钟后再试" }, 429);
  }

  let body;
  try {
    const raw = await request.text();
    if (raw.length > 4096) return json({ ok: false, error: "请求过大" }, 413);
    body = JSON.parse(raw);
  } catch {
    return json({ ok: false, error: "请求格式错误" }, 400);
  }

  const user = String((body && body.user) || "").trim();
  const password = String((body && body.password) || "");
  const expectedUser = String((env && env.ADMIN_USER) || "Andy");
  const hash = env && env.ADMIN_PASSWORD_HASH;

  if (!hash) {
    return json({ ok: false, error: "管理员密码尚未配置（ADMIN_PASSWORD_HASH）" }, 500);
  }
  if (!user || !password) {
    return json({ ok: false, error: "请输入用户名和密码" }, 400);
  }

  const userOk = user === expectedUser;
  let passOk = false;
  try {
    passOk = await verifyPassword(password, hash);
  } catch (err) {
    // 密码哈希参数异常（迭代次数过高/格式坏）时不要抛成 Worker 1101，给可读错误。
    console.log(`[yindun-relay] password_verify_failed=${err && err.name}`);
    return json({ ok: false, error: "管理员密码哈希格式异常" }, 500);
  }
  if (!userOk || !passOk) {
    // 不区分“用户名错/密码错”，避免枚举
    return json({ ok: false, error: "用户名或密码错误" }, 401);
  }

  try {
    const { token, exp } = await signSession(env, expectedUser);
    return json(
      { ok: true, user: expectedUser, exp },
      200,
      { "Set-Cookie": sessionCookie(token) }
    );
  } catch (err) {
    console.log(`[yindun-relay] session_sign_failed=${err && err.name}`);
    return json({ ok: false, error: "会话密钥未配置（ADMIN_SESSION_SECRET）" }, 500);
  }
}

export async function onRequestGet() {
  return json({ ok: false, error: "Method Not Allowed" }, 405);
}
