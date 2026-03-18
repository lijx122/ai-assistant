import Anthropic from '@anthropic-ai/sdk';
import { getConfig } from '../config';
import { getDb } from '../db';
import { randomUUID } from 'crypto';

/**
 * Context Summary 模块
 * 使用 Haiku 模型对长对话进行摘要压缩，解决 token 超限问题
 *
 * 策略：
 * 1. 估算当前 messages 的 token 数
 * 2. 超过阈值时，保留最近 N 轮，中间消息送 Haiku 生成摘要
 * 3. 组装为：[user:摘要] + [assistant:确认] + 保留的最近 N 轮
 * 4. 压缩结果持久化到 session_compacts 表，重启后可复用
 */

/** 压缩事件回调类型 */
export type CompactEventCallback = (event: 'compact_start' | 'compact_done', payload: any) => void;

/** 摘要结果 */
export interface CompactResult {
    messages: Anthropic.MessageParam[];
    didCompact: boolean;
    originalTokens: number;
    compactedTokens: number;
    summary?: string;
}

/** Compact 快照记录 */
export interface CompactSnapshot {
    id: string;
    session_id: string;
    workspace_id: string;
    compacted_at: number;
    summary: string;
    compacted_messages: Anthropic.MessageParam[];
    original_tokens: number;
    compacted_tokens: number;
}

/**
 * 估算消息的 token 数量
 * token ≈ 字符数 / 3.5（中文比英文 token 密度高，使用更保守的估算）
 * 代码块 token 密度更高，保持 / 3.5
 */
export function estimateTokens(messages: Anthropic.MessageParam[]): number {
    let totalChars = 0;
    let codeChars = 0;

    for (const msg of messages) {
        const content = extractTextContent(msg.content);
        // 检测代码块
        const codeBlocks = content.match(/```[\s\S]*?```/g) || [];
        const codeContent = codeBlocks.join('');
        const nonCodeContent = content.replace(/```[\s\S]*?```/g, '');

        codeChars += codeContent.length;
        totalChars += nonCodeContent.length;
    }

    // 统一使用 /3.5 估算（中文 token 密度更高）
    const codeTokens = Math.ceil(codeChars / 3.5);
    const textTokens = Math.ceil(totalChars / 3.5);

    return codeTokens + textTokens;
}

/**
 * 从消息内容中提取纯文本
 */
function extractTextContent(content: any): string {
    if (typeof content === 'string') {
        return content;
    }

    if (!Array.isArray(content)) {
        return String(content);
    }

    return (content as any[])
        .map((block: any) => {
            if (block.type === 'text' && block.text) {
                return block.text;
            }
            if (block.type === 'tool_use') {
                return `[调用工具: ${block.name}]`;
            }
            if (block.type === 'tool_result') {
                const output = block.content || block.output || '';
                const outputText = typeof output === 'string' ? output : JSON.stringify(output);
                return `[工具结果: ${outputText.slice(0, 100)}${outputText.length > 100 ? '...' : ''}]`;
            }
            if (block.type === 'image') {
                return '[图片]';
            }
            return '';
        })
        .join(' ');
}

/**
 * 将消息列表格式化为适合摘要的文本
 */
function formatForSummary(messages: Anthropic.MessageParam[]): string {
    return messages.map((msg, idx) => {
        const role = (msg as any).role;
        const content = extractTextContent(msg.content);
        // 限制单条消息长度，避免超长内容淹没摘要
        const truncated = content.length > 800
            ? content.slice(0, 800) + '... [内容过长已截断]'
            : content;
        return `[${idx + 1}] ${role.toUpperCase()}: ${truncated}`;
    }).join('\n\n');
}

/**
 * 调用 Haiku 生成摘要
 * 独立调用，不依赖 AgentRunner，避免循环依赖
 */
export async function summarize(
    messages: Anthropic.MessageParam[],
    onEvent?: CompactEventCallback
): Promise<string> {
    const config = getConfig();
    const compactConfig = config.claude.compact;

    // 创建独立的 anthropic 客户端（用于摘要）
    const anthropic = new Anthropic({
        apiKey: config.anthropicApiKey,
        baseURL: config.anthropicBaseUrl,
    });

    const formattedMessages = formatForSummary(messages);

    const systemPrompt = `你是一个对话摘要助手。请将以下对话压缩为简洁、准确的摘要。

要求：
1. 保留关键决策、重要结论和核心信息
2. 保留已确认的代码修改、文件操作结果
3. 保留用户的明确意图和需求
4. 去除冗余的中间探索过程和试错细节
5. 使用简洁的要点或段落形式
6. 如果对话中有代码，保留关键代码片段`;

    try {
        const response = await anthropic.messages.create({
            model: compactConfig.summary_model,
            max_tokens: compactConfig.max_summary_tokens,
            system: systemPrompt,
            messages: [{ role: 'user', content: formattedMessages }],
            // 禁用 thinking，摘要任务不需要推理过程（针对支持 thinking 的模型如 claude-3-7）
            ...(compactConfig.summary_model.match(/claude-3-[57]/) ? { thinking: { type: 'disabled' } } : {}),
        });

        console.log('[ContextSummary] Haiku response:', JSON.stringify({
            model: compactConfig.summary_model,
            contentLength: response.content?.length,
            blockTypes: response.content?.map((b: any) => b.type),
        }));

        // 查找第一个 text 类型的块（thinking 模型可能返回 thinking + text）
        const textBlock = response.content.find((b: any) => b.type === 'text');
        if (!textBlock || textBlock.type !== 'text') {
            throw new Error('Haiku 未返回文本内容');
        }

        return textBlock.text;
    } catch (error) {
        // 降级：返回简化版摘要
        console.error('[ContextSummary] Haiku 摘要失败，使用降级策略:', error);
        return `[对话摘要 - 共 ${messages.length} 条消息]\n关键主题: ${extractKeyTopics(messages)}`;
    }
}

/**
 * 提取关键主题（降级策略）
 */
function extractKeyTopics(messages: Anthropic.MessageParam[]): string {
    // 简单提取用户消息的前 3 条作为主题
    const userMessages = messages
        .filter((m: any) => m.role === 'user')
        .slice(0, 3)
        .map((m: any) => {
            const text = extractTextContent(m.content);
            return text.slice(0, 50) + (text.length > 50 ? '...' : '');
        });
    return userMessages.join('; ') || '无明确主题';
}

/**
 * 保存 compact 快照到数据库
 */
export async function saveCompact(
    sessionId: string,
    workspaceId: string,
    summary: string,
    compactedMessages: Anthropic.MessageParam[],
    originalTokens: number,
    compactedTokens: number
): Promise<void> {
    const db = getDb();
    const id = randomUUID();
    const compactedAt = Date.now();

    try {
        db.prepare(
            `INSERT INTO session_compacts (
                id, session_id, workspace_id, compacted_at, summary,
                compacted_messages, original_tokens, compacted_tokens
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
            id, sessionId, workspaceId, compactedAt, summary,
            JSON.stringify(compactedMessages), originalTokens, compactedTokens
        );

        // 同步插入 FTS5 虚拟表，用于归档摘要检索（非 Recall，Recall 使用 messages_fts）
        try {
            db.prepare(
                `INSERT INTO compact_fts(summary, session_id, workspace_id, created_at)
                 VALUES (?, ?, ?, ?)`
            ).run(summary, sessionId, workspaceId, compactedAt);
        } catch (ftsError) {
            // FTS5 插入失败不阻塞主流程，仅记录日志
            console.warn('[ContextSummary] FTS5 插入失败（归档摘要检索功能受影响）:', ftsError);
        }

        console.log(`[ContextSummary] Compact 快照已保存: session=${sessionId}, tokens=${originalTokens}→${compactedTokens}`);
    } catch (error) {
        console.error('[ContextSummary] 保存 compact 快照失败:', error);
        // 不抛出错误，允许继续对话
    }
}

/**
 * 获取最新的 compact 快照
 */
export function getLatestCompact(sessionId: string): CompactSnapshot | null {
    const db = getDb();

    try {
        const row = db.prepare(
            `SELECT * FROM session_compacts
             WHERE session_id = ?
             ORDER BY compacted_at DESC
             LIMIT 1`
        ).get(sessionId) as any;

        if (!row) {
            return null;
        }

        return {
            id: row.id,
            session_id: row.session_id,
            workspace_id: row.workspace_id,
            compacted_at: row.compacted_at,
            summary: row.summary,
            compacted_messages: JSON.parse(row.compacted_messages),
            original_tokens: row.original_tokens,
            compacted_tokens: row.compacted_tokens,
        };
    } catch (error) {
        console.error('[ContextSummary] 读取 compact 快照失败:', error);
        return null;
    }
}

/**
 * 获取 session 的所有 compact 快照（按时间升序）
 * 供前端展示多条分隔线
 */
export function getAllCompacts(sessionId: string): CompactSnapshot[] {
    const db = getDb();

    try {
        const rows = db.prepare(
            `SELECT * FROM session_compacts
             WHERE session_id = ?
             ORDER BY compacted_at ASC`
        ).all(sessionId) as any[];

        return rows.map(row => ({
            id: row.id,
            session_id: row.session_id,
            workspace_id: row.workspace_id,
            compacted_at: row.compacted_at,
            summary: row.summary,
            compacted_messages: JSON.parse(row.compacted_messages),
            original_tokens: row.original_tokens,
            compacted_tokens: row.compacted_tokens,
        }));
    } catch (error) {
        console.error('[ContextSummary] 读取所有 compact 快照失败:', error);
        return [];
    }
}

/**
 * 主入口：判断是否需要压缩，如需要则执行摘要压缩
 *
 * @param messages 原始消息列表
 * @param sessionId 会话 ID（用于保存快照）
 * @param workspaceId 工作区 ID（用于保存快照）
 * @param onEvent 事件回调（用于通知前端）
 * @returns 压缩后的消息列表
 */
export async function compactIfNeeded(
    messages: Anthropic.MessageParam[],
    sessionId?: string,
    workspaceId?: string,
    onEvent?: CompactEventCallback
): Promise<CompactResult> {
    const config = getConfig();
    const compactConfig = config.claude.compact;

    // 如果禁用 compact，直接返回
    if (!compactConfig.enabled) {
        return {
            messages: [...messages],
            didCompact: false,
            originalTokens: estimateTokens(messages),
            compactedTokens: estimateTokens(messages),
        };
    }

    const originalTokens = estimateTokens(messages);

    // 新的阈值判断：双条件同时满足
    // 1. 超过 token_limit（默认 60000）
    // 2. 超过 max_tokens * threshold_ratio
    const tokenLimit = compactConfig.token_limit ?? 60000;
    const ratioThreshold = Math.floor(config.claude.max_tokens * compactConfig.threshold_ratio);

    const shouldCompact = originalTokens > tokenLimit && originalTokens > ratioThreshold;

    // 未超过阈值，无需压缩
    if (!shouldCompact) {
        return {
            messages: [...messages],
            didCompact: false,
            originalTokens,
            compactedTokens: originalTokens,
        };
    }

    // 通知前端开始压缩
    onEvent?.('compact_start', { before: originalTokens, tokenLimit, ratioThreshold });

    // 计算保留的消息数量（preserve_rounds * 2，因为一轮 = user + assistant）
    // 注意：实际可能包含 tool_use/tool_result，所以稍微多保留一些
    const preserveCount = compactConfig.preserve_rounds * 2;

    // 如果消息总数不足保留数量，不压缩
    if (messages.length <= preserveCount + 2) {
        console.log('[ContextSummary] 消息数量不足，跳过压缩');
        return {
            messages: [...messages],
            didCompact: false,
            originalTokens,
            compactedTokens: originalTokens,
        };
    }

    // 切割：保留最近 N 条，其余送去摘要
    // 关键修复：确保保留段以 user 消息开头，避免连续 assistant 消息
    let toPreserve = messages.slice(-preserveCount);

    // 确保保留段以 user 消息开头（否则从头部移除，直到第一个是 user）
    while (toPreserve.length > 0 && (toPreserve[0] as any).role !== 'user') {
        toPreserve = toPreserve.slice(1);
    }

    // 重新计算实际要摘要的消息
    const toSummarize = messages.slice(0, messages.length - toPreserve.length);

    // 如果调整后保留的消息太少，不压缩
    if (toPreserve.length < compactConfig.preserve_rounds * 2 - 2) {
        console.log('[ContextSummary] 调整后保留消息太少，跳过压缩');
        return {
            messages: [...messages],
            didCompact: false,
            originalTokens,
            compactedTokens: originalTokens,
        };
    }

    console.log(`[ContextSummary] 触发压缩: ${originalTokens} tokens > token_limit(${tokenLimit}) & ratio_threshold(${ratioThreshold}), 摘要 ${toSummarize.length} 条, 保留 ${toPreserve.length} 条`);

    // 调用 Haiku 生成摘要
    const summary = await summarize(toSummarize, onEvent);

    // 组装新消息列表
    // 格式：user 发送摘要 → assistant 确认
    let summaryContent = `【上下文摘要】以下是之前对话的关键内容：\n\n${summary}`;
    summaryContent += "\n\n请基于以上背景继续协助我。";

    const compactedMessages: Anthropic.MessageParam[] = [
        {
            role: 'user',
            content: summaryContent,
        },
        {
            role: 'assistant',
            content: '好的，我已了解之前的对话背景和关键信息，请继续。',
        },
        ...toPreserve,
    ];

    const compactedTokens = estimateTokens(compactedMessages);

    // 保存快照到数据库（如果提供了 sessionId 和 workspaceId）
    if (sessionId && workspaceId) {
        await saveCompact(sessionId, workspaceId, summary, compactedMessages, originalTokens, compactedTokens);
    }

    // 通知前端压缩完成
    onEvent?.('compact_done', {
        before: originalTokens,
        after: compactedTokens,
        summary,
        saved: originalTokens - compactedTokens,
    });

    console.log(`[ContextSummary] 压缩完成: ${originalTokens} → ${compactedTokens} tokens, 节省 ${originalTokens - compactedTokens} tokens`);

    return {
        messages: compactedMessages,
        didCompact: true,
        originalTokens,
        compactedTokens,
        summary,
    };
}

/**
 * 格式化压缩日志（用于服务器端日志）
 */
export function formatCompactLog(result: CompactResult): string {
    if (!result.didCompact) {
        return `[ContextSummary] 未触发压缩，当前 ${result.originalTokens} tokens`;
    }

    const savings = result.originalTokens - result.compactedTokens;
    const ratio = ((savings / result.originalTokens) * 100).toFixed(1);

    return `[ContextSummary] 压缩: ${result.originalTokens} → ${result.compactedTokens} tokens ` +
           `(-${savings}, -${ratio}%)`;
}
