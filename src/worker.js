// 隐盾演示中转站 · Worker 入口（V3.6.21）
//
// 仓库同时保留 Cloudflare Pages Functions 形态（functions/api/ai/*），
// 这里只是把同一套处理函数接到 Worker 的 fetch 上——两种部署方式共用一份逻辑。
//
// 与 Pages 的唯一差异：Worker 的 Request 没有 `.ip` 属性（Pages 有），
// 限流需要从 CF-Connecting-IP 头取客户端 IP；这里用 Proxy 补上，处理函数无需改。

import { onRequestOptions, onRequestPost } from "../functions/api/ai/chat/completions.js";
import { onRequestGet } from "../functions/api/ai/healthz.js";

function withClientIp(request) {
  const ip = request.headers.get("CF-Connecting-IP") || "";
  if (!ip) return request;
  return new Proxy(request, {
    get(target, prop) {
      if (prop === "ip") return ip;
      const value = target[prop];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const req = withClientIp(request);
    const context = { request: req, env, ctx, waitUntil: ctx && ctx.waitUntil };

    if (url.pathname === "/api/ai/healthz" && request.method === "GET") {
      return onRequestGet(context);
    }
    if (url.pathname === "/api/ai/chat/completions") {
      if (request.method === "OPTIONS") return onRequestOptions(context);
      if (request.method === "POST") return onRequestPost(context);
      return new Response("Method Not Allowed", { status: 405 });
    }
    if (url.pathname === "/" || url.pathname === "") {
      return new Response(
        "隐盾演示中转站\n\nGET  /api/ai/healthz\nPOST /api/ai/chat/completions（需隐盾客户端门禁头）\n",
        { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8" } },
      );
    }
    return new Response("Not found", { status: 404 });
  },
};
