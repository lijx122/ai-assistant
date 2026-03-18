/**
 * Internal Routes - 内部 API 路由
 * 用于运维告警、系统内部通信
 *
 * @module src/routes/internal
 */

import { Hono } from 'hono';
import { getDb } from '../db';
import { createAlert, handleAlert, attemptFix, ignoreAlert } from '../services/alert-handler';
import { randomUUID } from 'crypto';

export const internalRouter = new Hono();

// POST /api/internal/alert
// 创建告警，异步处理
internalRouter.post('/alert', async (c) => {
    try {
        const body = await c.req.json();

        // 参数校验
        if (!body.source || !body.message) {
            return c.json({
                success: false,
                error: 'Missing required fields: source, message',
            }, 400);
        }

        // 如果没有提供 workspace_id，使用默认工作区
        let workspaceId = body.workspace_id;
        if (!workspaceId) {
            const db = getDb();
            const defaultWorkspace = db.prepare(
                'SELECT id FROM workspaces ORDER BY created_at ASC LIMIT 1'
            ).get() as { id: string } | undefined;
            workspaceId = defaultWorkspace?.id || 'default';
        }

        // 创建告警记录
        const alertId = await createAlert({
            workspace_id: workspaceId,
            task_id: body.task_id,
            source: body.source,
            message: body.message,
            raw: body.raw,
        });

        // 异步处理告警（AI分析、通知）
        setImmediate(() => {
            handleAlert(alertId).catch(err => {
                console.error('[InternalRoute] handleAlert error:', err);
            });
        });

        // 立即返回，不等待处理完成
        return c.json({
            success: true,
            alertId,
            message: 'Alert created, processing asynchronously',
        });

    } catch (err: any) {
        console.error('[InternalRoute] Create alert error:', err);
        return c.json({
            success: false,
            error: err.message || 'Failed to create alert',
        }, 500);
    }
});

// GET /api/internal/alerts
// 查询告警列表
internalRouter.get('/alerts', (c) => {
    try {
        const workspaceId = c.req.query('workspace_id');
        const status = c.req.query('status');
        const limit = parseInt(c.req.query('limit') || '50');

        const db = getDb();
        let sql = 'SELECT * FROM alerts WHERE 1=1';
        const params: any[] = [];

        if (workspaceId) {
            sql += ' AND workspace_id = ?';
            params.push(workspaceId);
        }
        if (status) {
            sql += ' AND status = ?';
            params.push(status);
        }

        sql += ' ORDER BY created_at DESC LIMIT ?';
        params.push(limit);

        const alerts = db.prepare(sql).all(...params);

        return c.json({
            success: true,
            alerts,
        });

    } catch (err: any) {
        console.error('[InternalRoute] Get alerts error:', err);
        return c.json({
            success: false,
            error: err.message || 'Failed to get alerts',
        }, 500);
    }
});

// GET /api/internal/alerts/:id
// 获取单个告警详情
internalRouter.get('/alerts/:id', (c) => {
    try {
        const alertId = c.req.param('id');
        const db = getDb();
        const alert = db.prepare('SELECT * FROM alerts WHERE id = ?').get(alertId);

        if (!alert) {
            return c.json({
                success: false,
                error: 'Alert not found',
            }, 404);
        }

        return c.json({
            success: true,
            alert,
        });

    } catch (err: any) {
        console.error('[InternalRoute] Get alert error:', err);
        return c.json({
            success: false,
            error: err.message || 'Failed to get alert',
        }, 500);
    }
});

// POST /api/internal/alerts/:id/fix
// 手动触发修复
internalRouter.post('/alerts/:id/fix', async (c) => {
    try {
        const alertId = c.req.param('id');
        const db = getDb();
        const alert = db.prepare('SELECT * FROM alerts WHERE id = ?').get(alertId) as
            { workspace_id: string } | undefined;

        if (!alert) {
            return c.json({
                success: false,
                error: 'Alert not found',
            }, 404);
        }

        // 异步执行修复
        setImmediate(() => {
            attemptFix(alertId, alert.workspace_id).catch(err => {
                console.error('[InternalRoute] attemptFix error:', err);
            });
        });

        return c.json({
            success: true,
            message: 'Fix triggered asynchronously',
        });

    } catch (err: any) {
        console.error('[InternalRoute] Fix alert error:', err);
        return c.json({
            success: false,
            error: err.message || 'Failed to fix alert',
        }, 500);
    }
});

// POST /api/internal/alerts/:id/ignore
// 忽略告警
internalRouter.post('/alerts/:id/ignore', async (c) => {
    try {
        const alertId = c.req.param('id');
        const db = getDb();
        const alert = db.prepare('SELECT * FROM alerts WHERE id = ?').get(alertId) as
            { workspace_id: string } | undefined;

        if (!alert) {
            return c.json({
                success: false,
                error: 'Alert not found',
            }, 404);
        }

        await ignoreAlert(alertId, alert.workspace_id);

        return c.json({
            success: true,
            message: 'Alert ignored',
        });

    } catch (err: any) {
        console.error('[InternalRoute] Ignore alert error:', err);
        return c.json({
            success: false,
            error: err.message || 'Failed to ignore alert',
        }, 500);
    }
});
