/**
 * Tool Registry - 统一类型定义
 *
 * 所有工具必须遵循的接口规范
 */

import Anthropic from '@anthropic-ai/sdk';

/**
 * 统一工具返回格式
 */
export interface ToolResult<T = any> {
    /** 是否成功执行 */
    success: boolean;
    /** 成功时的返回数据 */
    data?: T;
    /** 失败时的错误信息 */
    error?: string;
    /** 内容是否被截断（如输出过长） */
    truncated?: boolean;
    /** 执行耗时（毫秒） */
    elapsed_ms?: number;
    /** 是否需要人工确认 */
    requiresConfirmation?: boolean;
    /** 确认请求ID（用于后续确认/取消） */
    confirmationId?: string;
    /** 确认请求的标题 */
    confirmationTitle?: string;
    /** 确认请求的描述 */
    confirmationDescription?: string;
    /** 风险等级 */
    riskLevel?: 'high' | 'medium' | 'low';
}

/**
 * 工具执行上下文
 */
export interface ToolContext {
    /** 工作区 ID */
    workspaceId: string;
    /** 会话 ID（可选） */
    sessionId?: string;
    /** 用户 ID（可选） */
    userId?: string;
    /** 工具调用 ID（用于关联前端工具块） */
    toolUseId?: string;
    /** 工作区根目录（由 Registry 统一注入） */
    cwd?: string;
}

/**
 * 工具执行函数类型
 */
export type ToolExecutor = (input: any, context: ToolContext) => Promise<ToolResult> | ToolResult;

/**
 * 工具定义（符合 Anthropic SDK 格式）
 */
export interface ToolDefinition {
    name: string;
    description: string;
    input_schema: {
        type: 'object';
        properties: Record<string, any>;
        required?: string[];
    };
}

/**
 * 注册的工具项
 */
export interface RegisteredTool {
    /** 工具定义（用于 SDK） */
    definition: ToolDefinition;
    /** 工具执行函数 */
    executor: ToolExecutor;
    /** 超时时间（毫秒），默认 30000 */
    timeoutMs?: number;
    /** 是否需要人工确认（危险操作） */
    requiresConfirmation?: boolean;
    /** 风险等级：low | medium | high */
    riskLevel?: 'low' | 'medium' | 'high';
}

/**
 * 工具注册表
 */
export type ToolRegistryMap = Map<string, RegisteredTool>;
