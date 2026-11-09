-- Cloudflare D1 动态数据库表结构定义
-- 用于存储博主日常动态说说（Moments）

CREATE TABLE IF NOT EXISTS dynamic_moments (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  images TEXT NOT NULL DEFAULT '[]', -- JSON 字符串数组，如 '["https://img.lengxiqwq.com/..."]'
  pinned INTEGER NOT NULL DEFAULT 0, -- 0: 普通说说, 1: 置顶说说
  location TEXT DEFAULT NULL,        -- 可选位置标签，如 "上海"
  created_at INTEGER NOT NULL,       -- 毫秒级 Unix 时间戳 (Date.now())
  updated_at INTEGER NOT NULL        -- 毫秒级 Unix 时间戳 (Date.now())
);

-- 创建索引：优先按置顶降序，再按创建时间降序，保证前台分页流式读取极致性能
CREATE INDEX IF NOT EXISTS idx_dynamic_pinned_created 
ON dynamic_moments (pinned DESC, created_at DESC);
