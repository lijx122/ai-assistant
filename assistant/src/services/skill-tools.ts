/**
 * Skill Tools - 统一导出 skill 相关功能（兼容旧接口）
 *
 * @deprecated 请直接使用 src/services/skill-loader.ts
 */

import {
    getSkill as _getSkill,
    listSkills as _listSkills,
    loadAllSkills,
    clearSkillCache,
    type SkillDefinition,
} from './skill-loader';

export type { SkillDefinition };
export { loadAllSkills, clearSkillCache };

export function getSkillFilePath(workspaceId: string, skillName: string): string | null {
    // 兼容旧接口：workspaceId 参数不再需要（统一使用 .skills/）
    const skill = _getSkill(skillName);
    return skill?.skillDir ? `${skill.skillDir}/SKILL.md` : null;
}

export function readSkillFile(workspaceId: string, skillName: string): string | null {
    const skill = _getSkill(skillName);
    return skill?.content || null;
}

export function listAvailableSkills(workspaceId: string): string[] {
    return _listSkills().map(s => s.name);
}

export const readSkillToolDefinition = require('./tools/skill').readSkillToolDefinition;

export function executeReadSkill(args: { name: string }, context: any): any {
    return require('./tools/skill').executeReadSkill(args, context);
}
