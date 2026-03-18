/**
 * Message Indexer 模块
 * 负责消息的 embedding 生成和向量索引（滑动窗口版本）
 *
 * 滑动窗口策略：
 * - 每个索引单元包含相邻的 user 消息上下文（默认窗口大小 3）
 * - 解决零散对话语义不完整问题
 * - 锚点消息取窗口中间位置
 *
 * @module src/services/message-indexer
 */

import { getDb } from '../db';
import { embed } from './embedder';

/** 滑动窗口配置 */
const WINDOW_SIZE = 3; // 窗口大小（消息数）
const STEP = 1; // 滑动步长

/**
 * 从 content 中提取纯文本
 * 复用现有 extractText 逻辑
 */
function extractText(content: string): string {
  if (!content) return '';

  try {
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed)) {
      return parsed
        .filter((b: any) => b.type === 'text' && b.text)
        .map((b: any) => b.text)
        .join(' ');
    }
    if (parsed.text && typeof parsed.text === 'string') {
      return parsed.text;
    }
  } catch {
    // 不是 JSON，保持原样
  }

  return content;
}

/**
 * 对 session 进行滑动窗口索引
 * 用于启动回填和批量重建
 *
 * @param sessionId 会话ID
 * @param workspaceId 工作区ID
 */
export async function indexSessionWindows(
  sessionId: string,
  workspaceId: string
): Promise<void> {
  const db = getDb();

  // 取该 session 所有 user 消息，按时间排序
  const messages = db.prepare(`
    SELECT id, content, created_at
    FROM messages
    WHERE session_id = ? AND role = 'user'
    ORDER BY created_at ASC
  `).all(sessionId) as any[];

  if (messages.length === 0) return;

  for (let i = 0; i < messages.length; i += STEP) {
    // 构建窗口：以当前位置为中心，前后各取一部分
    const halfWindow = Math.floor(WINDOW_SIZE / 2);
    const windowStart = Math.max(0, i - halfWindow);
    const windowEnd = Math.min(messages.length, i + halfWindow + 1);
    const window = messages.slice(windowStart, windowEnd);

    const anchorMessage = messages[i]; // 当前锚点消息

    // 已索引则跳过（启动回填场景，单条写入场景会提前删除）
    const existing = db.prepare(
      'SELECT 1 FROM message_embeddings WHERE message_id = ?'
    ).get(anchorMessage.id);
    if (existing) continue;

    // 合并窗口内所有消息文本
    const windowText = window
      .map(m => extractText(m.content))
      .filter(t => t.trim())
      .join('\n');

    if (!windowText.trim()) continue;

    try {
      const vec = await embed(windowText);
      const blob = Buffer.from(vec.buffer);

      db.prepare(`
        INSERT OR IGNORE INTO message_embeddings
        (message_id, workspace_id, session_id, embedding, window_text, window_size, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
      `).run(
        anchorMessage.id,
        workspaceId,
        sessionId,
        blob,
        windowText,
        window.length
      );

      console.log(`[Indexer] Indexed window ${anchorMessage.id.slice(0, 8)}... (size=${window.length})`);
    } catch (err) {
      console.warn('[Indexer] Failed to index window at message:', anchorMessage.id, err);
    }
  }
}

/**
 * 异步索引单条消息（触发窗口重新索引）
 * 单条消息写入时，不单独建索引，而是触发对该 session 最近消息的窗口重建
 *
 * @param messageId 消息ID
 * @param workspaceId 工作区ID
 * @param sessionId 会话ID
 * @param content 消息内容（JSON 或纯文本）
 * @param role 角色（只索引 user 消息）
 */
export async function indexMessage(
  messageId: string,
  workspaceId: string,
  sessionId: string,
  content: string,
  role: string
): Promise<void> {
  // 只索引 user 消息
  if (role !== 'user') return;

  const db = getDb();

  try {
    // 获取该 session 最近的 user 消息（用于窗口重建）
    // 只取最近 WINDOW_SIZE * 2 条，避免全量扫描
    const recentMessages = db.prepare(`
      SELECT id, content, created_at
      FROM messages
      WHERE session_id = ? AND role = 'user'
      ORDER BY created_at DESC
      LIMIT ?
    `).all(sessionId, WINDOW_SIZE * 2) as any[];

    if (recentMessages.length === 0) return;

    // 反转为正序（时间从小到大）
    const messages = recentMessages.reverse();

    // 对每条消息重建窗口索引
    for (let i = 0; i < messages.length; i++) {
      const anchor = messages[i];
      const halfWindow = Math.floor(WINDOW_SIZE / 2);

      // 窗口范围
      const windowStart = Math.max(0, i - halfWindow);
      const windowEnd = Math.min(messages.length, i + halfWindow + 1);
      const window = messages.slice(windowStart, windowEnd);

      // 删除旧索引（窗口内容可能已变化）
      db.prepare('DELETE FROM message_embeddings WHERE message_id = ?').run(anchor.id);

      // 合并窗口文本
      const windowText = window
        .map(m => extractText(m.content))
        .filter(t => t.trim())
        .join('\n');

      if (!windowText.trim()) continue;

      try {
        const vec = await embed(windowText);
        const blob = Buffer.from(vec.buffer);

        db.prepare(`
          INSERT OR IGNORE INTO message_embeddings
          (message_id, workspace_id, session_id, embedding, window_text, window_size, created_at)
          VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
        `).run(
          anchor.id,
          workspaceId,
          sessionId,
          blob,
          windowText,
          window.length
        );
      } catch (err) {
        console.warn('[Indexer] Window index failed for message', anchor.id, err);
      }
    }

    console.log(`[Indexer] Rebuilt window index for session ${sessionId.slice(0, 8)}...`);
  } catch (err) {
    console.warn('[Indexer] Failed to index message window:', (err as Error).message);
  }
}

/**
 * 启动时回填历史消息（按 session 分组窗口索引）
 * 异步执行，不阻塞启动
 */
export async function backfillEmbeddings(): Promise<void> {
  const db = getDb();

  try {
    // 找出有未索引 user 消息的 session
    const sessions = db.prepare(`
      SELECT DISTINCT m.session_id, s.workspace_id
      FROM messages m
      JOIN sessions s ON s.id = m.session_id
      LEFT JOIN message_embeddings me ON me.message_id = m.id
      WHERE m.role = 'user' AND me.message_id IS NULL
    `).all() as any[];

    if (sessions.length === 0) {
      console.log('[Indexer] No sessions to backfill');
      return;
    }

    console.log(`[Indexer] Backfilling ${sessions.length} sessions with sliding windows...`);
    let success = 0;

    for (const session of sessions) {
      try {
        await indexSessionWindows(session.session_id, session.workspace_id);
        success++;
      } catch (err) {
        console.warn('[Indexer] Session backfill failed:', session.session_id, err);
      }
    }

    console.log(`[Indexer] Backfill complete: ${success}/${sessions.length} sessions`);
  } catch (err) {
    console.warn('[Indexer] Backfill failed:', (err as Error).message);
  }
}
