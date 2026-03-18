import Anthropic from '@anthropic-ai/sdk';

/**
 * 估算消息的 token 数量
 * 使用经验公式：token ≈ 字符数 / 4（适用于中英文混合）
 * 对于代码，token 密度更高，使用字符数 / 3.5
 */
export function estimateTokens(messages: Anthropic.MessageParam[]): number {
    let totalChars = 0;
    let codeChars = 0;

    for (const msg of messages) {
        const content = extractTextContent(msg.content);
        // 简单检测代码块
        const codeBlocks = content.match(/```[\s\S]*?```/g) || [];
        const codeContent = codeBlocks.join('');
        const nonCodeContent = content.replace(/```[\s\S]*?```/g, '');

        codeChars += codeContent.length;
        totalChars += nonCodeContent.length;
    }

    // 代码块 token 密度更高
    const codeTokens = Math.ceil(codeChars / 3.5);
    const textTokens = Math.ceil(totalChars / 4);

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
                return `[tool_use: ${block.name}]`;
            }
            if (block.type === 'tool_result') {
                return `[tool_result: ${block.tool_use_id}]`;
            }
            return '';
        })
        .join(' ');
}

/**
 * 检测消息是否为 tool_result
 */
function isToolResultMessage(msg: any): boolean {
    if (typeof msg.content === 'string') {
        return false;
    }
    if (!Array.isArray(msg.content)) {
        return false;
    }
    return msg.content.some((block: any) => block.type === 'tool_result');
}

/**
 * 检测消息是否为 tool_use
 */
function isToolUseMessage(msg: any): boolean {
    if (typeof msg.content === 'string') {
        return false;
    }
    if (!Array.isArray(msg.content)) {
        return false;
    }
    return msg.content.some((block: any) => block.type === 'tool_use');
}

/**
 * 获取消息中的 tool 名称（用于摘要）
 */
function getToolName(msg: any): string | null {
    if (typeof msg.content === 'string') {
        return null;
    }
    if (!Array.isArray(msg.content)) {
        return null;
    }
    const toolBlock = msg.content.find((block: any) => block.type === 'tool_use');
    return toolBlock?.name || null;
}

/**
 * 压缩 tool_result 消息为摘要
 */
function compressToolResult(msg: any): any {
    const toolName = getToolName(msg) || 'unknown';
    return {
        role: msg.role,
        content: `[Compressed: Tool "${toolName}" execution completed. Original result was summarized.]`,
    };
}

/**
 * 压缩 assistant 消息（截断过长的内容）
 */
function compressAssistantMessage(msg: any, maxLength: number = 200): any {
    const content = extractTextContent(msg.content);

    if (content.length <= maxLength) {
        return msg;
    }

    const truncated = content.slice(0, maxLength) + '... [content truncated]';
    return {
        role: msg.role,
        content: truncated,
    };
}

export interface CompactOptions {
    /** 最大 token 阈值 */
    maxTokens: number;
    /** 保留的最近完整对话轮数（user + assistant = 1 轮） */
    preserveRounds?: number;
    /** 触发压缩的阈值比例（默认 0.8） */
    thresholdRatio?: number;
}

export interface CompactResult {
    /** 压缩后的消息 */
    messages: any[];
    /** 是否执行了压缩 */
    didCompact: boolean;
    /** 压缩前估算的 token 数 */
    originalTokens: number;
    /** 压缩后估算的 token 数 */
    compactedTokens: number;
    /** 被压缩的消息数量 */
    compressedCount: number;
}

/**
 * 压缩消息列表，减少 token 使用量
 *
 * 压缩策略：
 * 1. 保留 system prompt（如果有）
 * 2. 始终保留最近 N 轮完整对话
 * 3. 中间消息：
 *    - tool_result: 替换为摘要
 *    - assistant: 截断长内容
 *    - user: 保留关键信息，截断长内容
 */
export function compactMessages(
    messages: Anthropic.MessageParam[],
    options: CompactOptions
): CompactResult {
    const { maxTokens, preserveRounds = 4, thresholdRatio = 0.8 } = options;
    const threshold = Math.floor(maxTokens * thresholdRatio);

    const originalTokens = estimateTokens(messages);

    // 如果未达到阈值，无需压缩
    if (originalTokens <= threshold) {
        return {
            messages: [...messages],
            didCompact: false,
            originalTokens,
            compactedTokens: originalTokens,
            compressedCount: 0,
        };
    }

    // 分离 system prompt（如果是第一条且 role 为 system）
    let systemPrompt: any | null = null;
    let chatMessages = messages;

    if (messages.length > 0 && (messages[0] as any).role === 'system') {
        systemPrompt = messages[0];
        chatMessages = messages.slice(1);
    }

    // 计算需要保留的消息索引（最近 N 轮）
    // 一轮 = user 消息 + assistant 消息（可能包含 tool_use + tool_result）
    let preserveCount = 0;
    let roundsCounted = 0;
    const reversed = [...chatMessages].reverse();

    for (const msg of reversed) {
        preserveCount++;
        if ((msg as any).role === 'user') {
            roundsCounted++;
            if (roundsCounted >= preserveRounds) {
                break;
            }
        }
    }

    const preserveStartIndex = chatMessages.length - preserveCount;
    const messagesToCompact = chatMessages.slice(0, preserveStartIndex);
    const messagesToPreserve = chatMessages.slice(preserveStartIndex);

    // 压缩中间消息
    const compressed: any[] = [];
    let compressedCount = 0;

    for (const msg of messagesToCompact) {
        if (isToolResultMessage(msg)) {
            // tool_result 压缩为摘要
            compressed.push(compressToolResult(msg));
            compressedCount++;
        } else if ((msg as any).role === 'assistant' && !isToolUseMessage(msg)) {
            // 普通 assistant 消息截断
            compressed.push(compressAssistantMessage(msg, 150));
            compressedCount++;
        } else if ((msg as any).role === 'user') {
            // user 消息适度截断
            compressed.push(compressAssistantMessage(msg, 100));
            compressedCount++;
        } else {
            // 其他消息保留（如 tool_use 需要保留以保持对话完整性）
            compressed.push(msg);
        }
    }

    // 组装最终消息列表
    const finalMessages: any[] = [];
    if (systemPrompt) {
        finalMessages.push(systemPrompt);
    }
    finalMessages.push(...compressed);
    finalMessages.push(...messagesToPreserve);

    const compactedTokens = estimateTokens(finalMessages);

    return {
        messages: finalMessages,
        didCompact: true,
        originalTokens,
        compactedTokens,
        compressedCount,
    };
}

/**
 * 格式化压缩日志
 */
export function formatCompactLog(result: CompactResult): string {
    const savings = result.originalTokens - result.compactedTokens;
    const ratio = ((savings / result.originalTokens) * 100).toFixed(1);

    return `Context compacted: ${result.originalTokens} → ${result.compactedTokens} tokens ` +
           `(-${savings}, -${ratio}%), ${result.compressedCount} messages compressed`;
}
