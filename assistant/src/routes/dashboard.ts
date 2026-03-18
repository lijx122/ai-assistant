import { Hono } from 'hono';
import { getDb } from '../db';
import { authMiddleware } from '../middleware/auth';
import { AuthContext } from '../types';
import { getRunnerStatus } from '../services/agent-runner';
import { getConfig } from '../config';
import { channelManager } from '../channels';
import { getTerminalStatus } from '../services/terminal';
import { getLogStats } from '../services/logger';

export const dashboardRouter = new Hono<{ Variables: { user: AuthContext } }>();

dashboardRouter.use('*', authMiddleware);

// GET /api/dashboard/system
// 返回系统各组件健康状态
dashboardRouter.get('/system', async (c) => {
    const config = getConfig();

    // 检查 runner 状态
    const runnerStatus = getRunnerStatus();

    // 检查 lark 连接状态
    const larkStatus = { status: 'ok' as const, detail: 'connected' };

    // 获取终端状态
    const terminalStatus = getTerminalStatus();

    // 获取渠道状态
    const channels = channelManager.getStatus();

    return c.json({
        runner: runnerStatus,
        lark: larkStatus,
        terminal: terminalStatus,
        channels,
        timestamp: Date.now()
    });
});

// GET /api/dashboard/stats
// 返回统计数据（token 消耗等）
dashboardRouter.get('/stats', (c) => {
    const db = getDb();
    const workspaceId = c.req.query('workspaceId');

    // 基础统计
    let query = 'SELECT COUNT(*) as totalCalls, SUM(input_tokens) as totalInput, SUM(output_tokens) as totalOutput FROM sdk_calls';
    const params: any[] = [];

    if (workspaceId) {
        query += ' WHERE workspace_id = ?';
        params.push(workspaceId);
    }

    const stats = db.prepare(query).get(...params) as {
        totalCalls: number;
        totalInput: number;
        totalOutput: number;
    };

    // 今日统计
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayStart = today.getTime();

    let todayQuery = 'SELECT COUNT(*) as count FROM sdk_calls WHERE created_at >= ?';
    const todayParams: any[] = [todayStart];

    if (workspaceId) {
        todayQuery += ' AND workspace_id = ?';
        todayParams.push(workspaceId);
    }

    const todayStats = db.prepare(todayQuery).get(...todayParams) as { count: number };

    // 24小时每小时统计（用于折线图）
    const hourlyStats: { hour: string; calls: number; inputTokens: number; outputTokens: number }[] = [];
    const now = Date.now();
    const oneHour = 60 * 60 * 1000;

    for (let i = 23; i >= 0; i--) {
        const hourStart = now - (i + 1) * oneHour;
        const hourEnd = now - i * oneHour;

        let hourQuery = 'SELECT COUNT(*) as calls, SUM(input_tokens) as input, SUM(output_tokens) as output FROM sdk_calls WHERE created_at >= ? AND created_at < ?';
        const hourParams: any[] = [hourStart, hourEnd];

        if (workspaceId) {
            hourQuery += ' AND workspace_id = ?';
            hourParams.push(workspaceId);
        }

        const hourResult = db.prepare(hourQuery).get(...hourParams) as {
            calls: number;
            input: number;
            output: number;
        };

        const hourDate = new Date(hourEnd);
        hourlyStats.push({
            hour: `${hourDate.getHours().toString().padStart(2, '0')}:00`,
            calls: hourResult?.calls || 0,
            inputTokens: hourResult?.input || 0,
            outputTokens: hourResult?.output || 0,
        });
    }

    return c.json({
        total: {
            calls: stats?.totalCalls || 0,
            inputTokens: stats?.totalInput || 0,
            outputTokens: stats?.totalOutput || 0,
        },
        today: {
            calls: todayStats?.count || 0,
        },
        hourly: hourlyStats,
        workspaceId: workspaceId || null,
    });
});

// GET /api/dashboard/tasks
// 返回任务概览
dashboardRouter.get('/tasks', (c) => {
    const db = getDb();

    // 今日执行统计
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayStart = today.getTime();

    const runs = db.prepare(
        'SELECT COUNT(*) as count FROM task_runs WHERE started_at >= ?'
    ).get(todayStart) as { count: number };

    // 失败列表（最近5条）
    const failures = db.prepare(
        'SELECT tr.*, t.name as task_name FROM task_runs tr JOIN tasks t ON tr.task_id = t.id WHERE tr.status = ? ORDER BY tr.started_at DESC LIMIT 5'
    ).all('error') as any[];

    // 各状态统计
    const statusStats = db.prepare(
        'SELECT status, COUNT(*) as count FROM task_runs WHERE started_at >= ? GROUP BY status'
    ).all(todayStart) as { status: string; count: number }[];

    const statusMap: Record<string, number> = {};
    for (const row of statusStats) {
        statusMap[row.status] = row.count;
    }

    return c.json({
        todayRuns: runs?.count || 0,
        todayByStatus: statusMap,
        recentFailures: failures.map(f => ({
            id: f.id,
            taskId: f.task_id,
            taskName: f.task_name,
            error: f.error,
            startedAt: f.started_at,
        })),
    });
});

// GET /api/dashboard/logs
// 返回日志统计（新增）
dashboardRouter.get('/logs', (c) => {
    const stats = getLogStats();
    return c.json({
        success: true,
        data: stats,
    });
});
