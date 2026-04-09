/**
 * Skill 工具 - 按需读取技能文档
 */

import { readFileSync, existsSync, readdirSync } from 'fs';
import { isAbsolute, resolve } from 'path';
import { getWorkspaceRootPath } from '../workspace-config';
import { getConfig } from '../../config';
import type { ToolDefinition, ToolContext, ToolResult } from './types';

/**
 * 获取技能文件路径
 * 优先查找工作区 skills，不存在则查 scripts/skills，然后查 src/skills
 *
 * 支持子目录路径格式，例如：
 * - "git"         → skills/git.md
 * - "tools/code"  → skills/tools/code.md
 */
export function getSkillFilePath(workspaceId: string, skillName: string): string | null {
    // 去除 .md 后缀，统一处理
    const normalizedName = skillName.endsWith('.md') ? skillName.slice(0, -3) : skillName;
    const { workspaceDirs, globalDirs } = getSkillScanDirs(workspaceId);

    // 路径片段：支持 "tools/code" 这种带 / 的格式
    const pathParts = normalizedName.split('/');

    // workspace 目录优先（覆盖全局）
    for (const dir of workspaceDirs) {
        // 优先查找：dir/tools/code.md → dir/tools/code.md
        const filePath = resolve(dir, ...pathParts) + '.md';
        if (existsSync(filePath)) {
            return filePath;
        }
        // 备选：dir/tools/code/SKILL.md
        const altPath = resolve(dir, ...pathParts, 'SKILL.md');
        if (existsSync(altPath)) {
            return altPath;
        }
    }

    for (const dir of globalDirs) {
        const filePath = resolve(dir, ...pathParts) + '.md';
        if (existsSync(filePath)) {
            return filePath;
        }
        const altPath = resolve(dir, ...pathParts, 'SKILL.md');
        if (existsSync(altPath)) {
            return altPath;
        }
    }

    return null;
}

/**
 * 读取技能文件内容
 */
export function readSkillFile(workspaceId: string, skillName: string): string | null {
    const filePath = getSkillFilePath(workspaceId, skillName);

    if (!filePath) {
        return null;
    }

    try {
        return readFileSync(filePath, 'utf8');
    } catch (err) {
        console.warn(`[SkillTools] Failed to read skill ${skillName}:`, err);
        return null;
    }
}

/**
 * 列出所有可用技能
 */
export function listAvailableSkills(workspaceId: string): string[] {
    const skills = new Set<string>();
    const { workspaceDirs, globalDirs } = getSkillScanDirs(workspaceId);

    const readDirSkills = (dir: string) => {
        if (existsSync(dir)) {
            readdirSync(dir)
                .filter(f => f.endsWith('.md'))
                .forEach(f => skills.add(f.replace('.md', '')));
        }
    };

    // 全局目录先扫，再扫 workspace（名称层面保持去重）
    for (const dir of globalDirs) {
        readDirSkills(dir);
    }
    for (const dir of workspaceDirs) {
        readDirSkills(dir);
    }

    return Array.from(skills).sort();
}

/**
 * 提取所有可用技能并解析一句话摘要
 */
export function getSkillCatalog(workspaceId: string): string {
    const availableSkills = listAvailableSkills(workspaceId);
    if (availableSkills.length === 0) return '';
    const config = getConfig();
    const maxLen = config.skills.catalog_max_summary_chars;

    const catalog: string[] = [];
    for (const name of availableSkills) {
        const content = readSkillFile(workspaceId, name);
        if (!content) continue;

        let summary = extractSkillSummary(content);
        if (summary.length > maxLen) {
            summary = summary.slice(0, maxLen) + '...';
        }

        catalog.push(`- ${name}：${summary}`);
    }

    return catalog.join('\n');
}

function getSkillScanDirs(workspaceId: string): { workspaceDirs: string[]; globalDirs: string[] } {
    const config = getConfig();
    const workspaceRoot = getWorkspaceRootPath(workspaceId);

    const workspaceDirs = dedupeDirs(
        (config.skills.workspace_dirs || ['skills']).map(dir => resolve(workspaceRoot, dir))
    );

    const globalDirs = dedupeDirs(
        (config.skills.global_dirs || ['scripts/skills', 'src/skills']).map(dir =>
            isAbsolute(dir) ? resolve(dir) : resolve(process.cwd(), dir)
        )
    );

    return { workspaceDirs, globalDirs };
}

function dedupeDirs(dirs: string[]): string[] {
    const seen = new Set<string>();
    const result: string[] = [];

    for (const dir of dirs) {
        const normalized = resolve(dir);
        if (!seen.has(normalized)) {
            seen.add(normalized);
            result.push(normalized);
        }
    }

    return result;
}

function extractSkillSummary(content: string): string {
    const frontmatter = parseFrontmatter(content);
    const description = frontmatter?.description?.trim();
    if (description) return description;

    const lines = content.split('\n').map(l => l.trim()).filter(Boolean);
    for (const line of lines) {
        if (line.startsWith('---')) continue;
        if (line.startsWith('#')) {
            return line.replace(/^#+\s*/, '').trim() || '未提供描述';
        }
        if (!line.startsWith('|') && !line.startsWith('```')) {
            return line;
        }
    }

    return '未提供描述';
}

function parseFrontmatter(content: string): Record<string, string> | null {
    if (!content.startsWith('---\n') && !content.startsWith('---\r\n')) {
        return null;
    }

    const lines = content.split(/\r?\n/);
    if (lines[0].trim() !== '---') {
        return null;
    }

    let end = -1;
    for (let i = 1; i < lines.length; i++) {
        if (lines[i].trim() === '---') {
            end = i;
            break;
        }
    }

    if (end === -1) {
        return null;
    }

    const result: Record<string, string> = {};
    for (let i = 1; i < end; i++) {
        const line = lines[i].trim();
        if (!line || line.startsWith('#')) continue;
        const sep = line.indexOf(':');
        if (sep === -1) continue;
        const key = line.slice(0, sep).trim();
        const rawValue = line.slice(sep + 1).trim();
        if (!key) continue;
        result[key] = rawValue.replace(/^["']|["']$/g, '').trim();
    }

    return result;
}

/**
 * read_skill 工具定义
 */
export const readSkillToolDefinition: ToolDefinition = {
    name: 'read_skill',
    description: 'Read a skill documentation file by name. Skills are markdown files that provide guidance on specific tasks. Workspace-specific skills override global skills with the same name.',
    input_schema: {
        type: 'object',
        properties: {
            name: {
                type: 'string',
                description: 'Name of the skill to read (e.g., "git", "deploy", "debug-node")',
            },
        },
        required: ['name'],
    },
};

/**
 * 执行 read_skill
 */
export function executeReadSkill(input: { name: string }, context: ToolContext): ToolResult {
    const startTime = Date.now();
    const { name } = input;
    const { workspaceId } = context;

    const content = readSkillFile(workspaceId, name);

    if (content === null) {
        const availableSkills = listAvailableSkills(workspaceId);
        return {
            success: false,
            error: `Skill "${name}" not found. Available skills: ${availableSkills.join(', ') || 'none'}`,
            elapsed_ms: Date.now() - startTime,
        };
    }

    return {
        success: true,
        data: {
            name,
            content,
            length: content.length,
        },
        elapsed_ms: Date.now() - startTime,
    };
}

/**
 * 注册的工具配置
 */
export const readSkillTool = {
    definition: readSkillToolDefinition,
    executor: executeReadSkill,
    riskLevel: 'low' as const,
};
