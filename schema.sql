-- 隐盾演示中转站 · 管理控制台数据表
-- 用法：npx wrangler d1 execute yindun-relay-logs --remote --file=./schema.sql

CREATE TABLE IF NOT EXISTS relay_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,                 -- 毫秒时间戳
  ip TEXT,                             -- 客户端 IP（仅管理员可见）
  country TEXT,
  city TEXT,
  colo TEXT,
  ua TEXT,                             -- 客户端 User-Agent（截断）
  client_version TEXT,                 -- 从 Yindun/<版本> 提取
  model TEXT,
  status INTEGER,                      -- HTTP 状态码
  ok INTEGER NOT NULL DEFAULT 0,       -- 1 = 2xx
  latency_ms INTEGER,
  stream INTEGER NOT NULL DEFAULT 0,
  question TEXT,                       -- 最后一条用户消息（截断 2000 字）
  answer TEXT,                         -- 非流式回答（截断 2000 字；流式为空）
  error TEXT,                          -- 失败原因（截断 300 字）
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  total_tokens INTEGER
);

CREATE INDEX IF NOT EXISTS idx_relay_logs_ts ON relay_logs (ts DESC);
CREATE INDEX IF NOT EXISTS idx_relay_logs_status ON relay_logs (status);
CREATE INDEX IF NOT EXISTS idx_relay_logs_ip ON relay_logs (ip);
