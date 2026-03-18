/**
 * Lark (飞书) 渠道实现
 *
 * @module src/channels/lark
 */

import * as lark from '@larksuiteoapi/node-sdk';
import axios from 'axios';
import { randomUUID } from 'crypto';
import { Channel, ChannelMessage, SendOptions, AlertOptions, ReplyResult } from './base';
import { getConfig } from '../config';
import { getDb } from '../db';
import { NotifyTarget } from '../types';
import { buildWorkspaceConfigPrompt } from '../services/workspace-config';
import { AgentStreamCallback, getRunner } from '../services/agent-runner';
import { workspaceLock } from '../services/workspace-lock';

const LARK_MAX_MSG_LENGTH = 28000;
const LARK_RETRY_DELAYS = [1000, 2000, 3000];

/**
 * 飞书渠道实现
 */
export class LarkChannel extends Channel {
    readonly name = 'lark';

    private wsClient: lark.WSClient | null = null;
    private larkClient: lark.Client | null = null;
    private eventDispatcher: lark.EventDispatcher | null = null;

    // 工作区路由映射：chatId -> workspaceId
    private chatWorkspaceMap = new Map<string, string>();

    // 等待回复的回调映射
    private pendingReplies = new Map<string, (reply: ReplyResult) => void>();

    isAvailable(): boolean {
        const config = getConfig();
        return !!(config.lark?.enabled && config.larkAppId && config.larkAppSecret);
    }

    async initialize(): Promise<void> {
        console.log('[LarkChannel] initialize called, isAvailable:', this.isAvailable());

        if (!this.isAvailable()) {
            console.log('[LarkChannel] Not available, skipping initialization');
            return;
        }

        const config = getConfig();
        console.log('[LarkChannel] Config loaded:', {
            hasAppId: !!config.larkAppId,
            hasAppSecret: !!config.larkAppSecret,
            enabled: config.lark?.enabled,
        });

        this.larkClient = new lark.Client({
            appId: config.larkAppId!,
            appSecret: config.larkAppSecret!,
            disableTokenCache: false,
        });

        this.eventDispatcher = new lark.EventDispatcher({}).register({
            'im.message.receive_v1': (data: any) => this.handleLarkMessage(data),
        });

        this.wsClient = new lark.WSClient({
            appId: config.larkAppId!,
            appSecret: config.larkAppSecret!,
        });

        this.wsClient.start({ eventDispatcher: this.eventDispatcher });
        this.initialized = true;
        console.log('[LarkChannel] Service started over WebSocket');
        console.log('[LarkChannel] defaultChatId:', config.larkDefaultChatId ? `${config.larkDefaultChatId.slice(0, 8)}...` : '未配置');
    }

    async shutdown(): Promise<void> {
        if (this.wsClient) {
            // WebSocket client 没有直接的 close 方法，依赖 GC
            this.wsClient = null;
        }
        this.larkClient = null;
        this.eventDispatcher = null;
        this.initialized = false;
        console.log('[LarkChannel] Service scheduled for shutdown');
    }

    /**
     * 发送普通消息
     */
    async sendMessage(text: string, options?: SendOptions): Promise<boolean> {
        console.log('[LarkChannel] sendMessage called', { hasClient: !!this.larkClient, textLen: text?.length });

        if (!this.larkClient) {
            console.warn('[LarkChannel] sendMessage: larkClient is null');
            return false;
        }

        const config = getConfig();
        let target: NotifyTarget | undefined;

        if (typeof options?.target === 'string') {
            // target 是字符串时，需要判断是否为有效的飞书 chat_id（oc_xxx 或 c_xxx）
            // workspace_id 不是有效的 chat_id，不能直接使用
            const maybeChatId = options.target;
            if (maybeChatId.startsWith('oc_') || maybeChatId.startsWith('c_')) {
                target = { channel: 'lark', chat_id: maybeChatId };
            } else {
                // 可能是 workspace_id，不当作 chat_id 使用
                console.log('[LarkChannel] target is not a valid chat_id, will use defaultChatId:', maybeChatId.slice(0, 10));
                target = undefined;
            }
        } else {
            target = options?.target as NotifyTarget;
        }

        // 使用 defaultChatId 作为 fallback
        const chatId = target?.chat_id || config.larkDefaultChatId;

        console.log('[LarkChannel] sendMessage target:', {
            hasChatId: !!chatId,
            hasMessageId: !!target?.message_id,
            isGroup: target?.is_group,
            chatIdPrefix: chatId?.slice(0, 10),
        });

        if (!chatId) {
            console.warn('[LarkChannel] sendMessage: no chat_id and no defaultChatId configured');
            return false;
        }

        try {
            const content = (target?.is_group && target?.user_open_id)
                ? `<at user_id="${target.user_open_id}"></at> ${text}`
                : text;
            const truncated = this.truncateMessage(content);
            const messageId = target?.message_id;

            console.log('[LarkChannel] sendMessage sending, usingReply:', !!messageId, 'chatId:', chatId.slice(-8));

            await this.withRetry(async () => {
                if (messageId) {
                    await this.larkClient!.im.message.reply({
                        path: { message_id: messageId },
                        data: {
                            content: JSON.stringify({ text: truncated }),
                            msg_type: 'text',
                        },
                    });
                } else {
                    console.log('[LarkChannel] message.create with receive_id_type: chat_id, chatId:', chatId.slice(-8));
                    await this.larkClient!.im.message.create({
                        params: { receive_id_type: 'chat_id' },
                        data: {
                            receive_id: chatId,
                            content: JSON.stringify({ text: truncated }),
                            msg_type: 'text',
                        },
                    });
                }
            }, 'sendMessage');

            console.log('[LarkChannel] sendMessage success');
            return true;
        } catch (err: any) {
            console.error('[LarkChannel] sendMessage failed:', err.message, err.code, err.stack);
            return false;
        }
    }

    /**
     * 发送告警通知
     */
    async sendAlert(text: string, options?: AlertOptions): Promise<boolean> {
        const config = getConfig();
        const chatId = options?.target?.chat_id || config.larkDefaultChatId;

        if (!chatId) {
            console.warn('[LarkChannel] sendAlert: no chat_id configured');
            return false;
        }

        const levelEmoji = {
            info: 'ℹ️',
            warning: '⚠️',
            error: '❌',
            critical: '🚨',
        };

        const emoji = options?.level ? levelEmoji[options.level] : '⚠️';
        const alertText = `${emoji} ${text}`;

        // 如果有操作按钮，构建交互式消息
        if (options?.actions && options.actions.length > 0) {
            return this.sendInteractiveAlert(alertText, options.actions, chatId);
        }

        return this.sendMessage(alertText, { target: { channel: 'lark', chat_id: chatId } });
    }

    /**
     * 发送交互式告警（带按钮）
     */
    private async sendInteractiveAlert(
        text: string,
        actions: AlertOptions['actions'],
        chatId: string
    ): Promise<boolean> {
        if (!this.larkClient) return false;

        const buttons = actions!.map((action) => ({
            tag: 'button',
            text: { tag: 'plain_text', content: action.label },
            type: action.style === 'danger' ? 'danger' : action.style === 'primary' ? 'primary' : 'default',
            value: { action_id: action.id },
        }));

        const card = {
            config: { wide_screen_mode: true },
            header: {
                title: { tag: 'plain_text', content: '需要您的确认' },
                template: 'orange',
            },
            elements: [
                { tag: 'div', text: { tag: 'lark_md', content: text } },
                { tag: 'action', actions: buttons },
            ],
        };

        try {
            await this.withRetry(async () => {
                await this.larkClient!.im.message.create({
                    params: { receive_id_type: 'chat_id' },
                    data: {
                        receive_id: chatId,
                        content: JSON.stringify(card),
                        msg_type: 'interactive',
                    },
                });
            }, 'sendInteractiveAlert');
            return true;
        } catch (err: any) {
            console.error('[LarkChannel] sendInteractiveAlert failed:', err.message);
            return false;
        }
    }

    /**
     * 等待用户回复
     * 注意：飞书 WebSocket 模式下需要配合回调机制
     */
    async waitReply(timeoutMs = 300000): Promise<ReplyResult> {
        return new Promise((resolve) => {
            const timeoutId = setTimeout(() => {
                resolve({ timedOut: true, content: null });
            }, timeoutMs);

            // 注册一个一次性回调
            const messageId = randomUUID();
            this.pendingReplies.set(messageId, (result) => {
                clearTimeout(timeoutId);
                this.pendingReplies.delete(messageId);
                resolve(result);
            });
        });
    }

    // ── 内部方法 ────────────────────────────────────────────────

    /**
     * 处理飞书消息事件
     */
    private async handleLarkMessage(data: any): Promise<void> {
        console.log('[LarkChannel] handleLarkMessage triggered', JSON.stringify({
            message_type: data?.message?.message_type,
            chat_id: data?.message?.chat_id?.slice(-8),
            has_message: !!data?.message,
        }));

        try {
            const message = data.message;
            if (message.message_type !== 'text') {
                console.log('[LarkChannel] Ignoring non-text message:', message.message_type);
                return;
            }

            const contentObj = JSON.parse(message.content);
            const textContent = contentObj.text;
            const messageId = message.message_id;
            const openChatId = message.chat_id;
            const senderOpenId = data.sender?.sender_id?.open_id;
            const isGroup = message.chat_type === 'group';

            console.log('[LarkChannel] Received message:', {
                text: textContent?.slice(0, 50),
                chatId: openChatId?.slice(-8),
                isGroup,
                senderId: senderOpenId?.slice(-8),
            });

            // 群消息过滤
            if (isGroup) {
                const botUserId = data.bot?.bot_id;
                if (!botUserId) {
                    console.log('[LarkChannel] Group message but bot_id not found');
                    return;
                }
                if (!contentObj.text.includes('<at')) {
                    console.log('[LarkChannel] Group message without @bot, ignoring');
                    return;
                }
                if (!contentObj.text.includes(botUserId)) {
                    console.log('[LarkChannel] Group message @ not targeting this bot');
                    return;
                }
            }

            // 构造 ChannelMessage
            const channelMsg: ChannelMessage = {
                id: randomUUID(),
                sessionId: '', // 将在后续处理中确定
                workspaceId: '',
                role: 'user',
                content: textContent,
                createdAt: Date.now(),
                channelMessageId: messageId,
                senderId: senderOpenId,
                isGroup,
                raw: { chatId: openChatId, data },
            };

            console.log('[LarkChannel] Calling handleIncomingMessage, hasHandler:', !!this.messageHandler);

            // 触发上层处理器
            await this.handleIncomingMessage(channelMsg);

            console.log('[LarkChannel] handleIncomingMessage completed');
        } catch (err: any) {
            console.error('[LarkChannel] handleLarkMessage error:', err.message, err.stack);
        }
    }

    /**
     * 回复消息（内部使用）
     */
    async replyText(messageId: string, content: string): Promise<void> {
        if (!this.larkClient) return;

        try {
            await this.withRetry(async () => {
                await this.larkClient!.im.message.reply({
                    path: { message_id: messageId },
                    data: {
                        content: JSON.stringify({ text: this.truncateMessage(content) }),
                        msg_type: 'text',
                    },
                });
            }, 'replyText');
        } catch (err: any) {
            console.error('[LarkChannel] replyText failed:', err.message);
            throw err;
        }
    }

    /**
     * 带指数退避的重试执行
     */
    private async withRetry<T>(fn: () => Promise<T>, operationName: string, retries = 3): Promise<T> {
        let lastError: any;

        for (let i = 0; i < retries; i++) {
            try {
                return await fn();
            } catch (err: any) {
                lastError = err;
                const isLastAttempt = i === retries - 1;

                const isNetworkError = err.code === 'ECONNRESET'
                    || err.code === 'ETIMEDOUT'
                    || err.code === 'ECONNREFUSED'
                    || err.message?.includes('tenant_access_token');

                if (isLastAttempt || !isNetworkError) {
                    throw err;
                }

                const delay = LARK_RETRY_DELAYS[i] || 3000;
                await new Promise(r => setTimeout(r, delay));
            }
        }

        throw lastError;
    }

    /**
     * 按段落截断超长消息
     */
    private truncateMessage(text: string): string {
        if (text.length <= LARK_MAX_MSG_LENGTH) return text;

        const slice = text.slice(0, LARK_MAX_MSG_LENGTH);
        const lastNewline = slice.lastIndexOf('\n');
        const cutAt = lastNewline > LARK_MAX_MSG_LENGTH * 0.8 ? lastNewline : LARK_MAX_MSG_LENGTH;

        return `${text.slice(0, cutAt)}\n\n…（内容过长已截断，完整结果请前往 Web 端查看）`;
    }

    /**
     * 添加表情回应
     */
    async addReaction(messageId: string, emojiType = 'THUMBSUP'): Promise<void> {
        const token = await this.getTenantAccessToken();
        if (!token) return;

        try {
            await this.withRetry(async () => {
                await axios.post(
                    `https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/reactions`,
                    { reaction_type: { emoji_type: emojiType } },
                    { headers: { Authorization: `Bearer ${token}` }, timeout: 5000 }
                );
            }, 'addReaction');
        } catch (err: any) {
            console.debug('[LarkChannel] Add reaction failed:', err.message);
        }
    }

    /**
     * 获取 tenant_access_token
     */
    private async getTenantAccessToken(): Promise<string | null> {
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
                return res.data?.tenant_access_token || null;
            } catch (err: any) {
                if (i === 2) return null;
                await new Promise(r => setTimeout(r, 1000 * (i + 1)));
            }
        }
        return null;
    }

    // ── 公开访问器 ────────────────────────────────────────────────

    /**
     * 获取原生飞书客户端（兼容层使用）
     */
    getLarkClient(): lark.Client | null {
        return this.larkClient;
    }
}

// 单例实例
export const larkChannel = new LarkChannel();
