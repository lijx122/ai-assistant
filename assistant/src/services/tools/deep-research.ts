/**
 * Deep Research 工具 - 深度研究（真工具）
 *
 * 工具内部自主执行所有研究步骤：多轮搜索 + 内容抓取
 * 返回聚合后的真实研究数据，供 AI 生成报告
 *
 * @module src/services/tools/deep-research
 */

import type { ToolDefinition, ToolContext, ToolResult } from './types';
import { executeWebSearch } from './web-search';
import { executeWebFetch } from './web-fetch';

const DEFAULT_TIMEOUT_MS = 120000; // 2分钟超时（多轮搜索+抓取）

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
 * 工具定义
 */
export const deepResearchToolDefinition: ToolDefinition = {
    name: 'deep_research',
    description: `深度研究工具。工具内部自动执行多轮网络搜索和内容抓取，
返回聚合后的真实研究数据供你生成报告。

特点：
- 自主生成多角度搜索词
- 自动去重，合并搜索结果
- 抓取重要来源的全文内容
- 返回结构化的研究数据

适用：研究报告、深度分析、市场调研、技术调查。
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
        },
        required: ['topic'],
    },
};

/**
 * 执行深度研究
 */
export async function executeDeepResearch(
    input: { topic: string; depth?: 'quick' | 'standard' | 'deep' },
    context: ToolContext
): Promise<ToolResult> {
    const startTime = Date.now();
    const { topic, depth = 'standard' } = input;

    // 参数校验
    if (!topic || topic.trim().length === 0) {
        return {
            success: false,
            error: '研究主题不能为空',
            elapsed_ms: Date.now() - startTime,
        };
    }

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

    try {
        console.log(`[DeepResearch] Starting research for: ${topic}`);
        const result = await runDeepResearch(topic.trim(), depth, context);

        return {
            success: true,
            data: {
                topic: topic.trim(),
                depth,
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
