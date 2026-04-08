/**
 * Message Processor 模块
 * 统一消息处理入口，所有渠道消息汇聚到同一处理链路
 *
 * @module src/services/message-processor
 */

import { randomUUID } from 'crypto';
import { getDb } from '../db';
import { workspaceLock } from './workspace-lock';
import { getRunner, AgentStreamCallback } from './agent-runner';
import { buildWorkspaceConfigPrompt } from './workspace-config';
import { needsRecall, searchHistory, insertMessageFts } from './recall';
import { archiveSession } from './archiver';
import { channelManager, ChannelMessage } from '../channels';
import { Command } from '../channels/base';
import { webSocketChannel, clearTokenBuffer } from '../channels/websocket';
import { serializeContent, buildMessagesForSession } from './chat-messages';
import { broadcastToWorkspace } from '../routes/chat';
import { indexMessage } from './message-indexer';
import { deliveryQueue } from './channel-delivery';
import { logger } from './logger';

/**
 * 构建 System Prompt
 * 注入优先级：工作区记忆 > 用户偏好 > Recall（按需）
 */
export async function buildSystemPrompt(
    workspaceId: string,
    userContent: string,
    notifyTarget?: any
): Promise<string> {
    const workspaceConfigPrompt = buildWorkspaceConfigPrompt(workspaceId);
    const systemPromptParts: string[] = [];

    // 1. Recall 历史记录搜索提示 + 记忆工具提示
    systemPromptParts.push(`
---工具使用提示---
如果用户提到之前的对话内容（如"之前说的"、"上次讨论的"），使用 recall 工具搜索历史记录。
如需了解项目背景或用户偏好，使用 read_workspace_memory 和 read_impression 工具。`);

    // 2. 工作区配置（IDENTITY.md + USER.md + TOOLS.md）
    if (workspaceConfigPrompt) {
        systemPromptParts.push(workspaceConfigPrompt);
    }

    // 3. 技能目录 (Skill Catalog)
    const { getSkillCatalog } = await import('./tools/skill');
    const skillCatalog = getSkillCatalog(workspaceId);
    if (skillCatalog) {
        systemPromptParts.push(`
## Skill Catalog（自动注入）
以下是系统已发现的可用技能目录（技能名：一句话摘要）：
${skillCatalog}

当任务与某个技能匹配时，先调用 read_skill({"name":"<技能名>"}) 读取完整指南，再执行具体操作。
不要凭记忆猜测技能内容。`);
    }

    // 4. 基础角色定义
    systemPromptParts.push('You are a helpful personal assistant.');

    // 5. 行为约束
    systemPromptParts.push(`
---
重要行为约束：
1. 执行工具前不要预测或猜测结果
2. 必须先调用工具，拿到真实结果后再总结
3. 正确格式：「我来执行xxx」→ [调用工具] → 「结果如下：[真实数据]」
4. 错误格式：「结果如下：[猜测数据]」→ [调用工具]（这是不允许的）
---`);

    // 6. 消息来源（如果有）
    if (notifyTarget) {
        systemPromptParts.push(`\n\n当前消息来源：${JSON.stringify(notifyTarget)}`);
    }

    // 7. 深度研究模式检测（当用户消息包含深度研究指令时）
    // deep_research 是真工具，支持三种模式
    if (userContent && userContent.includes('deep_research')) {
        systemPromptParts.push(`
---
【深度研究模式】
deep_research 工具支持三种模式：
- web：网络深度研究（默认），执行多轮搜索和内容抓取
- codebase：分析当前工作区代码，调用 Claude Code 进行架构分析
- github：分析 GitHub 项目，支持快速分析和深度分析（含 clone）

用户请求使用 deep_research 工具时，请：
1. 根据用户意图选择合适的 mode（web/codebase/github）
2. 调用 deep_research 工具，传入用户的具体研究主题和相关参数
3. 等待工具返回聚合后的真实研究数据
4. 基于真实数据（而非猜测）生成完整报告
5. 报告中必须引用具体的 URL、数据或代码片段

重要：deep_research 工具会执行真实的搜索、代码分析或项目分析，请信任并基于返回的数据生成报告。`);
    }

    return systemPromptParts.join('\n');
}

/**
 * 发送回复到渠道
 */
async function sendReply(
    channelId: string,
    content: string,
    target?: any
): Promise<void> {
    const channel = channelManager.get(channelId);
    if (!channel) {
        console.warn(`[Processor] Channel ${channelId} not found`);
        return;
    }

    await channel.sendMessage(content, { target });
}

/**
 * 处理系统指令
 * @returns 是否是指令（true 表示已处理，不需要进入 AgentRunner）
 */
async function handleCommand(
    msg: ChannelMessage,
    workspaceId: string
): Promise<boolean> {
    const text = msg.content.trim();
    const db = getDb();

    // /help - 显示可用指令列表
    if (text === '/help') {
        const helpText = `可用指令：
/workspace {name} 或 切换工作区 {name} - 切换工作区
/recall {query} - 手动触发历史搜索
/archive - 手动归档当前会话
修复 - 修复最近的严重告警
忽略 - 忽略最近的严重告警
调整 - 调整检测脚本（需先「忽略」告警）
/help - 显示此帮助信息`;

        if (msg.raw?.chatId) {
            // 飞书渠道
            const { larkChannel } = await import('../channels/lark');
            await larkChannel.sendMessage(helpText, {
                target: { channel: 'lark', chat_id: msg.raw.chatId, message_id: msg.channelMessageId }
            });
        } else {
            // WebSocket 渠道
            await webSocketChannel.sendMessage(helpText, { target: workspaceId });
        }
        return true;
    }

    // /workspace {name} 或 切换工作区 {name} - 切换工作区
    const workspaceMatch = text.match(/^\/workspace\s+(\S+)$/i) ||
                           text.match(/^切换工作区\s+(\S+)$/i);
    if (workspaceMatch) {
        const wsName = workspaceMatch[1];
        const targetWs = db.prepare('SELECT id FROM workspaces WHERE name = ? AND status = ?').get(wsName, 'active') as any;

        if (targetWs) {
            // 更新 chat_workspace_map（通过 LarkChannel 的映射）
            if (msg.raw?.chatId) {
                const { larkChannel } = await import('../channels/lark');
                (larkChannel as any).chatWorkspaceMap?.set(msg.raw.chatId, targetWs.id);
            }

            const replyText = `已切换到工作区「${wsName}」`;
            if (msg.raw?.chatId) {
                await sendReply('lark', replyText, { channel: 'lark', chat_id: msg.raw.chatId, message_id: msg.channelMessageId });
            } else {
                await webSocketChannel.sendMessage(replyText, { target: workspaceId });
            }
        } else {
            const replyText = `未找到工作区「${wsName}」`;
            if (msg.raw?.chatId) {
                await sendReply('lark', replyText, { channel: 'lark', chat_id: msg.raw.chatId, message_id: msg.channelMessageId });
            } else {
                await webSocketChannel.sendMessage(replyText, { target: workspaceId });
            }
        }
        return true;
    }

    // /recall {query} - 手动触发历史搜索
    const recallMatch = text.match(/^\/recall\s+(.+)$/i);
    if (recallMatch) {
        const query = recallMatch[1];
        const result = searchHistory(workspaceId, query);

        let replyText: string;
        if (result.found === 0) {
            replyText = '未找到相关历史记录';
        } else {
            const sections = result.results.map(r =>
                `[${r.date} ${r.role}] ${r.content.slice(0, 200)}${r.content.length > 200 ? '...' : ''}`
            );
            replyText = '---相关历史记录---\n' + sections.join('\n---\n');
        }

        if (msg.raw?.chatId) {
            await sendReply('lark', replyText, { channel: 'lark', chat_id: msg.raw.chatId, message_id: msg.channelMessageId });
        } else {
            await webSocketChannel.sendMessage(replyText, { target: workspaceId });
        }
        return true;
    }

    // /archive - 手动归档当前会话
    if (text === '/archive') {
        if (!msg.sessionId) {
            const replyText = '无法确定当前会话';
            if (msg.raw?.chatId) {
                await sendReply('lark', replyText, { channel: 'lark', chat_id: msg.raw.chatId, message_id: msg.channelMessageId });
            } else {
                await webSocketChannel.sendMessage(replyText, { target: workspaceId });
            }
            return true;
        }

        const result = await archiveSession(msg.sessionId, workspaceId);
        let replyText: string;

        if (result.success) {
            if (result.skipped) {
                replyText = result.reason === 'already_archived'
                    ? '当前会话已归档，无需重复操作'
                    : '消息太少，无需归档';
            } else {
                replyText = `会话已归档（摘要 ${result.tokens} tokens）`;
            }
        } else {
            replyText = `归档失败：${result.reason}`;
        }

        if (msg.raw?.chatId) {
            await sendReply('lark', replyText, { channel: 'lark', chat_id: msg.raw.chatId, message_id: msg.channelMessageId });
        } else {
            await webSocketChannel.sendMessage(replyText, { target: workspaceId });
        }
        return true;
    }

    // ===== 告警指令处理 =====
    const alertReplyMatch = text.match(/^(修复|忽略|调整)$/);
    if (alertReplyMatch) {
        const command = alertReplyMatch[1];
        const { attemptFix, ignoreAlert, adjustScript, getLatestCriticalAlert, updatePendingScriptAdjust } = await import('./alert-handler');

        // 查询最近的通知中 critical 告警
        const latestAlert = await getLatestCriticalAlert(workspaceId);

        if (!latestAlert) {
            const replyText = '当前没有待处理的严重告警';
            if (msg.raw?.chatId) {
                await sendReply('lark', replyText, { channel: 'lark', chat_id: msg.raw.chatId, message_id: msg.channelMessageId });
            } else {
                await webSocketChannel.sendMessage(replyText, { target: workspaceId });
            }
            return true;
        }

        if (command === '修复') {
            // 触发修复
            await attemptFix(latestAlert.id, workspaceId);
            const replyText = `已开始修复告警 ${latestAlert.id.slice(0, 8)}，请稍后查看结果`;
            if (msg.raw?.chatId) {
                await sendReply('lark', replyText, { channel: 'lark', chat_id: msg.raw.chatId, message_id: msg.channelMessageId });
            } else {
                await webSocketChannel.sendMessage(replyText, { target: workspaceId });
            }
            return true;
        }

        if (command === '忽略') {
            // 忽略告警，询问是否调整脚本
            await ignoreAlert(latestAlert.id, workspaceId);
            const replyText = `已忽略告警 ${latestAlert.id.slice(0, 8)}\n\n是否调整检测脚本以避免重复告警？\n回复「调整」开始调整，回复「不用」保持现状`;
            if (msg.raw?.chatId) {
                await sendReply('lark', replyText, { channel: 'lark', chat_id: msg.raw.chatId, message_id: msg.channelMessageId });
            } else {
                await webSocketChannel.sendMessage(replyText, { target: workspaceId });
            }
            return true;
        }

        if (command === '调整') {
            // 检查是否有标记了 pending_script_adjust 的告警
            const pendingAlert = await getLatestCriticalAlert(workspaceId, true);
            if (pendingAlert && pendingAlert.pending_script_adjust) {
                await adjustScript(pendingAlert.id, workspaceId);
                const replyText = `开始调整检测脚本，告警 ${pendingAlert.id.slice(0, 8)}`;
                if (msg.raw?.chatId) {
                    await sendReply('lark', replyText, { channel: 'lark', chat_id: msg.raw.chatId, message_id: msg.channelMessageId });
                } else {
                    await webSocketChannel.sendMessage(replyText, { target: workspaceId });
                }
            } else {
                const replyText = '没有找到需要调整脚本的告警，请先「忽略」一个告警';
                if (msg.raw?.chatId) {
                    await sendReply('lark', replyText, { channel: 'lark', chat_id: msg.raw.chatId, message_id: msg.channelMessageId });
                } else {
                    await webSocketChannel.sendMessage(replyText, { target: workspaceId });
                }
            }
            return true;
        }
    }

    return false;
}

/**
 * 处理结构化命令（来自各渠道的统一命令格式）
 * @returns 是否已处理
 */
async function handleCommandByType(
    cmd: Command,
    msg: ChannelMessage,
    workspaceId: string
): Promise<boolean> {
    const db = getDb();

    switch (cmd.type) {
        case 'workspace_switch': {
            // /ws 切换工作区
            const wsName = cmd.args?.trim();
            if (!wsName) {
                await replyToMessage(msg, '用法：/ws <工作区名称>');
                return true;
            }
            const targetWs = db.prepare(
                'SELECT id, name FROM workspaces WHERE name = ? AND status = ?'
            ).get(wsName, 'active') as { id: string; name: string } | undefined;
            if (targetWs) {
                // 更新渠道特定的工作区映射
                if (msg.raw?.chatId) {
                    // 飞书：更新 chatWorkspaceMap
                    const { larkChannel } = await import('../channels/lark');
                    (larkChannel as any).chatWorkspaceMap?.set(msg.raw.chatId, targetWs.id);
                } else if (msg.raw?.accountId) {
                    // 微信：更新 senderWorkspaceMap
                    const { weixinChannel } = await import('../channels/weixin');
                    if (msg.senderId) {
                        (weixinChannel as any).senderWorkspaceMap?.set(msg.senderId, targetWs.id);
                    }
                }
                await replyToMessage(msg, `✅ 已切换到工作区「${targetWs.name}」`);
            } else {
                await replyToMessage(msg, `❌ 未找到工作区「${wsName}」`);
            }
            return true;
        }

        case 'workspace_list': {
            // /workspaces 列出所有工作区
            const workspaces = db.prepare(
                'SELECT name FROM workspaces WHERE status = ? ORDER BY name'
            ).all('active') as { name: string }[];
            const list = workspaces.map(w => `• ${w.name}`).join('\n');
            await replyToMessage(msg, `📋 可用工作区：\n\n${list || '（无）'}\n\n输入 /ws <名称> 切换`);
            return true;
        }

        case 'help': {
            // /help 帮助
            const helpText = `📖 助手命令：

/ws <名称> - 切换工作区
/workspaces - 列出所有工作区
/recall <关键词> - 搜索历史记录
/archive - 手动归档当前会话
/help - 显示此帮助

其他问题将转发给 AI 助手处理。`;
            await replyToMessage(msg, helpText);
            return true;
        }

        case 'terminal_block': {
            // /terminal 等终端命令拦截
            await replyToMessage(msg, '⚠️ 终端操作请前往 Web 界面。');
            return true;
        }
    }

    return false;
}

/**
 * 处理交互按钮点击
 * 将 actionId 转换为对应文本指令处理
 */
async function handleActionButton(
    msg: ChannelMessage,
    workspaceId: string
): Promise<boolean> {
    if (!msg.actionId) return false;

    // 根据 actionId 执行相应操作
    switch (msg.actionId) {
        case 'confirm_fix':
            // 触发修复流程
            if (msg.actionData?.alertId) {
                const { attemptFix } = await import('./alert-handler');
                await attemptFix(msg.actionData.alertId, workspaceId);
                return true;
            }
            break;

        case 'ignore_alert':
            // 忽略告警
            if (msg.actionData?.alertId) {
                const { ignoreAlert } = await import('./alert-handler');
                await ignoreAlert(msg.actionData.alertId, workspaceId);
                return true;
            }
            break;

        // 可以扩展更多 actionId 处理
    }

    return false;
}

/**
 * 运行 Agent 任务（从渠道调用）
 * 这是 chat.ts runAgentTask 的渠道适配版本
 */
async function runAgentTaskForChannel(
    sessionId: string,
    workspaceId: string,
    userContent: string,
    msg: ChannelMessage
): Promise<void> {
    const db = getDb();

    // Stream buffer for incremental saves
    let streamBuffer = '';
    let lastSaveTime = Date.now();
    const SAVE_INTERVAL_MS = 1500;

    // 预插入助手占位消息（created_at = now + 1，确保在 user 消息之后）
    const assistantMsgId = randomUUID();
    const now = Date.now();
    db.prepare(
        `INSERT INTO messages (id, session_id, workspace_id, user_id, role, content, status, streaming_content, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'streaming', '', ?)`
    ).run(assistantMsgId, sessionId, workspaceId, 'owner', 'assistant', '', now + 1);

    // 写入用户消息
    const userMsgId = randomUUID();
    db.prepare(
        'INSERT INTO messages (id, session_id, workspace_id, user_id, role, content, message_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(userMsgId, sessionId, workspaceId, 'owner', 'user', userContent, msg.channelMessageId || null, now);

    // 同步插入用户消息到 messages_fts（用于 Recall 全文检索作为降级）
    insertMessageFts(userMsgId, sessionId, workspaceId, 'user', userContent, now);

    // 异步生成向量 embedding（不 await，不阻塞主流程）
    indexMessage(userMsgId, workspaceId, sessionId, userContent, 'user')
        .catch(() => {}); // 静默降级

    // 更新会话活跃时间
    const title = userContent.slice(0, 20);
    db.prepare(
        "UPDATE sessions SET last_active_at = ?, title = COALESCE(NULLIF(title, ''), ?) WHERE id = ?"
    ).run(now, title, sessionId);

    // 排队提示
    const lockStatus = workspaceLock.getQueuePosition?.(workspaceId) ?? 0;
    if (lockStatus > 0) {
        const queueMsg = `正在处理中，已排队第 ${lockStatus} 位...`;
        if (msg.raw?.chatId) {
            await sendReply('lark', queueMsg, { channel: 'lark', chat_id: msg.raw.chatId, message_id: msg.channelMessageId });
        }
    }

    const release = await workspaceLock.acquire(workspaceId);

    try {
        // 构建消息列表
        const anthropicMsgs = await buildMessagesForSession(sessionId, workspaceId, {
            logPrefix: 'Processor',
            onEvent: (type, payload) => {
                if (type === 'compact_start' || type === 'compact_done') {
                    broadcastToWorkspace(workspaceId, { type, payload });
                }
            },
        });

        // 构建 system prompt
        const notifyTarget = msg.raw?.chatId ? {
            channel: 'lark',
            chat_id: msg.raw.chatId,
            user_open_id: msg.senderId,
            is_group: msg.isGroup,
            message_id: msg.channelMessageId,
        } : undefined;

        const systemPrompt = await buildSystemPrompt(workspaceId, userContent, notifyTarget);

        // Content blocks collection
        const assistantContentBlocks: any[] = [];
        const toolResultBlocks: any[] = [];
        let currentText = '';
        let runtimeError: string | null = null;
        let inputTokens = 0;
        let outputTokens = 0;

        const onEvent: AgentStreamCallback = (type, payload) => {
            // 广播到 WebSocket 客户端
            broadcastToWorkspace(workspaceId, { type, payload });

            if (type === 'text') {
                streamBuffer += payload;
                currentText += payload;

                const now = Date.now();
                if (now - lastSaveTime >= SAVE_INTERVAL_MS) {
                    updateStreamingContent(assistantMsgId, streamBuffer);
                    lastSaveTime = now;
                }
            } else if (type === 'tool_call') {
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
            } else if (type === 'error') {
                console.error(`[Processor] Error event received:`, payload);
                runtimeError = typeof payload === 'string' ? payload : JSON.stringify(payload);
            } else if (type === 'usage') {
                inputTokens = payload?.input_tokens ?? 0;
                outputTokens = payload?.output_tokens ?? 0;
            }
        };

        const runner = getRunner(workspaceId, onEvent);
        const startTime = Date.now();

        // 运行 Agent
        await runner.run(anthropicMsgs, systemPrompt, sessionId, workspaceId, onEvent);

        const duration = Date.now() - startTime;

        // 保存最终文本块
        if (currentText) {
            assistantContentBlocks.push({ type: 'text', text: currentText });
        }

        // 完成助手消息
        if (assistantContentBlocks.length > 0) {
            finalizeMessage(assistantMsgId, assistantContentBlocks, sessionId, workspaceId, 'assistant');
        } else {
            if (runtimeError) {
                finalizeMessage(
                    assistantMsgId,
                    [{ type: 'text', text: `执行失败：${runtimeError}` }],
                    sessionId,
                    workspaceId,
                    'assistant'
                );
            } else {
                db.prepare(
                    `UPDATE messages SET status = 'complete', streaming_content = NULL WHERE id = ?`
                ).run(assistantMsgId);
            }
        }

        // 保存工具结果
        for (const block of toolResultBlocks) {
            const toolResultMsgId = randomUUID();
            db.prepare(
                'INSERT INTO messages (id, session_id, workspace_id, user_id, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
            ).run(toolResultMsgId, sessionId, workspaceId, 'owner', 'user', serializeContent([block]), Date.now());
        }

        // 更新会话活跃时间
        db.prepare('UPDATE sessions SET last_active_at = ? WHERE id = ?').run(Date.now(), sessionId);

        // 记录 SDK 调用
        db.prepare(
            'INSERT INTO sdk_calls (id, session_id, workspace_id, user_id, model, input_tokens, output_tokens, duration_ms, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        ).run(randomUUID(), sessionId, workspaceId, 'owner', 'claude', inputTokens, outputTokens, duration, 'success', Date.now());

        // 回复渠道（统一通过 deliveryQueue 可靠投递）
        const replyContent = streamBuffer.trim() || '[处理完成，无返回内容]';

        if (msg.raw?.accountId) {
            // 微信：通过 deliveryQueue 可靠发送（带重试）
            deliveryQueue.enqueue({
                sessionId,
                channelType: 'weixin',
                senderId: msg.raw.senderId || '',
                botToken: msg.raw.botToken,
                contextToken: msg.raw.contextToken,
                workspaceId,
            });
        } else if (msg.raw?.chatId) {
            // 飞书：通过 deliveryQueue 可靠发送（带重试）
            deliveryQueue.enqueue({
                sessionId,
                channelType: 'lark',
                senderId: msg.senderId || '',
                messageId: msg.channelMessageId,
                chatId: msg.raw.chatId,
                workspaceId,
            });
        } else {
            // WebSocket：直接发送（无重试需求）
            await sendReply('lark', replyContent);
        }

    } catch (e: any) {
        console.error('[Processor] Agent task failed:', e);

        markMessageInterrupted(assistantMsgId, streamBuffer, sessionId, workspaceId, 'assistant');

        db.prepare(
            'INSERT INTO sdk_calls (id, session_id, workspace_id, user_id, model, status, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        ).run(randomUUID(), sessionId, workspaceId, 'owner', 'claude', 'error', e.message || 'Error', Date.now());

        broadcastToWorkspace(workspaceId, { type: 'error', payload: e.message || 'Execution Error' });

        // WebSocket 错误通知（微信/飞书错误由 deliveryQueue 在全部重试失败后发送提示）
        const errorMsg = `执行错误：${e.message}`;
        if (!msg.raw?.accountId && !msg.raw?.chatId) {
            await sendReply('lark', errorMsg);
        }
    } finally {
        // 确保 token 缓存被清空（即使出错）
        if (workspaceId) {
            clearTokenBuffer(workspaceId);
        }
        release();
    }
}

/**
 * 更新流式内容
 */
function updateStreamingContent(msgId: string, content: string): void {
    const db = getDb();
    db.prepare('UPDATE messages SET streaming_content = ? WHERE id = ?').run(content, msgId);
}

/**
 * 完成消息
 */
function finalizeMessage(msgId: string, contentBlocks: any[], sessionId?: string, workspaceId?: string, role?: string): void {
    const db = getDb();
    const content = serializeContent(contentBlocks);
    db.prepare(
        `UPDATE messages SET content = ?, streaming_content = NULL, status = 'complete' WHERE id = ?`
    ).run(content, msgId);

    // 清空该工作区的 token 缓存（消息已完成）
    if (workspaceId) {
        clearTokenBuffer(workspaceId);
    }

    // 同步插入到 messages_fts（只索引用户消息）
    if (sessionId && workspaceId && role === 'user') {
        insertMessageFts(msgId, sessionId, workspaceId, role, content, Date.now());
    }
}

/**
 * 标记消息中断
 */
function markMessageInterrupted(msgId: string, partialContent: string, sessionId?: string, workspaceId?: string, role?: string): void {
    const db = getDb();
    const content = partialContent || '';
    const serialized = serializeContent([{ type: 'text', text: content }]);
    db.prepare(
        `UPDATE messages SET content = ?, streaming_content = NULL, status = 'interrupted' WHERE id = ?`
    ).run(serialized, msgId);

    // 同步插入到 messages_fts（只索引用户消息）
    if (sessionId && workspaceId && role === 'user') {
        insertMessageFts(msgId, sessionId, workspaceId, role, serialized, Date.now());
    }
}

/**
 * 统一回复函数 - 支持所有渠道
 */
async function replyToMessage(msg: ChannelMessage, text: string): Promise<void> {
    if (msg.raw?.chatId) {
        // 飞书渠道
        await sendReply('lark', text, { channel: 'lark', chat_id: msg.raw.chatId, message_id: msg.channelMessageId });
    } else if (msg.raw?.accountId && msg.raw?.botToken) {
        // 微信渠道
        const { sendTextMessage } = await import('../services/weixin/ilink-api');
        await sendTextMessage(
            msg.raw.botToken,
            msg.raw.senderId,
            text,
            msg.raw.contextToken
        );
    } else {
        // WebSocket 渠道
        await webSocketChannel.sendMessage(text, { target: msg.workspaceId });
    }
}

/**
 * 统一消息处理入口
 * 所有渠道的消息都通过这个函数处理
 *
 * @param msg 统一消息结构
 * @param workspaceId 工作区ID
 */
export async function processChannelMessage(
    msg: ChannelMessage,
    workspaceId: string
): Promise<void> {
    console.log(`[Processor] Processing message from ${msg.senderId || 'unknown'}, workspace: ${workspaceId}`);

    // Log channel message received
    const channelName = msg.raw?.chatId ? 'lark' : msg.raw?.accountId ? 'weixin' : 'websocket';
    logger.system.info('channel', `Message received from ${msg.senderId || 'unknown'}`, { workspaceId, channel: channelName, contentLength: msg.content?.length || 0 });

    // 0. 命令消息优先处理（来自各渠道的统一命令）
    if (msg.command) {
        const handled = await handleCommandByType(msg.command, msg, workspaceId);
        if (handled) return;
    }

    // 1. 交互按钮检测（优先级最高，如果是指令或按钮操作则直接返回）
    if (msg.actionId) {
        const handled = await handleActionButton(msg, workspaceId);
        if (handled) return;
    }

    // 2. 指令检测（基于文本的命令）
    const isCommand = await handleCommand(msg, workspaceId);
    if (isCommand) {
        console.log('[Processor] Command handled, skipping AgentRunner');
        return;
    }

    // 3. 拦截终端命令（安全考虑）
    const text = msg.content.trim();
    if (text.startsWith('/terminal') || text.startsWith('/bash')) {
        await replyToMessage(msg, '请前往 Web 终端面板进行系统级操作。');
        return;
    }

    // 4. 调用 AgentRunner 处理
    if (!msg.sessionId) {
        console.error('[Processor] Missing sessionId');
        await replyToMessage(msg, '系统错误：无法确定会话');
        return;
    }

    await runAgentTaskForChannel(msg.sessionId, workspaceId, msg.content, msg);
}
