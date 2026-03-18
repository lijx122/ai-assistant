/**
 * Logs API Routes
 *
 * 提供日志查询接口和实时推送
 * GET /api/logs - 查询日志（支持过滤）
 * WS /ws/logs - WebSocket 实时日志流
 */

import { Hono } from 'hono';
import { getDb } from '../db';
import { authMiddleware } from '../middleware/auth';
import { AuthContext } from '../types';
import { queryLogs, getLogStats, LogLevel, LogCategory } from '../services/logger';

export const logsRouter = new Hono<{ Variables: { user: AuthContext } }>();

logsRouter.use('*', authMiddleware);

// GET /api/logs
// 查询日志列表
logsRouter.get('/', (c) => {
    const query = c.req.query();

    const result = queryLogs({
        category: query.category as LogCategory | undefined,
        level: query.level as LogLevel | undefined,
        module: query.module,
        traceId: query.traceId,
        startTime: query.startTime ? parseInt(query.startTime) : undefined,
        endTime: query.endTime ? parseInt(query.endTime) : undefined,
        keyword: query.keyword,
        limit: query.limit ? parseInt(query.limit) : 100,
        offset: query.offset ? parseInt(query.offset) : 0,
    });

    return c.json({
        success: true,
        data: result,
        total: result.length,
    });
});

// GET /api/logs/stats
// 获取日志统计
logsRouter.get('/stats', (c) => {
    const stats = getLogStats();
    return c.json({
        success: true,
        data: stats,
    });
});

// GET /api/logs/categories
// 获取所有分类列表
logsRouter.get('/categories', (c) => {
    const categories: { value: LogCategory; label: string }[] = [
        { value: 'system', label: '系统' },
        { value: 'sdk', label: 'SDK' },
        { value: 'task', label: '任务' },
        { value: 'terminal', label: '终端' },
    ];
    return c.json({
        success: true,
        data: categories,
    });
});

// GET /api/logs/modules
// 获取所有模块列表（去重）
logsRouter.get('/modules', (c) => {
    const db = getDb();
    if (!db) {
        return c.json({ success: false, error: 'DB not available' }, 500);
    }

    const rows = db.prepare('SELECT DISTINCT module FROM logs ORDER BY module').all() as { module: string }[];
    return c.json({
        success: true,
        data: rows.map(r => r.module),
    });
});

// GET /api/logs/recent
// 获取最近日志（简化接口）
logsRouter.get('/recent', (c) => {
    const query = c.req.query();
    const category = query.category as LogCategory | undefined;
    const limit = query.limit ? parseInt(query.limit) : 50;

    const result = queryLogs({
        category,
        limit,
    });

    return c.json({
        success: true,
        data: result,
    });
});
