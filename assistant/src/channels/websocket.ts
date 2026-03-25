/**
 * WebSocket 渠道实现
 * 前端 Web 界面的消息渠道
 *
 * @module src/channels/websocket
 */

import { Channel, ChannelMessage, SendOptions, AlertOptions, ReplyResult, AlertAction } from './base';

// WebSocket 连接管理：workspaceId -> Set<WSContext>
const wsConnections = new Map<string, Set<any>>();

// 等待回复的回调映射：sessionId -> resolve function
const pendingReplies = new Map<string, (reply: ReplyResult) => void>();

// 等待确认的回调映射：confirmId -> resolve function
const pendingConfirmations = new Map<string, (actionId: string | null) => void>();

// Token 缓存：当 WS 断开时缓存流式消息，重连后回放
// workspaceId -> { sessionId, tokens: Array<{type, content}> }
interface CachedToken {
    type: 'text' | 'tool_call' | 'tool_result' | 'error';
    content: any;
    timestamp: number;
}
interface TokenCache {
    sessionId: string;
    tokens: CachedToken[];
    createdAt: number;
}
const tokenBuffer = new Map<string, TokenCache>();
const TOKEN_BUFFER_TTL_MS = 5 * 60 * 1000;
const TOKEN_BUFFER_CLEANUP_INTERVAL_MS = 60 * 1000;

/**
 * WebSocket 渠道实现
 * 用于向前端 Web 界面发送消息、告警和确认请求
 */
export class WebSocketChannel extends Channel {
    readonly name = 'websocket';
    private tokenBufferCleanupTimer?: NodeJS.Timeout;

    /**
     * WebSocket 渠道总是可用（只要有前端连接即可）
     */
    isAvailable(): boolean {
        // 检查是否有任何活跃的 WebSocket 连接
        for (const connections of wsConnections.values()) {
            if (connections.size > 0) {
                return true;
            }
        }
        return false;
    }

    /**
     * 检查特定工作区是否有活跃连接
     */
    isWorkspaceAvailable(workspaceId: string): boolean {
        const connections = wsConnections.get(workspaceId);
        return !!(connections && connections.size > 0);
    }

    async initialize(): Promise<void> {
        this.initialized = true;
        this.tokenBufferCleanupTimer = setInterval(() => {
            this.cleanupExpiredTokenBuffers();
        }, TOKEN_BUFFER_CLEANUP_INTERVAL_MS);
        console.log('[WebSocketChannel] Initialized');
    }

    async shutdown(): Promise<void> {
        if (this.tokenBufferCleanupTimer) {
            clearInterval(this.tokenBufferCleanupTimer);
            this.tokenBufferCleanupTimer = undefined;
        }

        // 关闭所有连接
        for (const [workspaceId, connections] of wsConnections) {
            for (const ws of connections) {
                try {
                    ws.close();
                } catch {
                    // 忽略关闭错误
                }
            }
            connections.clear();
        }
        wsConnections.clear();
        this.initialized = false;
        console.log('[WebSocketChannel] All connections closed');
    }

    /**
     * 发送消息到前端
     * options.target 可以是 workspaceId 字符串
     */
    async sendMessage(text: string, options?: SendOptions): Promise<boolean> {
        let workspaceId: string | undefined;

        if (typeof options?.target === 'string') {
            workspaceId = options.target;
        } else if (options?.target && 'workspace_id' in options.target) {
            workspaceId = (options.target as any).workspace_id;
        }

        if (!workspaceId) {
            // 广播到所有工作区
            this.broadcastToAll({ type: 'system_message', payload: { text } });
            return true;
        }

        return this.broadcastToWorkspace(workspaceId, {
            type: 'system_message',
            payload: { text },
        });
    }

    /**
     * 发送告警通知到前端
     */
    async sendAlert(text: string, options?: AlertOptions): Promise<boolean> {
        const target = options?.target;
        let workspaceId: string | undefined;

        if (target && 'workspace_id' in target) {
            workspaceId = (target as any).workspace_id;
        }

        const payload: any = {
            type: 'alert',
            text,
            level: options?.level || 'warning',
            timestamp: Date.now(),
        };

        if (options?.actions) {
            payload.actions = options.actions;
        }

        if (workspaceId) {
            return this.broadcastToWorkspace(workspaceId, { type: 'alert', payload });
        } else {
            this.broadcastToAll({ type: 'alert', payload });
            return true;
        }
    }

    /**
     * 发送确认请求（危险操作）
     * 前端展示确认弹窗，用户选择后通过 WebSocket 回复
     */
    async requestConfirmation(
        title: string,
        description: string,
        actions?: AlertAction[],
        timeoutMs = 300000
    ): Promise<string | null> {
        const confirmId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

        const defaultActions: AlertAction[] = [
            { id: 'confirm', label: '确认', style: 'danger' },
            { id: 'cancel', label: '取消', style: 'secondary' },
        ];

        const payload = {
            type: 'confirmation_request',
            confirmId,
            title,
            description,
            actions: actions || defaultActions,
            timestamp: Date.now(),
        };

        // 广播到所有连接的工作区
        this.broadcastToAll({ type: 'confirmation', payload });

        // 等待用户回复
        return new Promise((resolve) => {
            const timeoutId = setTimeout(() => {
                pendingConfirmations.delete(confirmId);
                resolve(null);
            }, timeoutMs);

            pendingConfirmations.set(confirmId, (actionId) => {
                clearTimeout(timeoutId);
                pendingConfirmations.delete(confirmId);
                resolve(actionId);
            });
        });
    }

    /**
     * 等待用户回复
     * 通过 WebSocket 双向通信实现
     */
    async waitReply(timeoutMs = 300000): Promise<ReplyResult> {
        return new Promise((resolve) => {
            const sessionId = `session-${Date.now()}`;
            const timeoutId = setTimeout(() => {
                pendingReplies.delete(sessionId);
                resolve({ timedOut: true, content: null });
            }, timeoutMs);

            pendingReplies.set(sessionId, (result) => {
                clearTimeout(timeoutId);
                pendingReplies.delete(sessionId);
                resolve(result);
            });
        });
    }

    // ── 连接管理 ────────────────────────────────────────────────

    /**
     * 注册 WebSocket 连接到指定工作区
     * 由 server.ts 在 WebSocket 连接建立时调用
     */
    registerConnection(workspaceId: string, ws: any, sessionId?: string): void {
        if (!wsConnections.has(workspaceId)) {
            wsConnections.set(workspaceId, new Set());
        }
        wsConnections.get(workspaceId)!.add(ws);
        console.log(`[WebSocketChannel] Connection registered for workspace ${workspaceId.slice(0, 8)}`);

        // 重连后回放缓存的 token
        this.replayCachedTokens(workspaceId, ws, sessionId);
    }

    /**
     * 移除 WebSocket 连接
     * 由 server.ts 在 WebSocket 关闭时调用
     */
    unregisterConnection(workspaceId: string, ws: any): void {
        const connections = wsConnections.get(workspaceId);
        if (connections) {
            connections.delete(ws);
            if (connections.size === 0) {
                wsConnections.delete(workspaceId);
            }
        }
    }

    /**
     * 处理前端发来的 WebSocket 消息（非抽象方法）
     * 由 server.ts 在 WebSocket onMessage 时调用
     */
    handleWebSocketMessage(workspaceId: string, data: any, ws: any): void {
        // 处理确认回复
        if (data.type === 'confirmation_response' && data.confirmId) {
            const callback = pendingConfirmations.get(data.confirmId);
            if (callback) {
                callback(data.actionId || null);
            }
            return;
        }

        // 处理普通回复
        if (data.type === 'reply' && data.sessionId) {
            const callback = pendingReplies.get(data.sessionId);
            if (callback) {
                callback({
                    timedOut: false,
                    content: data.content,
                    senderId: data.userId,
                });
            }
            return;
        }

        // 转换为标准 ChannelMessage 并触发上层处理器
        if (this.messageHandler && data.content) {
            const message: ChannelMessage = {
                id: data.messageId || `${Date.now()}-${Math.random().toString(36).slice(2)}`,
                sessionId: data.sessionId || '',
                workspaceId,
                role: 'user',
                content: typeof data.content === 'string' ? data.content : JSON.stringify(data.content),
                createdAt: Date.now(),
                raw: { ws, data },
            };
            this.handleIncomingMessage(message);
        }
    }

    // ── 广播工具 ────────────────────────────────────────────────

    /**
     * 广播到指定工作区的所有连接
     * 如果无连接，缓存 token 供重连后回放
     */
    broadcastToWorkspace(workspaceId: string, payload: any): boolean {
        const connections = wsConnections.get(workspaceId);
        const messageStr = JSON.stringify(payload);

        // 提取 token 类型和内容用于缓存
        let tokenToCache: CachedToken | null = null;
        if ((payload.type === 'token' || payload.type === 'text') && payload.payload !== undefined) {
            tokenToCache = {
                type: payload.type === 'token' ? (payload.payload.type || 'text') : 'text',
                content: payload.type === 'token' ? payload.payload.content : payload.payload,
                timestamp: Date.now()
            };
        } else if (
            payload.type === 'tool_call' ||
            payload.type === 'tool_result' ||
            payload.type === 'error' ||
            payload.type === 'done' ||
            payload.type === 'task_running' ||
            payload.type?.includes('confirmation')
        ) {
            tokenToCache = {
                type: payload.type,
                content: payload.payload || payload,
                timestamp: Date.now()
            };
        }

        if (!connections || connections.size === 0) {
            // 无连接时缓存 token
            if (tokenToCache) {
                this.cacheToken(workspaceId, tokenToCache);
            }
            return false;
        }

        let sent = 0;

        for (const ws of connections) {
            if (ws.readyState === 1) { // OPEN
                try {
                    ws.send(messageStr);
                    sent++;
                } catch (err) {
                    console.error('[WebSocketChannel] Send error:', err);
                }
            }
        }

        return sent > 0;
    }

    /**
     * 缓存 token 到 workspace buffer
     */
    private cacheToken(workspaceId: string, token: CachedToken): void {
        // 从 payload 中提取 sessionId，如果没有则使用 workspace 级缓存
        const cache = tokenBuffer.get(workspaceId);
        if (cache) {
            cache.tokens.push(token);
            // 限制缓存大小，防止内存泄漏（最多缓存 1000 个 token）
            if (cache.tokens.length > 1000) {
                cache.tokens = cache.tokens.slice(-1000);
                console.warn(`[WebSocketChannel] Token buffer for ${workspaceId.slice(0, 8)} exceeded 1000, trimmed`);
            }
        } else {
            tokenBuffer.set(workspaceId, {
                sessionId: '', // 会在 replay 时更新
                tokens: [token],
                createdAt: Date.now(),
            });
        }
    }

    /**
     * 重放缓存的 token 到新连接
     */
    replayCachedTokens(workspaceId: string, ws: any, sessionId?: string): void {
        const cache = tokenBuffer.get(workspaceId);
        if (!cache || cache.tokens.length === 0) {
            return;
        }

        if (Date.now() - cache.createdAt > TOKEN_BUFFER_TTL_MS) {
            tokenBuffer.delete(workspaceId);
            console.log(`[WebSocketChannel] Discarded expired token buffer for workspace ${workspaceId.slice(0, 8)}`);
            return;
        }

        console.log(`[WebSocketChannel] Replaying ${cache.tokens.length} cached tokens for workspace ${workspaceId.slice(0, 8)}`);

        // 更新 sessionId 如果提供
        if (sessionId) {
            cache.sessionId = sessionId;
        }

        // 回放事件结构必须与实时推送一致，避免前端协议分叉
        for (const token of cache.tokens) {
            try {
                const payload = {
                    type: token.type,
                    payload: token.content,
                    isReplay: true,
                    timestamp: token.timestamp,
                };
                ws.send(JSON.stringify(payload));
            } catch (err) {
                console.error('[WebSocketChannel] Replay error:', err);
            }
        }
    }

    private cleanupExpiredTokenBuffers(): void {
        const now = Date.now();
        let cleaned = 0;

        for (const [workspaceId, cache] of tokenBuffer.entries()) {
            if (now - cache.createdAt > TOKEN_BUFFER_TTL_MS) {
                tokenBuffer.delete(workspaceId);
                cleaned++;
            }
        }

        if (cleaned > 0) {
            console.log(`[WebSocketChannel] Cleaned ${cleaned} expired token buffers`);
        }
    }

    /**
     * 获取 workspace 的缓存 token 数量
     */
    getCachedTokenCount(workspaceId: string): number {
        return tokenBuffer.get(workspaceId)?.tokens.length || 0;
    }

    /**
     * 清空指定工作区的 token 缓存
     * 在消息完成时调用
     */
    clearTokenBuffer(workspaceId: string): void {
        const cache = tokenBuffer.get(workspaceId);
        if (cache) {
            const count = cache.tokens.length;
            tokenBuffer.delete(workspaceId);
            console.log(`[WebSocketChannel] Cleared ${count} cached tokens for workspace ${workspaceId.slice(0, 8)}`);
        }
    }

    /**
     * 广播到所有工作区
     */
    broadcastToAll(payload: any): void {
        for (const workspaceId of wsConnections.keys()) {
            this.broadcastToWorkspace(workspaceId, payload);
        }
    }

    /**
     * 获取工作区连接数
     */
    getConnectionCount(workspaceId?: string): number {
        if (workspaceId) {
            return wsConnections.get(workspaceId)?.size || 0;
        }

        let total = 0;
        for (const connections of wsConnections.values()) {
            total += connections.size;
        }
        return total;
    }

    /**
     * 获取所有活跃工作区ID
     */
    getActiveWorkspaces(): string[] {
        return Array.from(wsConnections.keys());
    }
}

// 单例实例
export const webSocketChannel = new WebSocketChannel();

/**
 * 清空指定工作区的 token 缓存（独立导出，供 finalizeMessage 调用）
 */
export function clearTokenBuffer(workspaceId: string): void {
    webSocketChannel.clearTokenBuffer(workspaceId);
}
