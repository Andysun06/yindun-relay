// 隐盾中转站 · 管理控制台鉴权与会话
//
// 密码只以 PBKDF2-SHA256 哈希形式存在环境变量 ADMIN_PASSWORD_HASH 中，
// 格式：pbkdf2$sha256$150000$<salt base64url>$<hash base64url>
// 生成方式见 README；仓库与前端都不包含明文密码。
//
// 会话：HttpOnly + Secure + SameSite=Strict Cookie，内容为 HMAC-SHA256 签名的
// `用户名|过期时间`。密钥来自 ADMIN_SESSION_SECRET（随机 32 字节），未配置时拒绝登录。

const COOKIE_NAME = "yd_admin";
const SESSION_SECONDS = 12 * 60 * 60;
const enc = new TextEncoder();

export function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...extraHeaders,
    },
  });
}

export function getClientIp(request) {
  return String(
    request.ip ||
      request.headers.get("CF-Connecting-IP") ||
      (request.headers.get("x-forwarded-for") || "").split(",")[0].trim() ||
      "unknown"
  );
}

function toB64url(bytes) {
  let bin = "";
  const arr = new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(text) {
  const padded = String(text || "").replace(/-/g, "+").replace(/_/g, "/") +
    "===".slice((String(text || "").length + 3) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function constantTimeEqual(a, b) {
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]
  );
  return crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    key,
    256
  );
}

export function parsePasswordHash(stored) {
  const parts = String(stored || "").split("$");
  if (parts.length !== 5 || parts[0] !== "pbkdf2" || parts[1] !== "sha256") return null;
  const iterations = Number(parts[2]);
  if (!Number.isFinite(iterations) || iterations < 1_000) return null;
  try {
    return { iterations, salt: fromB64url(parts[3]), hash: fromB64url(parts[4]) };
  } catch {
    return null;
  }
}

export async function verifyPassword(password, stored) {
  const parsed = parsePasswordHash(stored);
  if (!parsed) return false;
  const derived = await pbkdf2(String(password || ""), parsed.salt, parsed.iterations);
  return constantTimeEqual(derived, parsed.hash);
}

async function hmac(secret, data) {
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}

export async function signSession(env, user) {
  const secret = String((env && env.ADMIN_SESSION_SECRET) || "");
  if (!secret) throw new Error("ADMIN_SESSION_SECRET missing");
  const exp = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
  const payload = `${user}|${exp}`;
  const sig = await hmac(secret, payload);
  return { token: `${toB64url(enc.encode(payload))}.${toB64url(sig)}`, exp };
}

export function sessionCookie(token) {
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_SECONDS}`;
}

export function clearSessionCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

function readCookie(request, name) {
  const raw = String(request.headers.get("cookie") || "");
  const match = raw.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match ? match[1] : "";
}

export async function readSession(request, env) {
  const secret = String((env && env.ADMIN_SESSION_SECRET) || "");
  const expectedUser = String((env && env.ADMIN_USER) || "Andy");
  if (!secret) return null;
  const token = readCookie(request, COOKIE_NAME);
  if (!token || !token.includes(".")) return null;
  const [payloadB64, sigB64] = token.split(".");
  let payload;
  let sig;
  try {
    payload = new TextDecoder().decode(fromB64url(payloadB64));
    sig = fromB64url(sigB64);
  } catch {
    return null;
  }
  const expected = await hmac(secret, payload);
  if (!constantTimeEqual(expected, sig)) return null;
  const [user, expText] = payload.split("|");
  const exp = Number(expText);
  if (!user || user !== expectedUser) return null;
  if (!Number.isFinite(exp) || exp <= Math.floor(Date.now() / 1000)) return null;
  return { user, exp };
}

export async function requireAdmin(request, env) {
  const session = await readSession(request, env);
  return session;
}

// 登录失败限流（isolate 内存级，够挡住在线爆破；多 isolate 下是软限制）
const loginBuckets = new Map();
const LOGIN_LIMIT = 5;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;

export function loginAllowed(ip) {
  const now = Date.now();
  const key = String(ip || "unknown");
  let arr = loginBuckets.get(key);
  if (!arr) {
    arr = [];
    loginBuckets.set(key, arr);
  }
  while (arr.length && now - arr[0] > LOGIN_WINDOW_MS) arr.shift();
  if (arr.length >= LOGIN_LIMIT) return false;
  arr.push(now);
  if (loginBuckets.size > 5000) {
    for (const [k, v] of loginBuckets) if (!v.length) loginBuckets.delete(k);
  }
  return true;
}
