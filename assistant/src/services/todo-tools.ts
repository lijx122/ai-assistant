import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { getWorkspaceRootPath } from './workspace-config';

export interface TodoItem {
    text: string;
    done: boolean;
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
 * 文件不存在时返回空列表
 */
export function readTodoList(workspaceId: string): TodoList {
    const filePath = getTodoFilePath(workspaceId);

    try {
        if (!existsSync(filePath)) {
            return { items: [], updatedAt: Date.now() };
        }

        const content = readFileSync(filePath, 'utf8');
        const data = JSON.parse(content) as TodoList;

        // Validate data structure
        if (!Array.isArray(data.items)) {
            console.warn(`[TodoTools] Invalid todo list format for workspace ${workspaceId}, resetting`);
            return { items: [], updatedAt: Date.now() };
        }

        return {
            items: data.items.filter(item =>
                typeof item.text === 'string' &&
                typeof item.done === 'boolean'
            ),
            updatedAt: data.updatedAt || Date.now(),
        };
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
        return todoList;
    } catch (err) {
        console.error(`[TodoTools] Failed to write todo list for workspace ${workspaceId}:`, err);
        throw new Error(`Failed to save todo list: ${err}`);
    }
}

/**
 * 工具定义：todo_write
 * 用于 Agent 写入任务清单
 */
export const todoWriteToolDefinition = {
    name: 'todo_write',
    description: 'Write or update the task checklist for this conversation. Use this to track multi-step tasks. Each item has a text description and a done status.',
    input_schema: {
        type: 'object' as const,
        properties: {
            items: {
                type: 'array' as const,
                description: 'Array of todo items to save. This will replace the entire current list.',
                items: {
                    type: 'object' as const,
                    properties: {
                        text: {
                            type: 'string' as const,
                            description: 'The task description',
                        },
                        done: {
                            type: 'boolean' as const,
                            description: 'Whether the task is completed',
                        },
                    },
                    required: ['text', 'done'],
                },
            },
        },
        required: ['items'],
    },
};

/**
 * 工具定义：todo_read
 * 用于 Agent 读取当前任务清单
 */
export const todoReadToolDefinition = {
    name: 'todo_read',
    description: 'Read the current task checklist for this conversation. Use this to check progress on multi-step tasks before adding new items or marking items done.',
    input_schema: {
        type: 'object' as const,
        properties: {},
    },
};

/**
 * 执行 todo_write 工具调用
 */
export function executeTodoWrite(workspaceId: string, args: { items: TodoItem[] }): { success: boolean; message: string; count: number } {
    try {
        writeTodoList(workspaceId, args.items);
        const doneCount = args.items.filter(i => i.done).length;
        return {
            success: true,
            message: `Saved ${args.items.length} tasks (${doneCount} completed)`,
            count: args.items.length,
        };
    } catch (err: any) {
        return {
            success: false,
            message: `Failed to save tasks: ${err.message}`,
            count: 0,
        };
    }
}

/**
 * 执行 todo_read 工具调用
 */
export function executeTodoRead(workspaceId: string): { items: TodoItem[]; count: number; completed: number } {
    const list = readTodoList(workspaceId);
    const completed = list.items.filter(i => i.done).length;
    return {
        items: list.items,
        count: list.items.length,
        completed,
    };
}
