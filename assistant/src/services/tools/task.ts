import { getDb } from '../../db';
import { randomUUID } from 'crypto';
import { registerTask } from '../../services/cron';
import type { ToolDefinition, ToolContext, ToolResult } from './types';

export async function executeCreateTask(
    input: any,
    context: ToolContext
): Promise<ToolResult> {
    const startTime = Date.now();
    const { workspaceId } = context;

    try {
        const {
            name,
            type,
            schedule,
            command,
            command_type,
            notify_target,
        } = input;

        // Validation
        if (!name || typeof name !== 'string') {
            return {
                success: false,
                error: 'Task name is required',
                elapsed_ms: Date.now() - startTime,
            };
        }

        if (!['cron', 'interval', 'once'].includes(type)) {
            return {
                success: false,
                error: 'Type must be "cron", "interval", or "once"',
                elapsed_ms: Date.now() - startTime,
            };
        }

        if (!['shell', 'assistant', 'http'].includes(command_type)) {
            return {
                success: false,
                error: 'Command type must be "shell", "assistant", or "http"',
                elapsed_ms: Date.now() - startTime,
            };
        }

        // Validate schedule based on type
        if (type === 'cron') {
            // Basic cron validation - should have 5 parts
            const parts = schedule.split(/\s+/);
            if (parts.length < 5) {
                return {
                    success: false,
                    error: 'Cron expression must have 5 fields (minute hour day month weekday)',
                    elapsed_ms: Date.now() - startTime,
                };
            }
        } else if (type === 'interval') {
            // Validate interval format (e.g., "30m", "2h", "1d")
            if (!/^\d+[mhd]$/.test(schedule)) {
                return {
                    success: false,
                    error: 'Interval must be in format like "30m", "2h", or "1d"',
                    elapsed_ms: Date.now() - startTime,
                };
            }
        } else if (type === 'once') {
            // Validate timestamp
            const date = new Date(schedule);
            if (isNaN(date.getTime())) {
                return {
                    success: false,
                    error: 'For "once" type, schedule must be a valid timestamp or ISO date string',
                    elapsed_ms: Date.now() - startTime,
                };
            }
        }

        // Shell and assistant commands require workspace
        if ((command_type === 'shell' || command_type === 'assistant') && !workspaceId) {
            return {
                success: false,
                error: `Workspace ID is required for "${command_type}" command type`,
                elapsed_ms: Date.now() - startTime,
            };
        }

        const db = getDb();
        const id = randomUUID();
        const now = Date.now();

        // Calculate next run time
        let nextRun: number | null = null;
        if (type === 'once') {
            nextRun = new Date(schedule).getTime();
        } else if (type === 'interval') {
            const match = schedule.match(/^(\d+)([mhd])$/);
            if (match) {
                const value = parseInt(match[1], 10);
                const unit = match[2];
                const ms = unit === 'm' ? value * 60000 : unit === 'h' ? value * 3600000 : value * 86400000;
                nextRun = now + ms;
            }
        }

        // Insert task
        db.prepare(
            `INSERT INTO tasks (id, workspace_id, user_id, name, type, schedule, command, command_type,
                              status, notify_target, last_run, next_run, run_count, fail_count, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, NULL, ?, 0, 0, ?)`
        ).run(
            id,
            workspaceId || '',
            'system', // system user for AI-created tasks
            name,
            type,
            schedule,
            command,
            command_type,
            notify_target ? JSON.stringify(notify_target) : null,
            nextRun,
            now
        );

        // Register with cron engine
        const task = {
            id,
            workspace_id: workspaceId || '',
            user_id: 'system',
            name,
            type,
            schedule,
            command,
            command_type,
            status: 'active' as const,
            notify_target: notify_target ? JSON.stringify(notify_target) : null,
            alert_on_error: 0,
            last_run: null,
            next_run: nextRun,
            run_count: 0,
            fail_count: 0,
            created_at: now,
        };
        registerTask(task);

        return {
            success: true,
            data: {
                id,
                name,
                type,
                schedule,
                command_type,
                status: 'active',
                next_run: nextRun,
                message: `Task "${name}" created successfully. It will run ${type === 'once' ? 'once' : 'automatically'} according to the schedule.`,
            },
            elapsed_ms: Date.now() - startTime,
        };
    } catch (err: any) {
        return {
            success: false,
            error: `Failed to create task: ${err.message}`,
            elapsed_ms: Date.now() - startTime,
        };
    }
}

/**
 * create_task 工具定义
 */
export const createTaskToolDefinition: ToolDefinition = {
    name: 'create_task',
    description: 'Create a scheduled task (cron job) that runs automatically at specified intervals. Supports cron expressions, fixed intervals (e.g., 30m, 2h, 1d), or one-time execution. The task can execute shell commands, HTTP requests, or AI assistant conversations.',
    input_schema: {
        type: 'object',
        properties: {
            name: {
                type: 'string',
                description: 'A descriptive name for the task, e.g., "Daily Backup" or "Hourly Report"',
            },
            type: {
                type: 'string',
                enum: ['cron', 'interval', 'once'],
                description: 'The scheduling type: "cron" for cron expressions, "interval" for fixed intervals (30m, 2h, 1d), or "once" for one-time execution',
            },
            schedule: {
                type: 'string',
                description: 'The schedule: cron expression (e.g., "0 2 * * *" for 2 AM daily), interval (e.g., "30m", "2h", "1d"), or ISO timestamp for once type',
            },
            command: {
                type: 'string',
                description: 'The command to execute: shell command, HTTP URL, or AI prompt depending on command_type',
            },
            command_type: {
                type: 'string',
                enum: ['shell', 'assistant', 'http'],
                description: 'The execution type: "shell" for shell commands, "assistant" for AI conversation, "http" for webhook requests',
            },
            notify_target: {
                type: 'object',
                description: 'Optional notification target for task completion/failure',
                properties: {
                    channel: {
                        type: 'string',
                        enum: ['lark', 'web'],
                        description: 'Notification channel: "lark" for Feishu/Lark, "web" for web dashboard',
                    },
                    chat_id: {
                        type: 'string',
                        description: 'For lark channel: the chat_id to send notifications to',
                    },
                },
            },
        },
        required: ['name', 'type', 'schedule', 'command', 'command_type'],
    },
};

/**
 * 注册的工具配置
 */
export const createTaskTool = {
    definition: createTaskToolDefinition,
    executor: executeCreateTask,
    riskLevel: 'medium' as const,
};
