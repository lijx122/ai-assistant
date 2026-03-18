/**
 * Web Fetch 工具 - 抓取网页并提取正文
 *
 * @module src/services/tools/web-fetch
 *
 * 使用 @mozilla/readability 提取正文内容，支持超时和截断
 */

import type { ToolDefinition, ToolContext, ToolResult } from './types';

const DEFAULT_TIMEOUT_MS = 15000; // 15秒超时
const MAX_CONTENT_LENGTH = 20000; // 最大字符数

type ReadabilityCtor = new (doc: Document) => { parse: () => { title?: string; textContent?: string } | null };
type JSDOMCtor = new (
    html: string,
    options?: {
        url?: string;
        contentType?: string;
        includeNodeLocations?: boolean;
        storageQuota?: number;
    }
) => { window: { document: Document } };

let readabilityDepsPromise: Promise<{ Readability: ReadabilityCtor; JSDOM: JSDOMCtor }> | null = null;

async function loadReadabilityDeps(): Promise<{ Readability: ReadabilityCtor; JSDOM: JSDOMCtor }> {
    if (!readabilityDepsPromise) {
        readabilityDepsPromise = (async () => {
            const dynamicImport = new Function('s', 'return import(s)') as (s: string) => Promise<any>;
            const [readabilityModule, jsdomModule] = await Promise.all([
                dynamicImport('@mozilla/readability'),
                dynamicImport('jsdom'),
            ]);

            const Readability =
                readabilityModule?.Readability ||
                readabilityModule?.default?.Readability ||
                readabilityModule?.default;
            const JSDOM =
                jsdomModule?.JSDOM ||
                jsdomModule?.default?.JSDOM ||
                jsdomModule?.default;

            if (!Readability || !JSDOM) {
                throw new Error('Readability/JSDOM 模块加载失败');
            }

            return { Readability, JSDOM };
        })();
    }
    return readabilityDepsPromise;
}

/**
 * 工具定义
 */
export const webFetchToolDefinition: ToolDefinition = {
    name: 'web_fetch',
    description: `抓取指定 URL 的网页内容并提取正文。

使用 @mozilla/readability 智能提取文章正文，过滤导航、广告等无关内容。

参数：
- url: 网页 URL（必填）
- extract_text: 是否提取正文（可选，默认 true）。为 false 时返回原始 HTML

返回结果包含：
- title: 页面标题
- content: 正文内容（Markdown 格式）
- url: 原始 URL
- truncated: 是否被截断（内容超过 20000 字符时）

超时 15 秒，失败时返回错误信息。`,
    input_schema: {
        type: 'object',
        properties: {
            url: {
                type: 'string',
                description: '网页 URL，必须以 http:// 或 https:// 开头',
            },
            extract_text: {
                type: 'boolean',
                description: '是否提取正文（默认 true）。为 false 时返回原始 HTML',
            },
        },
        required: ['url'],
    },
};

/**
 * 执行网页抓取
 */
export async function executeWebFetch(
    input: { url: string; extract_text?: boolean },
    context: ToolContext
): Promise<ToolResult> {
    const startTime = Date.now();
    const { url, extract_text = true } = input;

    // 参数校验
    if (!url || url.trim().length === 0) {
        return {
            success: false,
            error: 'URL 不能为空',
            elapsed_ms: 0,
        };
    }

    // URL 格式校验
    const trimmedUrl = url.trim();
    if (!trimmedUrl.startsWith('http://') && !trimmedUrl.startsWith('https://')) {
        return {
            success: false,
            error: 'URL 必须以 http:// 或 https:// 开头',
            elapsed_ms: 0,
        };
    }

    try {
        console.log(`[WebFetch] Fetching: ${trimmedUrl} (extract_text: ${extract_text})`);

        // 设置超时 fetch
        const response = await fetch(trimmedUrl, {
            method: 'GET',
            headers: {
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
                'Accept-Encoding': 'gzip, deflate, br',
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Cache-Control': 'no-cache',
            },
            signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
        });

        if (!response.ok) {
            const errorText = await response.text().catch(() => 'Unknown error');
            console.warn(`[WebFetch] HTTP ${response.status}: ${errorText}`);
            return {
                success: false,
                error: `获取网页失败: HTTP ${response.status} ${response.statusText}`,
                elapsed_ms: Date.now() - startTime,
            };
        }

        // 获取 HTML 内容
        const html = await response.text();

        if (!extract_text) {
            // 不提取正文，直接返回 HTML
            const truncated = html.length > MAX_CONTENT_LENGTH;
            const content = truncated ? html.slice(0, MAX_CONTENT_LENGTH) : html;

            return {
                success: true,
                data: {
                    url: trimmedUrl,
                    html: content,
                    truncated,
                    total_length: html.length,
                },
                truncated,
                elapsed_ms: Date.now() - startTime,
            };
        }

        // 使用 Readability 提取正文
        const result = await extractWithReadability(html, trimmedUrl);

        if (!result.success) {
            // Readability 提取失败，降级返回原始 HTML 片段
            console.warn(`[WebFetch] Readability failed, falling back to raw HTML`);
            const truncated = html.length > MAX_CONTENT_LENGTH;
            const content = truncated ? html.slice(0, MAX_CONTENT_LENGTH) : html;

            return {
                success: true,
                data: {
                    url: trimmedUrl,
                    title: '',
                    content: content,
                    extracted: false,
                    truncated,
                    total_length: html.length,
                    note: '正文提取失败，返回原始 HTML',
                },
                truncated,
                elapsed_ms: Date.now() - startTime,
            };
        }

        // 处理内容截断
        let content = result.content || '';
        let truncated = false;

        if (content.length > MAX_CONTENT_LENGTH) {
            content = content.slice(0, MAX_CONTENT_LENGTH);
            truncated = true;
            console.log(`[WebFetch] Content truncated: ${MAX_CONTENT_LENGTH}/${content.length}`);
        }

        // 转换为 Markdown 格式（简单处理）
        const markdownContent = htmlToMarkdown(content);

        console.log(`[WebFetch] Extracted: "${result.title}" (${content.length} chars)`);

        return {
            success: true,
            data: {
                url: trimmedUrl,
                title: result.title || '',
                content: markdownContent,
                extracted: true,
                truncated,
                total_length: result.content?.length || 0,
            },
            truncated,
            elapsed_ms: Date.now() - startTime,
        };

    } catch (err: any) {
        const elapsed = Date.now() - startTime;

        // 处理超时
        if (err.name === 'AbortError') {
            console.warn(`[WebFetch] Timeout after ${DEFAULT_TIMEOUT_MS}ms`);
            return {
                success: false,
                error: `抓取超时（${DEFAULT_TIMEOUT_MS / 1000}秒）`,
                elapsed_ms: elapsed,
            };
        }

        // 其他错误
        console.error('[WebFetch] Error:', err);
        return {
            success: false,
            error: `抓取失败: ${err.message}`,
            elapsed_ms: elapsed,
        };
    }
}

/**
 * 使用 Readability 提取正文
 */
async function extractWithReadability(html: string, url: string): Promise<{ success: boolean; title?: string; content?: string }> {
    try {
        const { Readability, JSDOM } = await loadReadabilityDeps();

        // 创建 JSDOM 实例
        const dom = new JSDOM(html, {
            url,
            contentType: 'text/html',
            includeNodeLocations: false,
            storageQuota: 10000000, // 10MB 限制
        });

        // 使用 Readability 提取
        const reader = new Readability(dom.window.document);
        const article = reader.parse();

        if (!article) {
            return { success: false };
        }

        // 组合标题和正文
        const title = article.title || '';
        const content = article.textContent || '';

        return {
            success: true,
            title,
            content,
        };
    } catch (err) {
        console.error('[WebFetch] Readability error:', err);
        return { success: false };
    }
}

/**
 * 简单 HTML 转 Markdown
 * 仅做基础转换，保持内容可读性
 */
function htmlToMarkdown(html: string): string {
    if (!html) return '';

    // 已经是纯文本的情况
    if (!html.includes('<')) {
        return html;
    }

    let md = html;

    // 移除 script 和 style 标签及其内容
    md = md.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
    md = md.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');

    // 移除注释
    md = md.replace(/<!--[\s\S]*?-->/g, '');

    // 转换标题
    md = md.replace(/<h1[^>]*>(.*?)<\/h1>/gi, '# $1\n\n');
    md = md.replace(/<h2[^>]*>(.*?)<\/h2>/gi, '## $1\n\n');
    md = md.replace(/<h3[^>]*>(.*?)<\/h3>/gi, '### $1\n\n');
    md = md.replace(/<h4[^>]*>(.*?)<\/h4>/gi, '#### $1\n\n');
    md = md.replace(/<h5[^>]*>(.*?)<\/h5>/gi, '##### $1\n\n');
    md = md.replace(/<h6[^>]*>(.*?)<\/h6>/gi, '###### $1\n\n');

    // 转换段落和换行
    md = md.replace(/<p[^>]*>(.*?)<\/p>/gi, '$1\n\n');
    md = md.replace(/<br\s*\/?>/gi, '\n');

    // 转换链接
    md = md.replace(/<a[^>]+href="([^"]+)"[^>]*>(.*?)<\/a>/gi, '[$2]($1)');

    // 转换图片
    md = md.replace(/<img[^>]+src="([^"]+)"[^>]*alt="([^"]*)"[^>]*>/gi, '![$2]($1)');
    md = md.replace(/<img[^>]+src="([^"]+)"[^>]*>/gi, '![]($1)');

    // 转换粗体和斜体
    md = md.replace(/<(strong|b)[^>]*>(.*?)<\/(strong|b)>/gi, '**$2**');
    md = md.replace(/<(em|i)[^>]*>(.*?)<\/(em|i)>/gi, '*$2*');

    // 转换代码块
    md = md.replace(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi, '```\n$1\n```\n');
    md = md.replace(/<code[^>]*>(.*?)<\/code>/gi, '`$1`');

    // 转换列表
    md = md.replace(/<ul[^>]*>([\s\S]*?)<\/ul>/gi, '$1');
    md = md.replace(/<ol[^>]*>([\s\S]*?)<\/ol>/gi, '$1');
    md = md.replace(/<li[^>]*>(.*?)<\/li>/gi, '- $1\n');

    // 转换引用
    md = md.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, '> $1\n\n');

    // 转换水平线
    md = md.replace(/<hr\s*\/?>/gi, '---\n\n');

    // 移除其他 HTML 标签
    md = md.replace(/<[^>]+>/g, '');

    // 解码 HTML 实体
    md = md.replace(/&nbsp;/g, ' ');
    md = md.replace(/&lt;/g, '<');
    md = md.replace(/&gt;/g, '>');
    md = md.replace(/&amp;/g, '&');
    md = md.replace(/&quot;/g, '"');
    md = md.replace(/&#39;/g, "'");
    md = md.replace(/&mdash;/g, '—');
    md = md.replace(/&ndash;/g, '–');

    // 清理多余空白
    md = md.replace(/\n{3,}/g, '\n\n');
    md = md.trim();

    return md;
}

/**
 * 注册的工具配置
 */
export const webFetchTool = {
    definition: webFetchToolDefinition,
    executor: executeWebFetch,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    riskLevel: 'low' as const,
};
