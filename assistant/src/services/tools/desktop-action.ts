/**
 * desktop_action 工具（占位符）
 * 桌面 GUI 自动化（nut.js/pyautogui）尚未启用
 */

import type { ToolDefinition, ToolContext, ToolResult } from './types';

export const desktopActionToolDefinition: ToolDefinition = {
    name: 'desktop_action',
    description: `桌面 GUI 自动化工具（当前未启用）。
可执行：鼠标点击/移动、键盘输入、截图、窗口操作等。
适用场景：操作不提供 API 的桌面应用（微信桌面版、各类客户端）。
启用方式：在 config.yaml 中设置 tools.desktop_action.enabled=true 并安装 nut.js。`,
    input_schema: {
        type: 'object',
        properties: {
            action: { type: 'string', description: '操作类型（click/type/screenshot/focus_window）' },
            target: { type: 'string', description: '目标（坐标、窗口标题或图像模板）' },
            value: { type: 'string', description: '输入的文字（type 操作时）' },
        },
        required: ['action'],
    },
};

export async function executeDesktopAction(
    _input: any,
    _context: ToolContext
): Promise<ToolResult> {
    return {
        success: false,
        error: '桌面 GUI 自动化尚未启用。如需启用，请在 config.yaml 中设置 tools.desktop_action.enabled=true 并安装 nut.js（npm install @nut-tree/nut-js）。',
    };
}

export const desktopActionTool = {
    definition: desktopActionToolDefinition,
    executor: executeDesktopAction,
    timeoutMs: 30000,
    riskLevel: 'high' as const,
    requiresConfirmation: false,
};
