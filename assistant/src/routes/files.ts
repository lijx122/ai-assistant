import { Hono } from 'hono';
import { getConfig } from '../config';
import { getDb } from '../db';
import { authMiddleware } from '../middleware/auth';
import { AuthContext } from '../types';
import { readdir, readFile, writeFile, stat, realpath, access, constants, mkdir, rename, rm, cp } from 'fs/promises';
import { resolve, join, dirname, relative, isAbsolute, normalize } from 'path';
import { existsSync } from 'fs';

export const filesRouter = new Hono<{ Variables: { user: AuthContext; workspaceId?: string; resolvedPath?: { absolutePath: string; isAllowed: boolean } } }>();

filesRouter.use('*', authMiddleware);

const MAX_FILE_SIZE = 500 * 1024; // 500KB limit

/**
 * 获取工作区的 root_path
 */
function getWorkspaceRootPath(workspaceId: string): string | null {
    const db = getDb();
    const workspace = db.prepare('SELECT root_path FROM workspaces WHERE id = ?').get(workspaceId) as { root_path: string } | undefined;
    return workspace?.root_path || null;
}

/**
 * 路径安全检查：确保目标路径在允许的根目录内
 * 返回解析后的绝对路径，或 null 如果路径不合法
 */
async function resolveSafePath(targetPath: string, workspaceId: string): Promise<{ absolutePath: string; isAllowed: boolean } | null> {
    const config = getConfig();

    // 获取工作区路径
    const workspaceRoot = getWorkspaceRootPath(workspaceId);
    if (!workspaceRoot) {
        return null;
    }

    // 解析目标路径
    let absolutePath: string;
    if (isAbsolute(targetPath)) {
        // 绝对路径：检查是否在 allowed_roots 中
        absolutePath = normalize(targetPath);
    } else {
        // 相对路径：基于工作区 root 解析
        absolutePath = normalize(resolve(workspaceRoot, targetPath));
    }

    // 检查路径是否存在，获取真实路径
    try {
        const realPath = await realpath(absolutePath).catch(() => absolutePath);
        absolutePath = realPath;
    } catch {
        // 文件可能不存在，继续用解析后的路径
    }

    // 安全检查：路径必须在以下范围内之一：
    // 1. 工作区 root_path
    // 2. config.files.allowed_roots 中的路径
    const allowedRoots = [workspaceRoot, ...config.files.allowed_roots];

    const isAllowed = allowedRoots.some(root => {
        const normalizedRoot = normalize(resolve(root));
        // 确保路径以 root 开头（防止 ../ 绕过）
        return absolutePath === normalizedRoot ||
               absolutePath.startsWith(normalizedRoot + '/');
    });

    return { absolutePath, isAllowed };
}

/**
 * 中间件：解析并验证路径
 * 将解析后的路径存储在 context 中供后续使用
 * 查询参数或 body 中需要有 workspaceId 和 path
 */
async function resolvePathMiddleware(c: any, next: any) {
    const body = await c.req.json().catch(() => ({}));
    const workspaceId = c.req.query('workspaceId') || body.workspaceId;
    const path = c.req.query('path') || body.path;

    if (!workspaceId) {
        return c.json({ error: 'workspaceId is required' }, 400);
    }

    // 优先校验工作区存在性，避免被后续 path 缺失错误掩盖
    const workspaceRoot = getWorkspaceRootPath(workspaceId);
    if (!workspaceRoot) {
        return c.json({ error: 'Workspace not found' }, 404);
    }

    c.set('workspaceId', workspaceId);

    // 如果有 path 参数，解析它
    if (path) {
        const resolved = await resolveSafePath(path, workspaceId);
        if (!resolved) {
            return c.json({ error: 'Workspace not found' }, 404);
        }
        if (!resolved.isAllowed) {
            return c.json({ error: 'Access denied: path outside allowed directories' }, 403);
        }
        c.set('resolvedPath', resolved);
    }

    await next();
}

/**
 * 获取文件语言类型（用于 Monaco Editor 语法高亮）
 */
function getFileLanguage(filename: string): string {
    const ext = filename.split('.').pop()?.toLowerCase() || '';
    const languageMap: Record<string, string> = {
        'ts': 'typescript',
        'tsx': 'typescript',
        'js': 'javascript',
        'jsx': 'javascript',
        'json': 'json',
        'html': 'html',
        'vue': 'html',
        'svelte': 'html',
        'css': 'css',
        'scss': 'scss',
        'less': 'less',
        'py': 'python',
        'java': 'java',
        'go': 'go',
        'rs': 'rust',
        'c': 'c',
        'cpp': 'cpp',
        'h': 'c',
        'hpp': 'cpp',
        'md': 'markdown',
        'yml': 'yaml',
        'yaml': 'yaml',
        'xml': 'xml',
        'sh': 'shell',
        'bash': 'shell',
        'zsh': 'shell',
        'sql': 'sql',
        'dockerfile': 'dockerfile',
        'toml': 'ini',
        'ini': 'ini',
        'conf': 'ini',
        'config': 'ini',
        'env': 'plaintext',
        'lock': 'plaintext',
        'log': 'plaintext',
        'txt': 'plaintext',
        'php': 'php',
        'rb': 'ruby',
        'swift': 'swift',
        'kt': 'kotlin',
        'lua': 'lua',
        'r': 'r',
    };
    return languageMap[ext] || 'plaintext';
}

/**
 * 检查路径是否在工作区内（用于写操作限制）
 */
function isPathInWorkspace(absolutePath: string, workspaceId: string): boolean {
    const workspaceRoot = getWorkspaceRootPath(workspaceId);
    if (!workspaceRoot) return false;

    const normalizedRoot = normalize(resolve(workspaceRoot));
    return absolutePath === normalizedRoot ||
           absolutePath.startsWith(normalizedRoot + '/');
}

/**
 * GET /api/files?workspaceId=&path=
 * 列目录内容
 */
filesRouter.get('/', resolvePathMiddleware, async (c) => {
    const workspaceId = c.get('workspaceId')!;
    const resolved = c.get('resolvedPath');

    if (!resolved) {
        return c.json({ error: 'path is required' }, 400);
    }

    const { absolutePath } = resolved;

    try {
        // 检查是否是目录
        const stats = await stat(absolutePath);
        if (!stats.isDirectory()) {
            return c.json({ error: 'Path is not a directory' }, 400);
        }

        // 读取目录内容
        const entries = await readdir(absolutePath, { withFileTypes: true });

        const files = entries.map(entry => {
            const fullPath = join(absolutePath, entry.name);
            return {
                name: entry.name,
                path: relative(getWorkspaceRootPath(workspaceId)!, fullPath) || '.',
                absolutePath: fullPath,
                isDirectory: entry.isDirectory(),
                isFile: entry.isFile(),
                language: entry.isFile() ? getFileLanguage(entry.name) : null,
            };
        });

        // 排序：目录在前，文件在后，按名称排序
        files.sort((a, b) => {
            if (a.isDirectory !== b.isDirectory) {
                return a.isDirectory ? -1 : 1;
            }
            return a.name.localeCompare(b.name);
        });

        return c.json({
            success: true,
            path: c.req.query('path') || '.',
            absolutePath,
            files,
        });
    } catch (err: any) {
        console.error('[Files] Error listing directory:', err);
        return c.json({ error: 'Failed to list directory: ' + err.message }, 500);
    }
});

/**
 * GET /api/files/content?workspaceId=&path=
 * 读取文件内容
 */
filesRouter.get('/content', resolvePathMiddleware, async (c) => {
    const workspaceId = c.get('workspaceId')!;
    const resolved = c.get('resolvedPath');

    if (!resolved) {
        return c.json({ error: 'path is required' }, 400);
    }

    const { absolutePath } = resolved;

    try {
        // 检查文件是否存在且是文件
        const stats = await stat(absolutePath);
        if (!stats.isFile()) {
            return c.json({ error: 'Path is not a file' }, 400);
        }

        // 检查文件大小
        if (stats.size > MAX_FILE_SIZE) {
            return c.json({ error: `File too large (${stats.size} bytes), max allowed: ${MAX_FILE_SIZE} bytes` }, 413);
        }

        const content = await readFile(absolutePath, 'utf-8');
        const filename = absolutePath.split('/').pop() || '';

        return c.json({
            success: true,
            path: c.req.query('path'),
            absolutePath,
            content,
            language: getFileLanguage(filename),
            size: stats.size,
            modified: stats.mtime.getTime(),
        });
    } catch (err: any) {
        if (err.code === 'ENOENT') {
            return c.json({ error: 'File not found' }, 404);
        }
        console.error('[Files] Error reading file:', err);
        return c.json({ error: 'Failed to read file: ' + err.message }, 500);
    }
});

/**
 * PUT /api/files/content
 * 写入文件内容
 */
filesRouter.put('/content', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { workspaceId, path, content } = body;

    if (!workspaceId || !path || typeof content !== 'string') {
        return c.json({ error: 'workspaceId, path, and content are required' }, 400);
    }

    const resolved = await resolveSafePath(path, workspaceId);
    if (!resolved) {
        return c.json({ error: 'Workspace not found' }, 404);
    }
    if (!resolved.isAllowed) {
        return c.json({ error: 'Access denied: path outside allowed directories' }, 403);
    }

    const { absolutePath } = resolved;

    // 检查是否在写入允许的路径内（必须是工作区内）
    if (!isPathInWorkspace(absolutePath, workspaceId)) {
        return c.json({ error: 'Write operations only allowed within workspace directory' }, 403);
    }

    try {
        // 确保父目录存在
        const parentDir = dirname(absolutePath);
        if (!existsSync(parentDir)) {
            console.log('[FileRoute] Creating parent directory:', parentDir);
            await import('fs/promises').then(fs => fs.mkdir(parentDir, { recursive: true }));
        }

        console.log('[FileRoute] Writing file:', absolutePath, 'size:', content.length, 'chars');
        await writeFile(absolutePath, content, 'utf-8');
        console.log('[FileRoute] File saved successfully:', absolutePath);

        const stats = await stat(absolutePath);
        const filename = absolutePath.split('/').pop() || '';

        return c.json({
            success: true,
            path,
            absolutePath,
            language: getFileLanguage(filename),
            size: stats.size,
            modified: stats.mtime.getTime(),
        });
    } catch (err: any) {
        console.error('[FileRoute] Error writing file:', err);
        return c.json({ error: 'Failed to write file: ' + err.message }, 500);
    }
});

/**
 * POST /api/files
 * 创建新文件
 */
filesRouter.post('/', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { workspaceId, path, content = '' } = body;

    if (!workspaceId || !path) {
        return c.json({ error: 'workspaceId and path are required' }, 400);
    }

    const resolved = await resolveSafePath(path, workspaceId);
    if (!resolved) {
        return c.json({ error: 'Workspace not found' }, 404);
    }
    if (!resolved.isAllowed) {
        return c.json({ error: 'Access denied: path outside allowed directories' }, 403);
    }

    const { absolutePath } = resolved;

    // 检查是否在工作区内
    if (!isPathInWorkspace(absolutePath, workspaceId)) {
        return c.json({ error: 'Write operations only allowed within workspace directory' }, 403);
    }

    try {
        // 检查文件是否已存在
        try {
            await stat(absolutePath);
            return c.json({ error: 'File already exists' }, 409);
        } catch (e: any) {
            if (e.code !== 'ENOENT') throw e;
        }

        // 确保父目录存在
        const parentDir = dirname(absolutePath);
        if (!existsSync(parentDir)) {
            await mkdir(parentDir, { recursive: true });
        }

        // 创建空文件
        await writeFile(absolutePath, content, 'utf-8');
        console.log('[FileRoute] File created:', absolutePath);

        const filename = absolutePath.split('/').pop() || '';

        return c.json({
            success: true,
            path,
            absolutePath,
            language: getFileLanguage(filename),
            size: content.length,
        }, 201);
    } catch (err: any) {
        console.error('[FileRoute] Error creating file:', err);
        return c.json({ error: 'Failed to create file: ' + err.message }, 500);
    }
});

/**
 * POST /api/files/dir
 * 创建新目录
 */
filesRouter.post('/dir', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { workspaceId, path } = body;

    if (!workspaceId || !path) {
        return c.json({ error: 'workspaceId and path are required' }, 400);
    }

    const resolved = await resolveSafePath(path, workspaceId);
    if (!resolved) {
        return c.json({ error: 'Workspace not found' }, 404);
    }
    if (!resolved.isAllowed) {
        return c.json({ error: 'Access denied: path outside allowed directories' }, 403);
    }

    const { absolutePath } = resolved;

    // 检查是否在工作区内
    if (!isPathInWorkspace(absolutePath, workspaceId)) {
        return c.json({ error: 'Write operations only allowed within workspace directory' }, 403);
    }

    try {
        // 检查目录是否已存在
        try {
            const stats = await stat(absolutePath);
            if (stats.isDirectory()) {
                return c.json({ error: 'Directory already exists' }, 409);
            }
            return c.json({ error: 'Path already exists as a file' }, 409);
        } catch (e: any) {
            if (e.code !== 'ENOENT') throw e;
        }

        // 创建目录
        await mkdir(absolutePath, { recursive: true });
        console.log('[FileRoute] Directory created:', absolutePath);

        return c.json({
            success: true,
            path,
            absolutePath,
            isDirectory: true,
        }, 201);
    } catch (err: any) {
        console.error('[FileRoute] Error creating directory:', err);
        return c.json({ error: 'Failed to create directory: ' + err.message }, 500);
    }
});

/**
 * PATCH /api/files
 * 重命名文件/目录
 */
filesRouter.patch('/', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { workspaceId, oldPath, newPath } = body;

    if (!workspaceId || !oldPath || !newPath) {
        return c.json({ error: 'workspaceId, oldPath, and newPath are required' }, 400);
    }

    const oldResolved = await resolveSafePath(oldPath, workspaceId);
    const newResolved = await resolveSafePath(newPath, workspaceId);

    if (!oldResolved || !newResolved) {
        return c.json({ error: 'Workspace not found' }, 404);
    }
    if (!oldResolved.isAllowed || !newResolved.isAllowed) {
        return c.json({ error: 'Access denied: path outside allowed directories' }, 403);
    }

    // 检查是否在工作区内
    if (!isPathInWorkspace(oldResolved.absolutePath, workspaceId) ||
        !isPathInWorkspace(newResolved.absolutePath, workspaceId)) {
        return c.json({ error: 'Write operations only allowed within workspace directory' }, 403);
    }

    try {
        // 检查源文件是否存在
        try {
            await stat(oldResolved.absolutePath);
        } catch (e: any) {
            if (e.code === 'ENOENT') {
                return c.json({ error: 'Source file not found' }, 404);
            }
            throw e;
        }

        // 检查目标是否已存在
        try {
            await stat(newResolved.absolutePath);
            return c.json({ error: 'Destination already exists' }, 409);
        } catch (e: any) {
            if (e.code !== 'ENOENT') throw e;
        }

        // 执行重命名
        await rename(oldResolved.absolutePath, newResolved.absolutePath);
        console.log('[FileRoute] Renamed:', oldResolved.absolutePath, '->', newResolved.absolutePath);

        return c.json({
            success: true,
            oldPath,
            newPath,
            oldAbsolutePath: oldResolved.absolutePath,
            newAbsolutePath: newResolved.absolutePath,
        });
    } catch (err: any) {
        console.error('[FileRoute] Error renaming:', err);
        return c.json({ error: 'Failed to rename: ' + err.message }, 500);
    }
});

/**
 * DELETE /api/files
 * 删除文件/目录
 */
filesRouter.delete('/', async (c) => {
    const workspaceId = c.req.query('workspaceId');
    const path = c.req.query('path');

    if (!workspaceId || !path) {
        return c.json({ error: 'workspaceId and path are required' }, 400);
    }

    const resolved = await resolveSafePath(path, workspaceId);
    if (!resolved) {
        return c.json({ error: 'Workspace not found' }, 404);
    }
    if (!resolved.isAllowed) {
        return c.json({ error: 'Access denied: path outside allowed directories' }, 403);
    }

    // 检查是否在工作区内
    if (!isPathInWorkspace(resolved.absolutePath, workspaceId)) {
        return c.json({ error: 'Delete operations only allowed within workspace directory' }, 403);
    }

    // 防止删除工作区根目录
    const workspaceRoot = getWorkspaceRootPath(workspaceId);
    const normalizedRoot = workspaceRoot ? normalize(resolve(workspaceRoot)) : null;
    if (normalizedRoot && resolved.absolutePath === normalizedRoot) {
        return c.json({ error: 'Cannot delete workspace root directory' }, 403);
    }

    try {
        // 检查文件是否存在
        try {
            await stat(resolved.absolutePath);
        } catch (e: any) {
            if (e.code === 'ENOENT') {
                return c.json({ error: 'File not found' }, 404);
            }
            throw e;
        }

        // 执行删除（递归）
        await rm(resolved.absolutePath, { recursive: true, force: true });
        console.log('[FileRoute] Deleted:', resolved.absolutePath);

        return c.json({
            success: true,
            path,
            absolutePath: resolved.absolutePath,
        });
    } catch (err: any) {
        console.error('[FileRoute] Error deleting:', err);
        return c.json({ error: 'Failed to delete: ' + err.message }, 500);
    }
});

/**
 * POST /api/files/move
 * 移动/重命名文件或目录
 */
filesRouter.post('/move', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { workspaceId, oldPath, newPath, force = false } = body;

    if (!workspaceId || !oldPath || !newPath) {
        return c.json({ error: 'workspaceId, oldPath, and newPath are required' }, 400);
    }

    // 解析源路径和目标路径
    const oldResolved = await resolveSafePath(oldPath, workspaceId);
    const newResolved = await resolveSafePath(newPath, workspaceId);

    if (!oldResolved || !newResolved) {
        return c.json({ error: 'Workspace not found' }, 404);
    }
    if (!oldResolved.isAllowed || !newResolved.isAllowed) {
        return c.json({ error: 'Access denied: path outside allowed directories' }, 403);
    }

    // 检查是否在工作区内
    if (!isPathInWorkspace(oldResolved.absolutePath, workspaceId) ||
        !isPathInWorkspace(newResolved.absolutePath, workspaceId)) {
        return c.json({ error: 'Move operations only allowed within workspace directory' }, 403);
    }

    // 防止移动到自身子目录
    if (newResolved.absolutePath === oldResolved.absolutePath ||
        newResolved.absolutePath.startsWith(oldResolved.absolutePath + '/')) {
        return c.json({ error: 'Cannot move a directory into itself or its subdirectory' }, 400);
    }

    try {
        // 检查源文件是否存在
        try {
            await stat(oldResolved.absolutePath);
        } catch (e: any) {
            if (e.code === 'ENOENT') {
                return c.json({ error: 'Source file not found' }, 404);
            }
            throw e;
        }

        // 检查目标是否已存在
        let targetExists = false;
        try {
            await stat(newResolved.absolutePath);
            targetExists = true;
        } catch (e: any) {
            if (e.code !== 'ENOENT') throw e;
        }

        if (targetExists && !force) {
            return c.json({ error: 'Destination already exists', code: 'EEXIST' }, 409);
        }

        // 确保目标父目录存在
        const parentDir = dirname(newResolved.absolutePath);
        if (!existsSync(parentDir)) {
            await mkdir(parentDir, { recursive: true });
        }

        // 执行移动
        await rename(oldResolved.absolutePath, newResolved.absolutePath);
        console.log('[FileRoute] Moved:', oldResolved.absolutePath, '->', newResolved.absolutePath);

        return c.json({
            success: true,
            oldPath,
            newPath,
            oldAbsolutePath: oldResolved.absolutePath,
            newAbsolutePath: newResolved.absolutePath,
        });
    } catch (err: any) {
        console.error('[FileRoute] Error moving:', err);
        return c.json({ error: 'Failed to move: ' + err.message }, 500);
    }
});

/**
 * POST /api/files/copy
 * 复制文件或目录
 */
filesRouter.post('/copy', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { workspaceId, srcPath, dstPath } = body;

    if (!workspaceId || !srcPath || !dstPath) {
        return c.json({ error: 'workspaceId, srcPath, and dstPath are required' }, 400);
    }

    // 解析源路径和目标路径
    const srcResolved = await resolveSafePath(srcPath, workspaceId);
    const dstResolved = await resolveSafePath(dstPath, workspaceId);

    if (!srcResolved || !dstResolved) {
        return c.json({ error: 'Workspace not found' }, 404);
    }
    if (!srcResolved.isAllowed || !dstResolved.isAllowed) {
        return c.json({ error: 'Access denied: path outside allowed directories' }, 403);
    }

    // 检查是否在工作区内
    if (!isPathInWorkspace(srcResolved.absolutePath, workspaceId) ||
        !isPathInWorkspace(dstResolved.absolutePath, workspaceId)) {
        return c.json({ error: 'Copy operations only allowed within workspace directory' }, 403);
    }

    // 防止复制到自身子目录
    if (dstResolved.absolutePath.startsWith(srcResolved.absolutePath + '/')) {
        return c.json({ error: 'Cannot copy a directory into itself or its subdirectory' }, 400);
    }

    try {
        // 检查源文件是否存在
        const srcStat = await stat(srcResolved.absolutePath).catch(() => null);
        if (!srcStat) {
            return c.json({ error: 'Source file not found' }, 404);
        }

        // 确保目标父目录存在
        const parentDir = dirname(dstResolved.absolutePath);
        if (!existsSync(parentDir)) {
            await mkdir(parentDir, { recursive: true });
        }

        // 执行复制
        if (srcStat.isDirectory()) {
            await cp(srcResolved.absolutePath, dstResolved.absolutePath, { recursive: true });
        } else {
            await access(srcResolved.absolutePath, constants.R_OK);
            await access(parentDir, constants.W_OK);
            await copyFile(srcResolved.absolutePath, dstResolved.absolutePath);
        }
        console.log('[FileRoute] Copied:', srcResolved.absolutePath, '->', dstResolved.absolutePath);

        return c.json({
            success: true,
            srcPath,
            dstPath,
            srcAbsolutePath: srcResolved.absolutePath,
            dstAbsolutePath: dstResolved.absolutePath,
            isDirectory: srcStat.isDirectory(),
        });
    } catch (err: any) {
        console.error('[FileRoute] Error copying:', err);
        return c.json({ error: 'Failed to copy: ' + err.message }, 500);
    }
});

// Helper function for copying files
async function copyFile(src: string, dest: string): Promise<void> {
    const content = await readFile(src);
    await writeFile(dest, content);
}

/**
 * PATCH /api/files/rename
 * 重命名文件或目录（内部复用 move 逻辑）
 */
filesRouter.patch('/rename', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { workspaceId, oldPath, newPath } = body;

    if (!workspaceId || !oldPath || !newPath) {
        return c.json({ error: 'workspaceId, oldPath, and newPath are required' }, 400);
    }

    // 解析源路径和目标路径
    const oldResolved = await resolveSafePath(oldPath, workspaceId);
    const newResolved = await resolveSafePath(newPath, workspaceId);

    if (!oldResolved || !newResolved) {
        return c.json({ error: 'Workspace not found' }, 404);
    }
    if (!oldResolved.isAllowed || !newResolved.isAllowed) {
        return c.json({ error: 'Access denied: path outside allowed directories' }, 403);
    }

    // 检查是否在工作区内
    if (!isPathInWorkspace(oldResolved.absolutePath, workspaceId) ||
        !isPathInWorkspace(newResolved.absolutePath, workspaceId)) {
        return c.json({ error: 'Rename operations only allowed within workspace directory' }, 403);
    }

    // 防止重命名到自身子目录
    if (newResolved.absolutePath.startsWith(oldResolved.absolutePath + '/')) {
        return c.json({ error: 'Cannot rename a directory into itself or its subdirectory' }, 400);
    }

    try {
        // 检查源文件是否存在
        try {
            await stat(oldResolved.absolutePath);
        } catch (e: any) {
            if (e.code === 'ENOENT') {
                return c.json({ error: 'Source file not found' }, 404);
            }
            throw e;
        }

        // 检查目标是否已存在
        try {
            await stat(newResolved.absolutePath);
            return c.json({ error: 'Destination already exists' }, 409);
        } catch (e: any) {
            if (e.code !== 'ENOENT') throw e;
        }

        // 确保目标父目录存在
        const parentDir = dirname(newResolved.absolutePath);
        if (!existsSync(parentDir)) {
            await mkdir(parentDir, { recursive: true });
        }

        // 执行重命名
        await rename(oldResolved.absolutePath, newResolved.absolutePath);
        console.log('[FileRoute] Renamed:', oldResolved.absolutePath, '->', newResolved.absolutePath);

        return c.json({
            success: true,
            oldPath,
            newPath,
            oldAbsolutePath: oldResolved.absolutePath,
            newAbsolutePath: newResolved.absolutePath,
        });
    } catch (err: any) {
        console.error('[FileRoute] Error renaming:', err);
        return c.json({ error: 'Failed to rename: ' + err.message }, 500);
    }
});
