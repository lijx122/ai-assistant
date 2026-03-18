import Anthropic from '@anthropic-ai/sdk';
import { getDb } from '../db';
import { getConfig } from '../config';
import { compactIfNeeded, estimateTokens, getLatestCompact } from './context-summary';

export function parseContent(content: string): any {
    try {
        return JSON.parse(content);
    } catch {
        return content;
    }
}

export function serializeContent(content: any): string {
    if (typeof content === 'string') {
        return content;
    }
    return JSON.stringify(content);
}

/**
 * 合并连续的 user 消息（Anthropic API 要求）
 * tool_result 和紧跟的 user text 必须合并到同一个 user 消息中
 */
export function mergeConsecutiveUserMessages(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
    const result: Anthropic.MessageParam[] = [];

    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];

        if (
            msg.role === 'user' &&
            result.length > 0 &&
            result[result.length - 1].role === 'user'
        ) {
            const prev = result[result.length - 1];

            const prevContent: any[] = Array.isArray(prev.content)
                ? prev.content
                : [{ type: 'text' as const, text: prev.content }];
            const currContent: any[] = Array.isArray(msg.content)
                ? msg.content
                : [{ type: 'text' as const, text: msg.content }];

            result[result.length - 1] = {
                role: 'user',
                content: [...prevContent, ...currContent],
            };
        } else {
            result.push(msg);
        }
    }

    return result;
}

/**
 * 从数据库加载指定时间之后的消息
 */
function getMessagesAfter(sessionId: string, timestamp: number): Anthropic.MessageParam[] {
    const db = getDb();
    const rows = db.prepare(
        'SELECT role, content FROM messages WHERE session_id = ? AND created_at > ? ORDER BY created_at ASC'
    ).all(sessionId, timestamp) as any[];

    return rows
        .filter(r => r.content && r.content.trim().length > 0)
        .map(r => ({
            role: (r.role === 'assistant' ? 'assistant' : 'user') as 'user' | 'assistant',
            content: parseContent(r.content),
        }));
}

interface BuildMessagesOptions {
    onEvent?: (type: string, payload: any) => void;
    logPrefix?: string;
}

/**
 * 构建消息列表：优先使用 compact 快照 + 增量消息
 * 同时处理连续 user 消息的合并（不丢弃 tool_result）
 *
 * compact 检测只作用于历史消息，不包含当前用户输入
 */
export async function buildMessagesForSession(
    sessionId: string,
    workspaceId: string,
    options: BuildMessagesOptions = {}
): Promise<Anthropic.MessageParam[]> {
    const db = getDb();
    const compact = getLatestCompact(sessionId);
    const logPrefix = options.logPrefix || 'ChatMessages';

    let messages: Anthropic.MessageParam[];

    if (compact) {
        const newMessages = getMessagesAfter(sessionId, compact.compacted_at);
        console.log(`[${logPrefix}] compact cache hit: ${compact.compacted_messages.length} base + ${newMessages.length} new`);
        messages = [...compact.compacted_messages, ...newMessages];
    } else {
        const rows = db.prepare(
            'SELECT role, content FROM messages WHERE session_id = ? ORDER BY created_at ASC'
        ).all(sessionId) as any[];

        console.log(`[${logPrefix}] no compact cache, loading ${rows.length} messages from db`);
        messages = rows
            .filter(r => r.content && r.content.trim().length > 0)
            .map(r => ({
                role: (r.role === 'assistant' ? 'assistant' : 'user') as 'user' | 'assistant',
                content: parseContent(r.content),
            }));
    }

    const config = getConfig();
    if (config.claude.compact.enabled) {
        const estimatedTokens = estimateTokens(messages);
        const tokenLimit = config.claude.compact.token_limit ?? 60000;
        const ratioThreshold = Math.floor(config.claude.max_tokens * config.claude.compact.threshold_ratio);

        if (estimatedTokens > tokenLimit && estimatedTokens > ratioThreshold) {
            console.log(`[${logPrefix}] Token threshold exceeded (${estimatedTokens} > ${tokenLimit} & ${ratioThreshold}), triggering compact...`);

            try {
                const compactResult = await compactIfNeeded(
                    messages,
                    sessionId,
                    workspaceId,
                    options.onEvent
                        ? (event, payload) => {
                            if (event === 'compact_start') options.onEvent?.('compact_start', payload);
                            if (event === 'compact_done') options.onEvent?.('compact_done', payload);
                        }
                        : undefined
                );

                if (compactResult.didCompact) {
                    console.log(`[${logPrefix}] Compact completed: ${compactResult.originalTokens} → ${compactResult.compactedTokens} tokens`);
                    messages = compactResult.messages;
                }
            } catch (err) {
                console.warn(`[${logPrefix}] Compact failed, using original messages:`, err);
            }
        }
    }

    return mergeConsecutiveUserMessages(messages);
}
