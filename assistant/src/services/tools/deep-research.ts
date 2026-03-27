/**
 * Deep Research 工具 - 深度研究（真工具）
 *
 * 工具内部自主执行所有研究步骤：多轮搜索 + 内容抓取
 * 返回聚合后的真实研究数据，供 AI 生成报告
 *
 * 支持三种模式：
 * - web：网络研究（默认）
 * - codebase：分析工作区代码
 * - github：分析 GitHub 项目
 *
 * @module src/services/tools/deep-research
 */

import type { ToolDefinition, ToolContext, ToolResult } from './types';
import { executeWebSearch } from './web-search';
import { executeWebFetch } from './web-fetch';
import { executeClaudeCode } from './claude-code';
import { executeBash } from './bash';

const DEFAULT_TIMEOUT_MS = 120000; // 2分钟超时（多轮搜索+抓取）

/**
 * 研究模式
 */
type ResearchMode = 'web' | 'codebase' | 'github';

/**
 * 搜索结果项
 */
interface SourceItem {
    title: string;
    url: string;
    content: string;
    fetchedFull: boolean;
}

/**
 * 深度配置
 */
interface DeepConfig {
    searches: number;
    fetches: number;
}

/**
 * 执行深度研究
 * 工具内部自主执行所有研究步骤，返回聚合后的真实数据
 */
async function runDeepResearch(
    topic: string,
    depth: 'quick' | 'standard' | 'deep',
    context: ToolContext
): Promise<string> {
    const config: Record<string, DeepConfig> = {
        quick:    { searches: 3, fetches: 0 },
        standard: { searches: 5, fetches: 2 },
        deep:     { searches: 8, fetches: 4 },
    };

    const { searches: searchCount, fetches: fetchCount } = config[depth] || config.standard;
    const allSources: SourceItem[] = [];
    const searchLog: string[] = [];
    const fetchLog: string[] = [];
    let totalSearchTime = 0;
    let totalFetchTime = 0;

    console.log(`[DeepResearch] Starting research: ${topic} (depth: ${depth})`);

    // ── Phase 1：自动生成搜索角度 ──────────────────────

    // 用不同角度构造搜索词
    const searchQueries = generateSearchQueries(topic, searchCount);

    // ── Phase 2：执行所有搜索 ───────────────────────────

    for (const query of searchQueries) {
        searchLog.push(`搜索: ${query}`);
        console.log(`[DeepResearch] Searching: ${query}`);

        try {
            const startTime = Date.now();
            const result = await executeWebSearch(
                { query, num_results: 5 },
                context
            );
            totalSearchTime += Date.now() - startTime;

            if (result.success && result.data?.results) {
                const newResults = result.data.results;

                // 去重：同一 URL 不重复收录
                for (const r of newResults) {
                    const url = r.url || '';
                    if (url && !allSources.find(s => s.url === url)) {
                        allSources.push({
                            title: r.title || '',
                            url,
                            content: r.content || r.snippet || '',
                            fetchedFull: false,
                        });
                    }
                }

                searchLog.push(`  → 获得 ${newResults.length} 条结果（累计 ${allSources.length} 条）`);
            } else if (result.error) {
                searchLog.push(`  → 失败: ${result.error}`);
            }
        } catch (e: any) {
            searchLog.push(`  → 异常: ${e.message}`);
            console.error(`[DeepResearch] Search error for "${query}":`, e.message);
        }
    }

    console.log(`[DeepResearch] Search phase complete: ${allSources.length} unique sources`);

    // ── Phase 3：对重要来源抓取全文 ─────────────────────

    if (fetchCount > 0 && allSources.length > 0) {
        // 优先抓取内容较短的（说明 snippet 不完整）
        // 排除已获取完整内容的来源
        const toFetch = allSources
            .filter(s => !s.fetchedFull && s.content.length < 800)
            .sort((a, b) => a.content.length - b.content.length)
            .slice(0, fetchCount);

        for (const source of toFetch) {
            fetchLog.push(`抓取: ${source.url}`);
            console.log(`[DeepResearch] Fetching: ${source.url}`);

            try {
                const startTime = Date.now();
                const fetched = await executeWebFetch(
                    { url: source.url, max_chars: 4000 },
                    context
                );
                totalFetchTime += Date.now() - startTime;

                if (fetched.success && fetched.data?.content) {
                    source.content = fetched.data.content;
                    source.fetchedFull = true;
                    fetchLog.push(`  → 成功获取 ${fetched.data.content.length} 字符`);
                } else if (fetched.error) {
                    fetchLog.push(`  → 失败: ${fetched.error}`);
                }
            } catch (e: any) {
                fetchLog.push(`  → 异常: ${e.message}`);
                console.error(`[DeepResearch] Fetch error for "${source.url}":`, e.message);
            }
        }

        console.log(`[DeepResearch] Fetch phase complete: ${allSources.filter(s => s.fetchedFull).length} full articles`);
    }

    // ── Phase 4：整理输出 ───────────────────────────────

    const successfulFetches = allSources.filter(s => s.fetchedFull).length;
    const fetchedSources = allSources.filter(s => s.fetchedFull);
    const snippetSources = allSources.filter(s => !s.fetchedFull);

    // 按内容丰富程度排序
    const sortedSources = [...fetchedSources, ...snippetSources];

    const sourcesText = sortedSources
        .slice(0, 15)  // 最多返回15条来源
        .map((s, i) => {
            const prefix = s.fetchedFull ? '[全文]' : '[摘要]';
            const content = s.content.slice(0, 2000);
            return `
[来源 ${i + 1}] ${s.title}
URL: ${s.url}
${prefix} ${content}
            `.trim();
        })
        .join('\n\n---\n\n');

    const report = `
## 深度研究完成

**主题**：${topic}
**深度级别**：${depth}
- 搜索次数：${searchQueries.length} 次
- 抓取全文：${successfulFetches} 篇
- 累计来源：${allSources.length} 条（去重后）

**执行统计**：
- 搜索耗时：${(totalSearchTime / 1000).toFixed(1)}s
- 抓取耗时：${(totalFetchTime / 1000).toFixed(1)}s

---

## 执行日志

**搜索记录**：
${searchLog.map(l => `- ${l}`).join('\n')}

${fetchLog.length > 0 ? `**抓取记录**：
${fetchLog.map(l => `- ${l}`).join('\n')}` : ''}

---

## 原始研究数据

${sourcesText}

---

## 后续任务

请基于以上 ${allSources.length} 条真实研究数据，生成完整研究报告。
报告应包含：
1. **执行摘要**（200字以内）
2. **核心发现**（基于真实数据）
3. **数据支撑**（引用具体数字和统计）
4. **案例分析**（真实案例）
5. **挑战与局限**（诚实讨论）
6. **结论与建议**
7. **参考来源**（包含 URL）
`.trim();

    console.log(`[DeepResearch] Research complete: ${allSources.length} sources, ${successfulFetches} full articles`);

    return report;
}

/**
 * 提取核心关键词
 * 当 topic 超过20字时，在标点处截断，避免搜索词过长
 */
function extractCoreKeywords(topic: string): string {
    // 超过20字则截取前20字或找到最后一个标点截断
    if (topic.length <= 20) return topic;
    // 找到合适的截断点（逗号、顿号、空格）
    const breakPoints = ['，', '、', ' ', ',', '·'];
    for (const bp of breakPoints) {
        const idx = topic.indexOf(bp);
        if (idx > 5 && idx <= 25) return topic.slice(0, idx);
    }
    return topic.slice(0, 20);
}

/**
 * 获取当前年份
 */
function getCurrentYear(): number {
    return new Date().getFullYear();
}

/**
 * 生成搜索查询列表
 */
function generateSearchQueries(topic: string, count: number): string[] {
    const coreKeyword = extractCoreKeywords(topic);
    const year = getCurrentYear();

    const baseQueries = [
        topic,                                    // 第一条用完整 topic
        `${coreKeyword} 最新进展 ${year}`,        // 最新动态
        `${coreKeyword} 价格 对比`,               // 更精准的角度词
        `${coreKeyword} 案例 评测`,               // 实际案例与评测
        `${coreKeyword} 缺点 坑`,                // 批评视角
        `${coreKeyword} 趋势`,                    // 前瞻
        `${coreKeyword} 推荐 选择`,               // 权威观点
        `${coreKeyword} 横评`,                    // 横向对比
    ];

    return baseQueries.slice(0, count);
}

/**
 * 研究工作区代码
 */
async function researchCodebase(
    workspaceDir: string,
    topic: string,
    context: ToolContext
): Promise<string> {
    console.log(`[DeepResearch] Analyzing codebase: ${workspaceDir}, topic: ${topic}`);

    const analysisPrompt = `
分析当前工作区代码库，重点关注：${topic || '整体架构和代码质量'}

请输出：
1. 项目概述（技术栈、规模、定位）
2. 目录结构分析（核心模块说明）
3. 架构设计（主要模块及关系）
4. 核心依赖（关键第三方库及用途）
5. 代码质量观察（命名规范、注释、测试覆盖）
6. 潜在问题或改进点
7. 亮点设计（值得学习的实现）

要求：基于实际文件内容，引用具体文件路径和代码片段。
  `.trim();

    try {
        const result = await executeClaudeCode(
            { task: analysisPrompt, context: `工作区路径：${workspaceDir}` },
            context
        );

        if (result.success && result.data?.output) {
            return `
## 工作区代码分析完成

**工作区**：${workspaceDir}
**分析主题**：${topic || '整体架构'}

---

${result.data.output}

---

请基于以上分析，生成完整的代码分析报告。
            `.trim();
        } else {
            return `
## 工作区代码分析失败

错误：${result.error || '未知错误'}
提示：请确保 Claude Code CLI 已安装并可用。
            `.trim();
        }
    } catch (e: any) {
        console.error('[DeepResearch] Codebase analysis failed:', e);
        return `
## 工作区代码分析失败

错误：${e.message}
        `.trim();
    }
}

/**
 * 研究 GitHub 项目
 */
async function researchGitHub(
    githubUrl: string,
    cloneDepth: boolean,
    context: ToolContext,
    depth: 'quick' | 'standard' | 'deep'
): Promise<string> {
    console.log(`[DeepResearch] Analyzing GitHub: ${githubUrl}, clone: ${cloneDepth}`);

    // 标准化 URL
    let url = githubUrl;
    if (!url.startsWith('http')) {
        url = `https://github.com/${githubUrl}`;
    }
    const repoName = url.split('/').slice(-2).join('/');
    const sources: string[] = [];
    const logs: string[] = [];

    // ── 路径A：网络分析（总是执行）─────────────────────

    logs.push('分析 GitHub 页面...');

    // 1. fetch README
    const readmeUrl = url
        .replace('github.com', 'raw.githubusercontent.com')
        .replace(/\/$/, '') + '/main/README.md';
    try {
        const readme = await executeWebFetch(
            { url: readmeUrl, max_chars: 4000 },
            context
        );
        if (readme.success && readme.data?.content) {
            sources.push(`## README\n${readme.data.content}`);
            logs.push('✓ 获取 README 成功');
        } else {
            logs.push('✗ README 获取失败');
        }
    } catch (e: any) {
        logs.push(`✗ README 获取异常: ${e.message}`);
    }

    // 2. GitHub API 获取项目基本信息
    const apiUrl = url.replace('https://github.com/', 'https://api.github.com/repos/');
    try {
        const info = await executeWebFetch(
            { url: apiUrl, max_chars: 2000 },
            context
        );
        if (info.success && info.data?.content) {
            sources.push(`## 项目信息\n${info.data.content}`);
            logs.push('✓ 获取项目元数据成功');
        } else {
            logs.push('✗ 项目信息获取失败');
        }
    } catch (e: any) {
        logs.push(`✗ 项目信息获取异常: ${e.message}`);
    }

    // 3. 搜索项目相关讨论和评测
    const searchQueries = [
        `${repoName} github 使用教程 评测`,
        `${repoName} issue 问题 解决`,
        `${repoName} 优缺点 对比`,
    ].slice(0, depth === 'quick' ? 1 : depth === 'standard' ? 2 : 3);

    for (const q of searchQueries) {
        try {
            const result = await executeWebSearch(
                { query: q, num_results: 3 },
                context
            );
            if (result.success && result.data?.results) {
                sources.push(`## 搜索：${q}\n` +
                    result.data.results.map((r: any) => `### ${r.title}\n${r.content}`).join('\n\n')
                );
                logs.push(`✓ 搜索"${q}"获得 ${result.data.results.length} 条结果`);
            } else {
                logs.push(`✗ 搜索"${q}"失败`);
            }
        } catch (e: any) {
            logs.push(`✗ 搜索"${q}"异常: ${e.message}`);
        }
    }

    // ── 路径B：Clone 深度分析（可选）───────────────────

    if (cloneDepth) {
        logs.push('开始 clone 项目进行深度分析...');
        const tmpDir = `/tmp/deep-research-${Date.now()}`;

        try {
            // clone（shallow，只取最近1个commit）
            const cloneResult = await executeBash(
                { command: `git clone --depth 1 --single-branch "${url}" "${tmpDir}" 2>&1 | tail -5` },
                context
            );
            logs.push(`✓ Clone 完成: ${cloneResult.data?.output?.slice(0, 100) || '成功'}`);

            // 用 claude_code 分析
            const codeAnalysis = await executeClaudeCode(
                {
                    task: `分析以下路径的代码库：${tmpDir}
请输出：项目架构、核心实现逻辑、代码质量、设计亮点、潜在问题。
引用具体文件和代码片段。`,
                    context: `GitHub 项目：${url}`,
                },
                context
            );

            if (codeAnalysis.success && codeAnalysis.data?.output) {
                sources.push(`## 代码深度分析\n${codeAnalysis.data.output}`);
                logs.push('✓ 代码分析完成');
            } else {
                logs.push('✗ 代码分析失败');
            }

            // 清理
            await executeBash(
                { command: `rm -rf "${tmpDir}"` },
                context
            );
            logs.push('✓ 临时文件已清理');

        } catch (e: any) {
            logs.push(`✗ Clone 失败: ${e.message}`);
        }
    }

    // ── 整理输出 ──

    return `
## GitHub 项目深度研究完成

**项目**：${url}
**模式**：${cloneDepth ? '网络分析 + 本地代码分析' : '网络分析'}

**执行日志**：
${logs.map(l => `- ${l}`).join('\n')}

---

${sources.join('\n\n---\n\n')}

---

**指令**：请基于以上数据，生成完整的项目分析报告。
报告包含：项目定位、核心功能、技术架构、使用场景、优缺点、与同类项目对比、适用建议。
    `.trim();
}

/**
 * 工具定义
 */
export const deepResearchToolDefinition: ToolDefinition = {
    name: 'deep_research',
    description: `深度研究工具。支持三种研究模式：
- web：网络深度研究（默认），执行多轮搜索和内容抓取
- codebase：分析当前工作区代码，调用 Claude Code 进行架构分析
- github：分析 GitHub 项目，支持快速分析和深度分析（含 clone）

适用：研究报告、深度分析、市场调研、技术调查、代码审查。
不适用：简单事实查询、天气、快速问答。`,
    input_schema: {
        type: 'object',
        properties: {
            topic: {
                type: 'string',
                description: '研究主题，尽量具体明确',
            },
            depth: {
                type: 'string',
                enum: ['quick', 'standard', 'deep'],
                description: 'quick=3次搜索(无抓取), standard=5次搜索+2篇全文, deep=8次搜索+4篇全文',
            },
            mode: {
                type: 'string',
                enum: ['web', 'codebase', 'github'],
                description: 'web=网络研究（默认），codebase=工作区代码分析，github=GitHub项目分析',
                default: 'web',
            },
            github_url: {
                type: 'string',
                description: 'GitHub 项目 URL 或 owner/repo 格式，mode=github 时使用',
            },
            clone_depth: {
                type: 'boolean',
                description: '是否 clone 到本地进行深度代码分析，默认 false（仅分析页面和README）',
                default: false,
            },
        },
        required: ['topic'],
    },
};

/**
 * 执行深度研究
 */
export async function executeDeepResearch(
    input: {
        topic: string;
        depth?: 'quick' | 'standard' | 'deep';
        mode?: 'web' | 'codebase' | 'github';
        github_url?: string;
        clone_depth?: boolean;
    },
    context: ToolContext
): Promise<ToolResult> {
    const startTime = Date.now();
    const {
        topic,
        depth = 'standard',
        mode = 'web',
        github_url,
        clone_depth = false,
    } = input;

    // 参数校验
    if (!topic || topic.trim().length === 0) {
        return {
            success: false,
            error: '研究主题不能为空',
            elapsed_ms: Date.now() - startTime,
        };
    }

    // github 模式校验
    if (mode === 'github' && !github_url) {
        return {
            success: false,
            error: 'github 模式需要提供 github_url 参数',
            elapsed_ms: Date.now() - startTime,
        };
    }

    try {
        console.log(`[DeepResearch] Starting research: mode=${mode}, topic=${topic}`);

        let result: string;

        if (mode === 'codebase') {
            // 工作区代码分析模式
            const workspaceDir = context.cwd || '.';
            result = await researchCodebase(workspaceDir, topic, context);
        } else if (mode === 'github') {
            // GitHub 项目分析模式
            result = await researchGitHub(github_url!, clone_depth, context, depth);
        } else {
            // 原有 web 模式
            // 验证搜索服务配置
            const { getConfig } = await import('../../config');
            const config = getConfig();
            const searchBaseUrl = config.tools?.web_search?.base_url;

            if (!searchBaseUrl) {
                return {
                    success: false,
                    error: '搜索服务未配置：缺少 tools.web_search.base_url',
                    elapsed_ms: Date.now() - startTime,
                };
            }

            result = await runDeepResearch(topic.trim(), depth, context);
        }

        return {
            success: true,
            data: {
                topic: topic.trim(),
                depth,
                mode,
                research: result,
            },
            elapsed_ms: Date.now() - startTime,
        };
    } catch (e: any) {
        console.error('[DeepResearch] Research failed:', e);
        return {
            success: false,
            error: `研究失败: ${e.message}`,
            elapsed_ms: Date.now() - startTime,
        };
    }
}

/**
 * 注册的工具配置
 */
export const deepResearchTool = {
    definition: deepResearchToolDefinition,
    executor: executeDeepResearch,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    riskLevel: 'low' as const,
};
