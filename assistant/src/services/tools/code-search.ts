/**
 * Code Search Tool - 搜索工作区中的代码内容
 *
 * @module src/services/tools/code-search
 */

import { readFileSync, readdirSync } from 'fs';
import { join, relative, extname } from 'path';
import type { ToolDefinition, ToolContext, ToolResult } from './types';

export const codeSearchToolDefinition: ToolDefinition = {
    name: 'code_search',
    description: `在工作区目录中搜索代码内容。

参数说明：
- query: 搜索关键词（支持正则表达式）
- file_pattern: 可选，文件类型过滤（如 "*.ts", "*.js"）
- include_context: 可选，是否包含上下文行（默认 true）

搜索范围：所有代码文件（.ts, .js, .tsx, .jsx, .vue, .py, .go, .rs, .java, .c, .cpp, .md, .json, .yaml, .yml, .sh, .sql）

注意：
- 跳过 node_modules, dist, .git 等目录
- 最多返回 50 个匹配结果
- 正则表达式搜索（不区分大小写）`,
    input_schema: {
        type: 'object',
        properties: {
            query: {
                type: 'string',
                description: '搜索关键词（支持正则表达式）',
            },
            file_pattern: {
                type: 'string',
                description: '可选：文件类型过滤（如 "*.ts"）',
            },
            include_context: {
                type: 'boolean',
                description: '可选：是否包含上下文行（默认 true）',
            },
        },
        required: ['query'],
    },
};

async function searchInFiles(
    workspaceDir: string,
    query: string,
    filePattern?: string,
    includeContext = true
): Promise<string> {
    const results: string[] = [];

    // 收集所有文件
    function collectFiles(dir: string): string[] {
        const files: string[] = [];
        try {
            const entries = readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
                // 跳过隐藏目录和 node_modules
                if (entry.name.startsWith('.') || entry.name === 'node_modules'
                    || entry.name === 'dist') continue;
                const fullPath = join(dir, entry.name);
                if (entry.isDirectory()) {
                    files.push(...collectFiles(fullPath));
                } else {
                    // 文件类型过滤
                    const ext = extname(entry.name);
                    const codeExts = ['.ts', '.js', '.tsx', '.jsx', '.vue', '.py',
                        '.go', '.rs', '.java', '.c', '.cpp', '.md',
                        '.json', '.yaml', '.yml', '.sh', '.sql'];
                    if (codeExts.includes(ext)) {
                        // 如果指定了文件模式，检查扩展名
                        if (filePattern) {
                            const patternExt = filePattern.startsWith('*') ? filePattern.slice(1) : filePattern;
                            if (!extname(entry.name).endsWith(patternExt) && !entry.name.endsWith(patternExt)) {
                                continue;
                            }
                        }
                        files.push(fullPath);
                    }
                }
            }
        } catch { /* ignore */ }
        return files;
    }

    const allFiles = collectFiles(workspaceDir);

    // 搜索（支持正则和字符串）
    let regex: RegExp;
    try {
        regex = new RegExp(query, 'gi');
    } catch {
        regex = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    }

    let matchCount = 0;
    for (const filePath of allFiles) {
        if (matchCount >= 50) break;
        try {
            const content = readFileSync(filePath, 'utf-8');
            const lines = content.split('\n');
            const relPath = relative(workspaceDir, filePath);

            for (let i = 0; i < lines.length; i++) {
                if (regex.test(lines[i])) {
                    regex.lastIndex = 0;
                    matchCount++;

                    const contextLines: string[] = [];
                    if (includeContext) {
                        const start = Math.max(0, i - 3);
                        const end = Math.min(lines.length - 1, i + 3);
                        for (let j = start; j <= end; j++) {
                            const marker = j === i ? '→' : ' ';
                            contextLines.push(`${marker} ${j + 1}: ${lines[j]}`);
                        }
                    } else {
                        contextLines.push(`  ${i + 1}: ${lines[i]}`);
                    }

                    results.push(`📄 ${relPath}:${i + 1}\n${contextLines.join('\n')}`);
                    if (matchCount >= 50) break;
                }
                regex.lastIndex = 0;
            }
        } catch { /* ignore */ }
    }

    if (results.length === 0) {
        return `未找到匹配「${query}」的内容`;
    }

    return `找到 ${results.length} 处匹配：\n\n${results.join('\n\n---\n\n')}`;
}

export async function executeCodeSearch(
    input: { query: string; file_pattern?: string; include_context?: boolean },
    context: ToolContext
): Promise<ToolResult> {
    const startTime = Date.now();

    // 获取工作区路径
    let workspaceDir: string;
    if (context.workspaceId) {
        // 从 workspace-config 获取实际路径
        try {
            const { getWorkspaceRootPath } = await import('../workspace-config');
            workspaceDir = getWorkspaceRootPath(context.workspaceId);
        } catch {
            workspaceDir = context.cwd || process.cwd();
        }
    } else {
        workspaceDir = context.cwd || process.cwd();
    }

    try {
        const result = await searchInFiles(
            workspaceDir,
            input.query,
            input.file_pattern,
            input.include_context !== false
        );

        return {
            success: true,
            data: { result },
            elapsed_ms: Date.now() - startTime,
        };
    } catch (err: any) {
        return {
            success: false,
            error: err.message || 'Search failed',
            elapsed_ms: Date.now() - startTime,
        };
    }
}

export const codeSearchTool = {
    definition: codeSearchToolDefinition,
    executor: executeCodeSearch,
    timeoutMs: 60000,
    riskLevel: 'low' as const,
    requiresConfirmation: false,
};
