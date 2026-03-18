/**
 * Recall 模块
 * 基于 FTS5 实现历史对话消息的全文检索
 *
 * 使用方式：AI 通过 recall 工具主动搜索历史对话
 *
 * 数据源：messages_fts（messages 表的 FTS5 全文索引）
 */

import { getDb } from '../db';

/** 搜索结果项 */
export interface RecallMessageResult {
  messageId: string;
  content: string;
  session_id: string;
  workspace_id: string;
  role: string;
  created_at: number;
}

/** 工具返回格式 */
export interface RecallToolResult {
  found: number;
  results: Array<{
    date: string;
    role: string;
    content: string;
    sessionId: string;
  }>;
}

/** 回溯关键词（中英文）- 仅用于兼容检测，实际由 AI 自主决定 */
export const RECALL_KEYWORDS = [
  // 中文
  '之前', '上次', '刚才', '上面', '我们讨论', '记得吗', '我说过', '你说过', '还记得',
  '以前', '先前', '刚刚', '聊过', '谈到', '提到',
  // 英文
  'before', 'previous', 'earlier', 'last time', 'we discussed', 'we talked',
  'mentioned', 'said', 'remember',
];

/**
 * 检测用户消息是否需要回溯历史（兼容旧逻辑）
 */
export function needsRecall(userMessage: string): boolean {
  if (!userMessage || typeof userMessage !== 'string') {
    return false;
  }

  const lowerMsg = userMessage.toLowerCase();
  return RECALL_KEYWORDS.some(keyword => lowerMsg.includes(keyword.toLowerCase()));
}

/**
 * 同步插入消息到 messages_fts
 * 存储原始文本内容（FTS5 内置分词）
 */
export function insertMessageFts(
  messageId: string,
  sessionId: string,
  workspaceId: string,
  role: string,
  content: string,
  createdAt: number
): void {
  if (!messageId || !workspaceId) return;
  if (role !== 'user') return;

  const db = getDb();

  try {
    // 提取纯文本（去除 JSON 包装）
    let textContent = content;
    try {
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed)) {
        // 提取所有 text 类型的文本
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
    db.prepare(
      `INSERT INTO messages_fts(content, message_id, session_id, workspace_id, role, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(textContent, messageId, sessionId, workspaceId, role, createdAt);

  } catch (error) {
    // FTS5 插入失败不阻塞主流程，仅记录日志
    console.warn('[Recall] FTS5 insert failed:', error);
  }
}

/**
 * 使用 FTS5 搜索历史对话消息
 * 供 AI 通过 recall 工具调用
 *
 * 搜索策略：
 * 1. FTS5 MATCH 多词 AND 查询（如"考试 AND 地区"）
 * 2. 无结果降级到 LIKE OR 查询
 *
 * @param workspaceId 工作区ID（限定搜索范围）
 * @param keywords 空格分隔的关键词（AI 提供的搜索词）
 * @param limit 返回结果数量上限
 * @returns 搜索结果对象
 */
export function searchHistory(
  workspaceId: string,
  keywords: string,
  limit: number = 2
): RecallToolResult {
  if (!workspaceId || !keywords) {
    return { found: 0, results: [] };
  }

  const db = getDb();

  try {
    const terms = keywords.trim().split(/\s+/).filter(w => w.length >= 2);
    if (terms.length === 0) {
      return { found: 0, results: [] };
    }

    // Step 1: FTS5 MATCH 搜索（多词 AND）
    const ftsQuery = terms.join(' AND ');
    console.log(`[Recall] Tool called, keywords: "${keywords}", FTS MATCH: "${ftsQuery}"`);

    const ftsRows = db.prepare(
      `SELECT mf.content, mf.role, mf.created_at, mf.session_id
       FROM messages_fts mf
       WHERE messages_fts MATCH ? AND mf.workspace_id = ? AND mf.role = 'user'
       ORDER BY rank
       LIMIT ?`
    ).all(ftsQuery, workspaceId, limit) as any[];

    if (ftsRows && ftsRows.length > 0) {
      console.log(`[Recall] FTS MATCH "${ftsQuery}": ${ftsRows.length} results`);
      return formatToolResults(ftsRows);
    }

    // Step 2: FTS5 无结果，降级到 LIKE OR 模糊搜索
    console.log(`[Recall] FTS no results, fallback to LIKE`);

    const likeConditions = terms.map(() => 'content LIKE ?').join(' OR ');
    const likeParams = terms.map(t => `%${t}%`);

    const likeRows = db.prepare(
      `SELECT content, role, created_at, session_id
       FROM messages_fts
       WHERE (${likeConditions}) AND workspace_id = ? AND role = 'user'
       ORDER BY created_at DESC
       LIMIT ?`
    ).all(...likeParams, workspaceId, limit) as any[];

    if (likeRows && likeRows.length > 0) {
      console.log(`[Recall] LIKE fallback ["${terms.join('","')}"]: ${likeRows.length} results`);
      return formatToolResults(likeRows);
    }

    console.log('[Recall] No results found');
    return { found: 0, results: [] };

  } catch (error) {
    console.error('[Recall] Search failed:', error);
    return { found: 0, results: [] };
  }
}

/**
 * 格式化搜索结果为工具返回格式
 */
function formatToolResults(rows: any[]): RecallToolResult {
  const results = rows.map((row) => {
    const date = new Date(row.created_at).toLocaleDateString('zh-CN', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });

    // 内容截断到 300 字
    const content = row.content || '';
    const displayContent = content.length > 300
      ? content.slice(0, 300) + '...'
      : content;

    return {
      date,
      role: row.role,
      content: displayContent,
      sessionId: row.session_id,
    };
  });

  return { found: results.length, results };
}

/**
 * 清理指定会话的 messages_fts 记录
 * 用于会话删除时同步清理
 */
export function deleteMessagesFtsBySession(sessionId: string): void {
    if (!sessionId) return;

    const db = getDb();

    try {
        db.prepare(
            `DELETE FROM messages_fts WHERE session_id = ?`
        ).run(sessionId);

        console.log(`[Recall] Cleaned messages_fts for session ${sessionId}`);
    } catch (error) {
        console.error('[Recall] Failed to clean messages_fts:', error);
    }
}

/**
 * 清理指定消息的 messages_fts 记录
 * 用于单条消息删除时同步清理
 */
export function deleteMessagesFtsByMessageId(messageId: string): void {
    if (!messageId) return;

    const db = getDb();

    try {
        db.prepare(
            `DELETE FROM messages_fts WHERE message_id = ?`
        ).run(messageId);

        console.log(`[Recall] Cleaned messages_fts for message ${messageId.slice(-8)}...`);
    } catch (error) {
        console.error('[Recall] Failed to clean messages_fts:', error);
    }
}
