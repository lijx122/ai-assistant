import { Hono } from 'hono';
import { getDb } from '../db';
import { authMiddleware } from '../middleware/auth';
import { AuthContext } from '../types';
import { workspaceLock } from '../services/workspace-lock';
import { getRunner, AgentStreamCallback } from '../services/agent-runner';
import { getConfig } from '../config';
import { randomUUID } from 'crypto';
import Anthropic from '@anthropic-ai/sdk';
import {
    estimateTokens,
    summarize,
    saveCompact,
    getLatestCompact,
    CompactSnapshot,
    compactIfNeeded
} from '../services/context-summary';
import { webSocketChannel, clearTokenBuffer } from '../channels';
import { buildSystemPrompt } from '../services/message-processor';
import { logger } from '../services/logger';
import { parseContent, serializeContent, buildMessagesForSession } from '../services/chat-messages';
import {
    executeConfirmedTool,
    cancelExecution,
    getPendingConfirmation,
    getSessionPendingConfirmations,
} from '../services/tools';

export const chatRouter = new Hono<{ Variables: { user: AuthContext } }>();

chatRouter.use('*', authMiddleware);

/**
 * 广播消息到指定工作区
 * 通过 WebSocketChannel 发送
 */
export function broadcastToWorkspace(workspaceId: string, payload: any) {
    webSocketChannel.broadcastToWorkspace(workspaceId, payload);
}


chatRouter.get('/history', (c) => {
    const workspaceId = c.req.query('workspaceId');
    if (!workspaceId) return c.json({ error: 'Missing workspaceId' }, 400);

    const db = getDb();
    const rows = db.prepare('SELECT * FROM messages WHERE workspace_id = ? ORDER BY created_at ASC').all(workspaceId) as any[];

    // 解析 content JSON，过滤掉 streaming 状态的占位消息（前端不需要显示）
    const messages = rows
        .filter(r => r.status !== 'streaming') // 过滤掉正在生成的占位消息
        .map(r => ({
            ...r,
            content: parseContent(r.content),
        }));

    return c.json({ messages });
});

chatRouter.post('/', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { workspaceId, sessionId, content, messageId } = body;
    const user = c.get('user');

    if (!workspaceId || !content) {
        return c.json({ error: 'Missing workspaceId or content' }, 400);
    }

    // sessionId 必填，确保消息关联到正确会话
    if (!sessionId) {
        return c.json({ error: 'Missing sessionId' }, 400);
    }

    const db = getDb();

    // 验证 session 存在
    const session = db.prepare('SELECT id FROM sessions WHERE id = ?').get(sessionId);
    if (!session) {
        return c.json({ error: 'Session not found' }, 404);
    }

    // 1. Idempotency Check
    if (messageId) {
        const existing = db.prepare('SELECT id FROM messages WHERE message_id = ?').get(messageId);
        if (existing) {
            return c.json({ success: true, status: 'duplicate' });
        }
    }

    // Generate ID and Timestamp
    const internalMsgId = randomUUID();
    const now = Date.now();

    // 序列化 content（支持字符串或多模态数组）
    const serializedContent = serializeContent(content);

    // 2. Write User Message immediately
    db.prepare(
        'INSERT INTO messages (id, session_id, workspace_id, user_id, role, content, message_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(internalMsgId, sessionId, workspaceId, user.userId, 'user', serializedContent, messageId || null, now);

    // 更新会话最后活跃时间和标题（从 content 中提取文本作为标题）
    let titleText = '';
    if (typeof content === 'string') {
        titleText = content;
    } else if (Array.isArray(content)) {
        // 多模态：提取所有 text 类型的内容拼接
        titleText = content
            .filter((block: any) => block.type === 'text')
            .map((block: any) => block.text)
            .join(' ');
    } else {
        titleText = JSON.stringify(content);
    }
    const title = titleText.slice(0, 20);
    db.prepare(
        "UPDATE sessions SET last_active_at = ?, title = COALESCE(NULLIF(title, ''), ?) WHERE id = ?"
    ).run(now, title, sessionId);

    // 3. Pre-insert assistant placeholder message with streaming status
    const assistantMsgId = randomUUID();
    db.prepare(
        `INSERT INTO messages (id, session_id, workspace_id, user_id, role, content, status, streaming_content, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'streaming', '', ?)`
    ).run(assistantMsgId, sessionId, workspaceId, user.userId, 'assistant', '', now);

    // 4. Enqueue agent task (async, don't wait)
    setTimeout(() => {
        runAgentTask(sessionId, workspaceId, assistantMsgId, user.userId);
    }, 0);

    // 5. Return immediately with 202 Accepted
    return c.json({ success: true, assistantMsgId }, 202);
});

/**
 * Run agent task independently (decoupled from WebSocket lifecycle)
 * Updates streaming_content incrementally during generation
 */
async function runAgentTask(
    sessionId: string,
    workspaceId: string,
    assistantMsgId: string,
    userId: string
): Promise<void> {
    const db = getDb();

    // Stream buffer for incremental saves (declared here for catch block access)
    let streamBuffer = '';
    let lastSaveTime = Date.now();
    const SAVE_INTERVAL_MS = 1500; // Save every 1.5s

    // Broadcast queue position
    broadcastToWorkspace(workspaceId, { type: 'queue_position', position: 'waiting' });

    // Acquire workspace lock
    const release = await workspaceLock.acquire(workspaceId);

    try {
        broadcastToWorkspace(workspaceId, { type: 'queue_position', position: 'executing' });

        // Load messages with compact support
        let anthropicMsgs: Anthropic.MessageParam[] = await buildMessagesForSession(sessionId, workspaceId, {
            logPrefix: 'Chat',
            onEvent: (type, payload) => {
                if (type === 'compact_start' || type === 'compact_done') {
                    broadcastToWorkspace(workspaceId, { type, payload });
                }
            },
        });

        // 获取最后一条用户消息内容用于构建 system prompt
        const lastUserMessage = anthropicMsgs
            .filter((m: any) => m.role === 'user')
            .pop();

        const userContent = lastUserMessage
            ? typeof lastUserMessage.content === 'string'
                ? lastUserMessage.content
                : JSON.stringify(lastUserMessage.content)
            : '';

        // Build system prompt using unified function
        const systemPrompt = await buildSystemPrompt(workspaceId, userContent);

        // Log context summary
        const msgSummary = anthropicMsgs.map((m: any) => ({
            role: m.role,
            type: Array.isArray(m.content) ? m.content.map((c: any) => c.type).join(',') : 'text',
            len: JSON.stringify(m.content).length
        }));
        console.log('[Chat] Context summary:', JSON.stringify(msgSummary));

        // Content blocks collection
        const assistantContentBlocks: any[] = [];
        const toolResultBlocks: any[] = [];
        let currentText = '';
        let runtimeError: string | null = null;

        const onEvent: AgentStreamCallback = (type, payload) => {
            // Broadcast to all connected WebSocket clients
            broadcastToWorkspace(workspaceId, { type, payload });

            // HITL 诊断日志
            if (type.includes('confirmation')) {
                console.log(`[Chat] Broadcasting ${type} event:`, payload);
            }

            if (type === 'text') {
                streamBuffer += payload;
                currentText += payload;

                const now = Date.now();
                if (now - lastSaveTime >= SAVE_INTERVAL_MS) {
                    updateStreamingContent(assistantMsgId, streamBuffer);
                    lastSaveTime = now;
                }
            } else if (type === 'tool_call') {
                // Save previous text chunk before tool call
                if (currentText) {
                    assistantContentBlocks.push({ type: 'text', text: currentText });
                    currentText = '';
                }
                assistantContentBlocks.push({
                    type: 'tool_use',
                    id: payload.tool_use_id,
                    name: payload.name,
                    input: payload.input,
                });
            } else if (type === 'tool_result') {
                toolResultBlocks.push({
                    type: 'tool_result',
                    tool_use_id: payload.tool_use_id,
                    content: typeof payload.result === 'string'
                        ? payload.result
                        : JSON.stringify(payload.result),
                });
            } else if (type === 'done') {
                // Bug fix: Log done event
                console.log(`[Chat] Done event received for message ${assistantMsgId}`);
            } else if (type === 'error') {
                console.error(`[Chat] Error event received:`, payload);
                runtimeError = typeof payload === 'string' ? payload : JSON.stringify(payload);
            }
        };

        const runner = getRunner(workspaceId, onEvent);
        const startTime = Date.now();

        // Log agent start
        logger.sdk.info('agent-runner', `Task started: ${assistantMsgId}`, { workspaceId, sessionId, userId });

        // Run the agent
        await runner.run(anthropicMsgs, systemPrompt, sessionId, workspaceId, onEvent);

        const duration = Date.now() - startTime;

        // Log agent completion
        const contentLength = assistantContentBlocks.reduce((sum, b) => sum + (b.text?.length || 0), 0);
        logger.sdk.info('agent-runner', `Task done: ${assistantMsgId}`, { workspaceId, sessionId, duration, contentLength });

        // Save final text chunk
        if (currentText) {
            assistantContentBlocks.push({ type: 'text', text: currentText });
        }

        // Finalize the assistant message
        console.log(`[Chat] Finalizing message ${assistantMsgId}, blocks count: ${assistantContentBlocks.length}`);
        if (assistantContentBlocks.length > 0) {
            finalizeMessage(assistantMsgId, assistantContentBlocks);
            console.log(`[Chat] Message ${assistantMsgId} finalized successfully`);
        } else {
            if (runtimeError) {
                const errorContent = [{ type: 'text', text: `执行失败：${runtimeError}` }];
                finalizeMessage(assistantMsgId, errorContent);
                console.log(`[Chat] Message ${assistantMsgId} finalized with runtime error`);
            } else {
                // If no content, mark as complete with empty content
                console.log(`[Chat] No content blocks, marking as complete with empty content`);
                db.prepare(
                    `UPDATE messages SET status = 'complete', streaming_content = NULL WHERE id = ?`
                ).run(assistantMsgId);
            }
        }

        // Save tool results as separate user messages
        for (const block of toolResultBlocks) {
            const toolResultMsgId = randomUUID();
            db.prepare(
                'INSERT INTO messages (id, session_id, workspace_id, user_id, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
            ).run(toolResultMsgId, sessionId, workspaceId, userId, 'user', serializeContent([block]), Date.now());
        }

        // 清空 token 缓存（消息已完成）
        clearTokenBuffer(workspaceId);

        // Update session last active time
        db.prepare('UPDATE sessions SET last_active_at = ? WHERE id = ?').run(Date.now(), sessionId);

        // Record SDK call
        db.prepare(
            'INSERT INTO sdk_calls (id, session_id, workspace_id, user_id, model, duration_ms, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        ).run(randomUUID(), sessionId, workspaceId, userId, 'claude', duration, 'success', Date.now());

    } catch (e: any) {
        console.error('[Chat] Agent task failed:', e);

        // Mark message as interrupted, preserving partial content
        markMessageInterrupted(assistantMsgId, streamBuffer);

        // Record error
        db.prepare(
            'INSERT INTO sdk_calls (id, session_id, workspace_id, user_id, model, status, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        ).run(randomUUID(), sessionId, workspaceId, userId, 'claude', 'error', e.message || 'Error', Date.now());

        broadcastToWorkspace(workspaceId, { type: 'error', payload: e.message || 'Execution Error' });
    } finally {
        // 确保 token 缓存被清空（即使出错）
        clearTokenBuffer(workspaceId);
        release();
    }
}

/**
 * Update streaming content incrementally during generation
 */
function updateStreamingContent(msgId: string, content: string): void {
    const db = getDb();
    db.prepare('UPDATE messages SET streaming_content = ? WHERE id = ?').run(content, msgId);
}

/**
 * Finalize message: save content blocks, clear streaming_content, set status to complete
 */
function finalizeMessage(msgId: string, contentBlocks: any[]): void {
    const db = getDb();
    console.log(`[Chat] Executing finalizeMessage for ${msgId}, content length: ${JSON.stringify(contentBlocks).length}`);
    const result = db.prepare(
        `UPDATE messages SET content = ?, streaming_content = NULL, status = 'complete' WHERE id = ?`
    ).run(serializeContent(contentBlocks), msgId);
    console.log(`[Chat] finalizeMessage result: changes=${result.changes}`);
}

/**
 * Mark message as interrupted: save partial content, clear streaming_content
 */
function markMessageInterrupted(msgId: string, partialContent: string): void {
    const db = getDb();
    const content = partialContent || '';
    db.prepare(
        `UPDATE messages SET content = ?, streaming_content = NULL, status = 'interrupted' WHERE id = ?`
    ).run(serializeContent([{ type: 'text', text: content }]), msgId);
}

/**
 * Get streaming message for a session (for replay on reconnect)
 */
export function getStreamingMessage(sessionId: string): { id: string; content: string } | null {
    const db = getDb();
    const row = db.prepare(
        `SELECT id, COALESCE(streaming_content, content) as content
         FROM messages WHERE session_id = ? AND status = 'streaming'
         ORDER BY created_at DESC LIMIT 1`
    ).get(sessionId) as any;

    if (!row) return null;
    return { id: row.id, content: row.content || '' };
}

/**
 * Get streaming message for a workspace (for task status on reconnect)
 * Returns the most recent streaming message with created_at timestamp
 */
export function getStreamingMessageByWorkspace(workspaceId: string): { id: string; content: string; created_at: number } | null {
    const db = getDb();
    const row = db.prepare(
        `SELECT id, COALESCE(streaming_content, content) as content, created_at
         FROM messages WHERE workspace_id = ? AND status = 'streaming'
         ORDER BY created_at DESC LIMIT 1`
    ).get(workspaceId) as any;

    if (!row) return null;
    return { id: row.id, content: row.content || '', created_at: row.created_at };
}

// POST /api/chat/compact - 手动触发上下文压缩
chatRouter.post('/compact', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { sessionId, workspaceId } = body;

    if (!sessionId || !workspaceId) {
        return c.json({ success: false, error: 'Missing sessionId or workspaceId' }, 400);
    }

    const config = getConfig();
    const preserveRounds = config.claude.compact.preserve_rounds;
    const minMessages = preserveRounds * 2;

    try {
        // 检查是否已有 compact 快照，防止重复压缩
        const existingCompact = getLatestCompact(sessionId);
        if (existingCompact) {
            // 获取快照之后的新消息数量
            const db = getDb();
            const newMsgCount = db.prepare(
                'SELECT COUNT(*) as count FROM messages WHERE session_id = ? AND created_at > ?'
            ).get(sessionId, existingCompact.compacted_at) as { count: number };

            // 规则2：如果新消息少于 preserve_rounds * 2 条，提示但允许继续（可选警告）
            // 根据需求，只要有新消息就应允许压缩，此规则已移除
            if (newMsgCount.count === 0) {
                return c.json({ success: false, error: '上次压缩后暂无新对话，无需再次压缩' }, 400);
            }
        }

        // 使用 buildMessages 获取当前有效消息（已考虑已有快照）
        const messages = await buildMessagesForSession(sessionId, workspaceId, { logPrefix: 'Chat/Compact' });

        // 检查消息数量是否足够
        if (messages.length <= minMessages) {
            return c.json({ success: false, error: `消息太少，无需压缩（当前 ${messages.length} 条，最少需要 ${minMessages + 1} 条）` }, 400);
        }

        // 估算 token 数
        const estimatedTokens = estimateTokens(messages);

        // 广播 compact_start 事件
        broadcastToWorkspace(workspaceId, {
            type: 'compact_start',
            payload: { before: estimatedTokens, manual: true }
        });

        // 切割消息：保留最近 N 轮，其余送去摘要
        // 关键修复：确保保留段以 user 消息开头，避免连续 assistant 消息
        let preserveCount = preserveRounds * 2;
        let toPreserve: Anthropic.MessageParam[] = messages.slice(-preserveCount);

        // 确保保留段以 user 消息开头（否则从头部移除，直到第一个是 user）
        while (toPreserve.length > 0 && (toPreserve[0] as any).role !== 'user') {
            toPreserve = toPreserve.slice(1);
        }

        // 重新计算实际要摘要的消息
        const toSummarize = messages.slice(0, messages.length - toPreserve.length);

        // 调用 summarize 生成摘要（跳过阈值判断，直接生成）
        const summary = await summarize(toSummarize);

        // 组装压缩后的消息
        const compactedMessages: Anthropic.MessageParam[] = [
            {
                role: 'user',
                content: `【上下文摘要】以下是之前对话的关键内容：\n\n${summary}\n\n请基于以上背景继续协助我。`,
            },
            {
                role: 'assistant',
                content: '好的，我已了解之前的对话背景，请继续。',
            },
            ...toPreserve,
        ];

        const compactedTokens = estimateTokens(compactedMessages);

        // 保存 compact 快照到数据库
        await saveCompact(sessionId, workspaceId, summary, compactedMessages, estimatedTokens, compactedTokens);

        // 广播 compact_done 事件
        broadcastToWorkspace(workspaceId, {
            type: 'compact_done',
            payload: {
                before: estimatedTokens,
                after: compactedTokens,
                saved: estimatedTokens - compactedTokens,
                summary,
            }
        });

        console.log(`[Chat/Compact] Session ${sessionId}: ${estimatedTokens} → ${compactedTokens} tokens, saved ${estimatedTokens - compactedTokens}`);

        return c.json({ success: true, before: estimatedTokens, after: compactedTokens, saved: estimatedTokens - compactedTokens });

    } catch (error: any) {
        console.warn('[Chat/Compact] Failed:', error.message);
        return c.json({ success: false, error: error.message || 'Compact failed' }, 500);
    }
});

// POST /api/chat/confirm - 确认或取消待确认的工具调用
chatRouter.post('/confirm', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { confirmationId, action = 'confirm', sessionId } = body;

    if (!confirmationId) {
        return c.json({ success: false, error: 'Missing confirmationId' }, 400);
    }

    const pending = getPendingConfirmation(confirmationId);
    if (!pending) {
        return c.json({ success: false, error: '确认请求不存在或已过期' }, 404);
    }

    // 验证 sessionId 匹配（如果提供）
    if (sessionId && pending.context.sessionId !== sessionId) {
        return c.json({ success: false, error: 'Session ID 不匹配' }, 403);
    }

    if (action === 'cancel') {
        // 取消操作
        const cancelled = cancelExecution(confirmationId);
        if (cancelled) {
            // 广播取消事件到工作区
            broadcastToWorkspace(pending.context.workspaceId, {
                type: 'confirmation_cancelled',
                payload: {
                    confirmationId,
                    tool_use_id: pending.toolUseId,
                    toolName: pending.toolName,
                    sessionId: pending.context.sessionId,
                }
            });
            return c.json({ success: true, cancelled: true });
        }
        return c.json({ success: false, error: '取消失败' }, 500);
    }

    // 确认操作
    try {
        // 广播确认开始事件
        broadcastToWorkspace(pending.context.workspaceId, {
            type: 'confirmation_executing',
            payload: {
                confirmationId,
                tool_use_id: pending.toolUseId,
                toolName: pending.toolName,
                sessionId: pending.context.sessionId,
            }
        });

        // 执行已确认的工具调用
        const result = await executeConfirmedTool(confirmationId);

        // 广播执行结果
        broadcastToWorkspace(pending.context.workspaceId, {
            type: 'confirmation_done',
            payload: {
                confirmationId,
                tool_use_id: pending.toolUseId,
                toolName: pending.toolName,
                sessionId: pending.context.sessionId,
                success: result.success,
                result: result.data,
                error: result.error,
                elapsed_ms: result.elapsed_ms,
            }
        });

        return c.json({
            success: result.success,
            result: result.data,
            error: result.error,
            elapsed_ms: result.elapsed_ms,
        });
    } catch (err: any) {
        console.error('[Chat/Confirm] Execution failed:', err);
        return c.json({
            success: false,
            error: err.message || '执行失败',
        }, 500);
    }
});

// GET /api/chat/confirmations - 获取当前会话的待确认列表
chatRouter.get('/confirmations', (c) => {
    const sessionId = c.req.query('sessionId');
    if (!sessionId) {
        return c.json({ error: 'Missing sessionId' }, 400);
    }

    const pending = getSessionPendingConfirmations(sessionId);
    return c.json({
        confirmations: pending.map(p => ({
            confirmationId: p.confirmationId,
            toolName: p.toolName,
            title: p.title,
            description: p.description,
            riskLevel: p.riskLevel,
            createdAt: p.createdAt,
            timeoutMs: p.timeoutMs,
        })),
    });
});

// PUT /api/messages/:id - 更新消息内容（用于编辑重发）
chatRouter.put('/messages/:id', async (c) => {
    const messageId = c.req.param('id');
    const body = await c.req.json().catch(() => ({}));
    const { content } = body;

    if (content === undefined) {
        return c.json({ error: 'Missing content' }, 400);
    }

    const db = getDb();

    // 验证消息存在
    const message = db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId) as any;
    if (!message) {
        return c.json({ error: 'Message not found' }, 404);
    }

    // 只允许更新 user 消息
    if (message.role !== 'user') {
        return c.json({ error: 'Only user messages can be edited' }, 403);
    }

    // 序列化新内容
    const serializedContent = serializeContent(content);

    // 更新消息内容
    db.prepare('UPDATE messages SET content = ? WHERE id = ?').run(serializedContent, messageId);

    // 获取该消息之后的所有消息（包括 AI 回复和后续用户消息），删除它们
    const deleted = db.prepare(
        'DELETE FROM messages WHERE session_id = ? AND created_at >= ? AND id != ?'
    ).run(message.session_id, message.created_at, messageId);

    console.log(`[Message] Updated ${messageId} and deleted ${deleted.changes} subsequent messages`);

    return c.json({ success: true, deletedCount: deleted.changes });
});

// DELETE /api/messages/:id/response - 删除指定消息后的 AI 回复（保留用户消息）
chatRouter.delete('/messages/:id/response', (c) => {
    const messageId = c.req.param('id');
    const db = getDb();

    // 验证消息存在
    const message = db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId) as any;
    if (!message) {
        return c.json({ error: 'Message not found' }, 404);
    }

    // 删除该消息之后的所有消息
    const deleted = db.prepare(
        'DELETE FROM messages WHERE session_id = ? AND created_at > ?'
    ).run(message.session_id, message.created_at);

    console.log(`[Message] Deleted ${deleted.changes} messages after ${messageId}`);

    return c.json({ success: true, deletedCount: deleted.changes });
});
