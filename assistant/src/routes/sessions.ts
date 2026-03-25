import { Hono } from 'hono';
import { getDb } from '../db';
import { authMiddleware } from '../middleware/auth';
import { AuthContext } from '../types';
import { randomUUID } from 'crypto';
import { resolve } from 'path';
import { existsSync, unlinkSync, rmdirSync } from 'fs';
import { getAllCompacts } from '../services/context-summary';
import { archiveSession } from '../services/archiver';

// 解析 content 字段（支持字符串或 JSON）
function parseContent(content: string): any {
    try {
        return JSON.parse(content);
    } catch {
        // 兼容旧数据：纯文本直接返回
        return content;
    }
}

export const sessionRouter = new Hono<{ Variables: { user: AuthContext } }>();

sessionRouter.use('*', authMiddleware);

// GET /api/sessions?workspaceId=xxx
sessionRouter.get('/', (c) => {
    const workspaceId = c.req.query('workspaceId');
    if (!workspaceId) return c.json({ error: 'Missing workspaceId' }, 400);

    const db = getDb();
    const sessions = db.prepare(
        `SELECT s.*,
                COUNT(m.id) as message_count,
                MAX(m.created_at) as last_message_at,
                (
                    SELECT m2.content
                    FROM messages m2
                    WHERE m2.session_id = s.id AND m2.role = 'user'
                    ORDER BY m2.created_at ASC
                    LIMIT 1
                ) as first_message
         FROM sessions s
         LEFT JOIN messages m ON m.session_id = s.id
         WHERE s.workspace_id = ?
         GROUP BY s.id
         ORDER BY COALESCE(s.last_active_at, s.started_at) DESC`
    ).all(workspaceId) as any[];

    const sessionsWithMeta = sessions.map(s => ({
        ...s,
        messageCount: s.message_count || 0,
        firstMessage: s.first_message || '',
        createdAt: s.started_at,
        source: s.channel || 'web',
    }));

    return c.json({ sessions: sessionsWithMeta });
});

// POST /api/sessions
sessionRouter.post('/', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { workspaceId, channel = 'web', title = '' } = body;
    const user = c.get('user');

    if (!workspaceId) {
        return c.json({ error: 'Missing workspaceId' }, 400);
    }

    const db = getDb();
    const id = randomUUID();
    const now = Date.now();

    db.prepare(
        'INSERT INTO sessions (id, workspace_id, user_id, channel, title, started_at, last_active_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(id, workspaceId, user.userId, channel, title, now, now);

    const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Record<string, any> | undefined;
    if (!session) {
        return c.json({ error: 'Failed to create session' }, 500);
    }

    return c.json({
        success: true,
        session: {
            ...session,
            createdAt: session.started_at,
            messageCount: 0,
            firstMessage: '',
        }
    }, 201);
});

// DELETE /api/sessions/:id
sessionRouter.delete('/:id', (c) => {
    const id = c.req.param('id');
    const user = c.get('user');
    const db = getDb();

    // 获取会话信息
    const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as any;
    if (!session) {
        return c.json({ error: 'Session not found' }, 404);
    }

    // 获取工作区信息以确定文件路径
    const workspace = db.prepare('SELECT root_path FROM workspaces WHERE id = ?').get(session.workspace_id) as any;
    if (!workspace) {
        return c.json({ error: 'Workspace not found' }, 404);
    }

    // 1. 删除数据库记录（手动级联删除所有关联表，事务保证原子性）
    const deleteSession = db.transaction((sessionId: string) => {
        const delSdkCalls = db.prepare('DELETE FROM sdk_calls WHERE session_id = ?').run(sessionId);
        console.log('[Delete] session', sessionId, 'sdk_calls changes:', delSdkCalls.changes);

        const delEmbeddings = db.prepare('DELETE FROM message_embeddings WHERE session_id = ?').run(sessionId);
        console.log('[Delete] session', sessionId, 'message_embeddings changes:', delEmbeddings.changes);

        const delMessagesFts = db.prepare('DELETE FROM messages_fts WHERE session_id = ?').run(sessionId);
        console.log('[Delete] session', sessionId, 'messages_fts changes:', delMessagesFts.changes);

        const delMessages = db.prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId);
        console.log('[Delete] session', sessionId, 'messages changes:', delMessages.changes);

        const delCompacts = db.prepare('DELETE FROM session_compacts WHERE session_id = ?').run(sessionId);
        console.log('[Delete] session', sessionId, 'session_compacts changes:', delCompacts.changes);

        const delCompactFts = db.prepare('DELETE FROM compact_fts WHERE session_id = ?').run(sessionId);
        console.log('[Delete] session', sessionId, 'compact_fts changes:', delCompactFts.changes);

        const delAlerts = db.prepare('DELETE FROM alerts WHERE session_id = ?').run(sessionId);
        console.log('[Delete] session', sessionId, 'alerts changes:', delAlerts.changes);

        const delSession = db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
        console.log('[Delete] session', sessionId, 'sessions changes:', delSession.changes);

        return { delSession };
    });

    const { delSession } = deleteSession(id);

    if (delSession.changes === 0) {
        console.warn('[Delete] session', id, 'failed: no rows deleted');
        return c.json({ error: 'Session delete failed' }, 500);
    }

    // 2. 删除会话文件（如果存在）
    // 会话文件存储在工作区目录下的 .sessions/{sessionId}.json
    const sessionFilePath = resolve(workspace.root_path, '.sessions', `${id}.json`);
    if (existsSync(sessionFilePath)) {
        try {
            unlinkSync(sessionFilePath);
        } catch (err) {
            console.error(`[SessionDelete] Failed to delete session file: ${sessionFilePath}`, err);
        }
    }

    // 尝试删除空的 .sessions 目录
    const sessionsDir = resolve(workspace.root_path, '.sessions');
    try {
        rmdirSync(sessionsDir);
    } catch {
        // 目录不为空或不存在，忽略错误
    }

    return c.json({ success: true });
});

// GET /api/sessions/:id/messages
sessionRouter.get('/:id/messages', (c) => {
    const sessionId = c.req.param('id');
    const db = getDb();

    // 验证会话存在
    const session = db.prepare('SELECT id FROM sessions WHERE id = ?').get(sessionId);
    if (!session) return c.json({ error: 'Session not found' }, 404);

    const rows = db.prepare(
        'SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC'
    ).all(sessionId) as any[];

    // 解析 content JSON
    const messages = rows.map(r => ({
        ...r,
        content: parseContent(r.content),
    }));

    // 更新最后活跃时间
    db.prepare('UPDATE sessions SET last_active_at = ? WHERE id = ?').run(Date.now(), sessionId);

    // Bug Fix: 获取所有 compact 快照（支持多条分隔线）
    const compacts = getAllCompacts(sessionId);
    const formattedCompacts = compacts.map(c => {
        // 计算该 compact 前后的消息数
        const afterCount = rows.filter(m => m.created_at > c.compacted_at).length;
        const beforeCount = rows.length - afterCount;
        return {
            compacted_at: c.compacted_at,
            summary: c.summary,
            compressed_count: beforeCount,
            original_tokens: c.original_tokens,
            compacted_tokens: c.compacted_tokens,
        };
    });

    return c.json({ messages, compacts: formattedCompacts });
});

// PUT /api/sessions/:id
sessionRouter.put('/:id', async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json().catch(() => ({}));

    const db = getDb();
    const existing = db.prepare('SELECT id FROM sessions WHERE id = ?').get(id);
    if (!existing) return c.json({ error: 'Not found' }, 404);

    if (body.title !== undefined) {
        db.prepare('UPDATE sessions SET title = ? WHERE id = ?').run(body.title, id);
    }
    if (body.ended_at) {
        db.prepare('UPDATE sessions SET ended_at = ? WHERE id = ?').run(body.ended_at, id);
    }

    return c.json({ success: true });
});

// POST /api/sessions/:id/archive - 手动归档会话
sessionRouter.post('/:id/archive', async (c) => {
    const id = c.req.param('id');
    const db = getDb();

    // 验证会话存在
    const session = db.prepare('SELECT id, workspace_id FROM sessions WHERE id = ?').get(id) as { id: string; workspace_id: string } | undefined;
    if (!session) {
        return c.json({ error: 'Session not found' }, 404);
    }

    // 执行归档
    const result = await archiveSession(id, session.workspace_id);

    if (!result.success) {
        return c.json({ success: false, error: result.reason || 'Archive failed' }, 500);
    }

    if (result.skipped) {
        return c.json({ success: true, skipped: true, reason: result.reason });
    }

    return c.json({
        success: true,
        summary: result.summary,
        tokens: result.tokens,
    });
});
