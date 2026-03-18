import { Hono } from 'hono';
import { authMiddleware } from '../middleware/auth';
import { AuthContext } from '../types';
import { promises as fs } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { getDb } from '../db';

export const uploadRouter = new Hono<{ Variables: { user: AuthContext } }>();

uploadRouter.use('*', authMiddleware);

// 支持的文件类型
const ALLOWED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const ALLOWED_DOCUMENT_TYPES = ['application/pdf'];
const ALLOWED_TEXT_TYPES = ['text/plain', 'text/markdown', 'text/csv', 'application/json'];
const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB

interface UploadResult {
    id: string;
    name: string;
    type: 'image' | 'document' | 'text';
    mimeType: string;
    size: number;
    url?: string; // 图片预览 URL
    content?: string; // 文本文件内容
    base64?: string; // 图片/PDF 的 base64 编码
    mediaType?: string; // 用于 Claude API 的 media_type
}

// POST /api/upload - 上传文件
uploadRouter.post('/', async (c) => {
    const user = c.get('user');
    const workspaceId = c.req.query('workspaceId');

    if (!workspaceId) {
        return c.json({ error: 'Missing workspaceId' }, 400);
    }

    // 验证工作区存在
    const db = getDb();
    const workspace = db.prepare('SELECT id, root_path FROM workspaces WHERE id = ?').get(workspaceId) as { id: string; root_path: string } | undefined;
    if (!workspace) {
        return c.json({ error: 'Workspace not found' }, 404);
    }

    try {
        const body = await c.req.parseBody({ all: true });
        const files = body.files;

        if (!files) {
            return c.json({ error: 'No files uploaded' }, 400);
        }

        // 确保上传目录存在
        const uploadsDir = join(workspace.root_path || `workspaces/${workspaceId}`, '.uploads');
        await fs.mkdir(uploadsDir, { recursive: true });

        const fileArray = Array.isArray(files) ? files : [files];
        const results: UploadResult[] = [];

        for (const file of fileArray) {
            if (!(file instanceof File)) {
                continue;
            }

            // 检查文件大小
            if (file.size > MAX_FILE_SIZE) {
                return c.json({ error: `File ${file.name} exceeds 20MB limit` }, 413);
            }

            const mimeType = file.type;
            const fileId = randomUUID();
            const ext = file.name.split('.').pop() || '';
            const fileName = `${fileId}.${ext}`;
            const filePath = join(uploadsDir, fileName);

            // 读取文件内容
            const arrayBuffer = await file.arrayBuffer();
            const buffer = Buffer.from(arrayBuffer);

            // 保存文件到磁盘
            await fs.writeFile(filePath, buffer);

            const result: UploadResult = {
                id: fileId,
                name: file.name,
                mimeType,
                size: file.size,
                type: 'document', // 默认为 document，后续根据类型覆盖
            };

            if (ALLOWED_IMAGE_TYPES.includes(mimeType)) {
                // 图片文件：转 base64
                result.type = 'image';
                result.base64 = buffer.toString('base64');
                result.mediaType = mimeType;
                result.url = `data:${mimeType};base64,${result.base64}`;
            } else if (ALLOWED_DOCUMENT_TYPES.includes(mimeType)) {
                // PDF 文件：转 base64
                result.type = 'document';
                result.base64 = buffer.toString('base64');
                result.mediaType = mimeType;
            } else if (ALLOWED_TEXT_TYPES.includes(mimeType) || mimeType.startsWith('text/')) {
                // 文本文件：读取内容
                result.type = 'text';
                result.content = buffer.toString('utf-8');
            } else {
                // 其他类型：作为二进制文件处理
                result.type = 'document';
                result.base64 = buffer.toString('base64');
                result.mediaType = mimeType;
            }

            results.push(result);
        }

        return c.json({
            success: true,
            files: results,
        });
    } catch (error: any) {
        console.error('[Upload Error]:', error);
        return c.json({ error: 'Upload failed', message: error.message }, 500);
    }
});

// GET /api/upload/:workspaceId/list - 列出工作区的上传文件
uploadRouter.get('/:workspaceId/list', async (c) => {
    const workspaceId = c.req.param('workspaceId');
    const user = c.get('user');

    const db = getDb();
    const workspace = db.prepare('SELECT root_path FROM workspaces WHERE id = ? AND user_id = ?').get(workspaceId, user.userId) as { root_path: string } | undefined;

    if (!workspace) {
        return c.json({ error: 'Workspace not found' }, 404);
    }

    try {
        const uploadsDir = join(workspace.root_path || `workspaces/${workspaceId}`, '.uploads');
        const files: { name: string; size: number; modified: Date }[] = [];

        try {
            const entries = await fs.readdir(uploadsDir, { withFileTypes: true });
            for (const entry of entries) {
                if (entry.isFile()) {
                    const stat = await fs.stat(join(uploadsDir, entry.name));
                    files.push({
                        name: entry.name,
                        size: stat.size,
                        modified: stat.mtime,
                    });
                }
            }
        } catch (e) {
            // 目录不存在，返回空列表
        }

        return c.json({ files });
    } catch (error: any) {
        return c.json({ error: error.message }, 500);
    }
});

// DELETE /api/upload/:workspaceId/:fileName - 删除上传的文件
uploadRouter.delete('/:workspaceId/:fileName', async (c) => {
    const workspaceId = c.req.param('workspaceId');
    const fileName = c.req.param('fileName');
    const user = c.get('user');

    const db = getDb();
    const workspace = db.prepare('SELECT root_path FROM workspaces WHERE id = ? AND user_id = ?').get(workspaceId, user.userId) as { root_path: string } | undefined;

    if (!workspace) {
        return c.json({ error: 'Workspace not found' }, 404);
    }

    try {
        const uploadsDir = join(workspace.root_path || `workspaces/${workspaceId}`, '.uploads');
        const filePath = join(uploadsDir, fileName);

        // 安全检查：确保文件路径在 uploadsDir 内
        if (!filePath.startsWith(uploadsDir)) {
            return c.json({ error: 'Invalid file path' }, 400);
        }

        await fs.unlink(filePath);
        return c.json({ success: true });
    } catch (error: any) {
        return c.json({ error: error.message }, 500);
    }
});
