import {
    getSkillFilePath as unifiedGetSkillFilePath,
    readSkillFile as unifiedReadSkillFile,
    listAvailableSkills as unifiedListAvailableSkills,
    executeReadSkill as unifiedExecuteReadSkill,
    readSkillToolDefinition as unifiedReadSkillToolDefinition,
} from './tools/skill';
import { getWorkspaceRootPath } from './workspace-config';

export function getSkillFilePath(workspaceId: string, skillName: string): string | null {
    return unifiedGetSkillFilePath(workspaceId, skillName);
}

export function readSkillFile(workspaceId: string, skillName: string): string | null {
    return unifiedReadSkillFile(workspaceId, skillName);
}

export function listAvailableSkills(workspaceId: string): string[] {
    return unifiedListAvailableSkills(workspaceId);
}

export const readSkillToolDefinition = unifiedReadSkillToolDefinition;

export function executeReadSkill(workspaceId: string, args: { name: string }): {
    success: boolean;
    content: string;
    source: 'workspace' | 'global' | 'not_found';
} {
    const result = unifiedExecuteReadSkill(args, { workspaceId });
    if (!result.success) {
        return {
            success: false,
            content: result.error || `Failed to read skill "${args.name}"`,
            source: 'not_found',
        };
    }

    const filePath = unifiedGetSkillFilePath(workspaceId, args.name);
    const workspaceRoot = getWorkspaceRootPath(workspaceId);
    const source: 'workspace' | 'global' = filePath?.startsWith(workspaceRoot) ? 'workspace' : 'global';

    return {
        success: true,
        content: result.data?.content || '',
        source,
    };
}
