/**
 * WeChat (微信) 渠道实现
 * iLink Bot API
 *
 * @module src/channels/weixin
 */

import { randomUUID } from 'crypto';
import { Channel, ChannelMessage, SendOptions, AlertOptions, ReplyResult } from './base';
import * as ilinkApi from '../services/weixin/ilink-api';
import { getDb } from '../db';
import { webSocketChannel } from './websocket';

interface WeixinAccount {
    id: string;
    name?: string;
    bot_token: string;
    base_url?: string;
    status: string;
}

interface WeixinSession {
    id: string;
    qrcode: string;
    qrcode_url: string;
    qrcode_img: string;
    status: string;
    account_id?: string;
    created_at: number;
    expires_at: number;
}

export class WeixinChannel extends Channel {
    readonly name = 'weixin';

    private accounts: Map<string, WeixinAccount> = new Map();
    private pollingLoops: Map<string, boolean> = new Map();
    private cursors: Map<string, string> = new Map();
    // 每个 sender 对应的工作区映射（支持 /ws 切换）
    private senderWorkspaceMap: Map<string, string> = new Map();

    isAvailable(): boolean {
        // 检查数据库中是否有活跃账号
        const db = getDb();
        const result = db.prepare(
            "SELECT COUNT(*) as count FROM weixin_accounts WHERE status = 'active'"
        ).get() as { count: number };
        return result.count > 0;
    }

    async initialize(): Promise<void> {
        const db = getDb();

        // 从数据库恢复已登录的账号
        const accounts = db.prepare(
            'SELECT * FROM weixin_accounts WHERE status = ?'
        ).all('active') as WeixinAccount[];

        for (const account of accounts) {
            console.log(`[Weixin] Restoring account: ${account.id}`);
            this.accounts.set(account.id, account);
            this.startPolling(account);
        }

        console.log(`[Weixin] Initialized with ${accounts.length} account(s)`);
    }

    async shutdown(): Promise<void> {
        // 停止所有轮询
        for (const accountId of this.pollingLoops.keys()) {
            this.stopPolling(accountId);
        }
        this.accounts.clear();
        this.initialized = false;
        console.log('[Weixin] Shutdown complete');
    }

    async sendMessage(text: string, options?: SendOptions): Promise<boolean> {
        // 微信渠道的消息发送由 handleInboundMessage 内部处理
        // 这里主要用于回复确认
        console.log('[Weixin] sendMessage called:', text.slice(0, 50));
        return true;
    }

    async sendAlert(text: string, options?: AlertOptions): Promise<boolean> {
        // 告警发送到第一个活跃账号
        const firstAccount = this.accounts.values().next().value;
        if (!firstAccount) return false;

        // TODO: 实现告警消息发送
        console.log('[Weixin] sendAlert:', text.slice(0, 50));
        return true;
    }

    async waitReply(timeoutMs?: number): Promise<ReplyResult> {
        // 微信渠道不直接支持等待回复
        return { timedOut: true, content: null };
    }

    // ── 私有方法 ────────────────────────────────────────────────

    /**
     * 启动长轮询
     */
    private startPolling(account: WeixinAccount): void {
        if (this.pollingLoops.get(account.id)) return;
        this.pollingLoops.set(account.id, true);
        this.pollLoop(account);
    }

    private stopPolling(accountId: string): void {
        this.pollingLoops.set(accountId, false);
    }

    private async pollLoop(account: WeixinAccount): Promise<void> {
        let consecutiveErrors = 0;

        while (this.pollingLoops.get(account.id)) {
            try {
                const cursor = this.cursors.get(account.id) || '';
                const result = await ilinkApi.getUpdates(account.bot_token, cursor);

                // 调试日志
                if (result.msgs && result.msgs.length > 0) {
                    console.log(`[Weixin] Received ${result.msgs.length} messages`);
                    for (const msg of result.msgs) {
                        console.log(`[Weixin]   - from: ${msg.from_user_id}, type: ${msg.message_type}, has_content: ${!!msg.item_list?.length}`);
                    }
                }

                // 更新游标：优先使用 get_updates_buf，其次 sync_buf
                if (result.get_updates_buf) {
                    this.cursors.set(account.id, result.get_updates_buf);
                } else if ((result as any).sync_buf) {
                    this.cursors.set(account.id, (result as any).sync_buf);
                }

                // 检查返回值：ret 字段不存在或为 0 都视为成功
                const ret = result.ret;
                if (ret !== undefined && ret !== 0) {
                    console.error(`[Weixin] getUpdates error: ret=${ret}`);
                    if (ret === 401) {
                        // token 过期，标记账号失效
                        const db = getDb();
                        db.prepare('UPDATE weixin_accounts SET status = ? WHERE id = ?')
                            .run('expired', account.id);
                        this.stopPolling(account.id);
                        // 通知 Web 端账号失效
                        this.broadcastAccountStatus(account.id, 'expired');
                        break;
                    }
                    consecutiveErrors++;
                    if (consecutiveErrors > 5) {
                        await sleep(5000);
                    }
                    continue;
                }

                consecutiveErrors = 0;

                // 处理收到的消息（只处理用户发来的消息 message_type === 1）
                for (const msg of result.msgs || []) {
                    if (msg.message_type !== 1) continue; // 跳过非用户消息
                    console.log(`[Weixin] Processing message from ${msg.from_user_id}, type=${msg.message_type}`);
                    await this.handleInboundMessage(account, msg);
                }

            } catch (e: any) {
                if (e.name === 'TimeoutError') continue; // 正常超时，继续轮询
                console.error(`[Weixin] Poll error for ${account.id}:`, e.message);
                await sleep(3000);
            }
        }
    }

    private async handleInboundMessage(
        account: WeixinAccount,
        msg: ilinkApi.WeixinMessage
    ): Promise<void> {
        // 只处理文字消息
        const textBlock = msg.item_list?.find(b => b.type === 1);
        if (!textBlock?.text_item?.text) {
            console.log(`[Weixin] Skipping non-text message:`, JSON.stringify(msg).slice(0, 200));
            return;
        }

        const text = textBlock.text_item.text;
        const senderId = msg.from_user_id;

        console.log(`[Weixin] Message from ${senderId}: ${text.slice(0, 50)}`);

        // 更新最后使用时间
        const db = getDb();
        db.prepare('UPDATE weixin_accounts SET last_used_at = ? WHERE id = ?')
            .run(Date.now(), account.id);

        // ── 命令解析 ────────────────────────────────────────────────
        const trimmed = text.trim();

        // 检测命令类型
        if (trimmed.startsWith('/ws ')) {
            const channelMsg: ChannelMessage = {
                id: randomUUID(),
                sessionId: '', // 命令不需要 session
                workspaceId: this.senderWorkspaceMap.get(senderId) || this.getDefaultWorkspaceId() || '',
                role: 'user',
                content: trimmed,
                createdAt: Date.now(),
                senderId,
                command: { type: 'workspace_switch', raw: trimmed, args: trimmed.slice(4).trim() },
                raw: {
                    contextToken: msg.context_token,
                    accountId: account.id,
                    botToken: account.bot_token,
                    senderId,
                },
            };
            await this.handleIncomingMessage(channelMsg);
            return;
        }

        if (trimmed === '/workspaces' || trimmed === '/ws list') {
            const channelMsg: ChannelMessage = {
                id: randomUUID(),
                sessionId: '',
                workspaceId: this.senderWorkspaceMap.get(senderId) || this.getDefaultWorkspaceId() || '',
                role: 'user',
                content: trimmed,
                createdAt: Date.now(),
                senderId,
                command: { type: 'workspace_list', raw: trimmed },
                raw: {
                    contextToken: msg.context_token,
                    accountId: account.id,
                    botToken: account.bot_token,
                    senderId,
                },
            };
            await this.handleIncomingMessage(channelMsg);
            return;
        }

        if (trimmed === '/help' || trimmed === '/?') {
            const channelMsg: ChannelMessage = {
                id: randomUUID(),
                sessionId: '',
                workspaceId: this.senderWorkspaceMap.get(senderId) || this.getDefaultWorkspaceId() || '',
                role: 'user',
                content: trimmed,
                createdAt: Date.now(),
                senderId,
                command: { type: 'help', raw: trimmed },
                raw: {
                    contextToken: msg.context_token,
                    accountId: account.id,
                    botToken: account.bot_token,
                    senderId,
                },
            };
            await this.handleIncomingMessage(channelMsg);
            return;
        }

        if (trimmed.startsWith('/terminal') || trimmed.startsWith('/bash')) {
            const channelMsg: ChannelMessage = {
                id: randomUUID(),
                sessionId: '',
                workspaceId: this.senderWorkspaceMap.get(senderId) || this.getDefaultWorkspaceId() || '',
                role: 'user',
                content: trimmed,
                createdAt: Date.now(),
                senderId,
                command: { type: 'terminal_block', raw: trimmed },
                raw: {
                    contextToken: msg.context_token,
                    accountId: account.id,
                    botToken: account.bot_token,
                    senderId,
                },
            };
            await this.handleIncomingMessage(channelMsg);
            return;
        }

        // ── 正常消息处理 ────────────────────────────────────────────

        // 获取当前工作区（优先使用映射，否则用默认）
        const currentWs = this.senderWorkspaceMap.get(senderId) || this.getDefaultWorkspaceId();
        if (!currentWs) {
            console.error('[Weixin] No workspace available');
            return;
        }

        const userId = 'default'; // 微信渠道使用默认用户

        // 查找已存在的微信会话（复用 lark_chat_id 字段存储 senderId）
        const existingSession = db.prepare(`
            SELECT * FROM sessions
            WHERE lark_chat_id = ? AND workspace_id = ? AND channel = 'weixin' AND ended_at IS NULL
        `).get(senderId, currentWs) as any;

        let sessionId: string;
        let isNewSession = false;

        if (existingSession) {
            // 复用已有 session，更新活跃时间
            sessionId = existingSession.id;
            db.prepare('UPDATE sessions SET last_active_at = ? WHERE id = ?')
                .run(Date.now(), sessionId);
            console.log(`[Weixin] Reusing existing session: ${sessionId}`);
        } else {
            // 创建新会话
            sessionId = randomUUID();
            db.prepare(`
                INSERT INTO sessions (id, workspace_id, user_id, channel, lark_chat_id, title, status, started_at, last_active_at)
                VALUES (?, ?, ?, 'weixin', ?, ?, 'active', ?, ?)
            `).run(sessionId, currentWs, userId, senderId, text.slice(0, 20), Date.now(), Date.now());
            isNewSession = true;
            console.log(`[Weixin] Created new session: ${sessionId}`);
        }

        // 构造 ChannelMessage 走统一处理链路
        const channelMsg: ChannelMessage = {
            id: randomUUID(),
            sessionId,
            workspaceId: currentWs,
            role: 'user',
            content: text,
            createdAt: Date.now(),
            senderId,
            raw: {
                contextToken: msg.context_token,
                accountId: account.id,
                botToken: account.bot_token,
                senderId,
            },
        };

        // 触发上层处理器
        await this.handleIncomingMessage(channelMsg);

        // 等待处理完成后发送回复
        const reply = await this.waitForReply(sessionId);
        if (reply) {
            try {
                await ilinkApi.sendTextMessage(
                    account.bot_token,
                    senderId,
                    reply,
                    msg.context_token
                );
                console.log(`[Weixin] Reply sent to ${senderId}`);
            } catch (e: any) {
                console.error(`[Weixin] Failed to send reply:`, e.message);
            }
        }
    }

    private waitForReply(sessionId: string): Promise<string | null> {
        return new Promise((resolve) => {
            const timeoutMs = 120000; // 2分钟超时
            const checkInterval = 500;

            const startTime = Date.now();
            const check = () => {
                const db = getDb();
                const messages = db.prepare(`
                    SELECT content FROM messages
                    WHERE session_id = ? AND role = 'assistant'
                    ORDER BY created_at DESC LIMIT 1
                `).all(sessionId) as any[];

                if (messages.length > 0) {
                    const content = messages[0].content;
                    try {
                        const parsed = JSON.parse(content);
                        if (Array.isArray(parsed)) {
                            const text = parsed
                                .filter((b: any) => b.type === 'text')
                                .map((b: any) => b.text)
                                .join('\n');
                            resolve(text || null);
                            return;
                        }
                    } catch {
                        // 纯文本
                        resolve(content || null);
                        return;
                    }
                }

                if (Date.now() - startTime > timeoutMs) {
                    resolve(null);
                    return;
                }

                setTimeout(check, checkInterval);
            };

            // 等待1秒后再开始检查（给 Agent 处理时间）
            setTimeout(check, 1000);
        });
    }

    /**
     * 广播账号状态变化（通知 Web 端）
     */
    private broadcastAccountStatus(accountId: string, status: string): void {
        const defaultWs = this.getDefaultWorkspaceId();
        if (defaultWs) {
            webSocketChannel.broadcastToWorkspace(defaultWs, {
                type: 'weixin_account_status',
                accountId,
                status,
            });
        }
    }

    private getDefaultWorkspaceId(): string {
        const db = getDb();
        const ws = db.prepare('SELECT id FROM workspaces WHERE status = ? LIMIT 1')
            .get('active') as { id: string } | undefined;
        return ws?.id || '';
    }

    // ── 公开 API ────────────────────────────────────────────────

    /**
     * 开始登录流程
     */
    async startLogin(): Promise<{
        sessionId: string;
        qrcodeImgBase64: string;
        qrcodeUrl: string;
    }> {
        const { qrcode, qrcode_url, qrcode_img_content } = await ilinkApi.getBotQrcode();

        const db = getDb();
        const sessionId = `wx-login-${Date.now()}`;

        // 优先使用 API 返回的 base64 图片
        // 注意：API 可能把 URL 放在 qrcode_img_content 里，需要判断
        let qrcodeBase64 = qrcode_img_content;

        // 如果 qrcode_img_content 看起来像 URL（而不是真正的 base64），忽略它
        const looksLikeUrl = qrcodeBase64 && (
            qrcodeBase64.startsWith('http') ||
            qrcodeBase64.length < 200  // 真正的 base64 应该很长
        );
        if (looksLikeUrl) {
            console.log('[Weixin] qrcode_img_content looks like URL, will use it for QR');
        }

        // 确定用于生成二维码的 URL
        const qrUrl = qrcode_url || (looksLikeUrl ? qrcodeBase64 : '');

        // 如果 qrcode_img_content 不是 URL，优先使用它
        if (qrcodeBase64 && !looksLikeUrl) {
            // 已经是真正的 base64，不需要处理
            console.log('[Weixin] Using API-provided base64 QR code');
        } else if (qrUrl) {
            // 用 URL 生成二维码
            try {
                const QRCode = await import('qrcode');
                console.log('[Weixin] Generating QR from URL:', qrUrl);
                const dataUrl = await QRCode.toDataURL(qrUrl, {
                    type: 'image/png',
                    width: 300,
                    margin: 2,
                    color: { dark: '#000000', light: '#ffffff' }
                });
                // 安全提取 base64 部分
                const parts = dataUrl.split(',');
                qrcodeBase64 = parts.length > 1 ? parts[1] : dataUrl;
                console.log('[Weixin] QR generated, length:', qrcodeBase64.length);
            } catch (e: any) {
                console.error('[Weixin] QR generate failed:', e.message);
                qrcodeBase64 = '';
            }
        } else {
            console.warn('[Weixin] No QR code data available');
        }

        db.prepare(`
            INSERT INTO weixin_sessions (id, qrcode, qrcode_url, qrcode_img, status, created_at, expires_at)
            VALUES (?, ?, ?, ?, 'pending', ?, ?)
        `).run(sessionId, qrcode, qrcode_url, qrcodeBase64 || '', Date.now(), Date.now() + 5 * 60 * 1000);

        // 轮询扫码状态
        this.pollLoginStatus(sessionId, qrcode);

        return {
            sessionId,
            qrcodeImgBase64: qrcodeBase64 || '',
            qrcodeUrl: qrcode_url || '',
        };
    }

    private async pollLoginStatus(sessionId: string, qrcode: string): Promise<void> {
        const maxAttempts = 60; // 最多轮询60次（约120秒）
        let attempts = 0;

        while (attempts < maxAttempts) {
            await sleep(2000); // 2秒间隔
            attempts++;

            try {
                const status = await ilinkApi.getQrcodeStatus(qrcode);

                if (status.status === 'confirmed' && status.bot_token) {
                    // 登录成功，保存账号
                    const db = getDb();
                    const accountId = `wx-${Date.now()}`;
                    db.prepare(`
                        INSERT INTO weixin_accounts (id, bot_token, base_url, status, created_at)
                        VALUES (?, ?, ?, 'active', ?)
                    `).run(accountId, status.bot_token, status.baseurl, Date.now());

                    db.prepare('UPDATE weixin_sessions SET status = ?, account_id = ? WHERE id = ?')
                        .run('confirmed', accountId, sessionId);

                    const account: WeixinAccount = {
                        id: accountId,
                        bot_token: status.bot_token,
                        base_url: status.baseurl,
                        status: 'active',
                    };
                    this.accounts.set(accountId, account);
                    this.startPolling(account);

                    // 通知 Web 端登录成功
                    const defaultWs = this.getDefaultWorkspaceId();
                    if (defaultWs) {
                        webSocketChannel.broadcastToWorkspace(defaultWs, {
                            type: 'weixin_login_success',
                            sessionId,
                            accountId,
                        });
                    }

                    console.log(`[Weixin] Login success: ${accountId}`);
                    return;
                }

                if (status.status === 'expired') {
                    const db = getDb();
                    db.prepare('UPDATE weixin_sessions SET status = ? WHERE id = ?')
                        .run('expired', sessionId);

                    const defaultWs = this.getDefaultWorkspaceId();
                    if (defaultWs) {
                        webSocketChannel.broadcastToWorkspace(defaultWs, {
                            type: 'weixin_login_expired',
                            sessionId,
                        });
                    }
                    return;
                }
            } catch (e: any) {
                console.warn(`[Weixin] pollLoginStatus attempt ${attempts} failed:`, e.message);
                // 超时等网络错误，继续重试
                continue;
            }
        }

        // 超时
        const db = getDb();
        db.prepare('UPDATE weixin_sessions SET status = ? WHERE id = ?')
            .run('expired', sessionId);

        const defaultWs = this.getDefaultWorkspaceId();
        if (defaultWs) {
            webSocketChannel.broadcastToWorkspace(defaultWs, {
                type: 'weixin_login_expired',
                sessionId,
            });
        }
    }

    /**
     * 断开账号
     */
    async disconnectAccount(accountId: string): Promise<void> {
        this.stopPolling(accountId);
        this.accounts.delete(accountId);

        const db = getDb();
        db.prepare('UPDATE weixin_accounts SET status = ? WHERE id = ?')
            .run('inactive', accountId);

        console.log(`[Weixin] Account disconnected: ${accountId}`);
    }

    /**
     * 获取所有已登录的微信账号
     */
    getAccounts(): WeixinAccount[] {
        return Array.from(this.accounts.values());
    }

    /**
     * 获取所有账号（包含数据库中的）
     */
    getAllAccounts(): Array<WeixinAccount & { name?: string; created_at?: number; last_used_at?: number }> {
        const db = getDb();
        return db.prepare(
            'SELECT id, name, bot_token, base_url, status, created_at, last_used_at FROM weixin_accounts'
        ).all() as any[];
    }
}

// 单例实例
export const weixinChannel = new WeixinChannel();

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}
