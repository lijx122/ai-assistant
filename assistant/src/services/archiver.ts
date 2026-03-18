/**
 * Archiver 模块
 * 会话归档服务：将历史会话生成摘要并保存
 *
 * 功能：
 * 1. archiveSession: 手动归档指定会话
 * 2. startAutoArchive: 自动归档长时间未活跃的会话
 */

import { getDb } from '../db';
import { getConfig } from '../config';
import { summarize } from './context-summary';
import Anthropic from '@anthropic-ai/sdk';
import { randomUUID } from 'crypto';

/** 归档结果 */
export interface ArchiveResult {
    success: boolean;
    skipped?: boolean;
    reason?: string;
    summary?: string;
    tokens?: number;
}

/**
 * 归档指定会话
 * 生成摘要并写入 session_compacts + compact_fts
 *
 * @param sessionId 会话ID
 * @param workspaceId 工作区ID
 * @returns 归档结果
 */
export async function archiveSession(
    sessionId: string,
    workspaceId: string
): Promise<ArchiveResult> {
    const db = getDb();

    try {
        // 1. 检查是否已有 compact 记录
        const existing = db.prepare(
            'SELECT id FROM session_compacts WHERE session_id = ? LIMIT 1'
        ).get(sessionId);

        if (existing) {
            return { success: true, skipped: true, reason: 'already_archived' };
        }

        // 2. 获取会话消息
        const rows = db.prepare(
            'SELECT role, content FROM messages WHERE session_id = ? ORDER BY created_at ASC'
        ).all(sessionId) as any[];

        // 3. 检查消息数量
        if (rows.length < 2) {
            return { success: true, skipped: true, reason: 'too_few' };
        }

        // 4. 构建消息列表
        const messages: Anthropic.MessageParam[] = rows
            .filter(r => r.content && r.content.trim().length > 0)
            .map(r => {
                let content: any = r.content;
                // 尝试解析 JSON
                try {
                    content = JSON.parse(r.content);
                } catch {
                    // 保持字符串
                }
                return {
                    role: r.role as 'user' | 'assistant',
                    content,
                };
            });

        if (messages.length < 2) {
            return { success: true, skipped: true, reason: 'too_few' };
        }

        // 5. 生成摘要
        console.log(`[Archiver] Generating summary for session ${sessionId} (${messages.length} messages)`);
        const summary = await summarize(messages);

        // 6. 计算 token（简化估算）
        const estimatedTokens = Math.ceil(JSON.stringify(messages).length / 3.5);

        // 7. 构建 compact 消息（类似 context-summary 的做法）
        const compactedMessages: Anthropic.MessageParam[] = [
            {
                role: 'user',
                content: `【上下文摘要】以下是之前对话的关键内容：\n\n${summary}`,
            },
            {
                role: 'assistant',
                content: '好的，我已了解之前的对话背景。',
            },
        ];
        const compactedTokens = Math.ceil(JSON.stringify(compactedMessages).length / 3.5);

        // 8. 保存到 session_compacts
        const id = randomUUID();
        const compactedAt = Date.now();

        db.prepare(
            `INSERT INTO session_compacts (
                id, session_id, workspace_id, compacted_at, summary,
                compacted_messages, original_tokens, compacted_tokens
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
            id, sessionId, workspaceId, compactedAt, summary,
            JSON.stringify(compactedMessages), estimatedTokens, compactedTokens
        );

        // 9. 同步插入 FTS5
        try {
            db.prepare(
                `INSERT INTO compact_fts(summary, session_id, workspace_id, created_at)
                 VALUES (?, ?, ?, ?)`
            ).run(summary, sessionId, workspaceId, compactedAt);
        } catch (ftsError) {
            console.warn('[Archiver] FTS5 插入失败:', ftsError);
        }

        console.log(`[Archiver] Session ${sessionId} archived: ${estimatedTokens}→${compactedTokens} tokens`);

        return {
            success: true,
            summary,
            tokens: compactedTokens,
        };

    } catch (error) {
        console.error(`[Archiver] Failed to archive session ${sessionId}:`, error);
        return {
            success: false,
            reason: error instanceof Error ? error.message : 'unknown_error',
        };
    }
}

/**
 * 自动归档扫描
 * 每小时执行一次，归档最后消息 > 24 小时且无 compact 记录的会话
 *
 * @returns 扫描结果统计
 */
export async function runAutoArchive(): Promise<{ scanned: number; archived: number; errors: number }> {
    const db = getDb();
    const now = Date.now();
    const INACTIVE_THRESHOLD = 24 * 60 * 60 * 1000; // 24小时

    const stats = { scanned: 0, archived: 0, errors: 0 };

    try {
        // 查找需要归档的会话：
        // 1. 最后消息 > 24 小时前
        // 2. 没有 compact 记录
        const rows = db.prepare(`
            SELECT s.id, s.workspace_id, MAX(m.created_at) as last_message_at
            FROM sessions s
            JOIN messages m ON s.id = m.session_id
            WHERE s.id NOT IN (SELECT session_id FROM session_compacts)
            GROUP BY s.id
            HAVING last_message_at < ?
        `).all(now - INACTIVE_THRESHOLD) as { id: string; workspace_id: string; last_message_at: number }[];

        stats.scanned = rows.length;

        if (rows.length === 0) {
            console.log('[Archiver] Auto-archive: No sessions to archive');
            return stats;
        }

        console.log(`[Archiver] Auto-archive: Found ${rows.length} sessions to check`);

        // 逐个归档
        for (const row of rows) {
            try {
                const result = await archiveSession(row.id, row.workspace_id);
                if (result.success && !result.skipped) {
                    stats.archived++;
                }
            } catch (error) {
                console.error(`[Archiver] Auto-archive failed for ${row.id}:`, error);
                stats.errors++;
            }
        }

        console.log(`[Archiver] Auto-archive complete: ${stats.scanned} scanned, ${stats.archived} archived, ${stats.errors} errors`);
        return stats;

    } catch (error) {
        console.error('[Archiver] Auto-archive scan failed:', error);
        return stats;
    }
}

let archiveInterval: NodeJS.Timeout | null = null;

/**
 * 启动自动归档定时任务
 * 每小时扫描一次
 */
export function startAutoArchive(): void {
    if (archiveInterval) {
        console.log('[Archiver] Auto-archive already started');
        return;
    }

    const INTERVAL = 60 * 60 * 1000; // 1小时

    // 立即执行一次
    runAutoArchive().catch(err => {
        console.error('[Archiver] Initial auto-archive failed:', err);
    });

    // 定时执行
    archiveInterval = setInterval(() => {
        runAutoArchive().catch(err => {
            console.error('[Archiver] Scheduled auto-archive failed:', err);
        });
    }, INTERVAL);

    console.log('[Archiver] Auto-archive started (interval: 1 hour)');
}

/**
 * 停止自动归档定时任务
 */
export function stopAutoArchive(): void {
    if (archiveInterval) {
        clearInterval(archiveInterval);
        archiveInterval = null;
        console.log('[Archiver] Auto-archive stopped');
    }
}

/**
 * 获取归档统计
 */
export function getArchiveStats(): { totalCompacts: number; totalSessions: number } {
    const db = getDb();

    try {
        const compactCount = db.prepare('SELECT COUNT(*) as count FROM session_compacts').get() as { count: number };
        const sessionCount = db.prepare('SELECT COUNT(*) as count FROM sessions').get() as { count: number };

        return {
            totalCompacts: compactCount.count,
            totalSessions: sessionCount.count,
        };
    } catch (error) {
        console.error('[Archiver] Failed to get stats:', error);
        return { totalCompacts: 0, totalSessions: 0 };
    }
}
