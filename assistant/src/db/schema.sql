-- 用户（多用户预留，单用户只有一条 owner 记录）
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT DEFAULT 'admin',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  root_path TEXT,
  status TEXT DEFAULT 'active',
  created_at INTEGER NOT NULL,
  last_active_at INTEGER
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL DEFAULT 'default',
  channel TEXT NOT NULL,        -- web / lark / weixin
  lark_chat_id TEXT,            -- 飞书 chat_id，飞书来源时设置
  sdk_session_id TEXT,
  title TEXT,                   -- 会话标题
  status TEXT DEFAULT 'active', -- active / ended
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  last_active_at INTEGER        -- 最后活跃时间
);

CREATE INDEX IF NOT EXISTS idx_sessions_lark_chat_id ON sessions(lark_chat_id);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  message_id TEXT UNIQUE,       -- 幂等去重
  status TEXT DEFAULT 'complete', -- streaming | complete | interrupted
  streaming_content TEXT,       -- 流式过程中的增量内容
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sdk_calls (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  duration_ms INTEGER,
  status TEXT NOT NULL,         -- success / error
  error TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,           -- cron / interval / once
  schedule TEXT NOT NULL,
  command TEXT NOT NULL,
  command_type TEXT NOT NULL,   -- shell / assistant / http
  status TEXT DEFAULT 'active', -- active / paused / completed
  notify_target TEXT,           -- JSON，存储 NotifyTarget，任务完成后回源推送
  last_run INTEGER,
  next_run INTEGER,
  run_count INTEGER DEFAULT 0,
  fail_count INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS task_runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  status TEXT NOT NULL,         -- success / error / timeout
  output TEXT,
  error TEXT
);

CREATE TABLE IF NOT EXISTS terminal_sessions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  title TEXT,
  pid INTEGER,
  cwd TEXT,
  created_at INTEGER NOT NULL,
  last_active_at INTEGER,
  disconnected_at INTEGER,  -- WS 断开时间，NULL 表示连接中
  closed_at INTEGER
);

CREATE TABLE IF NOT EXISTS logs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT,
  user_id TEXT NOT NULL,
  level TEXT NOT NULL,          -- info / warn / error
  category TEXT NOT NULL,       -- system / sdk / task / terminal
  message TEXT NOT NULL,
  meta TEXT,                    -- JSON
  created_at INTEGER NOT NULL
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_messages_workspace ON messages(workspace_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_session_status ON messages(session_id, status);
CREATE INDEX IF NOT EXISTS idx_sdk_calls_workspace ON sdk_calls(workspace_id, created_at);
CREATE INDEX IF NOT EXISTS idx_logs_category ON logs(category, created_at);
CREATE INDEX IF NOT EXISTS idx_tasks_workspace ON tasks(workspace_id, status);

-- session_compacts: 对话上下文压缩快照表
CREATE TABLE IF NOT EXISTS session_compacts (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  compacted_at INTEGER NOT NULL,
  summary TEXT NOT NULL,
  compacted_messages TEXT NOT NULL,  -- JSON 序列化的 MessageParam[]
  original_tokens INTEGER,
  compacted_tokens INTEGER
);

CREATE INDEX IF NOT EXISTS idx_session_compacts_session ON session_compacts(session_id, compacted_at DESC);

-- compact_fts: FTS5 虚拟表，用于会话摘要全文检索（Recall功能）
-- 通过 migrate.ts version=6 自动创建，无需在此处重复创建
-- 结构：
--   CREATE VIRTUAL TABLE compact_fts USING fts5(
--     summary,       -- 可全文搜索的摘要内容
--     session_id,    -- UNINDEXED 关联会话ID
--     workspace_id,  -- UNINDEXED 关联工作区ID
--     created_at     -- UNINDEXED 创建时间戳
--   );

-- lessons: 全局经验库/错题本（跨 workspace 共享）
-- 通过 migrate.ts version=25 创建
-- 正文 md 存 <dataDir>/lessons/<id>.md，DB 只存元数据 + embedding
CREATE TABLE IF NOT EXISTS lessons (
  id                   TEXT PRIMARY KEY,
  task_type            TEXT NOT NULL,
  title                TEXT NOT NULL,
  summary              TEXT NOT NULL,
  embedding            BLOB NOT NULL,
  md_path              TEXT NOT NULL,
  source_session_id    TEXT,
  source_message_id    TEXT,
  source_workspace_id  TEXT,
  hit_count            INTEGER DEFAULT 0,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lessons_task_type ON lessons(task_type);

-- lesson_edges: 知识图谱边（教训之间的关联）
CREATE TABLE IF NOT EXISTS lesson_edges (
  from_id    TEXT NOT NULL,
  to_id      TEXT NOT NULL,
  relation   TEXT NOT NULL,
  strength   REAL DEFAULT 1.0,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (from_id, to_id, relation)
);
CREATE INDEX IF NOT EXISTS idx_edges_from ON lesson_edges(from_id);
CREATE INDEX IF NOT EXISTS idx_edges_to ON lesson_edges(to_id);

-- plans + plan_steps: 任务规划（PlanView.vue 后端支撑）
-- 通过 migrate.ts version=26 创建
CREATE TABLE IF NOT EXISTS plans (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  title        TEXT NOT NULL,
  requirement  TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'draft',
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_plans_workspace ON plans(workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS plan_steps (
  id          TEXT PRIMARY KEY,
  plan_id     TEXT NOT NULL,
  idx         INTEGER NOT NULL,
  title       TEXT NOT NULL,
  description TEXT,
  status      TEXT NOT NULL DEFAULT 'pending',
  result      TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_plan_steps_plan ON plan_steps(plan_id, idx);
