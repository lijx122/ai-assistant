/**
 * Skill Loader - 对齐 Claude Code 官方 .claude/skills/ 目录结构
 *
 * 从 .skills/ 目录加载所有 SKILL.md 文件，支持扁平命名格式。
 * 每个 skill 对应一个目录，目录名即 skill 名，SKILL.md 为主文件。
 *
 * @module src/services/skill-loader
 */

import { join, resolve } from 'path';
import { existsSync, readdirSync, readFileSync } from 'fs';

/**
 * Skill 定义
 */
export interface SkillDefinition {
    name: string;               // skill 名称（目录名）
    description: string;        // 一句话描述（from frontmatter）
    whenToUse?: string;         // 触发时机（from frontmatter）
    allowedTools?: string[];    // 允许使用的工具（from frontmatter）
    content: string;            // SKILL.md 正文（frontmatter 之后）
    frontmatter: Record<string, any>;
    skillDir: string;           // 技能目录路径
    loadedFrom: 'skills-dir' | 'bundled';
}

/**
 * skills 根目录查找策略：
 * 1. 项目根目录的 .skills/（生产/运行时）
 * 2. src/skills/（开发时兼容）
 */
function getSkillsRoot(): string {
    // 优先 .skills/（与 .claude/skills/ 对齐）
    const root1 = resolve(process.cwd(), '.skills');
    if (existsSync(root1)) return root1;

    // 兜底 src/skills（开发兼容）
    const root2 = resolve(process.cwd(), 'src', 'skills');
    if (existsSync(root2)) return root2;

    return root1; // 返回 .skills 路径（即使不存在，后续会跳过）
}

/**
 * 解析 YAML frontmatter
 */
function parseFrontmatter(raw: string): { frontmatter: Record<string, any>; content: string } {
    const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
    if (!match) return { frontmatter: {}, content: raw };

    const fm: Record<string, any> = {};
    for (const line of match[1].split('\n')) {
        const colonIdx = line.indexOf(':');
        if (colonIdx === -1) continue;
        const key = line.slice(0, colonIdx).trim();
        let value: any = line.slice(colonIdx + 1).trim();

        if (!key) continue;

        // 简单解析数组：[a, b, c]
        if (value.startsWith('[') && value.endsWith(']')) {
            value = value
                .slice(1, -1)
                .split(',')
                .map((s: string) => s.trim())
                .filter(Boolean);
        }

        fm[key] = value;
    }

    return { frontmatter: fm, content: match[2].trim() };
}

/**
 * 加载所有 skills（memoized，避免重复扫描）
 */
let _cache: Map<string, SkillDefinition> | null = null;
let _loadedFrom: 'skills-dir' | 'bundled' | null = null;

export function loadAllSkills(bust = false): Map<string, SkillDefinition> {
    if (_cache && !bust) return _cache;

    _cache = new Map();
    const root = getSkillsRoot();

    if (!existsSync(root)) {
        console.log('[SkillLoader] No .skills/ directory found, skipping');
        return _cache;
    }

    for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;

        const skillMdPath = join(root, entry.name, 'SKILL.md');
        if (!existsSync(skillMdPath)) continue;

        let raw: string;
        try {
            raw = readFileSync(skillMdPath, 'utf-8');
        } catch {
            console.warn(`[SkillLoader] Failed to read ${skillMdPath}`);
            continue;
        }

        const { frontmatter, content } = parseFrontmatter(raw);

        const skill: SkillDefinition = {
            name: frontmatter.name || entry.name,
            description: frontmatter.description || '',
            whenToUse: frontmatter.when_to_use,
            allowedTools: frontmatter.allowed_tools,
            content,
            frontmatter,
            skillDir: join(root, entry.name),
            loadedFrom: _loadedFrom || 'skills-dir',
        };

        _cache.set(skill.name, skill);
    }

    console.log(
        `[SkillLoader] Loaded ${_cache.size} skills from ${root}: ${[..._cache.keys()].sort().join(', ')}`
    );

    return _cache;
}

/**
 * 清除缓存（开发模式下 skill 文件变更时调用）
 */
export function clearSkillCache(): void {
    _cache = null;
}

/**
 * 获取单个 skill
 */
export function getSkill(name: string): SkillDefinition | null {
    const skills = loadAllSkills();
    return skills.get(name) || null;
}

/**
 * 列出所有 skill（名称 + 描述，用于 system prompt）
 */
export function listSkills(): Array<{
    name: string;
    description: string;
    whenToUse?: string;
    allowedTools?: string[];
}> {
    return [...loadAllSkills().values()].map(s => ({
        name: s.name,
        description: s.description,
        whenToUse: s.whenToUse,
        allowedTools: s.allowedTools,
    }));
}
