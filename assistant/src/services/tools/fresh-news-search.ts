/**
 * fresh_news_search 工具
 * 在 web_search 基础上加时间窗口过滤 + 来源白/黑名单
 */

import type { ToolDefinition, ToolContext, ToolResult } from './types';
import { getConfig } from '../../config';

const TIMEOUT_MS = 15000;

export const freshNewsSearchToolDefinition: ToolDefinition = {
    name: 'fresh_news_search',
    description: `时效性新闻/信息搜索，带时间窗口过滤和来源白名单。
适用场景：金融行情、时事新闻、政策公告等需要"最新"信息的查询。
相比 web_search，本工具会过滤掉 time_window 之外的旧文章，并支持来源白名单。`,
    input_schema: {
        type: 'object',
        properties: {
            query: {
                type: 'string',
                description: '搜索关键词',
            },
            time_window: {
                type: 'string',
                enum: ['1h', '6h', '24h', '3d', '7d', '30d'],
                description: '时间窗口（默认 24h）',
            },
            source_whitelist: {
                type: 'array',
                items: { type: 'string' },
                description: '来源域名白名单（如 ["caixin.com", "sina.com.cn"]），不填则不过滤',
            },
            source_blacklist: {
                type: 'array',
                items: { type: 'string' },
                description: '来源域名黑名单',
            },
            max_results: {
                type: 'number',
                description: '返回条数（默认 10，最大 20）',
            },
        },
        required: ['query'],
    },
};

/** time_window 字符串转毫秒 */
function windowMs(tw: string): number {
    const map: Record<string, number> = {
        '1h': 3600_000,
        '6h': 6 * 3600_000,
        '24h': 24 * 3600_000,
        '3d': 3 * 86400_000,
        '7d': 7 * 86400_000,
        '30d': 30 * 86400_000,
    };
    return map[tw] ?? 24 * 3600_000;
}

/** time_window 映射到 SearXNG time_range 参数 */
function toSearxTimeRange(tw: string): string {
    if (tw === '1h' || tw === '6h' || tw === '24h') return 'day';
    if (tw === '3d' || tw === '7d') return 'week';
    return 'month';
}

/** 从 URL 提取域名 host */
function getHost(url: string): string {
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

/** 简单的发布时间提取（从 HTML 抓取 og/article meta 或 <time>） */
function extractPublishedDate(html: string): Date | null {
    const patterns = [
        /<meta[^>]+property=["']article:published_time["'][^>]+content=["']([^"']+)["']/i,
        /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']article:published_time["']/i,
        /<time[^>]+datetime=["']([^"']+)["']/i,
        /["']datePublished["']\s*:\s*["']([^"']+)["']/i,
        /["']publishedAt["']\s*:\s*["']([^"']+)["']/i,
    ];
    for (const re of patterns) {
        const m = html.match(re);
        if (m) {
            const d = new Date(m[1]);
            if (!isNaN(d.getTime())) return d;
        }
    }
    return null;
}

export async function executeFreshNewsSearch(
    input: {
        query: string;
        time_window?: string;
        source_whitelist?: string[];
        source_blacklist?: string[];
        max_results?: number;
    },
    _context: ToolContext
): Promise<ToolResult> {
    const {
        query,
        time_window = '24h',
        source_whitelist,
        source_blacklist,
        max_results = 10,
    } = input;

    const config = getConfig();
    const baseUrl = config.tools?.web_search?.base_url;
    if (!baseUrl) {
        return { success: false, error: 'SearXNG 未配置：缺少 tools.web_search.base_url' };
    }

    const limit = Math.min(Math.max(1, max_results), 20);
    const cutoff = Date.now() - windowMs(time_window);

    // Step 1: SearXNG 搜索（带 time_range）
    let rawResults: Array<{ title: string; url: string; content: string }> = [];
    try {
        const searchUrl = new URL('/search', baseUrl);
        searchUrl.searchParams.set('q', query.trim());
        searchUrl.searchParams.set('format', 'json');
        searchUrl.searchParams.set('safesearch', '0');
        searchUrl.searchParams.set('language', 'zh-CN');
        searchUrl.searchParams.set('time_range', toSearxTimeRange(time_window));
        // Request more than needed to allow for filtering
        searchUrl.searchParams.set('pageno', '1');

        const resp = await fetch(searchUrl.toString(), {
            headers: { 'Accept': 'application/json' },
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (resp.ok) {
            const data = await resp.json();
            rawResults = (data.results || []).map((r: any) => ({
                title: r.title || '',
                url: r.url || '',
                content: r.content || r.snippet || '',
            }));
        }
    } catch (err: any) {
        console.warn('[FreshNews] SearXNG failed:', err.message);
        return { success: false, error: `搜索失败: ${err.message}` };
    }

    // Step 2: 白/黑名单过滤
    let filtered = rawResults.filter(r => {
        const host = getHost(r.url);
        if (source_blacklist?.some(b => host.includes(b))) return false;
        if (source_whitelist?.length && !source_whitelist.some(w => host.includes(w))) return false;
        return true;
    });

    // Step 3: 对前 limit*2 条结果尝试抓取发布时间
    const candidates = filtered.slice(0, limit * 2);
    const enriched: Array<{
        title: string; url: string; content: string;
        published_at: string | null; host: string;
    }> = [];

    await Promise.allSettled(
        candidates.map(async (r) => {
            let publishedAt: Date | null = null;
            try {
                const pageResp = await fetch(r.url, {
                    signal: AbortSignal.timeout(5000),
                    headers: { 'User-Agent': 'Mozilla/5.0' },
                });
                if (pageResp.ok) {
                    const html = await pageResp.text();
                    publishedAt = extractPublishedDate(html);
                }
            } catch { /* silent */ }

            // Keep if within window (or if we couldn't determine date)
            if (!publishedAt || publishedAt.getTime() >= cutoff) {
                enriched.push({
                    title: r.title,
                    url: r.url,
                    content: r.content.slice(0, 300),
                    published_at: publishedAt?.toISOString() ?? null,
                    host: getHost(r.url),
                });
            }
        })
    );

    // Step 4: 按发布时间倒序（未知时间排末尾）
    enriched.sort((a, b) => {
        if (!a.published_at && !b.published_at) return 0;
        if (!a.published_at) return 1;
        if (!b.published_at) return -1;
        return new Date(b.published_at).getTime() - new Date(a.published_at).getTime();
    });

    const results = enriched.slice(0, limit);

    // Step 5: 如无结果降级（不带时间过滤重搜）
    if (results.length === 0) {
        console.warn('[FreshNews] No results after filter, returning raw top results');
        const fallback = filtered.slice(0, limit).map(r => ({
            title: r.title,
            url: r.url,
            content: r.content.slice(0, 300),
            published_at: null,
            host: getHost(r.url),
        }));
        return {
            success: true,
            data: {
                query, time_window, results: fallback, total: fallback.length,
                note: '时效过滤失败，返回原始搜索结果',
            },
        };
    }

    return {
        success: true,
        data: { query, time_window, results, total: results.length },
    };
}

export const freshNewsSearchTool = {
    definition: freshNewsSearchToolDefinition,
    executor: executeFreshNewsSearch,
    timeoutMs: 30000,
    riskLevel: 'low' as const,
};
