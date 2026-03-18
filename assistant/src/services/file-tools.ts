/**
 * 文件工具 - 在工作区读写文件
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { resolve, dirname, normalize } from 'path';
import { getDb } from '../db';

// 工具定义
export const readFileToolDefinition = {
    name: 'read_file',
    description: '读取工作区内的文件内容。必须提供 path 参数，路径相对工作区根目录（如 "src/index.ts"）。',
    input_schema: {
        type: 'object' as const,
        properties: {
            path: {
                type: 'string' as const,
                description: '要读取的文件路径，相对于工作区根目录',
            },
        },
        required: ['path' as const],
    },
};

export const writeFileToolDefinition = {
    name: 'write_file',
    description: '在工作区创建或覆盖文件。必须提供 path（文件路径）和 content（文件内容）两个参数。',
    input_schema: {
        type: 'object' as const,
        properties: {
            path: {
                type: 'string' as const,
                description: '文件路径，相对于工作区根目录（如 "src/index.ts"）',
            },
            content: {
                type: 'string' as const,
                description: '要写入的文件内容',
            },
        },
        required: ['path' as const, 'content' as const],
    },
};

// 安全检查：验证路径是否在工作区内
function validatePath(workspaceRoot: string, relativePath: string): string {
    // 规范化路径，防止 ../ 穿越
    const normalized = normalize(relativePath);
    if (normalized.startsWith('..') || normalized.includes('/../') || normalized.includes('\\..\\')) {
        throw new Error(`Invalid path: ${relativePath} (path traversal detected)`);
    }

    const resolvedPath = resolve(workspaceRoot, normalized);
    if (!resolvedPath.startsWith(workspaceRoot)) {
        throw new Error(`Invalid path: ${relativePath} (escapes workspace)`);
    }

    return resolvedPath;
}

// 获取工作区根路径
function getWorkspaceRoot(workspaceId: string): string {
    const db = getDb();
    const workspace = db.prepare('SELECT root_path FROM workspaces WHERE id = ?').get(workspaceId) as
        { root_path: string } | undefined;

    if (!workspace) {
        throw new Error(`Workspace ${workspaceId} not found`);
    }

    return workspace.root_path;
}

// 执行读取文件
export function executeReadFile(workspaceId: string, input: { path: string }): {
    content: string;
    size: number;
    truncated?: boolean;
} {
    const { path: relativePath } = input;
    const workspaceRoot = getWorkspaceRoot(workspaceId);
    const filePath = validatePath(workspaceRoot, relativePath);

    if (!existsSync(filePath)) {
        throw new Error(`File not found: ${relativePath}`);
    }

    const content = readFileSync(filePath, 'utf8');
    const MAX_SIZE = 50000; // 50KB

    if (content.length > MAX_SIZE) {
        return {
            content: content.slice(0, MAX_SIZE) + '\n[文件内容已截断，超过 50KB]',
            size: content.length,
            truncated: true,
        };
    }

    return {
        content,
        size: content.length,
    };
}

// 执行写入文件
export function executeWriteFile(workspaceId: string, input: { path: string; content: string }): {
    path: string;
    bytesWritten: number;
    created: boolean;
} {
    const { path: relativePath, content } = input;
    const workspaceRoot = getWorkspaceRoot(workspaceId);
    const filePath = validatePath(workspaceRoot, relativePath);

    // 检查文件是否已存在
    const existed = existsSync(filePath);

    // 自动创建父目录
    const parentDir = dirname(filePath);
    if (!existsSync(parentDir)) {
        mkdirSync(parentDir, { recursive: true });
    }

    // 写入文件
    writeFileSync(filePath, content, 'utf8');

    console.log(`[FileTool] ${existed ? 'Updated' : 'Created'}: ${relativePath} (${content.length} bytes)`);

    return {
        path: relativePath,
        bytesWritten: content.length,
        created: !existed,
    };
}
