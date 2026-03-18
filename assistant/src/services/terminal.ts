/**
 * Terminal Service - PTY 会话管理
 *
 * 功能：
 * - 创建/关闭 PTY 会话
 * - 会话数量上限检查
 * - SIGTERM 优雅终止 + SIGKILL 强制终止
 * - WebSocket 与 PTY 双向数据透传
 * - 会话状态持久化到数据库
 */

import { execSync } from 'child_process';

// ========== 运行时架构兼容性校验 ==========
function checkPtyCompatibility() {
  try {
    require('node-pty');
  } catch (e: any) {
    if (e.message?.includes('wrong ELF') || e.message?.includes('mach-o') || e.message?.includes('architecture')) {
      console.warn('[pty] 架构不匹配，尝试自动重新编译…');
      console.warn('[pty] 错误信息:', e.message);
      try {
        execSync('npm rebuild node-pty', {
          stdio: 'inherit',
          cwd: process.cwd()
        });
        console.log('[pty] 重新编译成功，请重启服务');
      } catch (rebuildErr: any) {
        console.error('[pty] 自动编译失败:', rebuildErr.message);
        console.error('[pty] 请手动执行: npm rebuild node-pty');
      }
      process.exit(1);
    }
    throw e;
  }
}

checkPtyCompatibility();
// ========== 兼容性校验结束 ==========

import { spawn, IPty } from 'node-pty';
import { randomUUID } from 'crypto';
import { getDb } from '../db';
import { getConfig } from '../config';
import { mkdirSync, existsSync } from 'fs';

export interface TerminalSession {
    id: string;
    workspaceId: string;
    userId: string;
    pty: IPty;
    title: string;
    cwd: string;
    createdAt: number;
    lastActiveAt: number;
    closedAt?: number;
    connectedAt?: number;      // WS 连接时间
    disconnectedAt?: number;   // WS 断开时间
    outputBuffer: string[];    // 环形输出缓冲区，用于重连时回放
}

// 内存中的会话映射
const sessions = new Map<string, TerminalSession>();

// 关闭超时（SIGTERM 后等待时间，毫秒）
const KILL_TIMEOUT_MS = 5000;

// 终端 WS 断开超时清理时间（30 分钟）
const DISCONNECT_CLEANUP_MS = 30 * 60 * 1000;

// 输出缓冲区最大行数（约 50KB）
const OUTPUT_BUFFER_MAX_LINES = 500;

// 清理定时器
let cleanupInterval: NodeJS.Timeout | null = null;

/**
 * 自动探测系统默认 shell
 * 优先级：process.env.SHELL > dscl 查询 (macOS) > /bin/sh
 */
function getDefaultShell(): string {
    if (process.env.SHELL) {
        return process.env.SHELL;
    }

    // macOS: 使用 dscl 查询用户 shell
    try {
        const user = process.env.USER || process.env.USERNAME || '$(whoami)';
        const shell = execSync(`dscl . -read /Users/${user} UserShell 2>/dev/null | awk '{print $2}'`, {
            encoding: 'utf8',
            timeout: 1000,
        }).toString().trim();
        if (shell && shell.startsWith('/')) {
            return shell;
        }
    } catch {
        // dscl 失败，继续 fallback
    }

    return '/bin/sh';
}

/**
 * 获取当前活动会话数
 */
export function getActiveSessionCount(): number {
    return sessions.size;
}

/**
 * 创建新的 PTY 会话
 */
export function createTerminal(
    workspaceId: string,
    userId: string,
    cwd?: string,
    title?: string
): TerminalSession {
    const config = getConfig();

    // 检查会话上限
    if (sessions.size >= config.terminal.max_sessions) {
        throw new Error(`Maximum terminal sessions (${config.terminal.max_sessions}) reached. Please close some sessions.`);
    }

    const db = getDb();

    // 获取工作区 root_path 作为默认 cwd
    const workspace = db.prepare('SELECT root_path FROM workspaces WHERE id = ?').get(workspaceId) as { root_path: string } | undefined;
    let actualCwd = cwd;

    // 如果用户未提供 cwd，使用工作区 root_path，并自动创建（防止 posix_spawnp 因路径不存在而失败）
    if (!actualCwd) {
        actualCwd = workspace?.root_path || process.cwd();
        if (!existsSync(actualCwd)) {
            try {
                mkdirSync(actualCwd, { recursive: true });
                console.log(`[Terminal] Created missing cwd: ${actualCwd}`);
            } catch (err) {
                console.warn(`[Terminal] Failed to create cwd ${actualCwd}, falling back to process.cwd()`);
                actualCwd = process.cwd();
            }
        }
    }

    // 生成会话 ID
    const sessionId = randomUUID();
    const now = Date.now();

    // 创建 PTY 进程（优先使用配置的 shell，否则自动探测）
    const shell = config.terminal.shell || getDefaultShell();
    const env = process.env as { [key: string]: string };

    // 诊断日志：spawn 参数
    console.log('[pty spawn args]', JSON.stringify({
        shell,
        cwd: actualCwd,
        envPATH: env?.PATH,
        shellExists: existsSync(shell),
        cwdExists: existsSync(actualCwd)
    }));

    const pty = spawn(shell, [], {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        cwd: actualCwd,
        env,
    });

    // 创建会话对象
    const session: TerminalSession = {
        id: sessionId,
        workspaceId,
        userId,
        pty,
        title: title || `Terminal ${sessions.size + 1}`,
        cwd: actualCwd,
        createdAt: now,
        lastActiveAt: now,
        connectedAt: now,  // 创建时即视为已连接
        outputBuffer: [],  // 初始化输出缓冲区
    };

    // 保存到内存
    sessions.set(sessionId, session);

    // 写入数据库（disconnected_at 为 NULL 表示连接中）
    db.prepare(
        `INSERT INTO terminal_sessions (id, workspace_id, user_id, title, pid, cwd, created_at, last_active_at, disconnected_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(sessionId, workspaceId, userId, session.title, pty.pid, actualCwd, now, now, null);

    // 监听 PTY 退出，清理资源
    pty.onExit(({ exitCode, signal }) => {
        console.log(`[Terminal] Session ${sessionId} exited with code ${exitCode}, signal ${signal}`);
        cleanupTerminal(sessionId, exitCode);
    });

    console.log(`[Terminal] Created session ${sessionId} (PID: ${pty.pid}) in ${actualCwd}`);
    return session;
}

/**
 * 关闭 PTY 会话（优雅终止）
 */
export async function closeTerminal(sessionId: string, force = false): Promise<void> {
    const session = sessions.get(sessionId);
    if (!session) {
        throw new Error(`Terminal session ${sessionId} not found`);
    }

    const pty = session.pty;

    if (force) {
        // 强制终止
        console.log(`[Terminal] Force killing session ${sessionId} (PID: ${pty.pid})`);
        pty.kill('SIGKILL');
    } else {
        // 优雅终止：先发送 SIGTERM
        console.log(`[Terminal] Gracefully closing session ${sessionId} (PID: ${pty.pid})`);
        pty.kill('SIGTERM');

        // 设置超时，超时后强制终止
        setTimeout(() => {
            try {
                // 检查进程是否还在运行
                process.kill(pty.pid, 0); // 发送信号 0 检查进程是否存在
                console.log(`[Terminal] Session ${sessionId} did not exit gracefully, forcing kill`);
                pty.kill('SIGKILL');
            } catch {
                // 进程已退出，无需处理
            }
        }, KILL_TIMEOUT_MS);
    }
}

/**
 * 清理终端会话资源
 */
function cleanupTerminal(sessionId: string, exitCode?: number): void {
    const session = sessions.get(sessionId);
    if (!session) return;

    // 从内存中移除
    sessions.delete(sessionId);

    // 更新数据库
    const db = getDb();
    const now = Date.now();
    db.prepare(
        'UPDATE terminal_sessions SET closed_at = ? WHERE id = ?'
    ).run(now, sessionId);

    console.log(`[Terminal] Cleaned up session ${sessionId}, exitCode: ${exitCode}`);
}

/**
 * 获取会话信息
 */
export function getTerminal(sessionId: string): TerminalSession | undefined {
    return sessions.get(sessionId);
}

/**
 * 列出用户的活跃终端会话
 */
export function listTerminals(workspaceId?: string, userId?: string): Array<{
    id: string;
    workspaceId: string;
    userId: string;
    title: string;
    cwd: string;
    pid: number;
    createdAt: number;
    lastActiveAt: number;
}> {
    const result: Array<{
        id: string;
        workspaceId: string;
        userId: string;
        title: string;
        cwd: string;
        pid: number;
        createdAt: number;
        lastActiveAt: number;
    }> = [];

    for (const [id, session] of sessions) {
        if (workspaceId && session.workspaceId !== workspaceId) continue;
        if (userId && session.userId !== userId) continue;

        result.push({
            id,
            workspaceId: session.workspaceId,
            userId: session.userId,
            title: session.title,
            cwd: session.cwd,
            pid: session.pty.pid,
            createdAt: session.createdAt,
            lastActiveAt: session.lastActiveAt,
        });
    }

    return result;
}

/**
 * 更新会话最后活跃时间
 */
export function touchTerminal(sessionId: string): void {
    const session = sessions.get(sessionId);
    if (!session) return;

    const now = Date.now();
    session.lastActiveAt = now;

    // 异步更新数据库（不阻塞）
    try {
        const db = getDb();
        db.prepare('UPDATE terminal_sessions SET last_active_at = ? WHERE id = ?').run(now, sessionId);
    } catch (err) {
        console.error(`[Terminal] Failed to update last_active_at for ${sessionId}:`, err);
    }
}

/**
 * 调整终端大小
 */
export function resizeTerminal(sessionId: string, cols: number, rows: number): void {
    const session = sessions.get(sessionId);
    if (!session) {
        throw new Error(`Terminal session ${sessionId} not found`);
    }

    session.pty.resize(cols, rows);
    console.log(`[Terminal] Resized session ${sessionId} to ${cols}x${rows}`);
}

/**
 * 向终端写入数据
 */
export function writeToTerminal(sessionId: string, data: string): void {
    const session = sessions.get(sessionId);
    if (!session) {
        throw new Error(`Terminal session ${sessionId} not found`);
    }

    session.pty.write(data);
    touchTerminal(sessionId);
}

/**
 * 从终端读取数据（通过回调），同时写入缓冲区用于回放
 */
export function onTerminalData(sessionId: string, callback: (data: string) => void): () => void {
    const session = sessions.get(sessionId);
    if (!session) {
        throw new Error(`Terminal session ${sessionId} not found`);
    }

    const disposable = session.pty.onData((data) => {
        // 更新最后活跃时间
        touchTerminal(sessionId);
        // 写入缓冲区用于重连回放
        appendToOutputBuffer(session, data);
        // 回调给 WebSocket
        callback(data);
    });

    // 返回取消订阅函数
    return () => {
        disposable.dispose();
    };
}

/**
 * 追加数据到输出缓冲区（环形缓冲区，超出上限时丢弃旧数据）
 */
function appendToOutputBuffer(session: TerminalSession, data: string): void {
    session.outputBuffer.push(data);
    // 超出上限时从头部丢弃
    if (session.outputBuffer.length > OUTPUT_BUFFER_MAX_LINES) {
        session.outputBuffer.shift();
    }
}

/**
 * 获取终端输出缓冲区内容（用于重连时回放）
 */
export function getTerminalOutputBuffer(sessionId: string): string {
    const session = sessions.get(sessionId);
    if (!session) {
        throw new Error(`Terminal session ${sessionId} not found`);
    }
    return session.outputBuffer.join('');
}

/**
 * 服务关闭时清理所有终端
 */
export function shutdownAllTerminals(): void {
    console.log(`[Terminal] Shutting down all ${sessions.size} sessions...`);

    for (const [sessionId, session] of sessions) {
        try {
            session.pty.kill('SIGTERM');
        } catch (err) {
            console.error(`[Terminal] Error killing session ${sessionId}:`, err);
        }
    }

    sessions.clear();
}

/**
 * 仅用于测试：清理所有会话（不发送信号）
 */
export function _clearAllSessionsForTesting(): void {
    sessions.clear();
}

/**
 * 标记终端为已连接（WebSocket 连接时调用）
 */
export function markTerminalConnected(sessionId: string): void {
    const session = sessions.get(sessionId);
    if (!session) return;

    const now = Date.now();
    session.connectedAt = now;
    session.disconnectedAt = undefined;

    // 更新数据库
    try {
        const db = getDb();
        db.prepare('UPDATE terminal_sessions SET disconnected_at = NULL WHERE id = ?').run(sessionId);
        console.log(`[Terminal] Session ${sessionId} marked as connected`);
    } catch (err) {
        console.error(`[Terminal] Failed to mark connected for ${sessionId}:`, err);
    }
}

/**
 * 标记终端为已断开（WebSocket 断开时调用，不销毁 PTY）
 */
export function markTerminalDisconnected(sessionId: string): void {
    const session = sessions.get(sessionId);
    if (!session) return;

    const now = Date.now();
    session.disconnectedAt = now;

    // 更新数据库
    try {
        const db = getDb();
        db.prepare('UPDATE terminal_sessions SET disconnected_at = ? WHERE id = ?').run(now, sessionId);
        console.log(`[Terminal] Session ${sessionId} marked as disconnected (PTY preserved)`);
    } catch (err) {
        console.error(`[Terminal] Failed to mark disconnected for ${sessionId}:`, err);
    }
}

/**
 * 清理断开超过 30 分钟未重连的终端
 */
export function cleanupStaleTerminals(): void {
    const now = Date.now();
    let cleaned = 0;

    for (const [sessionId, session] of sessions) {
        // 跳过已连接的终端
        if (!session.disconnectedAt) continue;

        // 检查是否超过 30 分钟
        const disconnectedDuration = now - session.disconnectedAt;
        if (disconnectedDuration > DISCONNECT_CLEANUP_MS) {
            console.log(`[Terminal] Cleaning up stale session ${sessionId} (disconnected for ${Math.round(disconnectedDuration / 60000)} minutes)`);
            try {
                closeTerminal(sessionId, true); // 强制关闭
                cleaned++;
            } catch (err) {
                console.error(`[Terminal] Failed to cleanup stale session ${sessionId}:`, err);
            }
        }
    }

    if (cleaned > 0) {
        console.log(`[Terminal] Cleaned up ${cleaned} stale terminal(s)`);
    }
}

/**
 * 启动超时清理定时器
 */
export function startStaleTerminalCleanup(): void {
    if (cleanupInterval) return; // 已启动

    console.log('[Terminal] Starting stale terminal cleanup timer (30min threshold)');
    cleanupInterval = setInterval(cleanupStaleTerminals, 60 * 1000); // 每分钟检查一次
}

/**
 * 停止超时清理定时器
 */
export function stopStaleTerminalCleanup(): void {
    if (cleanupInterval) {
        clearInterval(cleanupInterval);
        cleanupInterval = null;
        console.log('[Terminal] Stopped stale terminal cleanup timer');
    }
}

/**
 * 列出终端会话（包含连接状态）
 */
export function listTerminalsWithStatus(workspaceId?: string, userId?: string): Array<{
    id: string;
    workspaceId: string;
    userId: string;
    title: string;
    cwd: string;
    pid: number;
    createdAt: number;
    lastActiveAt: number;
    connected: boolean;
    disconnectedAt?: number;
}> {
    const result: Array<{
        id: string;
        workspaceId: string;
        userId: string;
        title: string;
        cwd: string;
        pid: number;
        createdAt: number;
        lastActiveAt: number;
        connected: boolean;
        disconnectedAt?: number;
    }> = [];

    for (const [id, session] of sessions) {
        if (workspaceId && session.workspaceId !== workspaceId) continue;
        if (userId && session.userId !== userId) continue;

        result.push({
            id,
            workspaceId: session.workspaceId,
            userId: session.userId,
            title: session.title,
            cwd: session.cwd,
            pid: session.pty.pid,
            createdAt: session.createdAt,
            lastActiveAt: session.lastActiveAt,
            connected: !session.disconnectedAt,
            disconnectedAt: session.disconnectedAt,
        });
    }

    return result;
}

/**
 * 获取终端状态统计
 */
export function getTerminalStatus(): {
    total: number;
    connected: number;
    disconnected: number;
} {
    let connected = 0;
    let disconnected = 0;

    for (const session of sessions.values()) {
        if (session.disconnectedAt) {
            disconnected++;
        } else {
            connected++;
        }
    }

    return {
        total: sessions.size,
        connected,
        disconnected,
    };
}
