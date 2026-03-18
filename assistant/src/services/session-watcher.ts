/**
 * Session Watcher
 *
 * 定时扫描会话，触发 Post-Session 处理：
 * - 扫描间隔：config.memory.watcher.scan_interval_minutes 分钟
 * - 触发条件：最后消息 > config.memory.watcher.inactive_hours 小时前，且 2 小时内未处理过
 *
 * 流程：
 * 1. 查询符合条件的会话
 * 2. 对每个会话调用 runPostSession()
 * 3. 成功后标记为已处理
 */

import { getDb } from '../db';
import { getConfig } from '../config';
import { runPostSession, markSessionProcessed, isSessionProcessed } from './post-session';

// 避免重复处理：同一会话在此时间内不重复触发（毫秒）
const REPROCESS_THRESHOLD_MS = 2 * 60 * 60 * 1000; // 2 小时

let watcherInterval: NodeJS.Timeout | null = null;
let isRunning = false;
let currentScanIntervalMs: number = 5 * 60 * 1000; // 默认 5 分钟
let currentInactiveThresholdMs: number = 60 * 60 * 1000; // 默认 1 小时

/**
 * 从配置计算毫秒值
 */
function updateConfigValues(): { scanIntervalMs: number; inactiveThresholdMs: number } {
    const config = getConfig();
    const scanIntervalMs = config.memory.watcher.scan_interval_minutes * 60 * 1000;
    const inactiveThresholdMs = config.memory.watcher.inactive_hours * 60 * 60 * 1000;
    return { scanIntervalMs, inactiveThresholdMs };
}

/**
 * 查询需要处理的会话
 *
 * 条件：
 * 1. 最后一条消息时间 > inactive_hours 小时前
 * 2. 未在 post_session_log 中记录，或记录时间 > 2 小时前
 */
function findSessionsToProcess(): Array<{ id: string; workspace_id: string }> {
    const db = getDb();
    const config = getConfig();
    const now = Date.now();
    const inactiveThresholdMs = config.memory.watcher.inactive_hours * 60 * 60 * 1000;
    const inactiveThreshold = now - inactiveThresholdMs;
    const reprocessThreshold = now - REPROCESS_THRESHOLD_MS;

    // 子查询：找到每个 session 的最后消息时间
    // 然后筛选：最后消息 < inactive_hours小时前，且未处理或2小时前已处理
    const rows = db.prepare(`
        SELECT
            s.id,
            s.workspace_id,
            MAX(m.created_at) as last_message_at
        FROM sessions s
        JOIN messages m ON m.session_id = s.id
        GROUP BY s.id
        HAVING last_message_at < ?
           AND s.id NOT IN (
               SELECT session_id FROM post_session_log
               WHERE triggered_at > datetime(?, 'unixepoch')
           )
        ORDER BY last_message_at ASC
        LIMIT 10
    `).all(inactiveThreshold, reprocessThreshold / 1000) as Array<{
        id: string;
        workspace_id: string;
        last_message_at: number;
    }>;

    return rows;
}

/**
 * 执行一次扫描和处理
 */
async function scanAndProcess(): Promise<void> {
    if (isRunning) {
        console.log('[SessionWatcher] Previous scan still running, skipping...');
        return;
    }

    isRunning = true;
    console.log('[SessionWatcher] Starting scan...');

    try {
        const sessions = findSessionsToProcess();

        if (sessions.length === 0) {
            console.log('[SessionWatcher] No sessions to process');
            return;
        }

        console.log(`[SessionWatcher] Found ${sessions.length} sessions to process`);

        let processed = 0;
        let failed = 0;

        for (const session of sessions) {
            try {
                // 双重检查：防止并发重复处理
                if (isSessionProcessed(session.id)) {
                    console.log(`[SessionWatcher] Session ${session.id} already processed, skipping`);
                    continue;
                }

                console.log(`[SessionWatcher] Processing session ${session.id}...`);
                await runPostSession(session.id, session.workspace_id);

                // 标记为已处理
                markSessionProcessed(session.id);
                processed++;

                console.log(`[SessionWatcher] Session ${session.id} processed successfully`);
            } catch (error: any) {
                console.error(`[SessionWatcher] Failed to process session ${session.id}:`, error.message);
                failed++;
                // 继续处理下一个，不阻塞
            }
        }

        console.log(`[SessionWatcher] Scan complete: ${processed} processed, ${failed} failed`);
    } catch (error: any) {
        console.error('[SessionWatcher] Scan failed:', error.message);
    } finally {
        isRunning = false;
    }
}

/**
 * 启动 Session Watcher
 */
export function startSessionWatcher(): void {
    const config = getConfig();

    // 检查功能是否启用
    if (!config.memory.watcher.enabled) {
        console.log('[SessionWatcher] Disabled in config, skipping startup');
        return;
    }

    if (watcherInterval) {
        console.log('[SessionWatcher] Already running');
        return;
    }

    // 更新配置值
    const { scanIntervalMs, inactiveThresholdMs } = updateConfigValues();
    currentScanIntervalMs = scanIntervalMs;
    currentInactiveThresholdMs = inactiveThresholdMs;

    const scanIntervalMinutes = Math.round(scanIntervalMs / 60 / 1000);
    const inactiveHours = Math.round(inactiveThresholdMs / 60 / 60 / 1000);

    console.log(`[SessionWatcher] Starting watcher (interval: ${scanIntervalMinutes}min, inactive threshold: ${inactiveHours}h)...`);

    // 立即执行一次
    scanAndProcess();

    // 设置定时器
    watcherInterval = setInterval(scanAndProcess, scanIntervalMs);

    // 防止定时器阻止进程退出
    watcherInterval.unref();
}

/**
 * 停止 Session Watcher
 */
export function stopSessionWatcher(): void {
    if (watcherInterval) {
        clearInterval(watcherInterval);
        watcherInterval = null;
        console.log('[SessionWatcher] Stopped');
    }
}

/**
 * 手动触发一次扫描（用于调试或外部调用）
 */
export async function triggerManualScan(): Promise<{ processed: number; failed: number }> {
    const sessions = findSessionsToProcess();
    let processed = 0;
    let failed = 0;

    for (const session of sessions) {
        try {
            if (isSessionProcessed(session.id)) {
                continue;
            }

            await runPostSession(session.id, session.workspace_id);
            markSessionProcessed(session.id);
            processed++;
        } catch (error) {
            failed++;
        }
    }

    return { processed, failed };
}

/**
 * 获取当前状态（用于调试）
 */
export function getWatcherStatus(): {
    running: boolean;
    scanIntervalMs: number;
    inactiveThresholdMs: number;
    reprocessThresholdMs: number;
} {
    return {
        running: watcherInterval !== null,
        scanIntervalMs: currentScanIntervalMs,
        inactiveThresholdMs: currentInactiveThresholdMs,
        reprocessThresholdMs: REPROCESS_THRESHOLD_MS,
    };
}
