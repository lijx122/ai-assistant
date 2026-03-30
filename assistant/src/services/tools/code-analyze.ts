/**
 * Code Analyze Tool - 分析工作区代码结构和关键文件
 *
 * @module src/services/tools/code-analyze
 */

import { readFileSync, readdirSync } from 'fs';
import { join, relative } from 'path';
import type { ToolDefinition, ToolContext, ToolResult } from './types';

export const codeAnalyzeToolDefinition: ToolDefinition = {
    name: 'code_analyze',
    description: `分析工作区代码结构，提供架构概览和安全分析。

参数说明：
- focus: 分析重点（security | architecture | full）
- target: 可选，分析特定文件或目录

输出内容：
- 目录结构树
- package.json 依赖信息
- 关键文件内容摘要

注意：
- 不调用外部 AI，直接使用文件系统分析
- 敏感文件（如密钥文件）会被标记但不展示内容`,
    input_schema: {
        type: 'object',
        properties: {
            focus: {
                type: 'string',
                enum: ['security', 'architecture', 'full'],
                description: '分析重点：security（安全）、architecture（架构）、full（完整）',
            },
            target: {
                type: 'string',
                description: '可选：分析特定文件或目录路径',
            },
        },
        required: ['focus'],
    },
};

async function analyzeCodebase(
    workspaceDir: string,
    focus: string,
    target?: string
): Promise<string> {
    const sections: string[] = [];

    // 1. 目录结构
    function buildTree(dir: string, depth = 0, maxDepth = 3): string {
        if (depth > maxDepth) return '';
        let tree = '';
        try {
            const entries = readdirSync(dir, { withFileTypes: true })
                .filter(e => !e.name.startsWith('.') &&
                    e.name !== 'node_modules' &&
                    e.name !== 'dist')
                .sort((a, b) => {
                    if (a.isDirectory() !== b.isDirectory())
                        return a.isDirectory() ? -1 : 1;
                    return a.name.localeCompare(b.name);
                });
            for (const entry of entries) {
                const indent = '  '.repeat(depth);
                const icon = entry.isDirectory() ? '📁' : '📄';
                tree += `${indent}${icon} ${entry.name}\n`;
                if (entry.isDirectory()) {
                    tree += buildTree(join(dir, entry.name), depth + 1, maxDepth);
                }
            }
        } catch { /* ignore */ }
        return tree;
    }

    sections.push('## 目录结构\n```\n' + buildTree(workspaceDir) + '```');

    // 2. package.json 依赖
    try {
        const pkg = JSON.parse(readFileSync(join(workspaceDir, 'package.json'), 'utf-8'));
        const deps = Object.keys(pkg.dependencies || {});
        const devDeps = Object.keys(pkg.devDependencies || {});
        sections.push(`## 项目信息\n- 名称：${pkg.name}\n- 版本：${pkg.version}\n- 主要依赖：${deps.slice(0, 20).join(', ')}\n- 开发依赖：${devDeps.slice(0, 10).join(', ')}`);
    } catch { /* ignore */ }

    // 3. 根据 focus 读取相关文件
    if (focus === 'security' || focus === 'full') {
        // 搜索敏感模式
        const sensitivePatterns: { pattern: RegExp; name: string }[] = [
            { pattern: /process\.env\.[A-Z_]+/g, name: '环境变量引用' },
            { pattern: /password|secret|token|key|api_key|apikey/gi, name: '敏感关键词' },
            { pattern: /eval\(/g, name: 'eval() 调用' },
            { pattern: /new Function\(/g, name: 'Function 构造' },
        ];

        sections.push('## 安全检查\n');
        try {
            const srcDir = join(workspaceDir, 'src');
            if (srcDir) {
                const allFiles: string[] = [];
                function collectSrcFiles(dir: string) {
                    try {
                        const entries = readdirSync(dir, { withFileTypes: true });
                        for (const entry of entries) {
                            if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
                            const fullPath = join(dir, entry.name);
                            if (entry.isDirectory()) {
                                collectSrcFiles(fullPath);
                            } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.js')) {
                                allFiles.push(fullPath);
                            }
                        }
                    } catch { /* ignore */ }
                }
                collectSrcFiles(srcDir);

                for (const { pattern, name } of sensitivePatterns) {
                    let found = false;
                    for (const filePath of allFiles.slice(0, 20)) {
                        try {
                            const content = readFileSync(filePath, 'utf-8');
                            const matches = content.match(pattern);
                            if (matches && matches.length > 0) {
                                if (!found) {
                                    sections.push(`### ${name}`);
                                    found = true;
                                }
                                const relPath = relative(workspaceDir, filePath);
                                sections.push(`- ${relPath}: 找到 ${matches.length} 处`);
                            }
                        } catch { /* ignore */ }
                    }
                }
            }
        } catch { /* ignore */ }

        // 收集关键安全文件内容
        const keyFiles = ['src/middleware/auth.ts', 'src/routes/auth.ts',
            '.env.example', 'config.yaml'];
        for (const f of keyFiles) {
            try {
                const content = readFileSync(join(workspaceDir, f), 'utf-8');
                // 只展示前 500 字符，避免泄露
                sections.push(`## ${f}\n\`\`\`\n${content.slice(0, 500)}${content.length > 500 ? '\n...' : ''}\n\`\`\``);
            } catch { /* ignore */ }
        }
    }

    if (focus === 'architecture' || focus === 'full') {
        // 读取核心文件
        const coreFiles = ['src/server.ts', 'src/db/migrate.ts',
            'src/channels/base.ts'];
        for (const f of coreFiles) {
            try {
                const content = readFileSync(join(workspaceDir, f), 'utf-8');
                sections.push(`## ${f}\n\`\`\`typescript\n${content.slice(0, 3000)}${content.length > 3000 ? '\n...' : ''}\n\`\`\``);
            } catch { /* ignore */ }
        }
    }

    if (target) {
        try {
            const content = readFileSync(join(workspaceDir, target), 'utf-8');
            sections.push(`## 分析目标: ${target}\n\`\`\`\n${content.slice(0, 5000)}${content.length > 5000 ? '\n...' : ''}\n\`\`\``);
        } catch (e: any) {
            sections.push(`## 分析目标: ${target}\n文件不存在或读取失败: ${e.message}`);
        }
    }

    return sections.join('\n\n') + '\n\n---\n\n请基于以上代码信息进行分析。';
}

export async function executeCodeAnalyze(
    input: { focus: string; target?: string },
    context: ToolContext
): Promise<ToolResult> {
    const startTime = Date.now();

    // 获取工作区路径
    let workspaceDir: string;
    if (context.workspaceId) {
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
        const result = await analyzeCodebase(workspaceDir, input.focus, input.target);

        return {
            success: true,
            data: { result },
            elapsed_ms: Date.now() - startTime,
        };
    } catch (err: any) {
        return {
            success: false,
            error: err.message || 'Analysis failed',
            elapsed_ms: Date.now() - startTime,
        };
    }
}

export const codeAnalyzeTool = {
    definition: codeAnalyzeToolDefinition,
    executor: executeCodeAnalyze,
    timeoutMs: 60000,
    riskLevel: 'low' as const,
    requiresConfirmation: false,
};
