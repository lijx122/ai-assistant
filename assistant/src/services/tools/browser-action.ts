/**
 * browser_action 工具（占位符）
 * 浏览器自动化（Playwright）尚未启用，返回友好提示
 */

import type { ToolDefinition, ToolContext, ToolResult } from './types';

export const browserActionToolDefinition: ToolDefinition = {
    name: 'browser_action',
    description: `浏览器自动化工具（当前未启用）。
可执行：打开网页、点击元素、填写表单、抓取 DOM 内容、截图等。
当前替代方案：使用 web_fetch 获取静态页面内容，使用 web_search 搜索信息。
启用方式：在 config.yaml 中设置 tools.browser_action.enabled=true 并安装 Playwright。`,
    input_schema: {
        type: 'object',
        properties: {
            action: { type: 'string', description: '要执行的操作（navigate/click/fill/scrape/screenshot）' },
            url: { type: 'string', description: '目标 URL' },
            selector: { type: 'string', description: 'CSS 选择器' },
            value: { type: 'string', description: '填写的值（fill 操作时）' },
        },
        required: ['action'],
    },
};

export async function executeBrowserAction(
    _input: any,
    _context: ToolContext
): Promise<ToolResult> {
    return {
        success: false,
        error: '浏览器自动化尚未启用。当前替代方案：使用 web_fetch 获取页面内容，使用 web_search 搜索信息。如需启用，请在 config.yaml 中设置 tools.browser_action.enabled=true 并运行 npm run setup:browser。',
    };
}

export const browserActionTool = {
    definition: browserActionToolDefinition,
    executor: executeBrowserAction,
    timeoutMs: 30000,
    riskLevel: 'medium' as const,
    requiresConfirmation: false,
};
