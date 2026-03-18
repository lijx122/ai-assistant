import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import { getDb } from '../db';
import { getConfig } from '../config';

export interface WorkspaceConfig {
    identity: string;
    user: string;
    tools: string;
}

export interface WorkspaceConfigFiles {
    identity: string | null;  // IDENTITY.md content or null if not exists
    user: string | null;      // USER.md content or null if not exists
    tools: string | null;     // TOOLS.md content or null if not exists
}

const CONFIG_FILES = {
    identity: 'IDENTITY.md',
    user: 'USER.md',
    tools: 'TOOLS.md',
} as const;

/**
 * 获取工作区根目录路径
 */
export function getWorkspaceRootPath(workspaceId: string): string {
    const db = getDb();
    const workspace = db.prepare('SELECT root_path FROM workspaces WHERE id = ?').get(workspaceId) as { root_path: string } | undefined;

    if (!workspace?.root_path) {
        // Fallback: use default workspace path under dataDir
        const cfg = getConfig();
        return resolve(cfg.dataDir, 'workspaces', workspaceId);
    }

    return workspace.root_path;
}

/**
 * 加载工作区配置文件内容
 * 文件不存在时返回 null，不报错
 */
export function loadWorkspaceConfigFiles(workspaceId: string): WorkspaceConfigFiles {
    const rootPath = getWorkspaceRootPath(workspaceId);

    const readFile = (filename: string): string | null => {
        const filePath = resolve(rootPath, filename);
        try {
            if (!existsSync(filePath)) {
                return null;
            }
            return readFileSync(filePath, 'utf8');
        } catch (err) {
            console.warn(`[WorkspaceConfig] Failed to read ${filename}:`, err);
            return null;
        }
    };

    return {
        identity: readFile(CONFIG_FILES.identity),
        user: readFile(CONFIG_FILES.user),
        tools: readFile(CONFIG_FILES.tools),
    };
}

/**
 * 构建用于注入 system prompt 的配置内容
 * 按顺序拼接 IDENTITY.md + USER.md + TOOLS.md
 * 文件不存在时跳过
 */
export function buildWorkspaceConfigPrompt(workspaceId: string): string {
    const files = loadWorkspaceConfigFiles(workspaceId);
    const parts: string[] = [];

    if (files.identity) {
        parts.push('## 角色定位\n' + files.identity);
    }

    if (files.user) {
        parts.push('## 用户偏好\n' + files.user);
    }

    if (files.tools) {
        parts.push('## 可用工具\n' + files.tools);
    }

    if (parts.length === 0) {
        return '';
    }

    return '--- 工作区配置 ---\n' + parts.join('\n\n') + '\n---\n';
}

/**
 * 保存工作区配置文件
 */
export function saveWorkspaceConfigFile(
    workspaceId: string,
    fileType: keyof WorkspaceConfigFiles,
    content: string
): void {
    const rootPath = getWorkspaceRootPath(workspaceId);

    // Ensure directory exists
    if (!existsSync(rootPath)) {
        mkdirSync(rootPath, { recursive: true });
    }

    const filename = CONFIG_FILES[fileType];
    const filePath = resolve(rootPath, filename);

    try {
        writeFileSync(filePath, content, 'utf8');
    } catch (err) {
        console.error(`[WorkspaceConfig] Failed to write ${filename}:`, err);
        throw new Error(`Failed to save ${filename}: ${err}`);
    }
}

/**
 * 获取工作区配置文件路径（用于编辑器打开）
 */
export function getWorkspaceConfigFilePath(
    workspaceId: string,
    fileType: keyof WorkspaceConfigFiles
): string {
    const rootPath = getWorkspaceRootPath(workspaceId);
    return resolve(rootPath, CONFIG_FILES[fileType]);
}
