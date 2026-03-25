import * as chrono from 'chrono-node';
import type { ToolDefinition, ToolContext, ToolResult } from './types';
import { executeCreateTask } from './task';

export const reminderSetToolDefinition: ToolDefinition = {
    name: 'reminder_set',
    description: '设置提醒。输入提醒内容和自然语言时间，系统会创建一次性定时任务，在指定时间发送提醒通知。',
    input_schema: {
        type: 'object',
        properties: {
            message: {
                type: 'string',
                description: '提醒内容，例如：开会、提交日报、喝水',
            },
            time: {
                type: 'string',
                description: '自然语言时间，例如：30分钟后、明天上午9点、2026-03-25 14:00',
            },
            notify: {
                type: 'string',
                enum: ['web', 'lark', 'both'],
                description: '通知渠道，默认 both',
            },
        },
        required: ['message', 'time'],
    },
};

export async function executeReminderSet(
    input: { message: string; time: string; notify?: 'web' | 'lark' | 'both' },
    context: ToolContext
): Promise<ToolResult> {
    const startTime = Date.now();
    const message = (input.message || '').trim();
    const time = (input.time || '').trim();
    const notify = input.notify || 'both';

    if (!message) {
        return {
            success: false,
            error: '提醒内容不能为空',
            elapsed_ms: Date.now() - startTime,
        };
    }

    if (!time) {
        return {
            success: false,
            error: '提醒时间不能为空',
            elapsed_ms: Date.now() - startTime,
        };
    }

    const now = new Date();
    const parsed = chrono.zh.parseDate(time, now, { forwardDate: true }) || chrono.parseDate(time, now, { forwardDate: true });

    if (!parsed) {
        return {
            success: false,
            error: '无法解析时间',
            elapsed_ms: Date.now() - startTime,
        };
    }

    if (parsed.getTime() <= now.getTime()) {
        return {
            success: false,
            error: '提醒时间必须晚于当前时间',
            elapsed_ms: Date.now() - startTime,
        };
    }

    const notifyTarget = notify === 'lark' ? { channel: 'lark' } : { channel: 'web' };

    const createResult = await executeCreateTask(
        {
            name: `提醒: ${message.slice(0, 20)}`,
            type: 'once',
            schedule: parsed.toISOString(),
            command_type: 'assistant',
            command: `发送提醒通知：${message}`,
            notify_target: notifyTarget,
        },
        context
    );

    if (!createResult.success) {
        return {
            ...createResult,
            elapsed_ms: Date.now() - startTime,
        };
    }

    const taskId = (createResult.data as { id?: string } | undefined)?.id || '';

    return {
        success: true,
        data: {
            message,
            scheduledAt: parsed.toISOString(),
            humanReadable: parsed.toLocaleString('zh-CN', { hour12: false }),
            taskId,
            notifyRequested: notify,
        },
        elapsed_ms: Date.now() - startTime,
    };
}

export const reminderSetTool = {
    definition: reminderSetToolDefinition,
    executor: executeReminderSet,
    riskLevel: 'medium' as const,
};
