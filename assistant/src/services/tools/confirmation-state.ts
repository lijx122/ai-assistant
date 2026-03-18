/**
 * 确认状态管理模块
 *
 * 管理需要人工确认的工具调用
 */

import type { ToolContext, ToolResult } from './types';

/**
 * 待确认的工具调用
 */
export interface PendingConfirmation {
    /** 确认ID */
    confirmationId: string;
    /** 工具调用 ID（关联前端工具块） */
    toolUseId: string;
    /** 工具名称 */
    toolName: string;
    /** 工具输入参数 */
    input: any;
    /** 执行上下文 */
    context: ToolContext;
    /** 创建时间戳 */
    createdAt: number;
    /** 超时时间（毫秒） */
    timeoutMs: number;
    /** 确认标题 */
    title: string;
    /** 确认描述 */
    description: string;
    /** 风险等级 */
    riskLevel: 'high' | 'medium' | 'low';
    /** 确认/取消的回调 */
    resolve: (result: ToolResult) => void;
}

// 待确认调用存储
const pendingConfirmations = new Map<string, PendingConfirmation>();

// 默认超时时间：5分钟
const DEFAULT_CONFIRMATION_TIMEOUT_MS = 300000;

// 清理定时器
let cleanupTimer: NodeJS.Timeout | null = null;

/**
 * 创建待确认记录
 */
export function createPendingConfirmation(
    toolName: string,
    toolUseId: string,
    input: any,
    context: ToolContext,
    confirmationId: string,
    title: string,
    description: string,
    riskLevel: 'high' | 'medium' | 'low' = 'medium',
    timeoutMs: number = DEFAULT_CONFIRMATION_TIMEOUT_MS
): Promise<ToolResult> {
    return new Promise((resolve) => {
        const pending: PendingConfirmation = {
            confirmationId,
            toolUseId,
            toolName,
            input,
            context,
            createdAt: Date.now(),
            timeoutMs,
            title,
            description,
            riskLevel,
            resolve,
        };

        pendingConfirmations.set(confirmationId, pending);

        // 启动超时处理
        setTimeout(() => {
            if (pendingConfirmations.has(confirmationId)) {
                pendingConfirmations.delete(confirmationId);
                resolve({
                    success: false,
                    error: '确认请求已超时',
                    elapsed_ms: timeoutMs,
                });
            }
        }, timeoutMs);

        console.log(`[ConfirmationState] Created pending confirmation: ${confirmationId} for tool ${toolName}`);
    });
}

/**
 * 获取待确认记录
 */
export function getPendingConfirmation(confirmationId: string): PendingConfirmation | undefined {
    return pendingConfirmations.get(confirmationId);
}

/**
 * 确认执行
 */
export function confirmExecution(confirmationId: string): boolean {
    const pending = pendingConfirmations.get(confirmationId);
    if (!pending) {
        return false;
    }

    pendingConfirmations.delete(confirmationId);
    return true;
}

/**
 * 取消执行
 */
export function cancelExecution(confirmationId: string): boolean {
    const pending = pendingConfirmations.get(confirmationId);
    if (!pending) {
        return false;
    }

    pendingConfirmations.delete(confirmationId);
    pending.resolve({
        success: false,
        error: '用户已取消',
        elapsed_ms: 0,
    });

    console.log(`[ConfirmationState] Cancelled: ${confirmationId}`);
    return true;
}

/**
 * 获取所有待确认记录
 */
export function getAllPendingConfirmations(): PendingConfirmation[] {
    return Array.from(pendingConfirmations.values());
}

/**
 * 获取指定会话的待确认记录
 */
export function getSessionPendingConfirmations(sessionId: string): PendingConfirmation[] {
    return getAllPendingConfirmations().filter(p => p.context.sessionId === sessionId);
}

/**
 * 清理过期的待确认记录
 */
export function cleanupExpiredConfirmations(): void {
    const now = Date.now();
    let cleaned = 0;

    for (const [id, pending] of pendingConfirmations) {
        if (now - pending.createdAt > pending.timeoutMs) {
            pendingConfirmations.delete(id);
            pending.resolve({
                success: false,
                error: '确认请求已超时',
                elapsed_ms: pending.timeoutMs,
            });
            cleaned++;
        }
    }

    if (cleaned > 0) {
        console.log(`[ConfirmationState] Cleaned up ${cleaned} expired confirmations`);
    }
}

/**
 * 启动定期清理
 */
export function startCleanup(intervalMs: number = 60000): void {
    if (cleanupTimer) {
        clearInterval(cleanupTimer);
    }
    cleanupTimer = setInterval(cleanupExpiredConfirmations, intervalMs);
}

/**
 * 停止定期清理
 */
export function stopCleanup(): void {
    if (cleanupTimer) {
        clearInterval(cleanupTimer);
        cleanupTimer = null;
    }
}

/**
 * 获取待确认记录的统计信息
 */
export function getConfirmationStats(): {
    total: number;
    highRisk: number;
    mediumRisk: number;
    lowRisk: number;
} {
    const all = getAllPendingConfirmations();
    return {
        total: all.length,
        highRisk: all.filter(p => p.riskLevel === 'high').length,
        mediumRisk: all.filter(p => p.riskLevel === 'medium').length,
        lowRisk: all.filter(p => p.riskLevel === 'low').length,
    };
}
