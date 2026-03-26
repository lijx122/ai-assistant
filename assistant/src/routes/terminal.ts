/**
 * Terminal Routes - 终端 HTTP API
 *
 * 路由：
 * - POST /api/terminal - 创建新终端
 * - GET /api/terminal/list - 列出终端
 * - DELETE /api/terminal/:id - 关闭终端
 */

import { Hono } from 'hono';
import { getDb } from '../db';
import { authMiddleware } from '../middleware/auth';
import { AuthContext } from '../types';
import {
    createTerminal,
    closeTerminal,
    listTerminals,
    listTerminalsWithStatus,
    getTerminal,
    resizeTerminal,
} from '../services/terminal';

export const terminalRouter = new Hono<{ Variables: { user: AuthContext } }>();

terminalRouter.use('*', authMiddleware);

// POST /api/terminal - 创建新终端
terminalRouter.post('/', async (c) => {
    const user = c.get('user');
    const body = await c.req.json().catch(() => ({}));
    const { workspaceId, cwd, title } = body;

    if (!workspaceId) {
        return c.json({ error: 'Missing workspaceId' }, 400);
    }

    // 验证工作区存在
    const db = getDb();
    const workspace = db.prepare('SELECT id FROM workspaces WHERE id = ?').get(workspaceId);
    if (!workspace) {
        return c.json({ error: 'Workspace not found' }, 404);
    }

    try {
        const session = await createTerminal(workspaceId, user.userId, cwd, title);

        return c.json({
            success: true,
            terminal: {
                id: session.id,
                workspaceId: session.workspaceId,
                title: session.title,
                cwd: session.cwd,
                pid: session.pty.pid,
                createdAt: session.createdAt,
            },
        }, 201);
    } catch (err: any) {
        console.error('[TerminalRoute] Failed to create terminal:', err);

        if (err.message?.includes('Maximum terminal sessions')) {
            return c.json({ error: err.message }, 429);
        }

        if (err.message?.includes('not available')) {
            return c.json({ error: err.message, code: 'PTY_UNAVAILABLE' }, 503);
        }

        return c.json({ error: 'Failed to create terminal', message: err.message }, 500);
    }
});

// GET /api/terminal - 列出终端（支持 workspaceId 过滤，包含连接状态）
terminalRouter.get('/', (c) => {
    const user = c.get('user');
    const workspaceId = c.req.query('workspaceId');

    const terminals = listTerminalsWithStatus(workspaceId, user.userId);

    return c.json({ terminals });
});

// GET /api/terminal/list - 列出当前用户的终端（兼容旧接口）
terminalRouter.get('/list', (c) => {
    const user = c.get('user');
    const workspaceId = c.req.query('workspaceId');

    const terminals = listTerminalsWithStatus(workspaceId, user.userId);

    return c.json({ terminals });
});

// GET /api/terminal/:id - 获取终端详情
terminalRouter.get('/:id', (c) => {
    const user = c.get('user');
    const id = c.req.param('id');

    const session = getTerminal(id);
    if (!session) {
        return c.json({ error: 'Terminal not found' }, 404);
    }

    // 权限检查
    if (session.userId !== user.userId) {
        return c.json({ error: 'Forbidden' }, 403);
    }

    return c.json({
        terminal: {
            id: session.id,
            workspaceId: session.workspaceId,
            title: session.title,
            cwd: session.cwd,
            pid: session.pty.pid,
            createdAt: session.createdAt,
            lastActiveAt: session.lastActiveAt,
        },
    });
});

// POST /api/terminal/:id/resize - 调整终端大小
terminalRouter.post('/:id/resize', async (c) => {
    const user = c.get('user');
    const id = c.req.param('id');
    const body = await c.req.json().catch(() => ({}));
    const { cols, rows } = body;

    if (typeof cols !== 'number' || typeof rows !== 'number') {
        return c.json({ error: 'Missing cols or rows' }, 400);
    }

    const session = getTerminal(id);
    if (!session) {
        return c.json({ error: 'Terminal not found' }, 404);
    }

    // 权限检查
    if (session.userId !== user.userId) {
        return c.json({ error: 'Forbidden' }, 403);
    }

    try {
        resizeTerminal(id, cols, rows);
        return c.json({ success: true });
    } catch (err: any) {
        return c.json({ error: err.message }, 500);
    }
});

// DELETE /api/terminal/:id - 关闭终端
terminalRouter.delete('/:id', async (c) => {
    const user = c.get('user');
    const id = c.req.param('id');
    const force = c.req.query('force') === 'true';

    const session = getTerminal(id);
    if (!session) {
        return c.json({ error: 'Terminal not found' }, 404);
    }

    // 权限检查
    if (session.userId !== user.userId) {
        return c.json({ error: 'Forbidden' }, 403);
    }

    try {
        await closeTerminal(id, force);
        return c.json({ success: true });
    } catch (err: any) {
        return c.json({ error: err.message }, 500);
    }
});
