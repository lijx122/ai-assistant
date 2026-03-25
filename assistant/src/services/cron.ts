import { schedule, ScheduledTask } from 'node-cron';
import { getDb } from '../db';
import { pushToTarget } from './lark';
import { getWorkspaceRootPath } from './workspace-config';
import { exec } from 'child_process';
import { promisify } from 'util';
import axios from 'axios';
import { randomUUID } from 'crypto';
import { NotifyTarget } from '../types';
import { createAlert, handleAlert } from './alert-handler';
import { logger } from './logger';

const execAsync = promisify(exec);

// 正在运行的定时任务 Map: taskId -> ScheduledTask
const scheduledTasks = new Map<string, ScheduledTask>();

// 运行中任务锁（进程内）：taskId -> running
const runningTaskIds = new Set<string>();

// 任务定义
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
    notify_target: string | null; // JSON string of NotifyTarget
    alert_on_error: number; // 0 = false, 1 = true
    last_run: number | null;
    next_run: number | null;
    run_count: number;
    fail_count: number;
    isRunning?: boolean;
}

// 执行记录
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
 * 初始化定时任务引擎
 * 服务启动时调用，加载所有 active 任务
 */
export function initCronEngine(): void {
    console.log('[Cron] Initializing cron engine...');

    const db = getDb();
    const tasks = db.prepare(
        `SELECT * FROM tasks WHERE status = 'active'`
    ).all() as Task[];

    for (const task of tasks) {
        try {
            registerTask(task);
        } catch (err: any) {
            console.error(`[Cron] Failed to register task ${task.id} (${task.name}):`, err.message);
        }
    }

    console.log(`[Cron] Loaded ${tasks.length} active tasks`);
}

/**
 * 关闭定时任务引擎
 * 服务停止时调用，清理所有 scheduled tasks
 */
export function shutdownCronEngine(): void {
    console.log('[Cron] Shutting down cron engine...');

    for (const [taskId, scheduledTask] of scheduledTasks.entries()) {
        scheduledTask.stop();
        console.log(`[Cron] Stopped task ${taskId}`);
    }

    scheduledTasks.clear();
    console.log('[Cron] All tasks stopped');
}

/**
 * 注册单个任务到调度器
 */
export function registerTask(task: Task): void {
    // 先取消已存在的同名任务
    unregisterTask(task.id);

    if (task.status !== 'active') {
        return;
    }

    const cronExpression = convertToCronExpression(task.type, task.schedule);
    if (!cronExpression) {
        console.error(`[Cron] Invalid schedule for task ${task.id}: ${task.type} ${task.schedule}`);
        return;
    }

    // 计算下次执行时间
    updateNextRun(task.id, task.type, task.schedule);

    // 对于 once 类型，检查是否已过期
    if (task.type === 'once') {
        const nextRun = calculateNextRun('once', task.schedule);
        if (nextRun === null || nextRun <= Date.now()) {
            console.log(`[Cron] Skipping expired once task ${task.id}`);
            markTaskCompleted(task.id);
            return;
        }
    }

    const scheduledTask = schedule(cronExpression, async () => {
        if (runningTaskIds.has(task.id)) {
            console.warn(`[Cron] Task ${task.id} already running, skipping`);
            return;
        }

        runningTaskIds.add(task.id);
        try {
            await executeTask(task);
        } finally {
            runningTaskIds.delete(task.id);
        }
    }, {
        timezone: 'Asia/Shanghai',
    });

    scheduledTasks.set(task.id, scheduledTask);
    console.log(`[Cron] Registered task ${task.id} (${task.name}) with schedule: ${cronExpression}`);
}

/**
 * 取消任务注册
 */
export function unregisterTask(taskId: string): void {
    const existing = scheduledTasks.get(taskId);
    if (existing) {
        existing.stop();
        scheduledTasks.delete(taskId);
    }
    runningTaskIds.delete(taskId);
}

/**
 * 执行单个任务
 */
async function executeTask(task: Task): Promise<void> {
    const runId = randomUUID();
    const startedAt = Date.now();

    console.log(`[Cron] Executing task ${task.id} (${task.name}), runId: ${runId}`);
    logger.task.info('cron', `Executing task ${task.name}`, { taskId: task.id, workspaceId: task.workspace_id, commandType: task.command_type });

    // 创建执行记录
    const db = getDb();
    db.prepare(
        `INSERT INTO task_runs (id, task_id, started_at, ended_at, status, output, error)
         VALUES (?, ?, ?, NULL, 'success', NULL, NULL)`
    ).run(runId, task.id, startedAt);

    let output: string | null = null;
    let error: string | null = null;
    let status: 'success' | 'error' | 'timeout' = 'success';

    try {
        // 根据 command_type 执行不同逻辑
        switch (task.command_type) {
            case 'shell':
                output = await executeShell(task.workspace_id, task.command);
                break;
            case 'assistant':
                output = await executeAssistant(task.workspace_id, task.user_id, task.command, task.name);
                break;
            case 'http':
                output = await executeHttp(task.command);
                break;
            default:
                throw new Error(`Unknown command_type: ${task.command_type}`);
        }

        console.log(`[Cron] Task ${task.id} completed successfully`);
    } catch (err: any) {
        status = 'error';
        error = err.message || String(err);
        output = null;
        console.error(`[Cron] Task ${task.id} failed:`, error);
    }

    const endedAt = Date.now();
    const success = status === 'success';

    // Log task completion
    logger.task.info('cron', `Task ${task.name} ${success ? 'succeeded' : 'failed'}`, { taskId: task.id, workspaceId: task.workspace_id, duration: endedAt - startedAt, status });

    // 更新执行记录
    db.prepare(
        `UPDATE task_runs SET ended_at = ?, status = ?, output = ?, error = ? WHERE id = ?`
    ).run(endedAt, status, output, error, runId);

    // 更新任务统计
    const newRunCount = task.run_count + 1;
    const newFailCount = status === 'success' ? 0 : task.fail_count + 1;

    // 检查失败次数，超过3次自动暂停
    if (newFailCount >= 3) {
        console.warn(`[Cron] Task ${task.id} failed ${newFailCount} times, pausing`);
        db.prepare(
            `UPDATE tasks SET status = 'paused', last_run = ?, next_run = NULL, run_count = ?, fail_count = ? WHERE id = ?`
        ).run(startedAt, newRunCount, newFailCount, task.id);
        unregisterTask(task.id);
    } else {
        // 更新下次执行时间
        const nextRun = calculateNextRun(task.type, task.schedule);
        db.prepare(
            `UPDATE tasks SET last_run = ?, next_run = ?, run_count = ?, fail_count = ? WHERE id = ?`
        ).run(startedAt, nextRun, newRunCount, newFailCount, task.id);
    }

    // 发送通知
    const notifyTarget: NotifyTarget | null = task.notify_target ? JSON.parse(task.notify_target) : null;
    if (notifyTarget) {
        const duration = endedAt - startedAt;
        const summary = buildExecutionSummary(task, status, output, error, duration);
        try {
            await pushToTarget(notifyTarget, summary);
        } catch (notifyErr: any) {
            console.error(`[Cron] Failed to send notification for task ${task.id}:`, notifyErr.message);
        }
    }

    // Shell 任务失败且 alert_on_error=true 时，创建告警
    if (task.command_type === 'shell' && status === 'error' && task.alert_on_error) {
        try {
            // 解析 HINT: 和 LOG: 字段
            const outputStr = output || error || '';
            const hintMatch = outputStr.match(/HINT:\s*(.+?)(?:\n|$)/);
            const logMatch = outputStr.match(/LOG:\s*(.+?)(?:\n|$)/);

            const hint = hintMatch ? hintMatch[1].trim() : `任务 "${task.name}" 执行失败`;
            const log = logMatch ? logMatch[1].trim() : outputStr.slice(0, 500);

            const alertId = await createAlert({
                workspace_id: task.workspace_id,
                task_id: task.id,
                source: `cron-task:${task.name}`,
                message: hint,
                raw: JSON.stringify({
                    task_id: task.id,
                    task_name: task.name,
                    command: task.command,
                    output: log,
                    error: error,
                }),
            });

            console.log(`[Cron] Created alert ${alertId} for failed task ${task.id}`);

            // 启动告警处理流程（AI分析 + 通知）
            handleAlert(alertId).catch(err => {
                console.error(`[Cron] handleAlert failed for alert ${alertId}:`, err);
            });
        } catch (alertErr: any) {
            console.error(`[Cron] Failed to create alert for task ${task.id}:`, alertErr.message);
        }
    }

    // 对于 once 类型且执行成功，标记为已完成
    if (task.type === 'once' && status === 'success') {
        markTaskCompleted(task.id);
        unregisterTask(task.id);
    }
}

/**
 * 执行 shell 命令
 */
async function executeShell(workspaceId: string, command: string): Promise<string> {
    const cwd = getWorkspaceRootPath(workspaceId);

    const { stdout, stderr } = await execAsync(command, {
        cwd,
        timeout: 300000, // 5分钟超时
        maxBuffer: 1024 * 1024, // 1MB 输出缓冲
    });

    const output = stdout || stderr;
    return output.substring(0, 10000); // 限制输出长度
}

/**
 * 执行 assistant 类型任务（发送到对话引擎）
 */
async function executeAssistant(
    workspaceId: string,
    userId: string,
    command: string,
    taskName: string
): Promise<string> {
    const db = getDb();

    // 创建一个新的 session
    const sessionId = randomUUID();
    const now = Date.now();

    db.prepare(
        `INSERT INTO sessions (id, workspace_id, user_id, channel, title, started_at, last_active_at)
         VALUES (?, ?, ?, 'web', ?, ?, ?)`
    ).run(sessionId, workspaceId, userId, `[定时任务] ${taskName}`, now, now);

    // 插入用户消息（即定时任务的命令）
    const messageId = randomUUID();
    db.prepare(
        `INSERT INTO messages (id, session_id, workspace_id, user_id, role, content, created_at)
         VALUES (?, ?, ?, ?, 'user', ?, ?)`
    ).run(messageId, sessionId, workspaceId, userId, command, now);

    // 注意：这里我们返回 session ID，实际执行由对话引擎异步处理
    // 任务执行结果需要通过消息监听或后续查询获取
    return `已创建会话 ${sessionId}，任务已入队处理`;
}

/**
 * 执行 HTTP 请求
 */
async function executeHttp(command: string): Promise<string> {
    // command 应该是 URL
    const url = command.trim();

    if (!url.startsWith('http://') && !url.startsWith('https://')) {
        throw new Error('HTTP command must be a valid URL starting with http:// or https://');
    }

    const response = await axios.request({
        method: 'GET',
        url,
        timeout: 30000,
        validateStatus: () => true, // 接受任何状态码
    });

    const result = {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
        data: response.data,
    };

    return JSON.stringify(result, null, 2).substring(0, 10000);
}

/**
 * 转换任务类型和调度表达式为 cron 表达式
 */
function convertToCronExpression(type: string, schedule: string): string | null {
    switch (type) {
        case 'cron':
            // 直接使用 cron 表达式
            return schedule;
        case 'interval':
            // interval 格式: "30m" (30分钟), "2h" (2小时), "1d" (1天)
            return parseIntervalToCron(schedule);
        case 'once':
            // once 格式: ISO 8601 时间字符串或时间戳
            return parseOnceToCron(schedule);
        default:
            return null;
    }
}

/**
 * 解析 interval 格式为 cron
 * 支持: m(分钟), h(小时), d(天)
 */
function parseIntervalToCron(interval: string): string | null {
    const match = interval.match(/^(\d+)([mhd])$/);
    if (!match) return null;

    const value = parseInt(match[1], 10);
    const unit = match[2];

    switch (unit) {
        case 'm':
            // 每 N 分钟: */N * * * *
            return `*/${value} * * * *`;
        case 'h':
            // 每 N 小时: 0 */N * * *
            return `0 */${value} * * *`;
        case 'd':
            // 每 N 天: 0 0 */N * *
            return `0 0 */${value} * *`;
        default:
            return null;
    }
}

/**
 * 解析 once 格式为 cron（用于一次性执行）
 * 由于 node-cron 不支持一次性任务，我们使用一个只执行一次的 cron
 */
function parseOnceToCron(schedule: string): string | null {
    const date = new Date(schedule);
    if (isNaN(date.getTime())) {
        return null;
    }

    // 构建精确到分钟的 cron 表达式
    const minutes = date.getMinutes();
    const hours = date.getHours();
    const day = date.getDate();
    const month = date.getMonth() + 1;

    return `${minutes} ${hours} ${day} ${month} *`;
}

/**
 * 计算下次执行时间（毫秒时间戳）
 */
function calculateNextRun(type: string, schedule: string): number | null {
    const now = Date.now();

    switch (type) {
        case 'cron':
            // 对于 cron，估算下次执行（简化处理：假设每分钟检查）
            // 实际下次执行由 node-cron 内部管理
            return now + 60000;
        case 'interval':
            const match = schedule.match(/^(\d+)([mhd])$/);
            if (!match) return null;
            const value = parseInt(match[1], 10);
            const unit = match[2];
            const ms = unit === 'm' ? value * 60000 : unit === 'h' ? value * 3600000 : value * 86400000;
            return now + ms;
        case 'once':
            const date = new Date(schedule);
            return isNaN(date.getTime()) ? null : date.getTime();
        default:
            return null;
    }
}

/**
 * 更新任务的下次执行时间
 */
function updateNextRun(taskId: string, type: string, schedule: string): void {
    const nextRun = calculateNextRun(type, schedule);
    if (nextRun) {
        const db = getDb();
        db.prepare(`UPDATE tasks SET next_run = ? WHERE id = ?`).run(nextRun, taskId);
    }
}

/**
 * 标记任务为已完成
 */
function markTaskCompleted(taskId: string): void {
    const db = getDb();
    db.prepare(`UPDATE tasks SET status = 'completed', next_run = NULL WHERE id = ?`).run(taskId);
}

/**
 * 构建执行结果摘要
 */
function buildExecutionSummary(
    task: Task,
    status: 'success' | 'error' | 'timeout',
    output: string | null,
    error: string | null,
    duration: number
): string {
    const statusEmoji = status === 'success' ? '✅' : '❌';
    const statusText = status === 'success' ? '成功' : '失败';

    let summary = `${statusEmoji} 定时任务「${task.name}」执行${statusText}\n`;
    summary += `类型: ${task.command_type}\n`;
    summary += `耗时: ${Math.round(duration / 1000)}s\n`;

    if (status === 'success' && output) {
        summary += `\n输出:\n${output.substring(0, 500)}`;
        if (output.length > 500) {
            summary += '\n... (已截断)';
        }
    }

    if (status === 'error' && error) {
        summary += `\n错误:\n${error.substring(0, 500)}`;
    }

    return summary;
}

/**
 * 手动触发任务（用于测试或立即执行）
 */
export async function triggerTask(taskId: string): Promise<void> {
    const db = getDb();
    const task = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(taskId) as Task | undefined;

    if (!task) {
        throw new Error(`Task not found: ${taskId}`);
    }

    if (runningTaskIds.has(task.id)) {
        throw new Error(`Task already running: ${taskId}`);
    }

    runningTaskIds.add(task.id);
    try {
        await executeTask(task);
    } finally {
        runningTaskIds.delete(task.id);
    }
}

/**
 * 暂停任务
 */
export function pauseTask(taskId: string): void {
    const db = getDb();
    db.prepare(`UPDATE tasks SET status = 'paused', next_run = NULL WHERE id = ?`).run(taskId);
    unregisterTask(taskId);
}

/**
 * 恢复任务
 */
export function resumeTask(taskId: string): void {
    const db = getDb();
    const task = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(taskId) as Task | undefined;

    if (!task) {
        throw new Error(`Task not found: ${taskId}`);
    }

    if (task.status === 'completed') {
        throw new Error(`Cannot resume completed task`);
    }

    db.prepare(`UPDATE tasks SET status = 'active' WHERE id = ?`).run(taskId);
    registerTask({ ...task, status: 'active' });
}
