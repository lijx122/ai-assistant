/**
 * Web Fetch 工具 - 获取网页并提取正文
 *
 * @module src/services/tools/web-fetch
 */

import type { ToolDefinition, ToolContext, ToolResult } from './types';

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_MAX_CHARS = 3000;
const MAX_ALLOWED_CHARS = 20000;

type ReadabilityCtor = new (doc: Document) => {
    parse: () => {
        title?: string;
        textContent?: string;
        byline?: string;
        publishedTime?: string;
    } | null;
};

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

            const Readability = readabilityModule?.Readability || readabilityModule?.default?.Readability || readabilityModule?.default;
            const JSDOM = jsdomModule?.JSDOM || jsdomModule?.default?.JSDOM || jsdomModule?.default;

            if (!Readability || !JSDOM) {
                throw new Error('Readability/JSDOM 模块加载失败');
            }

            return { Readability, JSDOM };
        })();
    }

    return readabilityDepsPromise;
}

export const webFetchToolDefinition: ToolDefinition = {
    name: 'web_fetch',
    description: `获取网页内容，自动提取正文，过滤广告和导航栏。
适用于：阅读文章、查看文档、获取网页具体内容。
不适用于：需要登录的页面、动态渲染的 SPA。
返回：标题、正文（≤3000字）、发布时间（如有）、原始URL。`,
    input_schema: {
        type: 'object',
        properties: {
            url: {
                type: 'string',
                description: '要获取的网页地址',
            },
            max_chars: {
                type: 'number',
                description: '最大返回字符数，默认 3000',
            },
        },
        required: ['url'],
    },
};

export async function executeWebFetch(
    input: { url: string; max_chars?: number },
    context: ToolContext
): Promise<ToolResult> {
    const startTime = Date.now();
    const { url } = input;
    const maxChars = Math.min(Math.max(1, input.max_chars ?? DEFAULT_MAX_CHARS), MAX_ALLOWED_CHARS);

    if (!url || typeof url !== 'string' || url.trim().length === 0) {
        return {
            success: false,
            error: 'URL 不能为空',
            elapsed_ms: Date.now() - startTime,
        };
    }

    const normalizedUrl = url.trim();
    if (!normalizedUrl.startsWith('http://') && !normalizedUrl.startsWith('https://')) {
        return {
            success: false,
            error: 'URL 必须以 http:// 或 https:// 开头',
            elapsed_ms: Date.now() - startTime,
        };
    }

    try {
        const response = await fetch(normalizedUrl, {
            method: 'GET',
            headers: {
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            },
            signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
        });

        if (!response.ok) {
            return {
                success: false,
                error: `获取网页失败: HTTP ${response.status} ${response.statusText}`,
                elapsed_ms: Date.now() - startTime,
            };
        }

        const contentType = response.headers.get('content-type') || '';
        if (!contentType.toLowerCase().includes('text/html')) {
            return {
                success: false,
                error: '不支持的内容类型',
                elapsed_ms: Date.now() - startTime,
            };
        }

        const html = await response.text();
        const extracted = await extractArticle(html, normalizedUrl);

        if (!extracted.success) {
            const plainText = htmlToPlainText(html);
            const content = plainText.slice(0, maxChars);

            return {
                success: true,
                data: {
                    url: normalizedUrl,
                    title: '',
                    content,
                    byline: '',
                    publishedTime: '',
                    length: content.length,
                },
                truncated: plainText.length > maxChars,
                elapsed_ms: Date.now() - startTime,
            };
        }

        const content = (extracted.content || '').slice(0, maxChars);

        return {
            success: true,
            data: {
                url: normalizedUrl,
                title: extracted.title || '',
                content,
                byline: extracted.byline || '',
                publishedTime: extracted.publishedTime || '',
                length: content.length,
            },
            truncated: (extracted.content || '').length > maxChars,
            elapsed_ms: Date.now() - startTime,
        };
    } catch (err: any) {
        if (err?.name === 'AbortError') {
            return {
                success: false,
                error: '请求超时',
                elapsed_ms: Date.now() - startTime,
            };
        }

        return {
            success: false,
            error: `抓取失败: ${err.message}`,
            elapsed_ms: Date.now() - startTime,
        };
    }
}

async function extractArticle(html: string, url: string): Promise<{
    success: boolean;
    title?: string;
    content?: string;
    byline?: string;
    publishedTime?: string;
}> {
    try {
        const { Readability, JSDOM } = await loadReadabilityDeps();
        const dom = new JSDOM(html, {
            url,
            contentType: 'text/html',
            includeNodeLocations: false,
            storageQuota: 10000000,
        });

        const reader = new Readability(dom.window.document);
        const article = reader.parse();

        if (!article) {
            return { success: false };
        }

        return {
            success: true,
            title: article.title || '',
            content: normalizeText(article.textContent || ''),
            byline: article.byline || '',
            publishedTime: article.publishedTime || '',
        };
    } catch {
        return { success: false };
    }
}

function htmlToPlainText(html: string): string {
    return normalizeText(
        html
            .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
            .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
            .replace(/<[^>]+>/g, ' ')
            .replace(/&nbsp;/g, ' ')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&amp;/g, '&')
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
    );
}

function normalizeText(text: string): string {
    return text.replace(/\s+/g, ' ').trim();
}

export const webFetchTool = {
    definition: webFetchToolDefinition,
    executor: executeWebFetch,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    riskLevel: 'low' as const,
};
