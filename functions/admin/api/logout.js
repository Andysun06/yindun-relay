import { json, clearSessionCookie } from "../../_lib/admin.js";

export async function onRequestPost() {
  return json({ ok: true }, 200, { "Set-Cookie": clearSessionCookie() });
}

export async function onRequestGet() {
  return json({ ok: false, error: "Method Not Allowed" }, 405);
}
