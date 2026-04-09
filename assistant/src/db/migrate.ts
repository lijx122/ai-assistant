/**
 * Database Migration System
 *
 * 使用 user_version PRAGMA 追踪数据库版本
 * 启动时自动执行缺失的迁移
 */

import Database from 'better-sqlite3';

interface Migration {
    version: number;
    name: string;
    sql: string;
}

// 迁移历史（按版本号顺序）
const migrations: Migration[] = [
    {
        version: 1,
        name: 'add_terminal_disconnected_at',
        sql: `ALTER TABLE terminal_sessions ADD COLUMN disconnected_at INTEGER;`,
    },
    {
        version: 2,
        name: 'add_sessions_lark_chat_id',
        sql: `
            ALTER TABLE sessions ADD COLUMN lark_chat_id TEXT;
            CREATE INDEX IF NOT EXISTS idx_sessions_lark_chat_id ON sessions(lark_chat_id);
        `,
    },
    {
        version: 3,
        name: 'add_session_compacts_table',
        sql: `
            CREATE TABLE IF NOT EXISTS session_compacts (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                workspace_id TEXT NOT NULL,
                compacted_at INTEGER NOT NULL,
                summary TEXT NOT NULL,
                compacted_messages TEXT NOT NULL,
                original_tokens INTEGER,
                compacted_tokens INTEGER
            );
            CREATE INDEX IF NOT EXISTS idx_session_compacts_session ON session_compacts(session_id, compacted_at DESC);
        `,
    },
    {
        version: 4,
        name: 'add_messages_streaming_status',
        sql: `
            ALTER TABLE messages ADD COLUMN status TEXT DEFAULT 'complete';
            ALTER TABLE messages ADD COLUMN streaming_content TEXT;
            CREATE INDEX IF NOT EXISTS idx_messages_session_status ON messages(session_id, status);
        `,
    },
    {
        version: 5,
        name: 'add_tasks_notify_target',
        sql: `ALTER TABLE tasks ADD COLUMN notify_target TEXT;`,
    },
    {
        version: 6,
        name: 'add_compact_fts_table',
        sql: `
            -- FTS5 虚拟表：用于会话摘要归档检索
            CREATE VIRTUAL TABLE IF NOT EXISTS compact_fts USING fts5(
                summary,           -- 摘要内容（可全文搜索）
                session_id,        -- 关联的会话ID
                workspace_id,      -- 关联的工作区ID
                created_at         -- 创建时间戳
            );

            -- 回填已有 session_compacts 数据到 FTS5（幂等）
            INSERT INTO compact_fts(summary, session_id, workspace_id, created_at)
            SELECT summary, session_id, workspace_id, compacted_at
            FROM session_compacts
            WHERE session_id NOT IN (
                SELECT DISTINCT session_id FROM compact_fts
            );
        `,
    },
    {
        version: 7,
        name: 'add_messages_fts_table',
        sql: `
            -- FTS5 虚拟表：用于 Recall 原始对话检索
            CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
                content,           -- 消息内容（可全文搜索）
                message_id,        -- 关联的消息ID
                session_id,        -- 关联的会话ID
                workspace_id,      -- 关联的工作区ID
                role,              -- 消息角色
                created_at         -- 创建时间戳
            );

            -- 回填已有 messages 数据到 FTS5（幂等：跳过已存在的 message_id）
            -- 修复：正确提取 JSON 数组中的文本内容，处理纯文本、纯数字、JSON数组等情况
            INSERT INTO messages_fts(content, message_id, session_id, workspace_id, role, created_at)
            SELECT
                CASE
                    WHEN json_valid(m.content) AND json_type(m.content) = 'array' THEN
                        -- JSON 数组：提取所有 text 类型的文本拼接
                        COALESCE(
                            (SELECT group_concat(json_extract(value, '$.text'), ' ')
                             FROM json_each(m.content)
                             WHERE json_extract(value, '$.type') = 'text'),
                            m.content
                        )
                    WHEN json_valid(m.content) AND json_type(m.content) = 'object' THEN
                        -- JSON 对象：尝试提取 text 字段
                        COALESCE(json_extract(m.content, '$.text'), m.content)
                    ELSE
                        -- 纯文本或其他：直接存储
                        m.content
                END,
                m.id, m.session_id, s.workspace_id, m.role, m.created_at
            FROM messages m
            JOIN sessions s ON s.id = m.session_id
            WHERE m.role IN ('user', 'assistant')
                AND m.id NOT IN (SELECT message_id FROM messages_fts);
        `,
    },
    {
        version: 8,
        name: 'clear_messages_fts_for_rebuild',
        sql: `
            -- 清空 messages_fts 重新回填（使用原始文本，FTS5 内置分词）
            DELETE FROM messages_fts;
        `,
    },
    {
        version: 9,
        name: 'add_message_embeddings_table',
        sql: `
            -- 向量 embeddings 表：用于语义检索
            CREATE TABLE IF NOT EXISTS message_embeddings (
                message_id   TEXT PRIMARY KEY,
                workspace_id TEXT NOT NULL,
                session_id   TEXT NOT NULL,
                embedding    BLOB NOT NULL,  -- Float32Array 存储为 BLOB
                created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
            );
            CREATE INDEX IF NOT EXISTS idx_me_workspace
                ON message_embeddings(workspace_id);
            CREATE INDEX IF NOT EXISTS idx_me_session
                ON message_embeddings(session_id);
        `,
    },
    {
        version: 10,
        name: 'add_alerts_table_and_task_alert_on_error',
        sql: `
            -- alerts 表：运维告警存储
            CREATE TABLE IF NOT EXISTS alerts (
                id            TEXT PRIMARY KEY,
                workspace_id  TEXT NOT NULL,
                task_id       TEXT,
                source        TEXT NOT NULL,
                message       TEXT NOT NULL,
                raw           TEXT,
                status        TEXT DEFAULT 'pending',
                -- status: pending/notified/fixing/resolved/failed
                ai_analysis   TEXT,
                fix_attempts  INTEGER DEFAULT 0,
                fix_log       TEXT,
                pending_script_adjust INTEGER DEFAULT 0,
                created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
            );

            -- alerts 表索引
            CREATE INDEX IF NOT EXISTS idx_alerts_workspace_status
                ON alerts(workspace_id, status, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_alerts_task_id
                ON alerts(task_id);
            CREATE INDEX IF NOT EXISTS idx_alerts_created_at
                ON alerts(created_at DESC);

            -- tasks 表新增 alert_on_error 字段
            ALTER TABLE tasks ADD COLUMN alert_on_error INTEGER DEFAULT 0;
        `,
    },
    {
        version: 11,
        name: 'add_alerts_session_id',
        sql: `
            -- alerts 表新增 session_id 字段，用于关联消息记录
            ALTER TABLE alerts ADD COLUMN session_id TEXT;
            CREATE INDEX IF NOT EXISTS idx_alerts_session_id ON alerts(session_id);
        `,
    },
    {
        version: 12,
        name: 'add_window_fields_to_embeddings',
        sql: `
            -- message_embeddings 表新增窗口字段，用于滑动窗口索引
            ALTER TABLE message_embeddings ADD COLUMN window_text TEXT;
            ALTER TABLE message_embeddings ADD COLUMN window_size INTEGER DEFAULT 1;

            -- 清空旧数据，重新以滑动窗口方式回填
            DELETE FROM message_embeddings;
        `,
    },
    {
        version: 13,
        name: 'add_memory_tables_for_post_session',
        sql: `
            -- workspace_memory 表：工作区项目级记忆
            CREATE TABLE IF NOT EXISTS workspace_memory (
                id            TEXT PRIMARY KEY,
                workspace_id  TEXT NOT NULL UNIQUE,
                content       TEXT NOT NULL,
                updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP
            );
            CREATE INDEX IF NOT EXISTS idx_workspace_memory_updated
                ON workspace_memory(workspace_id, updated_at DESC);

            -- impressions 表：用户偏好印象
            CREATE TABLE IF NOT EXISTS impressions (
                id              TEXT PRIMARY KEY,
                workspace_id    TEXT NOT NULL UNIQUE,
                content         TEXT NOT NULL,
                confidence_avg  REAL DEFAULT 0.0,
                updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP
            );
            CREATE INDEX IF NOT EXISTS idx_impressions_updated
                ON impressions(workspace_id, updated_at DESC);

            -- post_session_log 表：Post-Session 处理日志（防重触发）
            CREATE TABLE IF NOT EXISTS post_session_log (
                id            TEXT PRIMARY KEY,
                session_id    TEXT NOT NULL UNIQUE,
                triggered_at  DATETIME DEFAULT CURRENT_TIMESTAMP
            );
            CREATE INDEX IF NOT EXISTS idx_post_session_log_triggered
                ON post_session_log(session_id, triggered_at);
        `,
    },
    {
        version: 14,
        name: 'add_logs_table',
        sql: `
            -- 检查是否存在旧 schema 的 logs 表，有则删除重建
            DROP TABLE IF EXISTS logs;
            DROP INDEX IF EXISTS idx_logs_category;

            -- 结构化日志表：四分类（system/sdk/task/terminal）
            CREATE TABLE IF NOT EXISTS logs (
                id            TEXT PRIMARY KEY,
                timestamp     INTEGER NOT NULL,
                level         TEXT NOT NULL,  -- debug/info/warn/error
                category      TEXT NOT NULL,  -- system/sdk/task/terminal
                module        TEXT NOT NULL,  -- 模块名，如 agent-runner, cron, etc.
                trace_id      TEXT,           -- 可选的追踪ID
                message       TEXT NOT NULL,
                metadata      TEXT            -- JSON 字符串
            );

            -- 日志表索引
            CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON logs(timestamp DESC);
            CREATE INDEX IF NOT EXISTS idx_logs_category ON logs(category, timestamp DESC);
            CREATE INDEX IF NOT EXISTS idx_logs_level ON logs(level, timestamp DESC);
            CREATE INDEX IF NOT EXISTS idx_logs_module ON logs(module, timestamp DESC);
            CREATE INDEX IF NOT EXISTS idx_logs_trace ON logs(trace_id, timestamp DESC);
        `,
    },
    {
        version: 16,
        name: 'add_performance_indexes',
        sql: `
            CREATE INDEX IF NOT EXISTS idx_sessions_workspace_created
                ON sessions(workspace_id, started_at DESC);
            CREATE INDEX IF NOT EXISTS idx_messages_session_created
                ON messages(session_id, created_at);
            CREATE INDEX IF NOT EXISTS idx_tasks_workspace
                ON tasks(workspace_id, status);
            CREATE INDEX IF NOT EXISTS idx_logs_timestamp
                ON logs(timestamp DESC);
            CREATE INDEX IF NOT EXISTS idx_logs_category
                ON logs(category, timestamp DESC);
        `,
    },
    {
        version: 17,
        name: 'add_terminal_sessions_disconnected_index',
        sql: `
            CREATE INDEX IF NOT EXISTS idx_terminal_sessions_disconnected
                ON terminal_sessions(disconnected_at);
        `,
    },
    {
        version: 18,
        name: 'add_sdk_calls_table',
        sql: `
            CREATE TABLE IF NOT EXISTS sdk_calls (
                id TEXT PRIMARY KEY,
                session_id TEXT,
                workspace_id TEXT NOT NULL,
                user_id TEXT NOT NULL,
                model TEXT NOT NULL,
                input_tokens INTEGER,
                output_tokens INTEGER,
                duration_ms INTEGER,
                status TEXT NOT NULL,
                error TEXT,
                created_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_sdk_calls_workspace ON sdk_calls(workspace_id, created_at);
        `,
    },
    {
        version: 19,
        name: 'add_weixin_channel_tables',
        sql: `
            CREATE TABLE IF NOT EXISTS weixin_accounts (
                id TEXT PRIMARY KEY,
                name TEXT,
                bot_token TEXT NOT NULL,
                base_url TEXT,
                status TEXT DEFAULT 'active',
                created_at INTEGER NOT NULL,
                last_used_at INTEGER
            );
            CREATE TABLE IF NOT EXISTS weixin_sessions (
                id TEXT PRIMARY KEY,
                qrcode TEXT,
                qrcode_url TEXT,
                qrcode_img TEXT,
                status TEXT DEFAULT 'pending',
                account_id TEXT,
                created_at INTEGER NOT NULL,
                expires_at INTEGER
            );
        `,
    },
    {
        version: 21,
        name: 'add_sessions_status_and_user_id',
        sql: `
            -- sessions 表新增 status 和 user_id 字段
            ALTER TABLE sessions ADD COLUMN status TEXT DEFAULT 'active';
            ALTER TABLE sessions ADD COLUMN user_id TEXT NOT NULL DEFAULT 'default';
        `,
    },
    {
        version: 22,
        name: 'add_last_sender_id_to_weixin_accounts',
        sql: `
            ALTER TABLE weixin_accounts ADD COLUMN last_sender_id TEXT;
        `,
    },
    {
        version: 23,
        name: 'add_notify_enabled_to_tasks',
        sql: `
            ALTER TABLE tasks ADD COLUMN notify_enabled INTEGER DEFAULT 0;
        `,
    },
    {
        version: 24,
        name: 'add_notify_on_success_to_tasks',
        sql: `
            ALTER TABLE tasks ADD COLUMN notify_on_success INTEGER DEFAULT 0;
        `,
    },
];

/**
 * 重新回填 messages_fts（使用原始文本）
 * 在 server 启动时调用，确保 version 8 迁移后执行
 */
export function backfillMessagesFts(db: Database.Database): number {
  // 查询需要回填的消息
  const messages = db.prepare(`
    SELECT m.id, m.content, m.role, m.session_id, m.created_at, s.workspace_id
    FROM messages m
    JOIN sessions s ON s.id = m.session_id
    WHERE m.role = 'user'
      AND m.id NOT IN (SELECT message_id FROM messages_fts)
    ORDER BY m.created_at ASC
  `).all() as any[];

  if (messages.length === 0) {
    console.log('[Recall] messages_fts is up to date');
    return 0;
  }

  const insert = db.prepare(`
    INSERT OR IGNORE INTO messages_fts
    (content, message_id, session_id, workspace_id, role, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  let count = 0;
  for (const msg of messages) {
    try {
      // 提取纯文本（去除 JSON 包装）
      let textContent = msg.content;
      try {
        const parsed = JSON.parse(msg.content);
        if (Array.isArray(parsed)) {
          textContent = parsed
            .filter((b: any) => b.type === 'text' && b.text)
            .map((b: any) => b.text)
            .join(' ');
        } else if (typeof parsed === 'string') {
          textContent = parsed;
        }
      } catch {
        // 不是 JSON，保持原样
      }

      // 直接存储原始文本（FTS5 内置分词）
      if (textContent) {
        insert.run(
          textContent,
          msg.id,
          msg.session_id,
          msg.workspace_id,
          msg.role,
          msg.created_at
        );
        count++;
      }
    } catch (err) {
      console.warn(`[Recall] Failed to backfill message ${msg.id}:`, err);
    }
  }

  console.log(`[Recall] Backfilled ${count} records to messages_fts`);
  return count;
}

/**
 * 执行数据库迁移
 */
export function runMigrations(db: Database.Database): void {
    // 获取当前版本（默认为 0）
    const currentVersion = db.pragma('user_version', { simple: true }) as number;
    console.log(`[DB] Current schema version: ${currentVersion}`);

    // 执行待处理的迁移
    for (const migration of migrations) {
        if (migration.version > currentVersion) {
            console.log(`[DB] Running migration ${migration.version}: ${migration.name}`);
            try {
                db.exec(migration.sql);
                // 更新版本号
                db.pragma(`user_version = ${migration.version}`);
                console.log(`[DB] Migration ${migration.version} completed`);
            } catch (err: any) {
                // 忽略 "duplicate column name" 错误（已手动添加的情况）
                if (err.message?.includes('duplicate column name')) {
                    console.log(`[DB] Migration ${migration.version} skipped: column already exists`);
                    db.pragma(`user_version = ${migration.version}`);
                } else {
                    console.error(`[DB] Migration ${migration.version} failed:`, err.message);
                    throw err;
                }
            }
        }
    }

    const newVersion = db.pragma('user_version', { simple: true }) as number;
    if (newVersion > currentVersion) {
        console.log(`[DB] Schema upgraded to version ${newVersion}`);
    } else {
        console.log('[DB] Schema is up to date');
    }
}

/**
 * 添加新迁移的步骤：
 * 1. 在 migrations 数组末尾添加新的 Migration 对象
 * 2. version 必须是递增的正整数
 * 3. sql 可以是多条语句（用分号分隔）
 *
 * 示例：
 * {
 *     version: 2,
 *     name: 'add_tasks_notify_target',
 *     sql: `ALTER TABLE tasks ADD COLUMN notify_target TEXT;`,
 * }
 */
