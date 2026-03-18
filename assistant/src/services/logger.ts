/**
 * Structured Logger Service
 *
 * 四分类结构化日志：system/sdk/task/terminal
 * 最小字段：{timestamp, level, module, message}
 * 可选字段：{trace_id, metadata}
 *
 * 禁止直接使用 console.log，所有日志通过此服务写入
 */

import { getDb } from '../db';

// ========== 类型定义 ==========

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogCategory = 'system' | 'sdk' | 'task' | 'terminal';

export interface LogEntry {
    id: string;
    timestamp: number;
    level: LogLevel;
    category: LogCategory;
    module: string;
    trace_id?: string;
    message: string;
    metadata?: Record<string, any>;
}

export interface LogQuery {
    category?: LogCategory;
    level?: LogLevel;
    module?: string;
    traceId?: string;
    startTime?: number;
    endTime?: number;
    keyword?: string;
    limit?: number;
    offset?: number;
}

// ========== 内部状态 ==========

let isEnabled = true;
const buffer: LogEntry[] = [];
let flushTimer: NodeJS.Timeout | null = null;
const BUFFER_SIZE = 100;      // 缓冲区大小阈值
const FLUSH_INTERVAL_MS = 5000; // 定时 flush 间隔

// ========== 私有函数 ==========

function generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

function flushBuffer(): void {
    if (buffer.length === 0) return;

    const db = getDb();
    if (!db) {
        console.error('[Logger] DB not available, dropping logs:', buffer.length);
        buffer.length = 0;
        return;
    }

    const insert = db.prepare(`
        INSERT INTO logs (id, timestamp, level, category, module, trace_id, message, metadata)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const batch = buffer.splice(0, buffer.length);

    try {
        db.transaction(() => {
            for (const log of batch) {
                insert.run(
                    log.id,
                    log.timestamp,
                    log.level,
                    log.category,
                    log.module,
                    log.trace_id || null,
                    log.message,
                    log.metadata ? JSON.stringify(log.metadata) : null
                );
            }
        })();
    } catch (err) {
        console.error('[Logger] Failed to flush logs:', err);
        // 失败时把日志放回缓冲区（避免丢失）
        buffer.unshift(...batch);
        if (buffer.length > BUFFER_SIZE * 2) {
            // 缓冲区过大时丢弃旧日志
            buffer.splice(0, buffer.length - BUFFER_SIZE);
        }
    }
}

function scheduleFlush(): void {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
        flushTimer = null;
        flushBuffer();
    }, FLUSH_INTERVAL_MS);
}

function writeLog(
    level: LogLevel,
    category: LogCategory,
    module: string,
    message: string,
    metadata?: Record<string, any>,
    traceId?: string
): void {
    if (!isEnabled) return;

    const entry: LogEntry = {
        id: generateId(),
        timestamp: Date.now(),
        level,
        category,
        module,
        trace_id: traceId,
        message,
        metadata,
    };

    buffer.push(entry);

    // 立即 flush 错误日志
    if (level === 'error') {
        flushBuffer();
    }
    // 缓冲区满时 flush
    else if (buffer.length >= BUFFER_SIZE) {
        flushBuffer();
    }
    // 否则定时 flush
    else {
        scheduleFlush();
    }
}

// ========== 公共 API ==========

export const logger = {
    /**
     * 启用/禁用日志服务
     */
    setEnabled(enabled: boolean): void {
        isEnabled = enabled;
    },

    /**
     * 立即刷新缓冲区到数据库
     */
    flush(): void {
        flushBuffer();
    },

    // ===== 按分类的快捷方法 =====

    /** System 日志：系统级事件（启动/关闭/配置变更等） */
    system: {
        debug: (module: string, message: string, meta?: Record<string, any>, traceId?: string) =>
            writeLog('debug', 'system', module, message, meta, traceId),
        info: (module: string, message: string, meta?: Record<string, any>, traceId?: string) =>
            writeLog('info', 'system', module, message, meta, traceId),
        warn: (module: string, message: string, meta?: Record<string, any>, traceId?: string) =>
            writeLog('warn', 'system', module, message, meta, traceId),
        error: (module: string, message: string, meta?: Record<string, any>, traceId?: string) =>
            writeLog('error', 'system', module, message, meta, traceId),
    },

    /** SDK 日志：Claude SDK 调用（token 消耗、响应时间等） */
    sdk: {
        debug: (module: string, message: string, meta?: Record<string, any>, traceId?: string) =>
            writeLog('debug', 'sdk', module, message, meta, traceId),
        info: (module: string, message: string, meta?: Record<string, any>, traceId?: string) =>
            writeLog('info', 'sdk', module, message, meta, traceId),
        warn: (module: string, message: string, meta?: Record<string, any>, traceId?: string) =>
            writeLog('warn', 'sdk', module, message, meta, traceId),
        error: (module: string, message: string, meta?: Record<string, any>, traceId?: string) =>
            writeLog('error', 'sdk', module, message, meta, traceId),
    },

    /** Task 日志：定时任务执行 */
    task: {
        debug: (module: string, message: string, meta?: Record<string, any>, traceId?: string) =>
            writeLog('debug', 'task', module, message, meta, traceId),
        info: (module: string, message: string, meta?: Record<string, any>, traceId?: string) =>
            writeLog('info', 'task', module, message, meta, traceId),
        warn: (module: string, message: string, meta?: Record<string, any>, traceId?: string) =>
            writeLog('warn', 'task', module, message, meta, traceId),
        error: (module: string, message: string, meta?: Record<string, any>, traceId?: string) =>
            writeLog('error', 'task', module, message, meta, traceId),
    },

    /** Terminal 日志：终端会话 */
    terminal: {
        debug: (module: string, message: string, meta?: Record<string, any>, traceId?: string) =>
            writeLog('debug', 'terminal', module, message, meta, traceId),
        info: (module: string, message: string, meta?: Record<string, any>, traceId?: string) =>
            writeLog('info', 'terminal', module, message, meta, traceId),
        warn: (module: string, message: string, meta?: Record<string, any>, traceId?: string) =>
            writeLog('warn', 'terminal', module, message, meta, traceId),
        error: (module: string, message: string, meta?: Record<string, any>, traceId?: string) =>
            writeLog('error', 'terminal', module, message, meta, traceId),
    },
};

// ========== 日志查询 API ==========

export function queryLogs(query: LogQuery = {}): LogEntry[] {
    const db = getDb();
    if (!db) throw new Error('DB not available');

    const conditions: string[] = [];
    const params: any[] = [];

    if (query.category) {
        conditions.push('category = ?');
        params.push(query.category);
    }
    if (query.level) {
        conditions.push('level = ?');
        params.push(query.level);
    }
    if (query.module) {
        conditions.push('module = ?');
        params.push(query.module);
    }
    if (query.traceId) {
        conditions.push('trace_id = ?');
        params.push(query.traceId);
    }
    if (query.startTime) {
        conditions.push('timestamp >= ?');
        params.push(query.startTime);
    }
    if (query.endTime) {
        conditions.push('timestamp <= ?');
        params.push(query.endTime);
    }
    if (query.keyword) {
        conditions.push('message LIKE ?');
        params.push(`%${query.keyword}%`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = query.limit ?? 100;
    const offset = query.offset ?? 0;

    const rows = db.prepare(`
        SELECT * FROM logs
        ${whereClause}
        ORDER BY timestamp DESC
        LIMIT ? OFFSET ?
    `).all(...params, limit, offset) as any[];

    return rows.map(row => ({
        id: row.id,
        timestamp: row.timestamp,
        level: row.level as LogLevel,
        category: row.category as LogCategory,
        module: row.module,
        trace_id: row.trace_id,
        message: row.message,
        metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    }));
}

export function getLogStats(): {
    total: number;
    byCategory: Record<LogCategory, number>;
    byLevel: Record<LogLevel, number>;
} {
    const db = getDb();
    if (!db) throw new Error('DB not available');

    const total = db.prepare('SELECT COUNT(*) as count FROM logs').get() as { count: number };

    const byCategory = { system: 0, sdk: 0, task: 0, terminal: 0 };
    const byLevel = { debug: 0, info: 0, warn: 0, error: 0 };

    const catRows = db.prepare('SELECT category, COUNT(*) as count FROM logs GROUP BY category').all() as any[];
    for (const row of catRows) {
        if (row.category in byCategory) {
            byCategory[row.category as LogCategory] = row.count;
        }
    }

    const levelRows = db.prepare('SELECT level, COUNT(*) as count FROM logs GROUP BY level').all() as any[];
    for (const row of levelRows) {
        if (row.level in byLevel) {
            byLevel[row.level as LogLevel] = row.count;
        }
    }

    return {
        total: total.count,
        byCategory,
        byLevel,
    };
}

export function cleanupOldLogs(olderThanDays: number): number {
    const db = getDb();
    if (!db) throw new Error('DB not available');

    const cutoff = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
    const result = db.prepare('DELETE FROM logs WHERE timestamp < ?').run(cutoff);

    return result.changes;
}
