/**
 * Recall 工具（向量语义检索版）
 * 供 AI 主动搜索历史对话记录
 *
 * @module src/services/tools/recall
 */

import { getDb } from '../../db';
import { embed, cosineSimilarity } from '../embedder';
import type { ToolDefinition, ToolExecutor, ToolContext, ToolResult, RegisteredTool } from './types';

/** Recall 工具定义 */
export const recallToolDefinition: ToolDefinition = {
  name: 'recall',
  description: `在当前工作区历史对话中语义搜索相关内容。

重要规则：
- 只在当前对话上下文中没有相关信息时才调用
- 如果用户的问题在当前会话中已经讨论过，直接回答，不要调用 recall
- 适合调用的场景：用户明确提到"之前"/"上次"/"你还记得"等回溯词
- 不适合调用的场景：当前对话已有足够上下文、用户只是继续当前话题

传入能代表用户意图的自然语言描述。`,
  input_schema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: '搜索意图描述，如"我们聊过的考试"或"Python异步相关讨论"'
      },
      limit: {
        type: 'number',
        description: '返回条数，默认 2，最多 5',
        minimum: 1,
        maximum: 5
      }
    },
    required: ['query']
  }
};

/**
 * 从 content 中提取纯文本
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
 * LIKE 降级搜索（保底方案）
 * 使用 window_text 字段搜索窗口合并后的完整内容
 */
function likeSearch(workspaceId: string, query: string, limit: number): any {
  const db = getDb();

  const terms = query.trim().split(/\s+/).filter(t => t.length >= 2);
  if (terms.length === 0) return { found: 0, results: [] };

  const whereClauses = terms.map(() => 'window_text LIKE ?').join(' OR ');
  const params = terms.map(t => `%${t}%`);

  try {
    const rows = db.prepare(`
      SELECT window_text, session_id, created_at, window_size
      FROM message_embeddings
      WHERE (${whereClauses})
        AND workspace_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(...params, workspaceId, limit) as any[];

    console.log(`[Recall] LIKE fallback: ${rows.length} results`);

    const results = rows.map(r => ({
      date: new Date(r.created_at).toLocaleDateString('zh-CN', {
        month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit'
      }),
      content: (r.window_text || '').slice(0, 300),
      sessionId: r.session_id,
      windowSize: r.window_size || 1
    }));

    return {
      found: results.length,
      results,
      message: results.length > 0
        ? `找到 ${results.length} 条相关历史对话（关键词匹配）`
        : '未找到相关历史记录'
    };
  } catch (err) {
    console.warn('[Recall] LIKE search failed:', err);
    return { found: 0, results: [], message: '搜索失败' };
  }
}

/**
 * 向量语义搜索
 */
async function vectorSearch(
  workspaceId: string,
  query: string,
  limit: number
): Promise<any> {
  const db = getDb();

  // Step 1：生成 query embedding
  let queryVec: Float32Array;
  try {
    queryVec = await embed(query);
  } catch (err) {
    console.warn('[Recall] Embed failed, fallback to LIKE:', (err as Error).message);
    return likeSearch(workspaceId, query, limit);
  }

  // Step 2：读取工作区所有 window embedding
  let rows: any[];
  try {
    rows = db.prepare(`
      SELECT me.message_id, me.embedding, me.session_id, me.created_at,
             me.window_text, me.window_size
      FROM message_embeddings me
      WHERE me.workspace_id = ?
    `).all(workspaceId) as any[];
  } catch (err) {
    console.warn('[Recall] Failed to query embeddings:', (err as Error).message);
    return likeSearch(workspaceId, query, limit);
  }

  if (rows.length === 0) {
    console.log('[Recall] No embeddings found, fallback to LIKE');
    return likeSearch(workspaceId, query, limit);
  }

  // Step 3：计算余弦相似度 + 时间衰减，过滤 + 排序
  const THRESHOLD = 0.45; // 相似度阈值，低于此不返回
  const SEMANTIC_WEIGHT = 0.7; // 语义权重
  const TIME_WEIGHT = 0.3; // 时间衰减权重
  const DECAY_DAYS = 30; // 衰减周期（30天半衰期）

  const now = Date.now();

  const scored = rows
    .map(row => {
      // 从 Buffer 恢复 Float32Array
      const buf = row.embedding as Buffer;
      const embeddingVec = new Float32Array(
        buf.buffer,
        buf.byteOffset,
        buf.byteLength / 4
      );

      // 语义相似度
      const semantic = cosineSimilarity(queryVec, embeddingVec);

      // 时间衰减计算
      const days = (now - new Date(row.created_at).getTime()) / 86400000;
      const timeDecay = Math.exp(-days / DECAY_DAYS);

      // 加权最终分数
      const finalScore = semantic * (SEMANTIC_WEIGHT + TIME_WEIGHT * timeDecay);

      return {
        ...row,
        score: finalScore,
        semantic,
        timeDecay
      };
    })
    .filter(r => r.score > THRESHOLD)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  // 日志输出（如有结果）
  if (scored.length > 0) {
    const top = scored[0];
    console.log(
      `[Recall] top result: semantic=${top.semantic.toFixed(2)} ` +
      `time_weight=${top.timeDecay.toFixed(2)} final=${top.score.toFixed(2)} ` +
      `window_size=${top.window_size || 1}`
    );
  }

  console.log(
    `[Recall] Vector results: ${scored.length}, threshold: ${THRESHOLD}`
  );

  // Step 4：无向量结果时降级 LIKE
  if (scored.length === 0) {
    console.log('[Recall] No vector results above threshold, fallback to LIKE');
    return likeSearch(workspaceId, query, limit);
  }

  console.log(
    `[Recall] Vector results: ${scored.length}, ` +
    `threshold: ${THRESHOLD}, top score: ${scored[0]?.semantic?.toFixed(3)}, window_size: ${scored[0]?.window_size || 1}`
  );

  // Step 5：格式化返回
  const results = scored.map(r => ({
    date: new Date(r.created_at).toLocaleDateString('zh-CN', {
      month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit'
    }),
    content: (r.window_text || '').slice(0, 300),
    sessionId: r.session_id,
    score: r.score.toFixed(3),
    windowSize: r.window_size || 1
  }));

  return {
    found: results.length,
    results,
    message: `找到 ${results.length} 条语义相关历史对话`
  };
}

/**
 * 执行 recall 工具
 */
export const executeRecall: ToolExecutor = async (
  input: { query: string; limit?: number },
  context: ToolContext
): Promise<ToolResult> => {
  const { query, limit = 2 } = input;
  const { workspaceId } = context;

  if (!workspaceId) {
    return {
      success: false,
      error: 'Missing workspaceId'
    };
  }

  if (!query || query.trim().length === 0) {
    return {
      success: false,
      error: 'Query is required'
    };
  }

  console.log(`[Recall] Tool called, query: "${query}"`);

  try {
    const result = await vectorSearch(workspaceId, query, Math.min(limit, 5));

    console.log(`[Recall] Found ${result.found} results`);

    return {
      success: true,
      data: {
        found: result.found,
        message: result.message,
        results: result.results
      }
    };

  } catch (error: any) {
    console.error('[Recall] Tool execution failed:', error);
    return {
      success: false,
      error: `搜索失败: ${error.message || 'Unknown error'}`
    };
  }
};

/** Recall 工具注册项 */
export const recallTool: RegisteredTool = {
  definition: recallToolDefinition,
  executor: executeRecall,
  riskLevel: 'low',
  timeoutMs: 30000 // 向量计算可能需要较长时间
};
