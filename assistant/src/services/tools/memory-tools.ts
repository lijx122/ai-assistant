/**
 * Memory Tools - 记忆读取工具
 *
 * AI 按需调用：
 * - read_workspace_memory: 读取工作区项目记忆
 * - read_impression:             读取用户偏好印象
 */

import { getWorkspaceMemory, getImpressions } from '../post-session';
import type { ToolDefinition, ToolExecutor, ToolContext, ToolResult, RegisteredTool } from './types';
import { getConfig } from '../../config';

/**
 * 工具定义
 */
export const readWorkspaceMemoryDefinition: ToolDefinition = {
    name: 'read_workspace_memory',
    description: `读取当前工作区的项目记忆。
只在用户明确询问项目相关内容时调用，例如：
"这个项目是做什么的"、"我们用的什么技术栈"、"之前的架构决策是什么"。
不要在普通技术问题或闲聊中调用。`,
    input_schema: {
        type: 'object',
        properties: {},
        required: [],
    },
};

export const readImpressionDefinition: ToolDefinition = {
    name: 'read_impression',
    description: `读取用户偏好信息。
只在需要个性化回复时调用，例如：
"你还记得我叫什么"、"我的编程习惯是什么"。
不要在普通技术问题中调用。`,
    input_schema: {
        type: 'object',
        properties: {},
        required: [],
    },
};

/**
 * 执行 read_workspace_memory
 */
export const executeReadWorkspaceMemory: ToolExecutor = async (
    _input: {},
    context: ToolContext
): Promise<ToolResult> => {
    try {
        const config = getConfig();

        // 检查功能是否启用
        if (!config.memory.workspace.enabled) {
            return {
                success: true,
                data: { content: '该功能已关闭' }
            };
        }

        const memory = getWorkspaceMemory(context.workspaceId);
        console.log(`[MemoryTool] read_workspace_memory for ${context.workspaceId}: ${memory ? 'found' : 'empty'}`);

        return {
            success: true,
            data: { content: memory || '暂无工作区记忆' }
        };
    } catch (err: any) {
        console.error('[MemoryTool] read_workspace_memory failed:', err.message);
        return {
            success: false,
            error: `读取失败: ${err.message}`
        };
    }
};

/**
 * 执行 read_impression
 */
export const executeReadImpression: ToolExecutor = async (
    _input: {},
    context: ToolContext
): Promise<ToolResult> => {
    try {
        const config = getConfig();

        // 检查功能是否启用
        if (!config.memory.impression.enabled) {
            return {
                success: true,
                data: { content: '该功能已关闭' }
            };
        }

        const impression = getImpressions(context.workspaceId);
        console.log(`[MemoryTool] read_impression for ${context.workspaceId}: ${impression ? 'found' : 'empty'}`);

        return {
            success: true,
            data: { content: impression || '暂无用户偏好记录' }
        };
    } catch (err: any) {
        console.error('[MemoryTool] read_impression failed:', err.message);
        return {
            success: false,
            error: `读取失败: ${err.message}`
        };
    }
};

/**
 * 工具注册项
 */
export const readWorkspaceMemoryTool: RegisteredTool = {
    definition: readWorkspaceMemoryDefinition,
    executor: executeReadWorkspaceMemory,
    riskLevel: 'low',
    timeoutMs: 5000
};

export const readImpressionTool: RegisteredTool = {
    definition: readImpressionDefinition,
    executor: executeReadImpression,
    riskLevel: 'low',
    timeoutMs: 5000
};
