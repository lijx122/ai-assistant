/**
 * read_skill 工具 - 按需读取技能文档
 *
 * 文档来源：.skills/{name}/SKILL.md（扁平目录结构，对齐 Claude Code 官方格式）
 */

import { getSkill, listSkills } from '../skill-loader';
import type { ToolDefinition, ToolContext, ToolResult } from './types';

/**
 * read_skill 工具定义
 */
export const readSkillToolDefinition: ToolDefinition = {
    name: 'read_skill',
    description: `读取指定技能文档（SKILL.md），获取该类工具的完整参数说明、返回值结构、适用场景和注意事项。
遇到不熟悉的工具时，应先调用此工具获取详细指南，再执行具体操作。
参数 name 为技能名称，如 "tools-search-research"、"tools-code"、"claude-code"。`,
    input_schema: {
        type: 'object',
        properties: {
            name: {
                type: 'string',
                description: '技能名称（目录名），如 "tools-search-research"、"tools-code"、"claude-code"',
            },
        },
        required: ['name'],
    },
};

/**
 * 执行 read_skill
 */
export function executeReadSkill(
    input: { name?: string },
    context: ToolContext
): ToolResult {
    const startTime = Date.now();
    const name = (input.name || '').trim();

    if (!name) {
        const all = listSkills();
        return {
            success: false,
            error: 'name 参数不能为空',
            data: { available: all },
            elapsed_ms: Date.now() - startTime,
        };
    }

    const skill = getSkill(name);

    if (!skill) {
        const all = listSkills();
        return {
            success: false,
            error: `Skill "${name}" not found`,
            data: {
                available: all,
                hint: `可用 skills（共 ${all.length} 个）：\n${all.map(s => `  • ${s.name}：${s.description}`).join('\n')}`,
            },
            elapsed_ms: Date.now() - startTime,
        };
    }

    return {
        success: true,
        data: {
            name: skill.name,
            description: skill.description,
            whenToUse: skill.whenToUse,
            allowedTools: skill.allowedTools,
            content: skill.content,
            length: skill.content.length,
            loadedFrom: skill.loadedFrom,
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
