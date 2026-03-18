/**
 * Note 工具 - 工作区笔记管理
 *
 * 存储路径: 工作区/.notes/{title}.md
 * Frontmatter: tags, created_at, updated_at
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'fs';
import { resolve, join } from 'path';
import { getDb } from '../../db';
import type { ToolDefinition, ToolContext, ToolResult } from './types';

const NOTES_DIR = '.notes';
const MAX_NOTE_SIZE = 50000; // 50KB

/**
 * Frontmatter 类型
 */
interface NoteFrontmatter {
    title: string;
    tags?: string[];
    created_at: string;
    updated_at: string;
}

/**
 * 解析 frontmatter
 */
function parseFrontmatter(content: string): { frontmatter: NoteFrontmatter | null; body: string } {
    const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
    if (!match) {
        return { frontmatter: null, body: content };
    }

    const fmText = match[1];
    const body = match[2];

    const frontmatter: Partial<NoteFrontmatter> = {};
    const lines = fmText.split('\n');

    for (const line of lines) {
        const colonIndex = line.indexOf(':');
        if (colonIndex === -1) continue;

        const key = line.slice(0, colonIndex).trim();
        const value = line.slice(colonIndex + 1).trim();

        if (key === 'tags') {
            // 解析 YAML 数组格式 [tag1, tag2] 或 ['tag1', 'tag2']
            const tagMatch = value.match(/\[(.*)\]/);
            if (tagMatch) {
                frontmatter.tags = tagMatch[1]
                    .split(',')
                    .map(t => t.trim().replace(/^['"]|['"]$/g, ''))
                    .filter(t => t);
            } else {
                frontmatter.tags = [];
            }
        } else {
            (frontmatter as Record<string, any>)[key] = value;
        }
    }

    return { frontmatter: frontmatter as NoteFrontmatter, body };
}

/**
 * 生成 frontmatter
 */
function generateFrontmatter(fm: NoteFrontmatter): string {
    const lines = ['---'];
    lines.push(`title: ${fm.title}`);

    if (fm.tags && fm.tags.length > 0) {
        const tagsStr = fm.tags.map(t => `'${t}'`).join(', ');
        lines.push(`tags: [${tagsStr}]`);
    }

    lines.push(`created_at: ${fm.created_at}`);
    lines.push(`updated_at: ${fm.updated_at}`);
    lines.push('---\n');

    return lines.join('\n');
}

/**
 * 获取工作区根路径
 */
function getWorkspaceRoot(workspaceId: string): { success: boolean; path?: string; error?: string } {
    const db = getDb();
    const workspace = db.prepare('SELECT root_path FROM workspaces WHERE id = ?').get(workspaceId) as
        { root_path: string } | undefined;

    if (!workspace) {
        return { success: false, error: `Workspace ${workspaceId} not found` };
    }

    return { success: true, path: workspace.root_path };
}

/**
 * 获取笔记目录路径
 */
function getNotesDir(workspaceRoot: string): string {
    return join(workspaceRoot, NOTES_DIR);
}

/**
 * 确保笔记目录存在
 */
function ensureNotesDir(workspaceRoot: string): void {
    const notesDir = getNotesDir(workspaceRoot);
    if (!existsSync(notesDir)) {
        mkdirSync(notesDir, { recursive: true });
    }
}

/**
 * 清理标题作为文件名
 */
function sanitizeFilename(title: string): string {
    // 替换非法字符为 -
    return title
        .replace(/[<>:"/\\|?*]/g, '-') // Windows 非法字符
        .replace(/\s+/g, '_') // 空格转下划线
        .replace(/_+/g, '_') // 多个下划线合并
        .replace(/^\.+/, '') // 去除开头的点
        .replace(/\.+$/, '') // 去除结尾的点
        .slice(0, 100) || 'untitled'; // 限制长度
}

/**
 * note_write 工具定义
 */
export const noteWriteToolDefinition: ToolDefinition = {
    name: 'note_write',
    description: '在工作区创建或更新笔记。自动管理 frontmatter（tags、创建时间、更新时间）。如果笔记已存在则更新内容，保留原有创建时间。',
    input_schema: {
        type: 'object',
        properties: {
            title: {
                type: 'string',
                description: '笔记标题，会作为文件名（自动清理非法字符）',
            },
            content: {
                type: 'string',
                description: '笔记正文内容（不含 frontmatter，会自动添加）',
            },
            tags: {
                type: 'array',
                items: { type: 'string' },
                description: '可选的标签数组，如 ["重要", "待办"]',
            },
        },
        required: ['title', 'content'],
    },
};

/**
 * note_read 工具定义
 */
export const noteReadToolDefinition: ToolDefinition = {
    name: 'note_read',
    description: '读取工作区内的笔记。返回笔记的完整内容，包括解析后的 frontmatter 和正文。',
    input_schema: {
        type: 'object',
        properties: {
            title: {
                type: 'string',
                description: '笔记标题，对应 .notes/{title}.md 文件',
            },
        },
        required: ['title'],
    },
};

/**
 * note_search 工具定义
 */
export const noteSearchToolDefinition: ToolDefinition = {
    name: 'note_search',
    description: '在工作区笔记目录中全文搜索。搜索标题、tags 和内容，返回匹配的笔记列表。',
    input_schema: {
        type: 'object',
        properties: {
            query: {
                type: 'string',
                description: '搜索关键词，不区分大小写',
            },
            limit: {
                type: 'number',
                description: '返回结果数量上限，默认 10',
            },
        },
        required: ['query'],
    },
};

/**
 * 执行写入笔记
 */
export function executeNoteWrite(
    input: { title: string; content: string; tags?: string[] },
    context: ToolContext
): ToolResult {
    const startTime = Date.now();
    const { title, content, tags = [] } = input;
    const { workspaceId } = context;

    const ws = getWorkspaceRoot(workspaceId);
    if (!ws.success) {
        return { success: false, error: ws.error, elapsed_ms: Date.now() - startTime };
    }

    ensureNotesDir(ws.path!);

    const filename = sanitizeFilename(title);
    const notePath = join(getNotesDir(ws.path!), `${filename}.md`);

    const now = new Date().toISOString();
    let createdAt = now;

    // 检查是否已存在
    const existed = existsSync(notePath);
    if (existed) {
        try {
            const existingContent = readFileSync(notePath, 'utf8');
            const parsed = parseFrontmatter(existingContent);
            if (parsed.frontmatter?.created_at) {
                createdAt = parsed.frontmatter.created_at;
            }
        } catch (e) {
            // 解析失败，使用新的创建时间
        }
    }

    const frontmatter: NoteFrontmatter = {
        title,
        tags,
        created_at: createdAt,
        updated_at: now,
    };

    const fullContent = generateFrontmatter(frontmatter) + content;

    try {
        writeFileSync(notePath, fullContent, 'utf8');

        console.log(`[NoteTool] ${existed ? 'Updated' : 'Created'}: ${title} (${filename}.md)`);

        return {
            success: true,
            data: {
                title,
                filename: `${filename}.md`,
                created: !existed,
                updated: existed,
                tags,
                created_at: createdAt,
                updated_at: now,
                content_length: content.length,
            },
            elapsed_ms: Date.now() - startTime,
        };
    } catch (err: any) {
        return {
            success: false,
            error: `Failed to write note: ${err.message}`,
            elapsed_ms: Date.now() - startTime,
        };
    }
}

/**
 * 执行读取笔记
 */
export function executeNoteRead(
    input: { title: string },
    context: ToolContext
): ToolResult {
    const startTime = Date.now();
    const { title } = input;
    const { workspaceId } = context;

    const ws = getWorkspaceRoot(workspaceId);
    if (!ws.success) {
        return { success: false, error: ws.error, elapsed_ms: Date.now() - startTime };
    }

    const filename = sanitizeFilename(title);
    const notePath = join(getNotesDir(ws.path!), `${filename}.md`);

    if (!existsSync(notePath)) {
        return {
            success: false,
            error: `Note not found: ${title} (looking for ${filename}.md)`,
            elapsed_ms: Date.now() - startTime,
        };
    }

    try {
        const fullContent = readFileSync(notePath, 'utf8');
        const parsed = parseFrontmatter(fullContent);

        const truncated = fullContent.length > MAX_NOTE_SIZE;
        const displayBody = parsed.body.length > MAX_NOTE_SIZE
            ? parsed.body.slice(0, MAX_NOTE_SIZE) + '\n[内容已截断，超过 50KB]'
            : parsed.body;

        return {
            success: true,
            data: {
                title,
                filename: `${filename}.md`,
                frontmatter: parsed.frontmatter,
                content: displayBody,
                full_content: truncated ? undefined : fullContent,
                size: fullContent.length,
                truncated,
            },
            truncated,
            elapsed_ms: Date.now() - startTime,
        };
    } catch (err: any) {
        return {
            success: false,
            error: `Failed to read note: ${err.message}`,
            elapsed_ms: Date.now() - startTime,
        };
    }
}

/**
 * 执行搜索笔记
 */
export function executeNoteSearch(
    input: { query: string; limit?: number },
    context: ToolContext
): ToolResult {
    const startTime = Date.now();
    const { query, limit = 10 } = input;
    const { workspaceId } = context;

    const ws = getWorkspaceRoot(workspaceId);
    if (!ws.success) {
        return { success: false, error: ws.error, elapsed_ms: Date.now() - startTime };
    }

    const notesDir = getNotesDir(ws.path!);

    if (!existsSync(notesDir)) {
        return {
            success: true,
            data: {
                query,
                results: [],
                total: 0,
            },
            elapsed_ms: Date.now() - startTime,
        };
    }

    const searchTerm = query.toLowerCase();
    const results: Array<{
        title: string;
        filename: string;
        tags: string[];
        created_at: string;
        updated_at: string;
        matched_in: ('title' | 'tags' | 'content')[];
        preview: string;
    }> = [];

    try {
        const files = readdirSync(notesDir).filter(f => f.endsWith('.md'));

        for (const filename of files) {
            const filePath = join(notesDir, filename);
            const stat = statSync(filePath);

            if (!stat.isFile()) continue;

            try {
                const fullContent = readFileSync(filePath, 'utf8');
                const parsed = parseFrontmatter(fullContent);

                const title = parsed.frontmatter?.title || filename.replace('.md', '');
                const tags = parsed.frontmatter?.tags || [];
                const body = parsed.body;

                const matchedIn: ('title' | 'tags' | 'content')[] = [];

                // 检查标题匹配
                if (title.toLowerCase().includes(searchTerm)) {
                    matchedIn.push('title');
                }

                // 检查 tags 匹配
                if (tags.some(t => t.toLowerCase().includes(searchTerm))) {
                    matchedIn.push('tags');
                }

                // 检查内容匹配
                const contentMatched = body.toLowerCase().includes(searchTerm);
                if (contentMatched) {
                    matchedIn.push('content');
                }

                if (matchedIn.length === 0) continue;

                // 生成预览（显示匹配内容附近）
                let preview = '';
                if (contentMatched) {
                    const index = body.toLowerCase().indexOf(searchTerm);
                    const start = Math.max(0, index - 50);
                    const end = Math.min(body.length, index + searchTerm.length + 50);
                    preview = (start > 0 ? '...' : '') + body.slice(start, end) + (end < body.length ? '...' : '');
                } else {
                    preview = body.slice(0, 100) + (body.length > 100 ? '...' : '');
                }

                results.push({
                    title,
                    filename,
                    tags,
                    created_at: parsed.frontmatter?.created_at || '',
                    updated_at: parsed.frontmatter?.updated_at || '',
                    matched_in: matchedIn,
                    preview,
                });

                if (results.length >= limit) break;
            } catch (e) {
                // 跳过无法读取的文件
                continue;
            }
        }

        // 按更新时间排序（最新的在前）
        results.sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());

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
        return {
            success: false,
            error: `Failed to search notes: ${err.message}`,
            elapsed_ms: Date.now() - startTime,
        };
    }
}

/**
 * 注册的工具配置
 */
export const noteWriteTool = {
    definition: noteWriteToolDefinition,
    executor: executeNoteWrite,
    riskLevel: 'low' as const,
};

export const noteReadTool = {
    definition: noteReadToolDefinition,
    executor: executeNoteRead,
    riskLevel: 'low' as const,
};

export const noteSearchTool = {
    definition: noteSearchToolDefinition,
    executor: executeNoteSearch,
    riskLevel: 'low' as const,
};
