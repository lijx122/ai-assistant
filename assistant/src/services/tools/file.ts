/**
 * File 工具 - 在工作区读写文件
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, renameSync, statSync } from 'fs';
import { resolve, dirname, normalize } from 'path';
import { getDb } from '../../db';
import type { ToolDefinition, ToolContext, ToolResult } from './types';

const MAX_FILE_SIZE = 50000; // 50KB

/**
 * 安全检查：验证路径是否在工作区内
 */
function validatePath(workspaceRoot: string, relativePath: string): { valid: boolean; error?: string; resolvedPath?: string } {
    const normalized = normalize(relativePath);
    if (normalized.startsWith('..') || normalized.includes('/../') || normalized.includes('\\..\\')) {
        return { valid: false, error: `Invalid path: ${relativePath} (path traversal detected)` };
    }

    const resolvedPath = resolve(workspaceRoot, normalized);
    if (!resolvedPath.startsWith(workspaceRoot)) {
        return { valid: false, error: `Invalid path: ${relativePath} (escapes workspace)` };
    }

    return { valid: true, resolvedPath };
}

/**
 * 获取工作区根路径
 */
function getWorkspaceRoot(workspaceId: string): { success: boolean; path?: string; error?: string } {
    const db = getDb();
    const workspace = db.prepare('SELECT root_path FROM workspaces WHERE id = ?').get(workspaceId) as
        { root_path: string } | undefined;

    if (!workspace) {
        return { success: false, error: `Workspace ${workspaceId} not found` };
    }

    return { success: true, path: workspace.root_path };
}

/**
 * read_file 工具定义
 */
export const readFileToolDefinition: ToolDefinition = {
    name: 'read_file',
    description: '读取工作区内的文件内容。必须提供 path 参数，路径相对工作区根目录（如 "src/index.ts"）。文件大小超过 50KB 会被截断。',
    input_schema: {
        type: 'object',
        properties: {
            path: {
                type: 'string',
                description: '要读取的文件路径，相对于工作区根目录',
            },
        },
        required: ['path'],
    },
};

/**
 * write_file 工具定义
 */
export const writeFileToolDefinition: ToolDefinition = {
    name: 'write_file',
    description: '在工作区创建或覆盖文件。必须提供 path（文件路径）和 content（文件内容）两个参数。自动创建父目录。',
    input_schema: {
        type: 'object',
        properties: {
            path: {
                type: 'string',
                description: '文件路径，相对于工作区根目录（如 "src/index.ts"）',
            },
            content: {
                type: 'string',
                description: '要写入的文件内容',
            },
        },
        required: ['path', 'content'],
    },
};

/**
 * 执行读取文件
 */
export function executeReadFile(
    input: { path: string },
    context: ToolContext
): ToolResult {
    const startTime = Date.now();
    const { path: relativePath } = input;
    const { workspaceId } = context;

    const ws = getWorkspaceRoot(workspaceId);
    if (!ws.success) {
        return { success: false, error: ws.error, elapsed_ms: Date.now() - startTime };
    }

    const validation = validatePath(ws.path!, relativePath);
    if (!validation.valid) {
        return { success: false, error: validation.error, elapsed_ms: Date.now() - startTime };
    }

    const filePath = validation.resolvedPath!;

    if (!existsSync(filePath)) {
        return {
            success: false,
            error: `File not found: ${relativePath}`,
            elapsed_ms: Date.now() - startTime,
        };
    }

    try {
        const content = readFileSync(filePath, 'utf8');
        const truncated = content.length > MAX_FILE_SIZE;

        return {
            success: true,
            data: {
                content: truncated ? content.slice(0, MAX_FILE_SIZE) + '\n[文件内容已截断，超过 50KB]' : content,
                size: content.length,
                truncated,
                path: relativePath,
            },
            truncated,
            elapsed_ms: Date.now() - startTime,
        };
    } catch (err: any) {
        return {
            success: false,
            error: `Failed to read file: ${err.message}`,
            elapsed_ms: Date.now() - startTime,
        };
    }
}

/**
 * 执行写入文件
 */
export function executeWriteFile(
    input: { path: string; content: string },
    context: ToolContext
): ToolResult {
    const startTime = Date.now();
    const { path: relativePath, content } = input;
    const { workspaceId } = context;

    const ws = getWorkspaceRoot(workspaceId);
    if (!ws.success) {
        return { success: false, error: ws.error, elapsed_ms: Date.now() - startTime };
    }

    const validation = validatePath(ws.path!, relativePath);
    if (!validation.valid) {
        return { success: false, error: validation.error, elapsed_ms: Date.now() - startTime };
    }

    const filePath = validation.resolvedPath!;
    const existed = existsSync(filePath);

    try {
        // 自动创建父目录
        const parentDir = dirname(filePath);
        if (!existsSync(parentDir)) {
            mkdirSync(parentDir, { recursive: true });
        }

        writeFileSync(filePath, content, 'utf8');

        console.log(`[FileTool] ${existed ? 'Updated' : 'Created'}: ${relativePath} (${content.length} bytes)`);

        return {
            success: true,
            data: {
                path: relativePath,
                bytesWritten: content.length,
                created: !existed,
            },
            elapsed_ms: Date.now() - startTime,
        };
    } catch (err: any) {
        return {
            success: false,
            error: `Failed to write file: ${err.message}`,
            elapsed_ms: Date.now() - startTime,
        };
    }
}

/**
 * 注册的工具配置
 */
export const readFileTool = {
    definition: readFileToolDefinition,
    executor: executeReadFile,
    riskLevel: 'low' as const,
};

export const writeFileTool = {
    definition: writeFileToolDefinition,
    executor: executeWriteFile,
    riskLevel: 'medium' as const, // 写操作中等风险
};

/**
 * file_delete 工具定义
 */
export const deleteFileToolDefinition: ToolDefinition = {
    name: 'file_delete',
    description: '删除工作区内的文件或目录。必须提供 path 参数。默认不递归删除目录，设置 recursive=true 可递归删除。此操作需要人工确认。',
    input_schema: {
        type: 'object',
        properties: {
            path: {
                type: 'string',
                description: '要删除的文件或目录路径，相对于工作区根目录',
            },
            recursive: {
                type: 'boolean',
                description: '是否递归删除目录（危险操作，需要确认）',
            },
        },
        required: ['path'],
    },
};

/**
 * file_move 工具定义
 */
export const moveFileToolDefinition: ToolDefinition = {
    name: 'file_move',
    description: '移动或重命名工作区内的文件或目录。必须提供 source（源路径）和 destination（目标路径）。',
    input_schema: {
        type: 'object',
        properties: {
            source: {
                type: 'string',
                description: '源文件或目录路径，相对于工作区根目录',
            },
            destination: {
                type: 'string',
                description: '目标路径，相对于工作区根目录',
            },
            overwrite: {
                type: 'boolean',
                description: '是否覆盖已存在的目标文件（设置为 true 时需要确认）',
            },
        },
        required: ['source', 'destination'],
    },
};

/**
 * 执行删除文件/目录
 */
export function executeDeleteFile(
    input: { path: string; recursive?: boolean },
    context: ToolContext
): ToolResult {
    const startTime = Date.now();
    const { path: relativePath, recursive = false } = input;
    const { workspaceId } = context;

    const ws = getWorkspaceRoot(workspaceId);
    if (!ws.success) {
        return { success: false, error: ws.error, elapsed_ms: Date.now() - startTime };
    }

    const validation = validatePath(ws.path!, relativePath);
    if (!validation.valid) {
        return { success: false, error: validation.error, elapsed_ms: Date.now() - startTime };
    }

    const filePath = validation.resolvedPath!;

    if (!existsSync(filePath)) {
        return {
            success: false,
            error: `File not found: ${relativePath}`,
            elapsed_ms: Date.now() - startTime,
        };
    }

    // 检查是否是目录且需要递归删除
    const stats = statSync(filePath);
    const isDir = stats.isDirectory();

    // 删除操作总是需要确认
    const confirmationId = `delete-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
    return {
        success: false,
        error: `删除操作需要确认: ${isDir ? '目录' : '文件'} "${relativePath}"`,
        requiresConfirmation: true,
        confirmationId,
        confirmationTitle: isDir ? '⚠️ 删除目录确认' : '⚠️ 删除文件确认',
        confirmationDescription: isDir
            ? `即将删除目录: ${relativePath}${recursive ? '（递归删除所有内容）' : '（仅删除空目录）'}\n\n此操作不可撤销，确认继续吗？`
            : `即将删除文件: ${relativePath}\n\n此操作不可撤销，确认继续吗？`,
        riskLevel: isDir && recursive ? 'high' : 'medium',
        elapsed_ms: 0,
    };
}

/**
 * 执行移动/重命名文件
 */
export function executeMoveFile(
    input: { source: string; destination: string; overwrite?: boolean },
    context: ToolContext
): ToolResult {
    const startTime = Date.now();
    const { source: sourcePath, destination: destPath, overwrite = false } = input;
    const { workspaceId } = context;

    const ws = getWorkspaceRoot(workspaceId);
    if (!ws.success) {
        return { success: false, error: ws.error, elapsed_ms: Date.now() - startTime };
    }

    const sourceValidation = validatePath(ws.path!, sourcePath);
    if (!sourceValidation.valid) {
        return { success: false, error: sourceValidation.error, elapsed_ms: Date.now() - startTime };
    }

    const destValidation = validatePath(ws.path!, destPath);
    if (!destValidation.valid) {
        return { success: false, error: destValidation.error, elapsed_ms: Date.now() - startTime };
    }

    const sourceFullPath = sourceValidation.resolvedPath!;
    const destFullPath = destValidation.resolvedPath!;

    if (!existsSync(sourceFullPath)) {
        return {
            success: false,
            error: `Source not found: ${sourcePath}`,
            elapsed_ms: Date.now() - startTime,
        };
    }

    const destExists = existsSync(destFullPath);

    // 如果目标已存在且需要覆盖，则返回确认请求
    if (destExists && overwrite) {
        const confirmationId = `move-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
        return {
            success: false,
            error: `覆盖操作需要确认: 目标 "${destPath}" 已存在`,
            requiresConfirmation: true,
            confirmationId,
            confirmationTitle: '⚠️ 覆盖文件确认',
            confirmationDescription: `移动操作将覆盖已存在的目标: ${destPath}\n\n源文件: ${sourcePath}\n目标文件: ${destPath}\n\n此操作不可撤销，确认继续吗？`,
            riskLevel: 'medium',
            elapsed_ms: 0,
        };
    }

    // 普通移动操作（无需确认）
    try {
        renameSync(sourceFullPath, destFullPath);

        console.log(`[FileTool] Moved: ${sourcePath} -> ${destPath}`);

        return {
            success: true,
            data: {
                source: sourcePath,
                destination: destPath,
                overwritten: false,
            },
            elapsed_ms: Date.now() - startTime,
        };
    } catch (err: any) {
        return {
            success: false,
            error: `Failed to move file: ${err.message}`,
            elapsed_ms: Date.now() - startTime,
        };
    }
}

/**
 * 实际执行删除操作（确认后调用）
 */
export function executeConfirmedDelete(
    input: { path: string; recursive?: boolean },
    context: ToolContext
): ToolResult {
    const startTime = Date.now();
    const { path: relativePath, recursive = false } = input;
    const { workspaceId } = context;

    const ws = getWorkspaceRoot(workspaceId);
    if (!ws.success) {
        return { success: false, error: ws.error, elapsed_ms: Date.now() - startTime };
    }

    const validation = validatePath(ws.path!, relativePath);
    if (!validation.valid) {
        return { success: false, error: validation.error, elapsed_ms: Date.now() - startTime };
    }

    const filePath = validation.resolvedPath!;

    if (!existsSync(filePath)) {
        return {
            success: false,
            error: `File not found: ${relativePath}`,
            elapsed_ms: Date.now() - startTime,
        };
    }

    try {
        const stats = statSync(filePath);
        const isDir = stats.isDirectory();

        rmSync(filePath, { recursive });

        console.log(`[FileTool] Deleted: ${relativePath}${isDir && recursive ? ' (recursive)' : ''}`);

        return {
            success: true,
            data: {
                path: relativePath,
                isDirectory: isDir,
                recursive,
            },
            elapsed_ms: Date.now() - startTime,
        };
    } catch (err: any) {
        return {
            success: false,
            error: `Failed to delete: ${err.message}`,
            elapsed_ms: Date.now() - startTime,
        };
    }
}

/**
 * 实际执行移动覆盖操作（确认后调用）
 */
export function executeConfirmedMove(
    input: { source: string; destination: string },
    context: ToolContext
): ToolResult {
    const startTime = Date.now();
    const { source: sourcePath, destination: destPath } = input;
    const { workspaceId } = context;

    const ws = getWorkspaceRoot(workspaceId);
    if (!ws.success) {
        return { success: false, error: ws.error, elapsed_ms: Date.now() - startTime };
    }

    const sourceValidation = validatePath(ws.path!, sourcePath);
    if (!sourceValidation.valid) {
        return { success: false, error: sourceValidation.error, elapsed_ms: Date.now() - startTime };
    }

    const destValidation = validatePath(ws.path!, destPath);
    if (!destValidation.valid) {
        return { success: false, error: destValidation.error, elapsed_ms: Date.now() - startTime };
    }

    const sourceFullPath = sourceValidation.resolvedPath!;
    const destFullPath = destValidation.resolvedPath!;

    try {
        // 先删除目标（如果存在）
        if (existsSync(destFullPath)) {
            rmSync(destFullPath, { recursive: true });
        }

        renameSync(sourceFullPath, destFullPath);

        console.log(`[FileTool] Moved (overwrite): ${sourcePath} -> ${destPath}`);

        return {
            success: true,
            data: {
                source: sourcePath,
                destination: destPath,
                overwritten: true,
            },
            elapsed_ms: Date.now() - startTime,
        };
    } catch (err: any) {
        return {
            success: false,
            error: `Failed to move file: ${err.message}`,
            elapsed_ms: Date.now() - startTime,
        };
    }
}

/**
 * 注册的工具配置 - 删除和移动
 */
export const deleteFileTool = {
    definition: deleteFileToolDefinition,
    executor: executeDeleteFile,
    riskLevel: 'high' as const,
    requiresConfirmation: true,
};

export const moveFileTool = {
    definition: moveFileToolDefinition,
    executor: executeMoveFile,
    riskLevel: 'medium' as const,
    requiresConfirmation: false, // 仅覆盖时需要确认
};
