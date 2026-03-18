/**
 * Tool Registry - 统一工具注册与分发
 *
 * 职责：
 * 1. 工具注册与发现
 * 2. 统一执行入口
 * 3. 超时控制
 * 4. 错误处理
 * 5. 执行耗时统计
 * 6. 危险操作确认流程
 */

import type { ToolDefinition, ToolExecutor, ToolContext, ToolResult, RegisteredTool } from './types';
import { createPendingConfirmation, confirmExecution, getPendingConfirmation } from './confirmation-state';
import { getWorkspaceRootPath } from '../workspace-config';

// 全局注册表
const registry = new Map<string, RegisteredTool>();

// 默认超时
const DEFAULT_TIMEOUT_MS = 30000;

/**
 * 注册工具
 */
export function registerTool(tool: RegisteredTool): void {
    const { name } = tool.definition;

    if (registry.has(name)) {
        console.warn(`[ToolRegistry] Tool "${name}" is already registered, overwriting`);
    }

    registry.set(name, tool);
    console.log(`[ToolRegistry] Registered tool: ${name} (risk: ${tool.riskLevel || 'low'})`);
}

/**
 * 批量注册工具
 */
export function registerTools(tools: RegisteredTool[]): void {
    for (const tool of tools) {
        registerTool(tool);
    }
}

/**
 * 获取工具定义列表（用于 SDK）
 */
export function getToolDefinitions(): ToolDefinition[] {
    return Array.from(registry.values()).map(t => t.definition);
}

/**
 * 获取所有注册的工具名称
 */
export function getRegisteredToolNames(): string[] {
    return Array.from(registry.keys());
}

/**
 * 检查工具是否已注册
 */
export function hasTool(name: string): boolean {
    return registry.has(name);
}

/**
 * 获取工具信息
 */
export function getToolInfo(name: string): RegisteredTool | undefined {
    return registry.get(name);
}

/**
 * 带超时的 Promise 包装
 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, toolName: string): Promise<T> {
    return Promise.race([
        promise,
        new Promise<T>((_, reject) => {
            setTimeout(() => {
                reject(new Error(`Tool "${toolName}" execution timeout after ${timeoutMs}ms`));
            }, timeoutMs);
        }),
    ]);
}

/**
 * 执行工具
 *
 * 统一入口，处理：
 * - 工具查找
 * - 危险操作确认
 * - 超时控制
 * - 错误处理
 * - 耗时统计
 * - 统一返回格式
 */
export async function executeTool(
    name: string,
    input: any,
    context: ToolContext
): Promise<ToolResult> {
    // 统一注入 cwd
    if (!context.cwd && context.workspaceId) {
        context = { ...context, cwd: getWorkspaceRootPath(context.workspaceId) };
    }

    const tool = registry.get(name);

    if (!tool) {
        return {
            success: false,
            error: `Unknown tool: ${name}`,
            elapsed_ms: 0,
        };
    }

    const startTime = Date.now();
    const timeoutMs = tool.timeoutMs || DEFAULT_TIMEOUT_MS;

    try {
        // 执行工具
        const resultOrPromise = tool.executor(input, context);
        const result = await withTimeout(Promise.resolve(resultOrPromise), timeoutMs, name);

        // 如果工具返回需要确认，创建待确认状态
        if (result && typeof result === 'object' && result.requiresConfirmation) {
            const confirmationId = result.confirmationId || `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;

            // 创建待确认 Promise，等待用户确认
            const pendingPromise = createPendingConfirmation(
                name,
                context.toolUseId || `${name}-${Date.now()}`,
                input,
                context,
                confirmationId,
                result.confirmationTitle || '操作确认',
                result.confirmationDescription || result.error || '需要确认此操作',
                result.riskLevel || tool.riskLevel || 'medium'
            );

            // 返回确认请求结果（包含 confirmationId）
            return {
                success: false,
                error: result.error || '操作需要确认',
                requiresConfirmation: true,
                confirmationId,
                confirmationTitle: result.confirmationTitle || '操作确认',
                confirmationDescription: result.confirmationDescription || result.error || '需要确认此操作',
                riskLevel: result.riskLevel || tool.riskLevel || 'medium',
                elapsed_ms: Date.now() - startTime,
            };
        }

        // 确保返回格式统一
        if (result && typeof result === 'object' && 'success' in result) {
            // 已经是 ToolResult 格式
            return {
                ...result,
                elapsed_ms: result.elapsed_ms ?? Date.now() - startTime,
            };
        }

        // 旧格式兼容：直接返回的数据包装为 success
        return {
            success: true,
            data: result,
            elapsed_ms: Date.now() - startTime,
        };
    } catch (err: any) {
        const elapsed = Date.now() - startTime;

        console.error(`[ToolRegistry] Tool "${name}" execution error:`, err);

        return {
            success: false,
            error: err.message || `Tool "${name}" execution failed`,
            elapsed_ms: elapsed,
        };
    }
}

/**
 * 确认并继续执行工具
 *
 * @param confirmationId 确认ID
 * @returns 执行结果
 */
export async function executeConfirmedTool(confirmationId: string): Promise<ToolResult> {
    const pending = getPendingConfirmation(confirmationId);

    if (!pending) {
        return {
            success: false,
            error: '确认请求不存在或已过期',
            elapsed_ms: 0,
        };
    }

    // 标记为已确认
    confirmExecution(confirmationId);

    const { toolName, input, context } = pending;
    const tool = registry.get(toolName);

    if (!tool) {
        pending.resolve({
            success: false,
            error: `Tool ${toolName} not found`,
            elapsed_ms: 0,
        });
        return {
            success: false,
            error: `Tool ${toolName} not found`,
            elapsed_ms: 0,
        };
    }

    const startTime = Date.now();
    const timeoutMs = tool.timeoutMs || DEFAULT_TIMEOUT_MS;

    try {
        // 对于 bash 工具，直接重新执行
        // 对于 file_delete/file_move，需要调用确认后的执行函数
        let result: ToolResult;

        if (toolName === 'file_delete' || toolName === 'file_move') {
            // 动态导入 file.ts 中的确认执行函数
            const { executeConfirmedDelete, executeConfirmedMove } = await import('./file');
            if (toolName === 'file_delete') {
                result = executeConfirmedDelete(input, context);
            } else {
                result = executeConfirmedMove(input, context);
            }
        } else {
            // 其他工具直接执行
            const resultOrPromise = tool.executor(input, context);
            result = await withTimeout(Promise.resolve(resultOrPromise), timeoutMs, toolName);
        }

        // 确保返回格式统一
        const finalResult: ToolResult = result && typeof result === 'object' && 'success' in result
            ? { ...result, elapsed_ms: result.elapsed_ms ?? Date.now() - startTime }
            : { success: true, data: result, elapsed_ms: Date.now() - startTime };

        // 解析待确认的 Promise
        pending.resolve(finalResult);

        return finalResult;
    } catch (err: any) {
        const elapsed = Date.now() - startTime;
        const errorResult: ToolResult = {
            success: false,
            error: err.message || `Tool "${toolName}" execution failed`,
            elapsed_ms: elapsed,
        };

        pending.resolve(errorResult);
        return errorResult;
    }
}

/**
 * 清除所有注册的工具（主要用于测试）
 */
export function clearRegistry(): void {
    registry.clear();
}

/**
 * 获取注册表状态（用于调试）
 */
export function getRegistryStatus(): { name: string; riskLevel: string; timeoutMs: number }[] {
    return Array.from(registry.entries()).map(([name, tool]) => ({
        name,
        riskLevel: tool.riskLevel || 'low',
        timeoutMs: tool.timeoutMs || DEFAULT_TIMEOUT_MS,
    }));
}
