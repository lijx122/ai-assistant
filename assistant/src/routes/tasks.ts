import { Hono } from 'hono';
import { getDb } from '../db';
import { randomUUID } from 'crypto';
import { authMiddleware } from '../middleware/auth';
import { AuthContext } from '../types';
import { registerTask, unregisterTask, triggerTask, pauseTask, resumeTask } from '../services/cron';

export const taskRouter = new Hono<{ Variables: { user: AuthContext } }>();

taskRouter.use('*', authMiddleware);

// 任务类型定义
interface Task {
    id: string;
    workspace_id: string;
    user_id: string;
    name: string;
    type: 'cron' | 'interval' | 'once';
    schedule: string;
    command: string;
    command_type: 'shell' | 'assistant' | 'http';
    status: 'active' | 'paused' | 'completed';
    notify_target: string | null;
    notify_enabled: number;
    alert_on_error: number;
    last_run: number | null;
    next_run: number | null;
    run_count: number;
    fail_count: number;
    created_at: number;
}

interface TaskRun {
    id: string;
    task_id: string;
    started_at: number;
    ended_at: number | null;
    status: 'success' | 'error' | 'timeout';
    output: string | null;
    error: string | null;
}

/**
 * GET /api/tasks?workspaceId=
 * 获取指定工作区的任务列表
 */
taskRouter.get('/', (c) => {
    const workspaceId = c.req.query('workspaceId');
    if (!workspaceId) {
        return c.json({ error: 'workspaceId is required' }, 400);
    }

    const userId = c.get('user').userId;
    const db = getDb();

    // 验证工作区访问权限
    const workspace = db.prepare('SELECT * FROM workspaces WHERE id = ? AND user_id = ?').get(workspaceId, userId);
    if (!workspace) {
        return c.json({ error: 'Workspace not found or access denied' }, 404);
    }

    const tasks = db.prepare(
        `SELECT id, workspace_id, name, type, schedule, command, command_type,
                status, notify_target, notify_enabled, alert_on_error, last_run, next_run, run_count, fail_count, created_at
         FROM tasks WHERE workspace_id = ? ORDER BY created_at DESC`
    ).all(workspaceId) as Task[];

    // 解析 notify_target JSON
    const tasksWithParsedNotifyTarget = tasks.map(task => ({
        ...task,
        notify_target: task.notify_target ? JSON.parse(task.notify_target) : null,
    }));

    return c.json({ tasks: tasksWithParsedNotifyTarget });
});

/**
 * GET /api/tasks/:id
 * 获取任务详情
 */
taskRouter.get('/:id', (c) => {
    const id = c.req.param('id');
    const userId = c.get('user').userId;

    const db = getDb();

    // 验证任务存在
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Task | undefined;
    if (!task) {
        return c.json({ error: 'Task not found' }, 404);
    }

    // 验证工作区访问权限（允许访问自己工作区的任务，包括 system 创建的）
    const workspace = db.prepare('SELECT * FROM workspaces WHERE id = ? AND user_id = ?').get(task.workspace_id, userId);
    if (!workspace) {
        return c.json({ error: 'Access denied' }, 403);
    }

    return c.json({
        task: {
            ...task,
            notify_target: task.notify_target ? JSON.parse(task.notify_target) : null,
        }
    });
});

/**
 * POST /api/tasks
 * 创建新任务
 */
taskRouter.post('/', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const userId = c.get('user').userId;

    // 验证必填字段
    const required = ['workspaceId', 'name', 'type', 'schedule', 'command', 'commandType'];
    for (const field of required) {
        if (!body[field]) {
            return c.json({ error: `${field} is required` }, 400);
        }
    }

    // 验证 type
    if (!['cron', 'interval', 'once'].includes(body.type)) {
        return c.json({ error: 'type must be cron, interval, or once' }, 400);
    }

    // 验证 commandType
    if (!['shell', 'assistant', 'http'].includes(body.commandType)) {
        return c.json({ error: 'commandType must be shell, assistant, or http' }, 400);
    }

    const db = getDb();

    // 验证工作区访问权限
    const workspace = db.prepare('SELECT * FROM workspaces WHERE id = ? AND user_id = ?').get(body.workspaceId, userId);
    if (!workspace) {
        return c.json({ error: 'Workspace not found or access denied' }, 404);
    }

    const id = randomUUID();
    const now = Date.now();

    // 计算下次执行时间
    let nextRun: number | null = null;
    if (body.type === 'once') {
        nextRun = new Date(body.schedule).getTime();
        if (isNaN(nextRun)) {
            return c.json({ error: 'Invalid schedule for once type' }, 400);
        }
    }

    // notify_target 序列化
    const notifyTarget = body.notifyTarget ? JSON.stringify(body.notifyTarget) : null;
    const notifyEnabled = body.notifyEnabled ? 1 : 0;
    const alertOnError = body.alertOnError ? 1 : 0;

    db.prepare(
        `INSERT INTO tasks (id, workspace_id, user_id, name, type, schedule, command, command_type,
                           status, notify_target, notify_enabled, alert_on_error, last_run, next_run, run_count, fail_count, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, NULL, ?, 0, 0, ?)`
    ).run(
        id,
        body.workspaceId,
        userId,
        body.name,
        body.type,
        body.schedule,
        body.command,
        body.commandType,
        notifyTarget,
        notifyEnabled,
        alertOnError,
        nextRun,
        now
    );

    // 注册到 cron 引擎
    const task: Task = {
        id,
        workspace_id: body.workspaceId,
        user_id: userId,
        name: body.name,
        type: body.type,
        schedule: body.schedule,
        command: body.command,
        command_type: body.commandType,
        status: 'active',
        notify_target: notifyTarget,
        notify_enabled: notifyEnabled,
        alert_on_error: alertOnError,
        last_run: null,
        next_run: nextRun,
        run_count: 0,
        fail_count: 0,
        created_at: now,
    };
    registerTask(task);

    const createdTask = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Task;
    return c.json({
        success: true,
        task: {
            ...createdTask,
            notify_target: createdTask.notify_target ? JSON.parse(createdTask.notify_target) : null,
        }
    }, 201);
});

/**
 * PUT /api/tasks/:id
 * 更新任务
 */
taskRouter.put('/:id', async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json().catch(() => ({}));
    const userId = c.get('user').userId;

    const db = getDb();

    // 验证任务存在
    const existingTask = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Task | undefined;
    if (!existingTask) {
        return c.json({ error: 'Task not found' }, 404);
    }

    // 验证工作区访问权限
    const workspace = db.prepare('SELECT * FROM workspaces WHERE id = ? AND user_id = ?').get(existingTask.workspace_id, userId);
    if (!workspace) {
        return c.json({ error: 'Access denied' }, 403);
    }

    // 已完成的任务不能修改（但 once 类型可以重新编辑激活）
    if (existingTask.status === 'completed' && existingTask.type !== 'once') {
        return c.json({ error: 'Cannot modify completed task' }, 400);
    }

    // 先取消现有任务
    unregisterTask(id);

    // 构建更新字段
    const updates: string[] = [];
    const values: any[] = [];

    if (body.name !== undefined) {
        updates.push('name = ?');
        values.push(body.name);
    }

    if (body.schedule !== undefined) {
        updates.push('schedule = ?');
        values.push(body.schedule);
    }

    if (body.command !== undefined) {
        updates.push('command = ?');
        values.push(body.command);
    }

    if (body.notifyTarget !== undefined) {
        updates.push('notify_target = ?');
        values.push(body.notifyTarget ? JSON.stringify(body.notifyTarget) : null);
    }

    if (body.notifyEnabled !== undefined) {
        updates.push('notify_enabled = ?');
        values.push(body.notifyEnabled ? 1 : 0);
    }

    if (body.alertOnError !== undefined) {
        updates.push('alert_on_error = ?');
        values.push(body.alertOnError ? 1 : 0);
    }

    // 如果修改了 type/schedule/command，或者是 once 类型任务编辑，重置状态
    const isOnceTaskReset = existingTask.type === 'once' && (body.schedule !== undefined || body.status === 'active');
    if (body.type !== undefined || body.schedule !== undefined || body.command !== undefined || isOnceTaskReset) {
        updates.push('status = ?');
        values.push('active');
        updates.push('fail_count = ?');
        values.push(0);
        // once 任务重置时清零 run_count
        if (existingTask.type === 'once') {
            updates.push('run_count = ?');
            values.push(0);
        }
    }

    // 重新计算下次执行时间
    const newType = body.type || existingTask.type;
    const newSchedule = body.schedule || existingTask.schedule;
    let nextRun: number | null = null;

    if (newType === 'once') {
        nextRun = new Date(newSchedule).getTime();
    }

    updates.push('next_run = ?');
    values.push(nextRun);

    if (updates.length === 0) {
        return c.json({ error: 'No fields to update' }, 400);
    }

    values.push(id);
    db.prepare(`UPDATE tasks SET ${updates.join(', ')} WHERE id = ?`).run(...values);

    // 重新注册任务（如果是 active 状态）
    const updatedTask = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Task;
    if (updatedTask.status === 'active') {
        registerTask(updatedTask);
    }

    return c.json({
        success: true,
        task: {
            ...updatedTask,
            notify_target: updatedTask.notify_target ? JSON.parse(updatedTask.notify_target) : null,
        }
    });
});

/**
 * DELETE /api/tasks/:id
 * 删除任务
 */
taskRouter.delete('/:id', (c) => {
    const id = c.req.param('id');
    const userId = c.get('user').userId;

    const db = getDb();

    // 验证任务存在
    const existingTask = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Task | undefined;
    if (!existingTask) {
        return c.json({ error: 'Task not found' }, 404);
    }

    // 验证工作区访问权限（允许删除自己工作区的任务，包括 system 创建的）
    const workspace = db.prepare('SELECT * FROM workspaces WHERE id = ? AND user_id = ?').get(existingTask.workspace_id, userId);
    if (!workspace) {
        return c.json({ error: 'Access denied' }, 403);
    }

    // 取消任务
    unregisterTask(id);

    // 删除关联的告警记录
    const delAlerts = db.prepare('DELETE FROM alerts WHERE task_id = ?').run(id);
    console.log('[Delete] task', id, 'alerts changes:', delAlerts.changes);

    // 删除执行记录（可选：保留历史记录，这里选择删除）
    const delTaskRuns = db.prepare('DELETE FROM task_runs WHERE task_id = ?').run(id);
    console.log('[Delete] task', id, 'task_runs changes:', delTaskRuns.changes);

    // 删除任务本身
    const delTask = db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
    console.log('[Delete] task', id, 'tasks changes:', delTask.changes);

    if (delTask.changes === 0) {
        console.warn('[Delete] task', id, 'failed: no rows deleted');
        return c.json({ error: 'Task delete failed' }, 500);
    }

    return c.json({ success: true });
});

/**
 * POST /api/tasks/:id/pause
 * 暂停任务
 */
taskRouter.post('/:id/pause', (c) => {
    const id = c.req.param('id');
    const userId = c.get('user').userId;

    const db = getDb();

    // 验证任务存在且属于当前用户
    const existingTask = db.prepare('SELECT * FROM tasks WHERE id = ? AND user_id = ?').get(id, userId) as Task | undefined;
    if (!existingTask) {
        return c.json({ error: 'Task not found or access denied' }, 404);
    }

    if (existingTask.status !== 'active') {
        return c.json({ error: 'Task is not active' }, 400);
    }

    pauseTask(id);

    const updatedTask = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Task;
    return c.json({
        success: true,
        task: {
            ...updatedTask,
            notify_target: updatedTask.notify_target ? JSON.parse(updatedTask.notify_target) : null,
        }
    });
});

/**
 * POST /api/tasks/:id/resume
 * 恢复任务
 */
taskRouter.post('/:id/resume', (c) => {
    const id = c.req.param('id');
    const userId = c.get('user').userId;

    const db = getDb();

    // 验证任务存在且属于当前用户
    const existingTask = db.prepare('SELECT * FROM tasks WHERE id = ? AND user_id = ?').get(id, userId) as Task | undefined;
    if (!existingTask) {
        return c.json({ error: 'Task not found or access denied' }, 404);
    }

    if (existingTask.status !== 'paused') {
        return c.json({ error: 'Task is not paused' }, 400);
    }

    resumeTask(id);

    const updatedTask = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Task;
    return c.json({
        success: true,
        task: {
            ...updatedTask,
            notify_target: updatedTask.notify_target ? JSON.parse(updatedTask.notify_target) : null,
        }
    });
});

/**
 * POST /api/tasks/:id/trigger
 * 手动触发任务执行
 */
taskRouter.post('/:id/trigger', async (c) => {
    const id = c.req.param('id');
    const userId = c.get('user').userId;

    const db = getDb();

    // 验证任务存在且属于当前用户
    const existingTask = db.prepare('SELECT * FROM tasks WHERE id = ? AND user_id = ?').get(id, userId) as Task | undefined;
    if (!existingTask) {
        return c.json({ error: 'Task not found or access denied' }, 404);
    }

    // 异步执行，不等待结果
    triggerTask(id).catch(err => {
        console.error(`[TaskRouter] Manual trigger failed for task ${id}:`, err);
    });

    return c.json({ success: true, message: 'Task triggered' });
});

/**
 * GET /api/tasks/:id/runs
 * 获取任务执行历史（最近100条）
 */
taskRouter.get('/:id/runs', (c) => {
    const id = c.req.param('id');
    const userId = c.get('user').userId;

    const db = getDb();

    // 验证任务存在且属于当前用户（或 system 创建的）
    const existingTask = db.prepare('SELECT * FROM tasks WHERE id = ? AND (user_id = ? OR user_id = ?)').get(id, userId, 'system') as Task | undefined;
    if (!existingTask) {
        return c.json({ error: 'Task not found or access denied' }, 404);
    }

    const runs = db.prepare(
        `SELECT id, task_id, started_at, ended_at, status, output, error
         FROM task_runs WHERE task_id = ? ORDER BY started_at DESC LIMIT 100`
    ).all(id) as TaskRun[];

    return c.json({ runs });
});
