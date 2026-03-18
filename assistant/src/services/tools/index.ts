/**
 * Tools Index - 统一导出所有工具
 *
 * 使用方式：
 * ```ts
 * import { registerAllTools, executeTool, getToolDefinitions } from './tools';
 *
 * // 注册所有工具
 * registerAllTools();
 *
 * // 获取工具定义（用于 SDK）
 * const definitions = getToolDefinitions();
 *
 * // 执行工具
 * const result = await executeTool('bash', { command: 'ls' }, { workspaceId: 'xxx' });
 * ```
 */

// 类型导出
export type {
    ToolDefinition,
    ToolExecutor,
    ToolContext,
    ToolResult,
    RegisteredTool,
} from './types';

// Registry 导出
export {
    registerTool,
    registerTools,
    getToolDefinitions,
    getRegisteredToolNames,
    hasTool,
    getToolInfo,
    executeTool,
    executeConfirmedTool,
    clearRegistry,
    getRegistryStatus,
} from './registry';

// 确认状态管理导出
export {
    createPendingConfirmation,
    getPendingConfirmation,
    confirmExecution,
    cancelExecution,
    getAllPendingConfirmations,
    getSessionPendingConfirmations,
    cleanupExpiredConfirmations,
    startCleanup,
    stopCleanup,
    getConfirmationStats,
    type PendingConfirmation,
} from './confirmation-state';

// 工具导出
export { bashTool, bashToolDefinition, executeBash } from './bash';
export { readFileTool, writeFileTool, deleteFileTool, moveFileTool, readFileToolDefinition, writeFileToolDefinition, deleteFileToolDefinition, moveFileToolDefinition, executeConfirmedDelete, executeConfirmedMove } from './file';
export { todoReadTool, todoWriteTool, todoReadToolDefinition, todoWriteToolDefinition } from './todo';
export { readSkillTool, readSkillToolDefinition } from './skill';
export { createTaskTool, createTaskToolDefinition, executeCreateTask } from './task';
export { recallTool, recallToolDefinition, executeRecall } from './recall';
export { claudeCodeTool, claudeCodeToolDefinition, executeClaudeCode } from './claude-code';
export { readWorkspaceMemoryTool, readImpressionTool, readWorkspaceMemoryDefinition, readImpressionDefinition } from './memory-tools';
export { noteWriteTool, noteReadTool, noteSearchTool, noteWriteToolDefinition, noteReadToolDefinition, noteSearchToolDefinition } from './note';

import { registerTools } from './registry';
import { bashTool } from './bash';
import { readFileTool, writeFileTool, deleteFileTool, moveFileTool } from './file';
import { todoReadTool, todoWriteTool } from './todo';
import { readSkillTool } from './skill';
import { createTaskTool } from './task';
import { recallTool } from './recall';
import { claudeCodeTool } from './claude-code';
import { readWorkspaceMemoryTool, readImpressionTool } from './memory-tools';
import { webSearchTool } from './web-search';
import { webFetchTool } from './web-fetch';
import { noteWriteTool, noteReadTool, noteSearchTool } from './note';

/**
 * 注册所有标准工具
 */
export function registerAllTools(): void {
    registerTools([
        bashTool,
        readFileTool,
        writeFileTool,
        deleteFileTool,
        moveFileTool,
        todoReadTool,
        todoWriteTool,
        readSkillTool,
        createTaskTool,
        recallTool,
        claudeCodeTool,
        readWorkspaceMemoryTool,
        readImpressionTool,
        webSearchTool,
        webFetchTool,
        noteWriteTool,
        noteReadTool,
        noteSearchTool,
    ]);
    console.log('[Tools] All standard tools registered');
}
