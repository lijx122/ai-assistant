import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, unlinkSync } from 'fs';
import { resolve } from 'path';
import {
    loadWorkspaceConfigFiles,
    buildWorkspaceConfigPrompt,
    saveWorkspaceConfigFile,
    getWorkspaceRootPath,
    getWorkspaceConfigFilePath,
} from '../src/services/workspace-config';
import { getDb, initDb, closeDb } from '../src/db';
import { randomUUID } from 'crypto';

const testDbPath = resolve(__dirname, 'test-workspace-config.db');

// Helper to create a test workspace
function createTestWorkspace(name: string = 'Test Workspace') {
    const db = getDb();
    const id = randomUUID();
    const rootPath = resolve(process.cwd(), 'data', 'workspaces', `test-${id}`);

    if (!existsSync(rootPath)) {
        mkdirSync(rootPath, { recursive: true });
    }

    db.prepare(
        'INSERT INTO workspaces (id, user_id, name, description, root_path, created_at, last_active_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(id, 'owner', name, '', rootPath, Date.now(), Date.now());

    return { id, rootPath };
}

// Helper to cleanup test workspace
function cleanupTestWorkspace(id: string, rootPath: string) {
    const db = getDb();
    db.prepare('DELETE FROM workspaces WHERE id = ?').run(id);
    if (existsSync(rootPath)) {
        rmSync(rootPath, { recursive: true, force: true });
    }
}

describe('Workspace Config (T-2.5)', () => {
    beforeEach(() => {
        // Clean up any existing test database
        if (existsSync(testDbPath)) unlinkSync(testDbPath);
        if (existsSync(testDbPath + '-wal')) unlinkSync(testDbPath + '-wal');
        if (existsSync(testDbPath + '-shm')) unlinkSync(testDbPath + '-shm');
        initDb(testDbPath);
    });

    afterEach(() => {
        closeDb();
        // Clean up test database
        if (existsSync(testDbPath)) unlinkSync(testDbPath);
        if (existsSync(testDbPath + '-wal')) unlinkSync(testDbPath + '-wal');
        if (existsSync(testDbPath + '-shm')) unlinkSync(testDbPath + '-shm');
    });

    describe('loadWorkspaceConfigFiles', () => {
        it('should return null for all files when workspace has no config files', () => {
            const { id, rootPath } = createTestWorkspace();

            try {
                const config = loadWorkspaceConfigFiles(id);

                expect(config.identity).toBeNull();
                expect(config.user).toBeNull();
                expect(config.tools).toBeNull();
            } finally {
                cleanupTestWorkspace(id, rootPath);
            }
        });

        it('should read IDENTITY.md when it exists', () => {
            const { id, rootPath } = createTestWorkspace();

            try {
                writeFileSync(resolve(rootPath, 'IDENTITY.md'), 'You are a helpful coding assistant.', 'utf8');

                const config = loadWorkspaceConfigFiles(id);

                expect(config.identity).toBe('You are a helpful coding assistant.');
                expect(config.user).toBeNull();
                expect(config.tools).toBeNull();
            } finally {
                cleanupTestWorkspace(id, rootPath);
            }
        });

        it('should read all three config files when they exist', () => {
            const { id, rootPath } = createTestWorkspace();

            try {
                writeFileSync(resolve(rootPath, 'IDENTITY.md'), 'Identity content', 'utf8');
                writeFileSync(resolve(rootPath, 'USER.md'), 'User preferences', 'utf8');
                writeFileSync(resolve(rootPath, 'TOOLS.md'), 'Available tools', 'utf8');

                const config = loadWorkspaceConfigFiles(id);

                expect(config.identity).toBe('Identity content');
                expect(config.user).toBe('User preferences');
                expect(config.tools).toBe('Available tools');
            } finally {
                cleanupTestWorkspace(id, rootPath);
            }
        });

        it('should handle non-existent workspace gracefully', () => {
            const config = loadWorkspaceConfigFiles('non-existent-id');

            // Falls back to default path which doesn't have config files
            expect(config.identity).toBeNull();
            expect(config.user).toBeNull();
            expect(config.tools).toBeNull();
        });
    });

    describe('buildWorkspaceConfigPrompt', () => {
        it('should return empty string when no config files exist', () => {
            const { id, rootPath } = createTestWorkspace();

            try {
                const prompt = buildWorkspaceConfigPrompt(id);

                expect(prompt).toBe('');
            } finally {
                cleanupTestWorkspace(id, rootPath);
            }
        });

        it('should build prompt with IDENTITY.md only', () => {
            const { id, rootPath } = createTestWorkspace();

            try {
                writeFileSync(resolve(rootPath, 'IDENTITY.md'), 'You are a backend expert.', 'utf8');

                const prompt = buildWorkspaceConfigPrompt(id);

                expect(prompt).toContain('--- 工作区配置 ---');
                expect(prompt).toContain('## 角色定位');
                expect(prompt).toContain('You are a backend expert.');
                expect(prompt).not.toContain('## 用户偏好');
                expect(prompt).not.toContain('## 可用工具');
            } finally {
                cleanupTestWorkspace(id, rootPath);
            }
        });

        it('should build prompt with all three files in correct order', () => {
            const { id, rootPath } = createTestWorkspace();

            try {
                writeFileSync(resolve(rootPath, 'IDENTITY.md'), 'Identity text', 'utf8');
                writeFileSync(resolve(rootPath, 'USER.md'), 'User text', 'utf8');
                writeFileSync(resolve(rootPath, 'TOOLS.md'), 'Tools text', 'utf8');

                const prompt = buildWorkspaceConfigPrompt(id);

                // Check order: identity -> user -> tools
                const identityIndex = prompt.indexOf('## 角色定位');
                const userIndex = prompt.indexOf('## 用户偏好');
                const toolsIndex = prompt.indexOf('## 可用工具');

                expect(identityIndex).toBeGreaterThan(-1);
                expect(userIndex).toBeGreaterThan(-1);
                expect(toolsIndex).toBeGreaterThan(-1);
                expect(identityIndex).toBeLessThan(userIndex);
                expect(userIndex).toBeLessThan(toolsIndex);
            } finally {
                cleanupTestWorkspace(id, rootPath);
            }
        });
    });

    describe('saveWorkspaceConfigFile', () => {
        it('should create IDENTITY.md file', () => {
            const { id, rootPath } = createTestWorkspace();

            try {
                saveWorkspaceConfigFile(id, 'identity', 'New identity content');

                const filePath = resolve(rootPath, 'IDENTITY.md');
                expect(existsSync(filePath)).toBe(true);

                const content = readFileSync(filePath, 'utf8');
                expect(content).toBe('New identity content');
            } finally {
                cleanupTestWorkspace(id, rootPath);
            }
        });

        it('should update existing file', () => {
            const { id, rootPath } = createTestWorkspace();

            try {
                // Create initial file
                writeFileSync(resolve(rootPath, 'USER.md'), 'Old content', 'utf8');

                // Update it
                saveWorkspaceConfigFile(id, 'user', 'Updated content');

                const filePath = resolve(rootPath, 'USER.md');
                const content = readFileSync(filePath, 'utf8');
                expect(content).toBe('Updated content');
            } finally {
                cleanupTestWorkspace(id, rootPath);
            }
        });

        it('should create directory if it does not exist', () => {
            const db = getDb();
            const id = randomUUID();
            const rootPath = resolve(process.cwd(), 'data', 'workspaces', `new-${id}`);

            // Insert workspace without creating directory
            db.prepare(
                'INSERT INTO workspaces (id, user_id, name, description, root_path, created_at, last_active_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
            ).run(id, 'owner', 'Test', '', rootPath, Date.now(), Date.now());

            try {
                expect(existsSync(rootPath)).toBe(false);

                saveWorkspaceConfigFile(id, 'tools', 'Tools content');

                expect(existsSync(rootPath)).toBe(true);
                expect(existsSync(resolve(rootPath, 'TOOLS.md'))).toBe(true);
            } finally {
                cleanupTestWorkspace(id, rootPath);
            }
        });
    });

    describe('getWorkspaceConfigFilePath', () => {
        it('should return correct path for each config file', () => {
            const { id, rootPath } = createTestWorkspace();

            try {
                const identityPath = getWorkspaceConfigFilePath(id, 'identity');
                const userPath = getWorkspaceConfigFilePath(id, 'user');
                const toolsPath = getWorkspaceConfigFilePath(id, 'tools');

                expect(identityPath).toBe(resolve(rootPath, 'IDENTITY.md'));
                expect(userPath).toBe(resolve(rootPath, 'USER.md'));
                expect(toolsPath).toBe(resolve(rootPath, 'TOOLS.md'));
            } finally {
                cleanupTestWorkspace(id, rootPath);
            }
        });
    });

    describe('getWorkspaceRootPath', () => {
        it('should return root path from database', () => {
            const { id, rootPath } = createTestWorkspace();

            try {
                const result = getWorkspaceRootPath(id);

                expect(result).toBe(rootPath);
            } finally {
                cleanupTestWorkspace(id, rootPath);
            }
        });

        it('should return fallback path for non-existent workspace', () => {
            const result = getWorkspaceRootPath('non-existent');

            expect(result).toContain('data/workspaces/non-existent');
        });
    });
});
