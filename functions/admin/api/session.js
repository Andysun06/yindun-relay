import { json, requireAdmin } from "../../_lib/admin.js";

export async function onRequestGet({ request, env }) {
  const session = await requireAdmin(request, env);
  if (!session) return json({ ok: false, error: "未登录" }, 401);
  return json({ ok: true, user: session.user, exp: session.exp });
}
