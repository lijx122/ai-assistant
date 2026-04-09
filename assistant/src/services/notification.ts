/**
 * Notification Manager — 任务通知动态渠道分发
 *
 * cron 任务完成后调用此服务，消息会分发到所有已注册且支持通知的渠道。
 * 微信/飞书/WebSocket 均通过 Channel.canNotify/sendNotification 抽象，无需硬编码。
 *
 * @module src/services/notification
 */

import { channelManager } from '../channels';
import { logger } from './logger';

export type NotifyLevel = 'info' | 'warn' | 'error';

/** 与 cron.ts 中 Task 的必要字段子集对齐 */
interface TaskSnapshot {
    id: string;
    workspace_id: string;
    name: string;
    command_type: string;
    notify_enabled: number;
    /** JSON string of { channels?: string[] } */
    notify_target: string | null;
}

/**
 * 格式化任务执行结果为通知文本
 */
export function formatTaskNotification(
    task: Pick<TaskSnapshot, 'name' | 'command_type'>,
    status: 'success' | 'error' | 'timeout',
    output: string | null,
    error: string | null,
    durationMs: number
): { message: string; level: NotifyLevel } {
    const time = new Date().toLocaleString('zh-CN');
    const durationSec = Math.round(durationMs / 1000);

    if (status === 'success') {
        const truncated = output && output.length > 200
            ? output.slice(0, 200) + '…（已截断）'
            : (output || '(无输出)');
        return {
            message: `定时任务「${task.name}」执行成功\n时间：${time}\n耗时：${durationSec}s\n输出：${truncated}`,
            level: 'info',
        };
    }

    const truncatedError = error && error.length > 300
        ? error.slice(0, 300) + '…（已截断）'
        : (error || '未知错误');
    return {
        message: `定时任务「${task.name}」执行失败\n时间：${time}\n耗时：${durationSec}s\n错误：${truncatedError}`,
        level: status === 'timeout' ? 'warn' : 'error',
    };
}

/**
 * 发送任务通知到所有支持通知的渠道
 */
export async function sendTaskNotification(params: {
    task: Pick<TaskSnapshot, 'id' | 'workspace_id' | 'name' | 'command_type' | 'notify_enabled' | 'notify_target'>;
    status: 'success' | 'error' | 'timeout';
    output: string | null;
    error: string | null;
    durationMs: number;
}): Promise<void> {
    const { task, status, output, error, durationMs } = params;

    // 解析勾选的渠道列表（兼容旧格式：notify_target.type）
    let notifyChannels: string[] = [];
    try {
        if (task.notify_target) {
            const parsed = JSON.parse(task.notify_target);
            if (Array.isArray(parsed.channels)) {
                notifyChannels = parsed.channels;
            } else if (parsed.type) {
                // 旧格式兼容
                notifyChannels = [parsed.type];
            }
        }
    } catch {
        // 解析失败，忽略
    }

    const allChannels = channelManager.getNotifiableChannels();
    const targetChannels = allChannels.filter(ch => notifyChannels.includes(ch.name));

    if (targetChannels.length === 0) {
        console.debug('[Notification] No matching notify channels for task', task.id);
        return;
    }

    const { message, level } = formatTaskNotification(task, status, output, error, durationMs);
    console.log(`[Notification] Sending ${status} notification for task "${task.name}" to ${targetChannels.length} channel(s): ${notifyChannels.join(',')}`);

    const results = await Promise.allSettled(
        targetChannels.map(channel =>
            channel.sendNotification(message, level)
                .then(ok => ({ channel: channel.name, ok }))
        )
    );

    for (const result of results) {
        if (result.status === 'fulfilled') {
            const { channel: chName, ok } = result.value;
            if (ok) {
                console.log(`[Notification] Sent via ${chName}`);
            } else {
                console.warn(`[Notification] Failed to send via ${chName}`);
            }
        } else {
            console.error(`[Notification] Exception sending via channel:`, result.reason());
        }
    }

    logger.system.info('notification', `Task notification sent: ${task.name} [${status}]`, {
        taskId: task.id,
        workspaceId: task.workspace_id,
        channelCount: targetChannels.length,
        channels: notifyChannels,
        level,
    });
}
