import { Hono } from 'hono';
import { getDb } from '../db';
import { randomUUID } from 'crypto';
import { mkdirSync, existsSync, rmSync } from 'fs';
import { resolve } from 'path';
import { authMiddleware } from '../middleware/auth';
import { AuthContext } from '../types';
import { getConfig } from '../config';
import { getGitTracker } from '../services/git-tracker';
import {
    loadWorkspaceConfigFiles,
    saveWorkspaceConfigFile,
    WorkspaceConfigFiles,
} from '../services/workspace-config';

export const workspaceRouter = new Hono<{ Variables: { user: AuthContext } }>();

workspaceRouter.use('*', authMiddleware);

workspaceRouter.get('/', (c) => {
    const db = getDb();
    // Fetch only active workspaces (not archived ones), user-scoping can be added here fully if multi-user
    const workspaces = db.prepare("SELECT * FROM workspaces WHERE status = 'active'").all();
    return c.json({ workspaces });
});

workspaceRouter.post('/', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    if (!body.name) {
        return c.json({ error: 'Name is required' }, 400);
    }

    const id = randomUUID();
    const userId = c.get('user').userId;
    // Use dataDir/workspaces directory as root to prevent root system conflicts
    const cfg = getConfig();
    const rootPath = resolve(cfg.dataDir, 'workspaces', id);

    if (!existsSync(rootPath)) {
        mkdirSync(rootPath, { recursive: true });
    }

    const db = getDb();
    db.prepare('INSERT INTO workspaces (id, user_id, name, description, root_path, created_at, last_active_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, userId, body.name, body.description || '', rootPath, Date.now(), Date.now());

    const workspace = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id);
    return c.json({ success: true, workspace }, 201);
});

workspaceRouter.put('/:id', async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json().catch(() => ({}));

    const db = getDb();
    const existing = db.prepare('SELECT id FROM workspaces WHERE id = ?').get(id);
    if (!existing) {
        return c.json({ error: 'Not found' }, 404);
    }

    if (body.name || typeof body.description !== 'undefined') {
        db.prepare('UPDATE workspaces SET name = COALESCE(@name, name), description = COALESCE(@description, description) WHERE id = @id')
            .run({ name: body.name ?? null, description: body.description ?? null, id });
    }

    return c.json({ success: true });
});

workspaceRouter.delete('/:id', (c) => {
    const id = c.req.param('id');
    const db = getDb();
    const existing = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as any;
    if (!existing) {
        return c.json({ error: 'Not found' }, 404);
    }

    const tableExists = (tableName: string): boolean => {
        const row = db.prepare(
            "SELECT 1 FROM sqlite_master WHERE type IN ('table', 'view') AND name = ? LIMIT 1"
        ).get(tableName) as { 1: number } | undefined;
        return !!row;
    };

    const columnExists = (tableName: string, columnName: string): boolean => {
        if (!tableExists(tableName)) return false;
        const columns = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
        return columns.some(c => c.name === columnName);
    };

    const deleteByWorkspace = (tableName: string): void => {
        if (!tableExists(tableName)) return;
        if (!columnExists(tableName, 'workspace_id')) {
            console.warn(`[Delete] workspace ${id}: skip ${tableName}, column workspace_id not found`);
            return;
        }
        const result = db.prepare(`DELETE FROM ${tableName} WHERE workspace_id = ?`).run(id);
        console.log('[Delete] workspace', id, `${tableName} changes:`, result.changes);
    };

    const runDeleteTx = db.transaction(() => {
        deleteByWorkspace('messages');
        deleteByWorkspace('message_embeddings');
        deleteByWorkspace('messages_fts');
        deleteByWorkspace('session_compacts');
        deleteByWorkspace('compact_fts');
        deleteByWorkspace('alerts');
        deleteByWorkspace('terminal_sessions');
        deleteByWorkspace('sdk_calls');
        deleteByWorkspace('logs');
        deleteByWorkspace('workspace_memory');
        deleteByWorkspace('impressions');

        if (tableExists('tasks')) {
            const taskIds = db.prepare('SELECT id FROM tasks WHERE workspace_id = ?').all(id) as { id: string }[];
            if (tableExists('task_runs')) {
                for (const task of taskIds) {
                    const delTaskRuns = db.prepare('DELETE FROM task_runs WHERE task_id = ?').run(task.id);
                    console.log('[Delete] workspace', id, 'task_runs for task', task.id, 'changes:', delTaskRuns.changes);
                }
            }
        }

        deleteByWorkspace('sessions');
        deleteByWorkspace('tasks');

        const delWorkspace = db.prepare('DELETE FROM workspaces WHERE id = ?').run(id);
        console.log('[Delete] workspace', id, 'workspaces changes:', delWorkspace.changes);
        if (delWorkspace.changes === 0) {
            throw new Error('Workspace delete failed');
        }
    });

    try {
        runDeleteTx();
    } catch (err: any) {
        console.error('[Delete] workspace', id, 'transaction failed:', err);
        return c.json({ error: err?.message || 'Workspace delete failed' }, 500);
    }

    // 2. 物理删除工作区目录及其所有内容
    if (existing.root_path && existsSync(existing.root_path)) {
        try {
            rmSync(existing.root_path, { recursive: true, force: true });
        } catch (err) {
            console.error(`[WorkspaceDelete] Failed to delete directory: ${existing.root_path}`, err);
        }
    }

    return c.json({ success: true });
});

// GET /api/workspaces/:id/config - 读取工作区配置文件
workspaceRouter.get('/:id/config', (c) => {
    const id = c.req.param('id');
    const db = getDb();

    const existing = db.prepare('SELECT id FROM workspaces WHERE id = ?').get(id);
    if (!existing) {
        return c.json({ error: 'Not found' }, 404);
    }

    const config = loadWorkspaceConfigFiles(id);
    return c.json({ success: true, config });
});

// PUT /api/workspaces/:id/config - 更新工作区配置文件
workspaceRouter.put('/:id/config', async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json().catch(() => ({}));

    const db = getDb();
    const existing = db.prepare('SELECT id FROM workspaces WHERE id = ?').get(id);
    if (!existing) {
        return c.json({ error: 'Not found' }, 404);
    }

    // Validate request body
    const allowedFields: (keyof WorkspaceConfigFiles)[] = ['identity', 'user', 'tools'];
    const updates: Partial<WorkspaceConfigFiles> = {};

    for (const field of allowedFields) {
        if (field in body && (typeof body[field] === 'string' || body[field] === null)) {
            updates[field] = body[field];
        }
    }

    if (Object.keys(updates).length === 0) {
        return c.json({ error: 'No valid config fields provided (expected: identity, user, tools)' }, 400);
    }

    try {
        for (const [fileType, content] of Object.entries(updates)) {
            if (content !== undefined && content !== null) {
                saveWorkspaceConfigFile(id, fileType as keyof WorkspaceConfigFiles, content);
            }
        }

        // Return updated config
        const updatedConfig = loadWorkspaceConfigFiles(id);
        return c.json({ success: true, config: updatedConfig });
    } catch (err: any) {
        console.error('[WorkspaceConfig] Failed to save config:', err);
        return c.json({ error: 'Failed to save config: ' + err.message }, 500);
    }
});

// GET /api/workspaces/:id/git - 获取 git 历史
workspaceRouter.get('/:id/git', (c) => {
    const id = c.req.param('id');
    const db = getDb();

    const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as any;
    if (!ws) {
        return c.json({ error: 'Not found' }, 404);
    }

    const tracker = getGitTracker(id, ws.root_path);
    const commits = tracker.getLog(30);
    return c.json({ commits });
});

// POST /api/workspaces/:id/git/revert - 回滚到指定 commit
workspaceRouter.post('/:id/git/revert', async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json().catch(() => ({}));
    const { hash } = body;

    if (!hash) {
        return c.json({ error: 'hash is required' }, 400);
    }

    const db = getDb();
    const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as any;
    if (!ws) {
        return c.json({ error: 'Not found' }, 404);
    }

    const tracker = getGitTracker(id, ws.root_path);
    const diffStat = tracker.getDiffStat(hash);
    const result = tracker.revertTo(hash);
    return c.json({ ...result, diffStat });
});

// POST /api/workspaces/:id/git/init - 初始化 Git 仓库
workspaceRouter.post('/:id/git/init', (c) => {
    const id = c.req.param('id');
    const db = getDb();

    const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as any;
    if (!ws) {
        return c.json({ error: 'Not found' }, 404);
    }

    const tracker = getGitTracker(id, ws.root_path);
    const success = tracker.ensureRepo();

    if (success) {
        // 创建初始 commit
        tracker.commit('init workspace');
        return c.json({ success: true, message: 'Git 仓库初始化成功' });
    } else {
        return c.json({ success: false, message: 'Git 仓库初始化失败' }, 500);
    }
});

// POST /api/workspaces/:id/git/save - 保存进度（带标签和注释）
workspaceRouter.post('/:id/git/save', async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json().catch(() => ({}));
    const { tag, message } = body;

    if (!message) {
        return c.json({ error: 'message is required' }, 400);
    }

    const db = getDb();
    const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as any;
    if (!ws) {
        return c.json({ error: 'Not found' }, 404);
    }

    const tracker = getGitTracker(id, ws.root_path);

    // 确保仓库已初始化
    tracker.ensureRepo();

    // 创建带标签的 commit
    const commitHash = tracker.commitWithTag(message, tag || '');

    if (commitHash) {
        return c.json({
            success: true,
            tag: tag || '',
            version: commitHash,
            message
        });
    } else {
        return c.json({ success: false, message: '没有可提交的改动，或提交失败' }, 400);
    }
});
