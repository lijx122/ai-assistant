export interface AuthContext {
    userId: string;
    role: 'admin' | 'member';
}

/**
 * 通知目标，用于任务完成后回源推送。
 * 飞书消息处理时自动写入 origin，Web 创建任务时可手动指定，实现跨渠道通知。
 */
export interface NotifyTarget {
    channel: 'lark' | 'web' | 'websocket' | 'none';
    chat_id?: string;         // 飞书 chat_id（私聊或群）
    user_open_id?: string;    // 飞书用户 open_id，群消息时附带 @
    is_group?: boolean;       // 是否为群消息
    message_id?: string;      // 原始消息 id，有则 reply，无则 create
    workspace_id?: string;    // WebSocket 渠道使用的工作区ID
}
