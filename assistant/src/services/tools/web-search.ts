/**
 * Web Search 工具 - 使用 SearXNG 进行网络搜索
 *
 * @module src/services/tools/web-search
 */

import type { ToolDefinition, ToolContext, ToolResult } from './types';
import { getConfig } from '../../config';

const DEFAULT_TIMEOUT_MS = 10000; // 10秒超时
const DEFAULT_NUM_RESULTS = 5;

/**
 * 工具定义
 */
export const webSearchToolDefinition: ToolDefinition = {
    name: 'web_search',
    description: `使用 SearXNG 搜索引擎进行网络搜索。

参数：
- query: 搜索关键词（必填）
- num_results: 返回结果数量（可选，默认5，最大10）

返回结果包含：标题、链接、摘要。超时10秒，失败返回空结果。`,
    input_schema: {
        type: 'object',
        properties: {
            query: {
                type: 'string',
                description: '搜索关键词',
            },
            num_results: {
                type: 'number',
                description: '返回结果数量（默认5，最大10）',
            },
        },
        required: ['query'],
    },
};

/**
 * SearXNG 搜索结果项
 */
interface SearxResult {
    title: string;
    url: string;
    content?: string;
    engine?: string;
}

/**
 * 执行网络搜索
 */
export async function executeWebSearch(
    input: { query: string; num_results?: number },
    context: ToolContext
): Promise<ToolResult> {
    const startTime = Date.now();
    const { query, num_results } = input;

    // 参数校验
    if (!query || query.trim().length === 0) {
        return {
            success: false,
            error: '搜索关键词不能为空',
            elapsed_ms: 0,
        };
    }

    // 获取 SearXNG 配置
    const config = getConfig();
    const baseUrl = config.tools?.web_search?.base_url;

    if (!baseUrl) {
        return {
            success: false,
            error: 'SearXNG 未配置：缺少 tools.web_search.base_url 配置',
            elapsed_ms: 0,
        };
    }

    // 限制结果数量
    const limit = Math.min(Math.max(1, num_results || DEFAULT_NUM_RESULTS), 10);

    try {
        // 构建 SearXNG API URL
        const searchUrl = new URL('/search', baseUrl);
        searchUrl.searchParams.set('q', query.trim());
        searchUrl.searchParams.set('format', 'json');
        searchUrl.searchParams.set('safesearch', '0');
        searchUrl.searchParams.set('language', 'zh-CN');

        console.log(`[WebSearch] Searching: ${query} (limit: ${limit})`);

        const response = await fetch(searchUrl.toString(), {
            method: 'GET',
            headers: {
                'Accept': 'application/json',
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
                'X-Forwarded-For': '127.0.0.1',
                'X-Real-IP': '127.0.0.1',
            },
            signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
        });

        if (!response.ok) {
            const errorText = await response.text().catch(() => 'Unknown error');
            console.warn(`[WebSearch] SearXNG returned ${response.status}: ${errorText}`);
            return {
                success: false,
                error: `搜索服务返回错误: ${response.status}`,
                data: {
                    query,
                    results: [],
                    total: 0,
                },
                elapsed_ms: Date.now() - startTime,
            };
        }

        // 解析响应
        const data = await response.json();

        // 提取搜索结果
        const results: SearxResult[] = (data.results || [])
            .slice(0, limit)
            .map((r: any) => ({
                title: r.title || '无标题',
                url: r.url || r.link || '',
                content: r.content || r.snippet || r.abstract || '',
                engine: r.engine || '',
            }));

        console.log(`[WebSearch] Found ${results.length} results for "${query}"`);

        return {
            success: true,
            data: {
                query,
                results,
                total: results.length,
            },
            elapsed_ms: Date.now() - startTime,
        };

    } catch (err: any) {
        const elapsed = Date.now() - startTime;

        // 处理超时
        if (err.name === 'AbortError') {
            console.warn(`[WebSearch] Timeout after ${DEFAULT_TIMEOUT_MS}ms`);
            return {
                success: false,
                error: '搜索超时（10秒）',
                data: {
                    query,
                    results: [],
                    total: 0,
                },
                elapsed_ms: elapsed,
            };
        }

        // 其他错误
        console.error('[WebSearch] Error:', err);
        return {
            success: false,
            error: `搜索失败: ${err.message}`,
            data: {
                query,
                results: [],
                total: 0,
            },
            elapsed_ms: elapsed,
        };
    }
}

/**
 * 注册的工具配置
 */
export const webSearchTool = {
    definition: webSearchToolDefinition,
    executor: executeWebSearch,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    riskLevel: 'low' as const, // 搜索是低风险操作
};
