import * as lark from '@larksuiteoapi/node-sdk';
import axios from 'axios';
import { getConfig } from '../config';
import { getDb } from '../db';
import { workspaceLock } from './workspace-lock';
import { NotifyTarget } from '../types';
import { randomUUID } from 'crypto';
import { larkChannel, ChannelMessage } from '../channels';
import { processChannelMessage } from './message-processor';
import { buildWorkspaceConfigPrompt } from './workspace-config';
import { AgentStreamCallback, getRunner } from './agent-runner';

const LARK_MAX_MSG_LENGTH = 28000;
const LARK_RETRY_DELAYS = [1000, 2000, 3000];

let wsClient: lark.WSClient | null = null;
let larkClient: lark.Client | null = null;

// 工作区路由映射：chatId -> workspaceId
const chatWorkspaceMap = new Map<string, string>();

// ═══════════════════════════════════════════════════════════════
// 兼容层：以下函数保留供现有代码调用，内部转发到 LarkChannel
// ═══════════════════════════════════════════════════════════════

// ── 重试工具函数 ────────────────────────────────────────────────

/**
 * 带指数退避的重试执行
 */
async function withRetry<T>(
    fn: () => Promise<T>,
    operationName: string,
    retries = 3
): Promise<T> {
    let lastError: any;

    for (let i = 0; i < retries; i++) {
        try {
            return await fn();
        } catch (err: any) {
            lastError = err;
            const isLastAttempt = i === retries - 1;

            // 网络错误（ECONNRESET, ETIMEDOUT 等）才重试
            const isNetworkError = err.code === 'ECONNRESET'
                || err.code === 'ETIMEDOUT'
                || err.code === 'ECONNREFUSED'
                || err.message?.includes('tenant_access_token');

            if (isLastAttempt || !isNetworkError) {
                throw err;
            }

            const delay = LARK_RETRY_DELAYS[i] || 3000;
            console.warn(`[Lark] ${operationName} failed (attempt ${i + 1}/${retries}): ${err.message}. Retrying in ${delay}ms...`);
            await new Promise(r => setTimeout(r, delay));
        }
    }

    throw lastError;
}

// ── 工具函数：获取 access_token ─────────────────────────────────

/**
 * 获取飞书 tenant_access_token（用于直接调用 HTTP API）
 */
async function getTenantAccessToken(): Promise<string | null> {
    const config = getConfig();
    if (!config.larkAppId || !config.larkAppSecret) {
        return null;
    }

    for (let i = 0; i < 3; i++) {
        try {
            const res = await axios.post(
                'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
                { app_id: config.larkAppId, app_secret: config.larkAppSecret },
                { timeout: 10000 }
            );
            const token = res.data?.tenant_access_token;
            if (token) return token;
            console.error('[Lark] tenant_access_token missing:', res.data);
            return null;
        } catch (err: any) {
            if (i === 2) {
                console.debug('[Lark] getTenantAccessToken failed after 3 retries:', err.message);
                return null;
            }
            await new Promise(r => setTimeout(r, 1000 * (i + 1)));
        }
    }
    return null;
}

// ── Reaction 管理 ───────────────────────────────────────────────

/**
 * 为消息添加表情回应，表示已收到正在处理
 */
async function addReaction(messageId: string, emojiType: string = 'THUMBSUP'): Promise<void> {
    const token = await getTenantAccessToken();
    if (!token) return;

    try {
        await withRetry(async () => {
            const res = await axios.post(
                `https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/reactions`,
                { reaction_type: { emoji_type: emojiType } },
                { headers: { Authorization: `Bearer ${token}` }, timeout: 5000 }
            );
            if (res.data?.code !== 0) {
                throw new Error(res.data?.msg || `API returned code ${res.data?.code}`);
            }
        }, 'addReaction');
        console.debug(`[Lark] Added reaction ${emojiType} to message ${messageId.slice(-8)}`);
    } catch (err: any) {
        // 失败静默处理，不影响主流程
        console.debug('[Lark] Add reaction failed:', err.message);
    }
}

// ── Session 管理 ────────────────────────────────────────────────

interface LarkSession {
    id: string;
    workspace_id: string;
    channel: string;
    lark_chat_id: string | null;
    title: string | null;
}

/**
 * 根据飞书 chat_id 查找或创建 session
 */
function getOrCreateSessionForLark(
    chatId: string,
    workspaceId: string,
    initialTitle?: string
): LarkSession {
    const db = getDb();

    // 1. 先尝试查找已存在的 session
    const existing = db.prepare(
        'SELECT * FROM sessions WHERE lark_chat_id = ? AND workspace_id = ?'
    ).get(chatId, workspaceId) as LarkSession | undefined;

    if (existing) {
        console.log(`[Lark] Found existing session: ${existing.id}`);
        return existing;
    }

    // 2. 不存在则创建新 session
    const sessionId = randomUUID();
    const now = Date.now();
    const title = initialTitle || `飞书会话 ${new Date().toLocaleString()}`;

    db.prepare(
        `INSERT INTO sessions (
            id, workspace_id, user_id, channel, lark_chat_id, title,
            started_at, last_active_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(sessionId, workspaceId, 'owner', 'lark', chatId, title, now, now);

    const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as LarkSession;
    console.log(`[Lark] Created new session ${sessionId} for chat ${chatId}`);
    return session;
}

/**
 * 更新 session 的最后活跃时间
 */
function touchSession(sessionId: string): void {
    const db = getDb();
    db.prepare('UPDATE sessions SET last_active_at = ? WHERE id = ?').run(Date.now(), sessionId);
}

// ── 消息存储 ────────────────────────────────────────────────

interface MessageRow {
    role: string;
    content: string;
}

/**
 * 将消息写入数据库（复用 Web 端相同的逻辑）
 */
function saveMessage(params: {
    sessionId: string;
    workspaceId: string;
    role: 'user' | 'assistant';
    content: string;
    messageId?: string;
}): void {
    const db = getDb();
    db.prepare(
        `INSERT INTO messages (
            id, session_id, workspace_id, user_id, role, content, message_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
        randomUUID(),
        params.sessionId,
        params.workspaceId,
        'owner',
        params.role,
        params.content,
        params.messageId || null,
        Date.now()
    );
}

/**
 * 读取 session 的历史消息，转换为 Anthropic 格式
 */
function loadSessionHistory(sessionId: string, limit: number): { role: 'user' | 'assistant'; content: string }[] {
    const db = getDb();

    console.log(`[Lark] Querying messages for sessionId=${sessionId}, limit=${limit}`);

    // Fix: limit=0 means "no limit" (from config), so conditionally add LIMIT clause
    const query = limit > 0
        ? `SELECT role, content FROM messages WHERE session_id = ? ORDER BY created_at ASC LIMIT ?`
        : `SELECT role, content FROM messages WHERE session_id = ? ORDER BY created_at ASC`;
    const params = limit > 0 ? [sessionId, limit] : [sessionId];

    const rows = db.prepare(query).all(...params) as MessageRow[];

    console.log(`[Lark] loadSessionHistory: sessionId=${sessionId}, rows=${rows.length}`);
    if (rows.length === 0) {
        // Debug: check what's in the db
        const allRows = db.prepare('SELECT session_id, role, LENGTH(content) as len FROM messages LIMIT 10').all() as any[];
        console.log(`[Lark] Debug - all messages:`, JSON.stringify(allRows));
    }

    // Bug 修复：压缩历史消息中的 tool_result 内容（除最后一条外）
    function compressToolResult(content: string, maxLen = 200): string {
        if (content.length <= maxLen) return content;
        return content.substring(0, maxLen) + '...[truncated]';
    }

    const result = rows.map((r, index) => {
        let content = r.content;
        // 尝试解析 JSON，如果是数组则压缩 tool_result
        // 只压缩非最新的消息（index < rows.length - 1）
        try {
            const parsed = JSON.parse(content);
            if (Array.isArray(parsed) && index < rows.length - 1) {
                const compressed = parsed.map((block: any) => {
                    if (block.type === 'tool_result' && typeof block.content === 'string') {
                        return { ...block, content: compressToolResult(block.content, 200) };
                    }
                    return block;
                });
                content = JSON.stringify(compressed);
            }
        } catch {
            // 不是 JSON，保持原样
        }
        return {
            role: (r.role === 'assistant' ? 'assistant' : 'user') as 'user' | 'assistant',
            content,
        };
    }).filter(r => r.content && r.content.trim().length > 0); // 过滤空内容消息

    console.log(`[Lark] loadSessionHistory: filtered result=${result.length}`);
    return result;
}

// ── 推送目标 ────────────────────────────────────────────────────

/**
 * 从飞书消息上下文构造 NotifyTarget。
 * 在 im.message.receive_v1 回调中调用，任务创建时存入 tasks.notify_target。
 */
export function buildNotifyTarget(
    chatId: string,
    userOpenId?: string,
    messageId?: string,
    isGroup = false
): NotifyTarget {
    return {
        channel: 'lark',
        chat_id: chatId,
        user_open_id: userOpenId,
        is_group: isGroup,
        message_id: messageId,
    };
}

/**
 * 通用推送：按 NotifyTarget 决定推送方式。
 * 【兼容层】内部转发到 larkChannel.sendMessage
 */
export async function pushToTarget(target: NotifyTarget, content: string): Promise<void> {
    console.log('[Lark] pushToTarget called', {
        isLarkAvailable: larkChannel.isAvailable(),
        hasOldClient: !!larkClient,
        targetChannel: target.channel,
        hasChatId: !!target.chat_id,
    });

    // 优先使用新的 Channel 实现
    if (larkChannel.isAvailable()) {
        console.log('[Lark] Using larkChannel.sendMessage');
        const result = await larkChannel.sendMessage(content, { target });
        console.log('[Lark] larkChannel.sendMessage result:', result);
        return;
    }

    // 降级到旧实现（兼容启动阶段）
    console.log('[Lark] Falling back to old implementation');
    if (!larkClient) {
        console.warn('[Lark] pushToTarget: no larkClient available');
        return;
    }
    if (target.channel !== 'lark') {
        console.warn('[Lark] pushToTarget: target channel is not lark');
        return;
    }
    if (!target.chat_id) {
        console.warn('[Lark] pushToTarget: no chat_id in target');
        return;
    }

    const client = larkClient;
    const chatId = target.chat_id;
    const messageId = target.message_id;

    const text = (target.is_group && target.user_open_id)
        ? `<at user_id="${target.user_open_id}"></at> ${content}`
        : content;

    const truncated = truncateMessage(text);

    try {
        await withRetry(async () => {
            if (messageId) {
                await client.im.message.reply({
                    path: { message_id: messageId },
                    data: {
                        content: JSON.stringify({ text: truncated }),
                        msg_type: 'text',
                    },
                });
            } else {
                await client.im.message.create({
                    params: { receive_id_type: 'chat_id' },
                    data: {
                        receive_id: chatId,
                        content: JSON.stringify({ text: truncated }),
                        msg_type: 'text',
                    },
                });
            }
        }, 'pushToTarget');
    } catch (err: any) {
        console.error('[Lark] pushToTarget failed after retries:', err.message);
    }
}

/**
 * 系统级告警推送：推送到 config.larkDefaultChatId。
 * 【兼容层】内部转发到 larkChannel.sendAlert
 */
export async function pushAlert(content: string): Promise<void> {
    // 优先使用新的 Channel 实现
    if (larkChannel.isAvailable()) {
        await larkChannel.sendAlert(content, { level: 'warning' });
        return;
    }

    // 降级到旧实现
    const config = getConfig();
    if (!config.larkDefaultChatId) return;
    await pushToTarget(
        { channel: 'lark', chat_id: config.larkDefaultChatId },
        `⚠️ ${content}`
    );
}

// ── 业务逻辑：处理飞书消息 ─────────────────────────────────────

/**
 * 处理飞书消息的主函数
 * 由 LarkChannel 在收到消息后调用
 *
 * 职责：
 * 1. 工作区路由（通过 chatWorkspaceMap）
 * 2. 处理 /ws 工作区切换命令
 * 3. 幂等校验（消息去重）
 * 4. Session 查找/创建
 * 5. 调用 processChannelMessage 进入统一处理链路
 */
export async function handleLarkBusinessMessage(msg: ChannelMessage): Promise<void> {
    console.log('[Lark] handleLarkBusinessMessage called');

    const { content: textContent, channelMessageId: messageId, raw } = msg;
    const { chatId: openChatId, data } = raw || {};
    const senderOpenId = msg.senderId;
    const isGroup = msg.isGroup || false;

    if (!openChatId || !messageId) {
        console.warn('[Lark] Missing chatId or messageId');
        return;
    }

    const config = getConfig();
    const db = getDb();

    // 工作区路由
    let workspaceId: string | undefined = chatWorkspaceMap.get(openChatId);
    if (!workspaceId) {
        // 尝试从 sessions 表查找已绑定的 workspace
        const session = db.prepare(
            'SELECT workspace_id FROM sessions WHERE lark_chat_id = ? ORDER BY last_active_at DESC LIMIT 1'
        ).get(openChatId) as { workspace_id: string } | undefined;

        if (session) {
            workspaceId = session.workspace_id;
            chatWorkspaceMap.set(openChatId, workspaceId);
        } else {
            // 没有绑定 session，取第一个 active 工作区
            const workspace = db.prepare(
                'SELECT id FROM workspaces WHERE status = ? LIMIT 1'
            ).get('active') as { id: string } | undefined;

            if (!workspace) {
                await replyText(messageId, '您尚未创建任何工作区，请前往 Web 端创建。');
                return;
            }
            chatWorkspaceMap.set(openChatId, workspace.id);
            workspaceId = workspace.id;
        }
    }

    const wsId = workspaceId;

    // /ws 命令（保留在 lark.ts，因为是飞书特有的）
    if (textContent.trim().startsWith('/ws ')) {
        const wsName = textContent.trim().slice(4).trim();
        const targetWs = db.prepare('SELECT id FROM workspaces WHERE name = ? AND status = ?').get(wsName, 'active') as any;
        if (targetWs) {
            chatWorkspaceMap.set(openChatId, targetWs.id);
            const newSession = getOrCreateSessionForLark(openChatId, targetWs.id);
            await replyText(messageId, `已切换到工作区「${wsName}」，会话 ID: ${newSession.id.slice(0, 8)}`);
        } else {
            await replyText(messageId, `未找到工作区「${wsName}」`);
        }
        return;
    }

    // 幂等校验：检查消息是否已处理
    const existingMessage = db.prepare('SELECT id FROM messages WHERE message_id = ?').get(messageId);
    if (existingMessage) {
        console.log(`[Lark] Duplicate message ${messageId.slice(-8)}... ignored`);
        return;
    }

    // 创建 session
    const session = getOrCreateSessionForLark(openChatId, wsId, textContent.slice(0, 20));
    const sessionId = session.id;

    await addReaction(messageId, 'THUMBSUP');
    touchSession(sessionId);

    // 构造 ChannelMessage 并调用统一处理链路
    const channelMsg: ChannelMessage = {
        id: msg.id,
        sessionId: sessionId,
        workspaceId: wsId,
        role: 'user',
        content: textContent,
        createdAt: Date.now(),
        channelMessageId: messageId,
        senderId: senderOpenId,
        isGroup: isGroup,
        raw: { chatId: openChatId, data },
    };

    // 调用统一处理链路
    await processChannelMessage(channelMsg, wsId);
}

// ── 服务启动 ────────────────────────────────────────────────────

export const startLarkService = () => {
    const config = getConfig();
    if (!config.lark.enabled) return;

    if (!config.larkAppId || !config.larkAppSecret) {
        console.warn('[Lark] Enabled but app_id or app_secret is missing.');
        return;
    }

    // 检查是否已存在 LarkChannel 实例（由 ChannelManager 初始化）
    if (larkChannel.getLarkClient()) {
        // 复用 LarkChannel 的客户端
        larkClient = larkChannel.getLarkClient();
        wsClient = null; // WebSocket 由 LarkChannel 管理
        console.log('[Lark] Reusing LarkChannel client');

        // 注册业务逻辑处理器到 LarkChannel
        larkChannel.onMessage(handleLarkBusinessMessage);
        console.log('[Lark] Registered handleLarkBusinessMessage to larkChannel');
        return; // 跳过旧版 eventDispatcher 注册
    } else {
        // 独立初始化（兼容旧模式）
        larkClient = new lark.Client({
            appId: config.larkAppId,
            appSecret: config.larkAppSecret,
            disableTokenCache: false,
        });
    }

    const eventDispatcher = new lark.EventDispatcher({}).register({
        'im.message.receive_v1': async (data: any) => {
            const message = data.message;
            if (message.message_type !== 'text') return;

            const contentObj = JSON.parse(message.content);
            const textContent = contentObj.text;
            const messageId = message.message_id;
            const openChatId = message.chat_id;
            const senderOpenId = data.sender?.sender_id?.open_id;
            const isGroup = message.chat_type === 'group';

            // 群消息过滤：群聊时只响应 @机器人的消息
            if (isGroup) {
                // 检查消息中是否包含 @机器人
                // 飞书群消息中，@ 用户会以 <at user_id="xxx">@用户名</at> 格式呈现
                const botUserId = data.bot?.bot_id;
                if (!botUserId) {
                    console.warn('[Lark] Group message but bot_id not found in data');
                    return;
                }
                // 简单检查：如果消息中不包含 @ 标记，则忽略
                if (!contentObj.text.includes('<at')) {
                    console.log('[Lark] Group message without @bot, ignoring');
                    return;
                }
                // 进一步检查是否 @ 了当前机器人
                if (!contentObj.text.includes(botUserId)) {
                    console.log('[Lark] Group message @ not targeting this bot, ignoring');
                    return;
                }
            }

            const db = getDb();

            // 工作区路由：优先使用已绑定的，否则取第一个 active
            let workspaceId: string | undefined = chatWorkspaceMap.get(openChatId);
            if (!workspaceId) {
                // 获取任意一个 active 工作区（不限制用户，因为 Lark 用户已通过应用授权）
                const workspace = db.prepare(
                    'SELECT id FROM workspaces WHERE status = ? LIMIT 1'
                ).get('active') as { id: string } | undefined;
                if (!workspace) {
                    await replyText(messageId, '您尚未创建任何工作区，请前往 Web 端创建一个工作区后再来对话。');
                    return;
                }
                chatWorkspaceMap.set(openChatId, workspace.id);
                workspaceId = workspace.id;
            }

            // workspaceId is now guaranteed to be string after the check above
            const wsId = workspaceId;

            // 处理 /ws 工作区切换命令
            if (textContent.trim().startsWith('/ws ')) {
                const wsName = textContent.trim().slice(4).trim();
                const targetWs = db.prepare(
                    'SELECT id FROM workspaces WHERE name = ? AND status = ?'
                ).get(wsName, 'active') as any;
                if (targetWs) {
                    chatWorkspaceMap.set(openChatId, targetWs.id);
                    // 切换工作区时，为新的工作区查找或创建 session
                    const newSession = getOrCreateSessionForLark(openChatId, targetWs.id);
                    await replyText(messageId, `已切换到工作区「${wsName}」，会话 ID: ${newSession.id.slice(0, 8)}...`);
                } else {
                    await replyText(messageId, `未找到工作区「${wsName}」，请检查名称或先在 Web 端创建`);
                }
                return;
            }

            // 幂等校验：使用数据库 UNIQUE 约束硬性保障
            // 先尝试插入占位记录，如果冲突说明已处理过
            try {
                db.prepare(
                    'INSERT INTO messages (id, session_id, workspace_id, user_id, role, content, message_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
                ).run(
                    randomUUID(),
                    'pending',  // 临时占位
                    wsId,
                    'owner',
                    'user',
                    textContent,
                    messageId,
                    'complete',
                    Date.now()
                );
            } catch (err: any) {
                // UNIQUE 约束冲突，消息已处理过
                if (err.message?.includes('UNIQUE') || err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
                    console.log(`[Lark] Duplicate message ${messageId.slice(-8)}... ignored`);
                    return;
                }
                // 其他错误继续抛出
                throw err;
            }

            // 占位插入成功，现在查找或创建 session
            const title = textContent.slice(0, 20);
            const session = getOrCreateSessionForLark(openChatId, wsId, title);
            const sessionId = session.id;

            console.log(`[Lark] Session created/found: ${sessionId}, type: ${typeof sessionId}`);

            // 更新占位记录为正确的 session_id
            const updateResult = db.prepare('UPDATE messages SET session_id = ? WHERE message_id = ?').run(sessionId, messageId);
            console.log(`[Lark] Updated messages: ${updateResult.changes} rows`);

            // 立即添加表情回应，表示已收到正在处理
            await addReaction(messageId, 'THUMBSUP');

            // 更新 session 活跃时间
            touchSession(sessionId);

            // 拦截终端命令
            if (textContent.trim().startsWith('/terminal') || textContent.trim().startsWith('/bash')) {
                await replyText(messageId, '请前往 Web 终端面板进行系统级操作。');
                return;
            }

            // 排队提示
            const lockStatus = workspaceLock.getQueuePosition
                ? workspaceLock.getQueuePosition(wsId)
                : 0;
            if (lockStatus > 0) {
                await replyText(messageId, `正在处理中，已排队第 ${lockStatus} 位...`);
            }

            // 构造来源信息，供后续任务创建时记录 notify_target
            const notifyTarget = buildNotifyTarget(openChatId, senderOpenId, messageId, isGroup);

            // Fire and forget
            setTimeout(async () => {
                const release = await workspaceLock.acquire(wsId);

                try {
                    // 从数据库读取该 session 的历史消息（关键修复：与 Web 端共享同一份数据）
                    const contextWindow = config.claude.context_window_messages ?? 20;
                    const anthropicMsgs = loadSessionHistory(sessionId, contextWindow);

                    // 组装系统提示词，注入工作区配置和记忆上下文
                    const workspaceConfigPrompt = buildWorkspaceConfigPrompt(wsId);

                    const systemPromptParts: string[] = [];

                    // 1. 工作区配置（IDENTITY.md + USER.md + TOOLS.md）
                    if (workspaceConfigPrompt) {
                        systemPromptParts.push(workspaceConfigPrompt);
                    }

                    // 2. 基础角色定义
                    systemPromptParts.push('You are a helpful personal assistant talking via Lark IM.');

                    // Bug 1 修复：添加行为约束，防止模型编造工具结果
                    systemPromptParts.push(`
---
重要行为约束：
1. 执行工具前不要预测或猜测结果
2. 必须先调用工具，拿到真实结果后再总结
3. 正确格式：「我来执行xxx」→ [调用工具] → 「结果如下：[真实数据]」
4. 错误格式：「结果如下：[猜测数据]」→ [调用工具]（这是不允许的）
---`);

                    // 3. 将 notifyTarget 注入 context，助手创建任务时可读取来源
                    systemPromptParts.push(`\n\n当前消息来源：${JSON.stringify(notifyTarget)}`);

                    const systemPrompt = systemPromptParts.join('\n');

                    let assistantResponse = '';
                    let inputTokens = 0;
                    let outputTokens = 0;

                    const onEvent: AgentStreamCallback = (type, payload) => {
                        if (type === 'text') {
                            assistantResponse += payload;
                        } else if (type === 'usage') {
                            inputTokens = payload?.input_tokens ?? 0;
                            outputTokens = payload?.output_tokens ?? 0;
                        }
                    };

                    const runner = getRunner(wsId, onEvent);
                    const startTime = Date.now();

                    // 日志：检查发给 Claude 的消息内容
                    const msgSummary = anthropicMsgs.map((m: any) => ({
                        role: m.role,
                        type: Array.isArray(m.content) ? m.content.map((c: any) => c.type).join(',') : 'text',
                        len: JSON.stringify(m.content).length
                    }));
                    console.log('[Lark] Context summary:', JSON.stringify(msgSummary));
                    console.log('[Lark] System prompt length:', systemPrompt.length);

                    if (anthropicMsgs.length === 0) {
                        console.error('[Lark] No messages to send to Claude!');
                        await replyText(messageId, '系统错误：没有可用的对话消息');
                        return;
                    }

                    await runner.run(anthropicMsgs, systemPrompt, sessionId, wsId, onEvent);
                    const duration = Date.now() - startTime;

                    // ========================================
                    // 写库和回复飞书解耦，分别 try-catch
                    // ========================================

                    // 1. 先写库（关键数据，必须成功）
                    let saveError: any = null;
                    try {
                        // 写入助手消息
                        saveMessage({
                            sessionId,
                            workspaceId: wsId,
                            role: 'assistant',
                            content: assistantResponse,
                        });

                        // 更新 session 最后活跃时间
                        touchSession(sessionId);

                        // 记录 SDK 调用（含 token 数）
                        db.prepare(
                            'INSERT INTO sdk_calls (id, session_id, workspace_id, user_id, model, input_tokens, output_tokens, duration_ms, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
                        ).run(
                            randomUUID(), sessionId, wsId, 'owner',
                            config.claude.model, inputTokens, outputTokens,
                            duration, 'success', Date.now()
                        );

                        console.log(`[Lark] Messages saved to DB for session ${sessionId}`);
                    } catch (err: any) {
                        saveError = err;
                        console.error('[Lark] CRITICAL: Failed to save messages to DB:', err.message);
                        // 继续执行，尝试回复用户，但记录错误
                    }

                    // 2. 再回复飞书（非关键，可重试）
                    try {
                        const trimmedResponse = assistantResponse.trim();
                        if (trimmedResponse) {
                            await replyText(messageId, truncateMessage(trimmedResponse));
                        } else {
                            console.warn('[Lark] Empty assistant response, skipping reply');
                            await replyText(messageId, '[处理完成，但没有返回内容]');
                        }
                    } catch (err: any) {
                        console.error('[Lark] Failed to reply to Lark:', err.message);
                        // 回复失败不影响已写入的数据
                    }

                    // 如果写库失败，抛出让外层 catch 处理
                    if (saveError) {
                        throw new Error(`Failed to save messages: ${saveError.message}`);
                    }

                } catch (e: any) {
                    // 记录错误到 sdk_calls
                    db.prepare(
                        'INSERT INTO sdk_calls (id, session_id, workspace_id, user_id, model, status, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
                    ).run(
                        randomUUID(), sessionId, wsId, 'owner',
                        config.claude.model, 'error', e.message || 'Unknown error', Date.now()
                    );
                    await replyText(messageId, `执行错误：${e.message}`);
                } finally {
                    release();
                }
            }, 0);
        },
    });

    // 仅在独立初始化模式下启动 WebSocket
    if (!larkChannel.getLarkClient()) {
        wsClient = new lark.WSClient({
            appId: config.larkAppId,
            appSecret: config.larkAppSecret,
        });

        wsClient.start({ eventDispatcher });
        console.log('[Lark] Service started over WebSocket.');
    } else {
        console.log('[Lark] WebSocket managed by LarkChannel, skipping duplicate start');
    }
};

export const stopLarkService = () => {
    // 仅清理本地引用，实际的 WebSocket 由 LarkChannel 管理
    if (wsClient) {
        wsClient = null;
    }
    larkClient = null;
    console.log('[Lark] Service scheduled for shutdown.');
};

// ── 内部工具函数 ────────────────────────────────────────────────

async function replyText(messageId: string, content: string): Promise<void> {
    if (!larkClient) return;

    // 保存本地引用
    const client = larkClient;

    try {
        await withRetry(async () => {
            await client.im.message.reply({
                path: { message_id: messageId },
                data: {
                    content: JSON.stringify({ text: content }),
                    msg_type: 'text',
                },
            });
        }, 'replyText');
    } catch (err: any) {
        console.error('[Lark] Failed to reply message after retries:', err.message);
        throw err; // 向上传播，让调用者知道失败了
    }
}

/**
 * 按段落截断超长消息，避免切到句子中间。
 * 截断点优先找换行符，找不到才硬切。
 */
function truncateMessage(text: string): string {
    if (text.length <= LARK_MAX_MSG_LENGTH) return text;

    // 在上限前找最近的换行符，保证截断点是完整段落
    const slice = text.slice(0, LARK_MAX_MSG_LENGTH);
    const lastNewline = slice.lastIndexOf('\n');
    const cutAt = lastNewline > LARK_MAX_MSG_LENGTH * 0.8 ? lastNewline : LARK_MAX_MSG_LENGTH;

    return `${text.slice(0, cutAt)}\n\n…（内容过长已截断，完整结果请前往 Web 端查看）`;
}
