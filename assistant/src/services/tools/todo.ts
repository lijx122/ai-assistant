/**
 * Todo 工具 - 任务清单管理
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { getWorkspaceRootPath } from '../workspace-config';
import type { ToolDefinition, ToolContext, ToolResult } from './types';

export interface TodoItem {
    text: string;
    status: 'pending' | 'running' | 'done' | 'failed';
    output?: string;
    error?: string;
    // 兼容老的字段
    done?: boolean;
}

export interface TodoList {
    items: TodoItem[];
    updatedAt: number;
}

const TODO_FILENAME = '.todo.json';

/**
 * 获取工作区 todo 文件路径
 */
export function getTodoFilePath(workspaceId: string): string {
    const rootPath = getWorkspaceRootPath(workspaceId);
    return resolve(rootPath, TODO_FILENAME);
}

/**
 * 读取工作区的 todo 列表
 */
export function readTodoList(workspaceId: string): TodoList {
    const filePath = getTodoFilePath(workspaceId);

    try {
        if (!existsSync(filePath)) {
            return { items: [], updatedAt: Date.now() };
        }

        const content = readFileSync(filePath, 'utf8');
        const data = JSON.parse(content) as TodoList;

        if (!Array.isArray(data.items)) {
            console.warn(`[TodoTools] Invalid todo list format for workspace ${workspaceId}, resetting`);
            return { items: [], updatedAt: Date.now() };
        }

        let changed = false;
        const validItems = data.items.filter(item => typeof item.text === 'string').map(item => {
            if (item.status) return item;
            // 兼容迁移旧格式
            changed = true;
            return {
                text: item.text,
                status: item.done ? 'done' as const : 'pending' as const
            };
        });

        const list = {
            items: validItems,
            updatedAt: data.updatedAt || Date.now(),
        };

        if (changed) {
            // 如果做了迁移，顺手写回
            try { writeTodoList(workspaceId, validItems); } catch {}
        }
        
        return list;
    } catch (err) {
        console.warn(`[TodoTools] Failed to read todo list for workspace ${workspaceId}:`, err);
        return { items: [], updatedAt: Date.now() };
    }
}

/**
 * 写入工作区的 todo 列表
 */
export function writeTodoList(workspaceId: string, items: TodoItem[]): TodoList {
    const filePath = getTodoFilePath(workspaceId);
    const todoList: TodoList = {
        items,
        updatedAt: Date.now(),
    };

    try {
        writeFileSync(filePath, JSON.stringify(todoList, null, 2), 'utf8');
        
        // Broadcast WS event after writing
        import('../../routes/chat').then(({ broadcastToWorkspace }) => {
            broadcastToWorkspace(workspaceId, {
                type: 'todo_updated',
                payload: todoList
            });
        }).catch(err => console.error('[TodoTools] Failed to broadcast todo_updated event:', err));

        return todoList;
    } catch (err) {
        console.error(`[TodoTools] Failed to write todo list for workspace ${workspaceId}:`, err);
        throw new Error(`Failed to save todo list: ${err}`);
    }
}

/**
 * todo_read 工具定义
 */
export const todoReadToolDefinition: ToolDefinition = {
    name: 'todo_read',
    description: 'Read the current task checklist for this conversation. Use this to check progress on multi-step tasks before adding new items or marking items done.',
    input_schema: {
        type: 'object',
        properties: {},
    },
};

/**
 * todo_write 工具定义
 */
export const todoWriteToolDefinition: ToolDefinition = {
    name: 'todo_write',
    description: 'Write or update the task checklist for this conversation. Use this to track multi-step tasks. Each item has a text description and a done status.',
    input_schema: {
        type: 'object',
        properties: {
            items: {
                type: 'array',
                description: 'Array of todo items to save. This will replace the entire current list.',
                items: {
                    type: 'object',
                    properties: {
                        text: {
                            type: 'string',
                            description: 'The task description',
                        },
                        status: {
                            type: 'string',
                            enum: ['pending', 'running', 'done', 'failed'],
                            description: 'Status of the task',
                        },
                        output: {
                            type: 'string',
                            description: 'Execution output, if any',
                        },
                        error: {
                            type: 'string',
                            description: 'Error output, if any',
                        }
                    },
                    required: ['text', 'status'],
                },
            },
        },
        required: ['items'],
    },
};

/**
 * 执行 todo_read
 */
export function executeTodoRead(_input: {}, context: ToolContext): ToolResult {
    const startTime = Date.now();
    const { workspaceId } = context;

    try {
        const list = readTodoList(workspaceId);
        const completed = list.items.filter(i => i.status === 'done').length;

        return {
            success: true,
            data: {
                items: list.items,
                count: list.items.length,
                completed,
            },
            elapsed_ms: Date.now() - startTime,
        };
    } catch (err: any) {
        return {
            success: false,
            error: `Failed to read todo list: ${err.message}`,
            elapsed_ms: Date.now() - startTime,
        };
    }
}

/**
 * 执行 todo_write
 */
export function executeTodoWrite(input: { items: TodoItem[] }, context: ToolContext): ToolResult {
    const startTime = Date.now();
    const { items } = input;
    const { workspaceId } = context;

    try {
        // Enforce status if not provided, for backwards compatibility
        const validItems = items.map(i => ({
            ...i,
            status: i.status || (i.done ? 'done' : 'pending')
        }));

        writeTodoList(workspaceId, validItems);
        const doneCount = validItems.filter(i => i.status === 'done').length;

        return {
            success: true,
            data: {
                message: `Saved ${validItems.length} tasks (${doneCount} completed)`,
                count: validItems.length,
                completed: doneCount,
            },
            elapsed_ms: Date.now() - startTime,
        };
    } catch (err: any) {
        return {
            success: false,
            error: `Failed to save tasks: ${err.message}`,
            elapsed_ms: Date.now() - startTime,
        };
    }
}

/**
 * 注册的工具配置
 */
export const todoReadTool = {
    definition: todoReadToolDefinition,
    executor: executeTodoRead,
    riskLevel: 'low' as const,
};

export const todoWriteTool = {
    definition: todoWriteToolDefinition,
    executor: executeTodoWrite,
    riskLevel: 'low' as const,
};
