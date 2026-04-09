/**
 * Channel 抽象基类
 * 统一飞书、WebSocket 等所有消息渠道的接口
 *
 * @module src/channels/base
 */

import type { NotifyTarget } from '../types';

/**
 * 统一消息结构
 */
export interface ChannelMessage {
    /** 消息唯一ID */
    id: string;
    /** 会话ID */
    sessionId: string;
    /** 工作区ID */
    workspaceId: string;
    /** 发送者角色 */
    role: 'user' | 'assistant' | 'system';
    /** 消息内容 */
    content: string;
    /** 创建时间戳 */
    createdAt: number;
    /** 原始渠道特定ID（如飞书message_id） */
    channelMessageId?: string;
    /** 发送者OpenID（渠道特定） */
    senderId?: string;
    /** 是否群聊 */
    isGroup?: boolean;
    /** 原始渠道数据 */
    raw?: any;
    /** 按钮点击时的 action 标识（交互按钮统一处理） */
    actionId?: string;
    /** 按钮附带数据 */
    actionData?: any;
    /** 命令类型（若为命令消息） */
    command?: Command;
}

/**
 * 命令类型枚举
 */
export type CommandType =
    | 'workspace_switch'  // /ws 切换工作区
    | 'workspace_list'    // /workspaces 列出工作区
    | 'help'              // /help 帮助
    | 'terminal_block';   // /terminal 等终端命令拦截

/**
 * 命令结构
 */
export interface Command {
    type: CommandType;
    /** 命令原始文本 */
    raw: string;
    /** 命令参数（如 /ws xxx 中的 xxx） */
    args?: string;
}

/**
 * 消息处理函数类型
 */
export type MessageHandler = (message: ChannelMessage) => void | Promise<void>;

/**
 * 告警操作按钮
 */
export interface AlertAction {
    /** 操作ID */
    id: string;
    /** 显示文本 */
    label: string;
    /** 样式: primary/secondary/danger */
    style?: 'primary' | 'secondary' | 'danger';
    /** 点击后发送的回复文本 */
    replyText?: string;
}

/**
 * 发送选项
 */
export interface SendOptions {
    /** 目标会话/聊天ID */
    target?: NotifyTarget | string;
    /** 是否静默（不触发通知） */
    silent?: boolean;
    /** 回复特定消息ID */
    replyToMessageId?: string;
}

/**
 * 告警选项
 */
export interface AlertOptions {
    /** 告警级别 */
    level?: 'info' | 'warning' | 'error' | 'critical';
    /** 操作按钮 */
    actions?: AlertAction[];
    /** 目标渠道（不指定则广播到所有渠道） */
    target?: NotifyTarget;
}

/**
 * 等待回复结果
 */
export interface ReplyResult {
    /** 是否超时 */
    timedOut: boolean;
    /** 回复内容（超时为null） */
    content: string | null;
    /** 回复者ID */
    senderId?: string;
}

/**
 * 渠道抽象基类
 * 所有具体渠道（飞书、WebSocket等）必须实现此接口
 */
export abstract class Channel {
    /** 渠道名称标识 */
    abstract readonly name: string;

    /** 是否已初始化 */
    protected initialized = false;

    /** 消息处理器（由上层注册） */
    protected messageHandler?: MessageHandler;

    /**
     * 检测渠道是否可用（已配置且可连接）
     * @returns 是否可用
     */
    abstract isAvailable(): boolean;

    /**
     * 初始化渠道
     * 在服务器启动时调用
     */
    abstract initialize(): Promise<void>;

    /**
     * 优雅关闭渠道
     * 在服务器关闭时调用
     */
    abstract shutdown(): Promise<void>;

    /**
     * 注册消息处理器
     * @param handler 处理收到的用户消息
     */
    onMessage(handler: MessageHandler): void {
        this.messageHandler = handler;
    }

    /**
     * 发送普通消息
     * @param text 消息文本
     * @param options 发送选项
     * @returns 是否发送成功
     */
    abstract sendMessage(text: string, options?: SendOptions): Promise<boolean>;

    /**
     * 发送告警通知
     * @param text 告警内容
     * @param options 告警选项
     * @returns 是否发送成功
     */
    abstract sendAlert(text: string, options?: AlertOptions): Promise<boolean>;

    /**
     * 等待用户回复（Human-in-the-loop）
     * @param timeoutMs 超时时间（毫秒）
     * @returns 回复结果
     */
    abstract waitReply(timeoutMs?: number): Promise<ReplyResult>;

    /**
     * 检测渠道是否支持主动通知（任务完成/失败时推送）
     * @returns 是否可以发送通知
     */
    canNotify(): boolean {
        return this.isAvailable();
    }

    /**
     * 发送任务通知
     * @param message 通知内容（格式化好的文本）
     * @param level 通知级别
     * @returns 是否发送成功
     */
    async sendNotification(message: string, level: 'info' | 'warn' | 'error'): Promise<boolean> {
        // 默认实现：降级为 sendAlert
        try {
            const alertLevel = level === 'info' ? 'info' : level === 'warn' ? 'warning' : 'error';
            return await this.sendAlert(message, { level: alertLevel });
        } catch {
            return false;
        }
    }

    /**
     * 发送确认请求（危险操作）
     * 默认实现基于 sendAlert + waitReply
     * @param title 确认标题
     * @param description 描述信息
     * @param actions 操作选项（默认：确认/取消）
     * @param timeoutMs 超时时间
     * @returns 用户选择的操作ID，超时为null
     */
    async requestConfirmation(
        title: string,
        description: string,
        actions?: AlertAction[],
        timeoutMs = 300000 // 默认5分钟
    ): Promise<string | null> {
        const defaultActions: AlertAction[] = [
            { id: 'confirm', label: '确认', style: 'danger', replyText: '确认' },
            { id: 'cancel', label: '取消', style: 'secondary', replyText: '取消' },
        ];

        const text = `⚠️ **${title}**\n\n${description}`;

        await this.sendAlert(text, {
            level: 'warning',
            actions: actions || defaultActions,
        });

        const result = await this.waitReply(timeoutMs);

        if (result.timedOut || !result.content) {
            return null;
        }

        // 匹配用户回复与操作选项
        const replyLower = result.content.toLowerCase().trim();
        const availableActions = actions || defaultActions;

        for (const action of availableActions) {
            if (replyLower === action.id.toLowerCase() ||
                replyLower === action.label.toLowerCase() ||
                replyLower === (action.replyText || '').toLowerCase()) {
                return action.id;
            }
        }

        // 未匹配到任何操作，返回原始内容让上层处理
        return result.content;
    }

    /**
     * 保护方法：触发消息处理
     * 子类在收到消息时调用此方法
     */
    protected async handleIncomingMessage(message: ChannelMessage): Promise<void> {
        if (this.messageHandler) {
            try {
                await this.messageHandler(message);
            } catch (err) {
                console.error(`[Channel:${this.name}] Message handler error:`, err);
            }
        }
    }
}

/**
 * 渠道管理器
 * 统一管理多个渠道实例
 */
export class ChannelManager {
    private channels = new Map<string, Channel>();
    private messageHandler?: MessageHandler;

    /**
     * 注册渠道
     */
    register(channel: Channel): void {
        this.channels.set(channel.name, channel);
        // 绑定统一的消息处理器
        channel.onMessage((msg) => this.handleMessage(msg));
    }

    /**
     * 设置全局消息处理器
     */
    onMessage(handler: MessageHandler): void {
        this.messageHandler = handler;
    }

    /**
     * 获取指定渠道
     */
    get(name: string): Channel | undefined {
        return this.channels.get(name);
    }

    /**
     * 获取所有可用渠道
     */
    getAvailable(): Channel[] {
        return Array.from(this.channels.values()).filter(c => c.isAvailable());
    }

    /**
     * 获取所有支持主动通知的渠道
     */
    getNotifiableChannels(): Channel[] {
        return Array.from(this.channels.values()).filter(c => c.canNotify());
    }

    /**
     * 广播消息到所有可用渠道
     */
    async broadcast(text: string, options?: SendOptions): Promise<void> {
        const available = this.getAvailable();
        for (const channel of available) {
            try {
                await channel.sendMessage(text, options);
            } catch (err) {
                console.error(`[ChannelManager] Failed to broadcast via ${channel.name}:`, err);
            }
        }
    }

    /**
     * 发送告警到所有渠道或指定渠道
     */
    async alert(text: string, options?: AlertOptions): Promise<void> {
        const available = this.getAvailable();

        // 如果指定了目标渠道，只发送到该渠道
        if (options?.target?.channel) {
            const targetChannel = this.channels.get(options.target.channel);
            if (targetChannel?.isAvailable()) {
                await targetChannel.sendAlert(text, options);
            }
            return;
        }

        // 否则广播到所有渠道
        for (const channel of available) {
            try {
                await channel.sendAlert(text, options);
            } catch (err) {
                console.error(`[ChannelManager] Failed to alert via ${channel.name}:`, err);
            }
        }
    }

    /**
     * 初始化所有渠道
     */
    async initializeAll(): Promise<void> {
        for (const channel of this.channels.values()) {
            if (channel.isAvailable()) {
                try {
                    await channel.initialize();
                } catch (err) {
                    console.error(`[ChannelManager] Failed to initialize ${channel.name}:`, err);
                }
            }
        }
    }

    /**
     * 关闭所有渠道
     */
    async shutdownAll(): Promise<void> {
        for (const channel of this.channels.values()) {
            try {
                await channel.shutdown();
            } catch (err) {
                console.error(`[ChannelManager] Failed to shutdown ${channel.name}:`, err);
            }
        }
    }

    /**
     * 获取所有渠道状态
     */
    getStatus(): Array<{ name: string; available: boolean }> {
        return Array.from(this.channels.values()).map(channel => ({
            name: channel.name,
            available: channel.isAvailable(),
        }));
    }

    private async handleMessage(message: ChannelMessage): Promise<void> {
        if (this.messageHandler) {
            await this.messageHandler(message);
        }
    }
}

// 全局渠道管理器实例
export const channelManager = new ChannelManager();
