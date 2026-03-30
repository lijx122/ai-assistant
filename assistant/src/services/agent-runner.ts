import Anthropic from '@anthropic-ai/sdk';
import { getConfig } from '../config';
import {
    registerAllTools,
    getToolDefinitions,
    executeTool,
} from './tools';

// 确保工具已注册
registerAllTools();

export type AgentStreamCallback = (type: 'text' | 'tool_call' | 'tool_result' | 'usage' | 'error' | 'done' | 'confirmation_requested', content: any) => void;

interface RunnerOptions {
    workspaceId: string;
    onEvent: AgentStreamCallback;
}


interface PendingToolUse {
    id: string;
    name: string;
    inputJson: string;
    input?: any;
}

export class AgentRunner {
    private client: Anthropic;
    private lastActive: number;
    private idleTimer: NodeJS.Timeout | null = null;
    private isDestroyed: boolean = false;

    public workspaceId: string;
    private currentSessionId?: string; // 当前会话ID

    constructor(options: RunnerOptions) {
        const config = getConfig();
        this.workspaceId = options.workspaceId;
        this.client = new Anthropic({
            apiKey: config.anthropicApiKey,
            baseURL: config.anthropicBaseUrl,
        });
        this.lastActive = Date.now();
        this.resetIdleTimer();
    }

    // Used for extending the lifecycle
    public poke() {
        this.lastActive = Date.now();
        this.resetIdleTimer();
    }

    private resetIdleTimer() {
        if (this.idleTimer) {
            clearTimeout(this.idleTimer);
        }
        const config = getConfig();
        const idleMs = config.runner.idle_timeout_minutes * 60 * 1000;

        // Safety against super short test configs
        if (idleMs > 0) {
            this.idleTimer = setTimeout(() => {
                this.destroy();
            }, idleMs);
        }
    }

    public destroy() {
        if (this.isDestroyed) return;
        this.isDestroyed = true;
        if (this.idleTimer) clearTimeout(this.idleTimer);
    }

    public async run(
        initialMessages: Anthropic.MessageParam[],
        systemPrompt?: string,
        sessionIdOrOnEvent?: string | AgentStreamCallback,
        workspaceIdOrOnEvent?: string | AgentStreamCallback,
        onEvent?: AgentStreamCallback
    ) {
        let sessionId: string | undefined;
        let workspaceId: string | undefined;
        let eventCb: AgentStreamCallback | undefined = onEvent;

        // 兼容旧签名：run(messages, systemPrompt, onEvent)
        if (typeof sessionIdOrOnEvent === 'function') {
            eventCb = sessionIdOrOnEvent;
        } else {
            sessionId = sessionIdOrOnEvent;
            if (typeof workspaceIdOrOnEvent === 'function') {
                // 兼容旧签名：run(messages, systemPrompt, sessionId, onEvent)
                eventCb = workspaceIdOrOnEvent;
            } else {
                workspaceId = workspaceIdOrOnEvent;
            }
        }

        if (this.isDestroyed) {
            if (eventCb) eventCb('error', 'Runner is destroyed');
            return;
        }

        this.poke();
        const config = getConfig();

        // 保存当前会话ID
        this.currentSessionId = sessionId;

        // 维护对话状态
        let messages: Anthropic.MessageParam[] = [...initialMessages];

        // Note: compact 检测已移至 chat.ts 的 buildMessages() 中
        // 在加载历史消息后、追加当前用户消息之前执行

        try {
            const maxRounds = Math.max(1, config.runner.max_rounds ?? 20);
            let terminated = false;

            for (let round = 1; round <= maxRounds; round++) {
                // 调用 Claude 一轮，收集所有 tool_use
                const roundResult = await this.runOnce(messages, systemPrompt, eventCb);
                const callback = eventCb;

                if (roundResult.error) {
                    if (callback) callback('error', roundResult.error);
                    terminated = true;
                    break;
                }

                // 把本轮 assistant 内容加入 messages
                const assistantContent: any[] = [];
                if (roundResult.textBuffer) {
                    assistantContent.push({ type: 'text', text: roundResult.textBuffer });
                }
                for (const tool of roundResult.toolUses) {
                    assistantContent.push({
                        type: 'tool_use',
                        id: tool.id,
                        name: tool.name,
                        input: tool.input,
                    });
                }

                if (assistantContent.length > 0) {
                    messages.push({
                        role: 'assistant',
                        content: assistantContent,
                    });
                }

                // 如果没有工具调用，结束对话；有工具调用则执行工具
                if (roundResult.toolUses.length === 0) {
                    if (callback) callback('done', null);
                    terminated = true;
                    break;
                }

                // 执行本轮所有工具，打包成一条 user message
                const toolResults = await Promise.all(
                    roundResult.toolUses.map(async (tool) => {
                        const result = await this.handleToolCall(tool);
                        console.log(`[AgentRunner] Tool result for ${tool.name}:`, JSON.stringify(result).slice(0, 500));

                        // T-7-HITL-1: 检查是否需要确认
                        console.log('[AgentRunner] Checking requiresConfirmation:', result.requiresConfirmation, 'type:', typeof result.requiresConfirmation);
                        if (result.requiresConfirmation) {
                            // 广播确认请求事件
                            console.log('[AgentRunner] Sending confirmation_requested event:', {
                                tool_use_id: tool.id,
                                confirmationId: result.confirmationId,
                                title: result.confirmationTitle,
                            });
                            if (callback) callback('confirmation_requested', {
                                tool_use_id: tool.id,
                                name: tool.name,
                                confirmationId: result.confirmationId,
                                title: result.confirmationTitle,
                                description: result.confirmationDescription,
                                riskLevel: result.riskLevel,
                            });

                            // 返回确认请求结果
                            return {
                                type: 'tool_result' as const,
                                tool_use_id: tool.id,
                                content: JSON.stringify(result),
                                requiresConfirmation: true,
                            };
                        }

                        if (callback) callback('tool_result', {
                            tool_use_id: tool.id,
                            name: tool.name,
                            result,
                        });
                        const contentStr = JSON.stringify(result);
                        console.log(`[AgentRunner] Tool result stringified length: ${contentStr.length}, preview: ${contentStr.slice(0, 200)}`);
                        return {
                            type: 'tool_result' as const,
                            tool_use_id: tool.id,
                            content: contentStr,
                        };
                    })
                );

                // 检查是否有需要确认的工具调用
                const hasConfirmationPending = toolResults.some(r => r.requiresConfirmation);
                if (hasConfirmationPending) {
                    // 有确认请求，暂停执行，等待用户确认
                    console.log('[AgentRunner] Tool(s) require confirmation, pausing execution');
                    if (callback) callback('done', { confirmationPending: true });
                    terminated = true;
                    break;
                }

                // 所有结果一起发回（一条 user message 包含多个 tool_result）
                messages.push({
                    role: 'user',
                    content: toolResults,
                });

                // 继续下一轮，Claude 拿到所有结果后统一总结
            }

            if (!terminated) {
                const errMsg = `Max rounds (${maxRounds}) reached, stopped to avoid infinite loop`;
                console.warn(`[AgentRunner] ${errMsg}`);
                if (eventCb) eventCb('error', errMsg);
                if (eventCb) eventCb('done', { maxRoundsReached: true, maxRounds });
            }
        } catch (err: any) {
            if (eventCb) eventCb('error', err.message || 'Stream error');
        }

        this.poke();
    }

    /**
     * 清理 messages 数组，确保符合 Anthropic API 要求
     * 1. 第一条必须是 user message
     * 2. tool_result 必须与前一条 assistant 的 tool_use 对齐
     * 3. 对历史脏数据做降级修复，避免请求被网关拒绝
     */
    private sanitizeMessages(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
        if (messages.length === 0) return messages;

        // 1. 第一条必须是 user 消息（支持多模态：text/image/document）
        let startIndex = 0;
        while (startIndex < messages.length) {
            const first = messages[startIndex];
            // 只要是 user role 且 content 有效即可（字符串或数组）
            const isValidUser = first.role === 'user' &&
                (typeof first.content === 'string' ||
                 (Array.isArray(first.content) && first.content.length > 0));
            if (isValidUser) break;
            console.warn('[AgentRunner] dropping invalid first message:', first.role,
                Array.isArray(first.content) ? first.content.map((c: any) => c.type).join(',') : typeof first.content);
            startIndex++;
        }

        // 防御：如果所有消息都被过滤，返回空数组（外层会处理）
        if (startIndex >= messages.length) {
            console.error('[AgentRunner] all messages were filtered, no valid user message found');
            return [];
        }

        const cleaned: Anthropic.MessageParam[] = [];
        let pendingToolUseIds = new Set<string>();

        const stripPendingToolUseFromLastAssistant = () => {
            if (pendingToolUseIds.size === 0 || cleaned.length === 0) return;
            const last = cleaned[cleaned.length - 1] as any;
            if (!last || last.role !== 'assistant' || !Array.isArray(last.content)) {
                pendingToolUseIds.clear();
                return;
            }

            const before = last.content.length;
            last.content = last.content.filter((block: any) => {
                if (block?.type !== 'tool_use') return true;
                return !pendingToolUseIds.has(block.id);
            });
            const removed = before - last.content.length;
            if (removed > 0) {
                console.warn(`[AgentRunner] stripped ${removed} unmatched tool_use block(s) from history`);
            }
            if (last.content.length === 0) {
                cleaned.pop();
            }
            pendingToolUseIds.clear();
        };

        for (let i = startIndex; i < messages.length; i++) {
            const msg: any = messages[i];
            const cloned: any = {
                ...msg,
                content: Array.isArray(msg.content)
                    ? msg.content.map((block: any) => ({ ...block }))
                    : msg.content,
            };

            // assistant 开启新一轮前，若上一轮仍有未匹配 tool_use，则移除残留
            if (cloned.role === 'assistant' && pendingToolUseIds.size > 0) {
                stripPendingToolUseFromLastAssistant();
            }

            if (cloned.role === 'assistant' && Array.isArray(cloned.content)) {
                pendingToolUseIds = new Set(
                    cloned.content
                        .filter((block: any) => block?.type === 'tool_use' && typeof block.id === 'string')
                        .map((block: any) => block.id)
                );
            } else if (cloned.role === 'user' && Array.isArray(cloned.content)) {
                const hasToolResult = cloned.content.some((block: any) => block?.type === 'tool_result');

                if (hasToolResult) {
                    cloned.content = cloned.content.filter((block: any) => {
                        if (block?.type !== 'tool_result') return true;

                        // 没有对应 tool_use，删除孤儿 tool_result
                        if (pendingToolUseIds.size === 0) return false;

                        // 仅保留和上一条 assistant tool_use 对齐的结果
                        if (pendingToolUseIds.has(block.tool_use_id)) {
                            pendingToolUseIds.delete(block.tool_use_id);
                            return true;
                        }
                        return false;
                    });

                    if (cloned.content.length === 0) {
                        console.warn('[AgentRunner] dropping orphan tool_result-only message');
                        continue;
                    }
                } else if (pendingToolUseIds.size > 0) {
                    // user 文本已到来但缺少 tool_result，剥离上一条 assistant 的残留 tool_use
                    stripPendingToolUseFromLastAssistant();
                }
            } else if (cloned.role === 'user' && pendingToolUseIds.size > 0) {
                // user string 消息，且缺少 tool_result
                stripPendingToolUseFromLastAssistant();
            }

            cleaned.push(cloned);
        }

        // 末尾 assistant 存在未匹配 tool_use 时，兜底剥离
        if (pendingToolUseIds.size > 0) {
            stripPendingToolUseFromLastAssistant();
        }

        return cleaned;
    }

    /**
     * 调用 Claude 一轮，收集所有 content blocks 和 tool_use
     */
    private async runOnce(
        messages: Anthropic.MessageParam[],
        systemPrompt?: string,
        onEvent?: AgentStreamCallback
    ): Promise<{
        textBuffer: string;
        toolUses: PendingToolUse[];
        stopReason: string;
        error?: string;
    }> {
        const config = getConfig();

        // 清理 messages，确保符合 API 要求
        const safeMsgs = this.sanitizeMessages(messages);
        if (safeMsgs.length !== messages.length) {
            console.log(`[AgentRunner] sanitized: ${messages.length} → ${safeMsgs.length} messages`);
        }

        // 防御：如果原始消息不为空但清理后为空，说明过滤过度，返回错误
        if (messages.length > 0 && safeMsgs.length === 0) {
            console.error('[AgentRunner] all messages were filtered by sanitization');
            return { textBuffer: '', toolUses: [], stopReason: 'error', error: 'No valid messages to send after sanitization' };
        }

        // 日志：打印完整 context 的实际内容（用于诊断 blocks count: 0 问题）
        console.log('[AgentRunner] Full context:', JSON.stringify(safeMsgs, null, 2));

        // 额外检查：确保消息格式合法
        for (let i = 0; i < safeMsgs.length; i++) {
            const msg = safeMsgs[i];
            // 检查连续 assistant 消息
            if (i > 0 && msg.role === 'assistant' && safeMsgs[i-1].role === 'assistant') {
                console.error(`[AgentRunner] Invalid: consecutive assistant messages at index ${i-1} and ${i}`);
            }
            // 检查空 content 数组
            if (Array.isArray(msg.content) && msg.content.length === 0) {
                console.error(`[AgentRunner] Invalid: empty content array at index ${i}`);
            }
        }
        // 检查第一条消息
        if (safeMsgs.length > 0 && safeMsgs[0].role !== 'user') {
            console.error(`[AgentRunner] Invalid: first message is not user, got ${safeMsgs[0].role}`);
        }

        // 日志：打印发送给 Claude 的 messages 摘要
        const msgSummary = safeMsgs.map((m: any) => ({
            role: m.role,
            type: Array.isArray(m.content) ? m.content.map((c: any) => c.type).join(',') : 'text',
            len: JSON.stringify(m.content).length
        }));
        console.log('[AgentRunner] Sending to Claude:', JSON.stringify(msgSummary));

        const stream = await this.client.messages.create({
            model: config.claude.model,
            max_tokens: config.claude.max_tokens,
            system: systemPrompt,
            messages: safeMsgs,
            tools: getToolDefinitions(),
            stream: true,
        });

        const toolUses: PendingToolUse[] = [];
        let currentTool: PendingToolUse | null = null;
        let textBuffer = '';
        let stopReason = 'end_turn';

        for await (const chunk of stream) {
            if (this.isDestroyed) {
                stream.controller.abort();
                return { textBuffer, toolUses, stopReason, error: 'Runner aborted mid-stream' };
            }

            if (chunk.type === 'content_block_start') {
                if (chunk.content_block.type === 'tool_use') {
                    currentTool = {
                        id: chunk.content_block.id,
                        name: chunk.content_block.name,
                        inputJson: '',
                    };
                }
            } else if (chunk.type === 'content_block_delta') {
                if (chunk.delta.type === 'text_delta') {
                    textBuffer += chunk.delta.text;
                    if (onEvent) onEvent('text', chunk.delta.text);
                } else if (chunk.delta.type === 'input_json_delta' && currentTool) {
                    currentTool.inputJson += chunk.delta.partial_json;
                }
            } else if (chunk.type === 'content_block_stop') {
                if (currentTool) {
                    // 解析 tool_use 的 input
                    try {
                        currentTool.input = currentTool.inputJson ? JSON.parse(currentTool.inputJson) : {};
                    } catch (e) {
                        console.error('[AgentRunner] Failed to parse tool input JSON:', currentTool.inputJson, e);
                        currentTool.input = {};
                    }
                    // 发送 tool_call 事件给前端
                    if (onEvent) onEvent('tool_call', {
                        tool_use_id: currentTool.id,
                        name: currentTool.name,
                        input: currentTool.input,
                    });
                    toolUses.push(currentTool);
                    currentTool = null;
                }
            } else if (chunk.type === 'message_stop') {
                stopReason = (chunk as any).stop_reason || 'end_turn';
                break;
            } else if (chunk.type === 'message_delta') {
                // 发送 usage 事件
                const usage = (chunk as any).usage;
                console.log('[AgentRunner] message_delta event, usage:', JSON.stringify(usage));
                if (usage && onEvent) {
                    onEvent('usage', {
                        input_tokens: usage.input_tokens,
                        output_tokens: usage.output_tokens,
                    });
                }
            }
        }

        // 检测空响应（用于诊断 blocks count: 0 问题）
        if (textBuffer === '' && toolUses.length === 0) {
            console.error('[AgentRunner] Empty response detected:', {
                stopReason,
                textBufferLength: textBuffer.length,
                toolUseCount: toolUses.length,
                lastMessageRole: safeMsgs.length > 0 ? safeMsgs[safeMsgs.length - 1]?.role : 'none',
                messageCount: safeMsgs.length
            });
        }

        return { textBuffer, toolUses, stopReason };
    }

    /**
     * 处理工具调用
     */
    private async handleToolCall(toolUse: PendingToolUse): Promise<any> {
        const { name, input, id } = toolUse;

        console.log(`[AgentRunner] Tool call: ${name}, input:`, JSON.stringify(input));

        // 使用 Tool Registry 执行工具
        const result = await executeTool(name, input, {
            workspaceId: this.workspaceId,
            sessionId: this.currentSessionId,
            toolUseId: id,
        });

        // T-7-HITL-1: 处理需要确认的情况
        if (result.requiresConfirmation) {
            return {
                success: false,
                requiresConfirmation: true,
                confirmationId: result.confirmationId,
                confirmationTitle: result.confirmationTitle,
                confirmationDescription: result.confirmationDescription,
                riskLevel: result.riskLevel,
                error: result.error || '此操作需要人工确认',
            };
        }

        // 转换格式：确保返回的 result 包含 success 字段
        if (!result.success) {
            return {
                success: false,
                error: result.error,
                ...(result.data || {})
            };
        }

        return {
            success: true,
            ...result.data
        };
    }
}

// Global registry of runners to prevent duplicate instantations
const runners = new Map<string, AgentRunner>();

export const getRunner = (workspaceId: string, onEvent: AgentStreamCallback): AgentRunner => {
    let runner = runners.get(workspaceId);
    if (!runner || runner['isDestroyed']) {
        runner = new AgentRunner({ workspaceId, onEvent });
        runners.set(workspaceId, runner);
    } else {
        // If it exists, extend its lifecycle
        runner.poke();
    }
    return runner;
};

/**
 * 清理已销毁的 runner，防止 Map 无限增长
 * 可由外部定时调用或在 getRunner 时惰性调用
 */
export const cleanupDestroyedRunners = (): number => {
    let cleanedCount = 0;
    for (const [workspaceId, runner] of runners.entries()) {
        if (runner['isDestroyed']) {
            runners.delete(workspaceId);
            cleanedCount++;
        }
    }
    if (cleanedCount > 0) {
        console.log(`[AgentRunner] Cleaned up ${cleanedCount} destroyed runner(s)`);
    }
    return cleanedCount;
};

export const clearRunners = () => {
    for (const runner of runners.values()) {
        runner.destroy();
    }
    runners.clear();
};

// 获取 Runner 状态（用于 dashboard）
export const getRunnerStatus = (): {
    status: 'ok' | 'warn' | 'error';
    activeCount: number;
    queueSize: number;
} => {
    let activeCount = 0;
    for (const [, runner] of runners) {
        if (!(runner as any).isDestroyed) {
            activeCount++;
        }
    }
    // 检查队列大小（如果有队列管理）
    const queueSize = (global as any).__runnerQueue?.length || 0;
    return {
        status: 'ok',
        activeCount,
        queueSize,
    };
};
