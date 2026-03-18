import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync, unlinkSync } from 'fs';
import { resolve } from 'path';
import {
    getSkillFilePath,
    readSkillFile,
    listAvailableSkills,
    executeReadSkill,
} from '../src/services/skill-tools';
import { getSkillCatalog } from '../src/services/tools/skill';
import { initDb, closeDb, getDb } from '../src/db';
import { randomUUID } from 'crypto';

const testDbPath = resolve(__dirname, 'test-skill.db');

// Helper to create a test workspace
function createTestWorkspace(name: string = 'Test Workspace') {
    const db = getDb();
    const id = randomUUID();
    const rootPath = resolve(process.cwd(), 'data', 'workspaces', `test-skill-${id}`);

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

describe('Skill Tools (T-2.8)', () => {
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

    describe('getSkillFilePath', () => {
        it('should return null when skill does not exist anywhere', () => {
            const { id, rootPath } = createTestWorkspace();

            try {
                const path = getSkillFilePath(id, 'non-existent-skill');
                expect(path).toBeNull();
            } finally {
                cleanupTestWorkspace(id, rootPath);
            }
        });

        it('should find global skill when no workspace skill exists', () => {
            const { id, rootPath } = createTestWorkspace();

            try {
                // git.md should exist in src/skills (created during setup)
                const path = getSkillFilePath(id, 'git');
                expect(path).not.toBeNull();
                expect(path).toContain('src/skills/git.md');
            } finally {
                cleanupTestWorkspace(id, rootPath);
            }
        });

        it('should find skill under scripts/skills', () => {
            const { id, rootPath } = createTestWorkspace();

            try {
                const path = getSkillFilePath(id, 'fix-service');
                expect(path).not.toBeNull();
                expect(path).toContain('scripts/skills/fix-service.md');
            } finally {
                cleanupTestWorkspace(id, rootPath);
            }
        });

        it('should prefer workspace skill over global skill', () => {
            const { id, rootPath } = createTestWorkspace();

            try {
                // Create a workspace-specific skill
                const skillsDir = resolve(rootPath, 'skills');
                mkdirSync(skillsDir, { recursive: true });
                writeFileSync(resolve(skillsDir, 'git.md'), 'Workspace git skill', 'utf8');

                const path = getSkillFilePath(id, 'git');
                expect(path).not.toBeNull();
                expect(path).toContain('skills/git.md');
                expect(path).not.toContain('src/skills');
            } finally {
                cleanupTestWorkspace(id, rootPath);
            }
        });

        it('should handle skill name with .md extension', () => {
            const { id, rootPath } = createTestWorkspace();

            try {
                const pathWithExt = getSkillFilePath(id, 'git.md');
                const pathWithoutExt = getSkillFilePath(id, 'git');
                expect(pathWithExt).toBe(pathWithoutExt);
            } finally {
                cleanupTestWorkspace(id, rootPath);
            }
        });
    });

    describe('readSkillFile', () => {
        it('should return null when skill does not exist', () => {
            const { id, rootPath } = createTestWorkspace();

            try {
                const content = readSkillFile(id, 'non-existent');
                expect(content).toBeNull();
            } finally {
                cleanupTestWorkspace(id, rootPath);
            }
        });

        it('should read workspace skill content', () => {
            const { id, rootPath } = createTestWorkspace();

            try {
                const skillsDir = resolve(rootPath, 'skills');
                mkdirSync(skillsDir, { recursive: true });
                writeFileSync(resolve(skillsDir, 'deploy.md'), '# Deploy Guide\n\nDeploy steps...', 'utf8');

                const content = readSkillFile(id, 'deploy');
                expect(content).toBe('# Deploy Guide\n\nDeploy steps...');
            } finally {
                cleanupTestWorkspace(id, rootPath);
            }
        });

        it('should read global skill content', () => {
            const { id, rootPath } = createTestWorkspace();

            try {
                const content = readSkillFile(id, 'git');
                expect(content).not.toBeNull();
                expect(content).toContain('Git');
            } finally {
                cleanupTestWorkspace(id, rootPath);
            }
        });
    });

    describe('listAvailableSkills', () => {
        it('should return global skills when no workspace skills exist', () => {
            const { id, rootPath } = createTestWorkspace();

            try {
                const skills = listAvailableSkills(id);
                expect(skills).toContain('git');
                expect(skills).toContain('fix-service');
            } finally {
                cleanupTestWorkspace(id, rootPath);
            }
        });

        it('should merge workspace and global skills', () => {
            const { id, rootPath } = createTestWorkspace();

            try {
                const skillsDir = resolve(rootPath, 'skills');
                mkdirSync(skillsDir, { recursive: true });
                writeFileSync(resolve(skillsDir, 'custom.md'), 'Custom skill', 'utf8');

                const skills = listAvailableSkills(id);
                expect(skills).toContain('git');       // global
                expect(skills).toContain('custom');    // workspace
            } finally {
                cleanupTestWorkspace(id, rootPath);
            }
        });

        it('should not duplicate skills with same name', () => {
            const { id, rootPath } = createTestWorkspace();

            try {
                // git.md exists globally, create workspace version
                const skillsDir = resolve(rootPath, 'skills');
                mkdirSync(skillsDir, { recursive: true });
                writeFileSync(resolve(skillsDir, 'git.md'), 'Workspace git', 'utf8');

                const skills = listAvailableSkills(id);
                const gitCount = skills.filter(s => s === 'git').length;
                expect(gitCount).toBe(1);
            } finally {
                cleanupTestWorkspace(id, rootPath);
            }
        });

        it('should return sorted skill names', () => {
            const { id, rootPath } = createTestWorkspace();

            try {
                const skillsDir = resolve(rootPath, 'skills');
                mkdirSync(skillsDir, { recursive: true });
                writeFileSync(resolve(skillsDir, 'zebra.md'), 'Zebra', 'utf8');
                writeFileSync(resolve(skillsDir, 'alpha.md'), 'Alpha', 'utf8');

                const skills = listAvailableSkills(id);
                const indexZebra = skills.indexOf('zebra');
                const indexAlpha = skills.indexOf('alpha');
                expect(indexAlpha).toBeLessThan(indexZebra);
            } finally {
                cleanupTestWorkspace(id, rootPath);
            }
        });
    });

    describe('executeReadSkill', () => {
        it('should return not_found for non-existent skill', () => {
            const { id, rootPath } = createTestWorkspace();

            try {
                const result = executeReadSkill(id, { name: 'non-existent' });
                expect(result.success).toBe(false);
                expect(result.source).toBe('not_found');
                expect(result.content).toContain('not found');
            } finally {
                cleanupTestWorkspace(id, rootPath);
            }
        });

        it('should return workspace skill with correct source', () => {
            const { id, rootPath } = createTestWorkspace();

            try {
                const skillsDir = resolve(rootPath, 'skills');
                mkdirSync(skillsDir, { recursive: true });
                writeFileSync(resolve(skillsDir, 'test.md'), 'Test skill content', 'utf8');

                const result = executeReadSkill(id, { name: 'test' });
                expect(result.success).toBe(true);
                expect(result.source).toBe('workspace');
                expect(result.content).toBe('Test skill content');
            } finally {
                cleanupTestWorkspace(id, rootPath);
            }
        });

        it('should return global skill with correct source', () => {
            const { id, rootPath } = createTestWorkspace();

            try {
                const result = executeReadSkill(id, { name: 'git' });
                expect(result.success).toBe(true);
                expect(result.source).toBe('global');
                expect(result.content).toContain('Git');
            } finally {
                cleanupTestWorkspace(id, rootPath);
            }
        });

        it('should list available skills when skill not found', () => {
            const { id, rootPath } = createTestWorkspace();

            try {
                const result = executeReadSkill(id, { name: 'unknown-skill' });
                expect(result.success).toBe(false);
                expect(result.content).toContain('Available skills');
                expect(result.content).toContain('git');
            } finally {
                cleanupTestWorkspace(id, rootPath);
            }
        });
    });

    describe('getSkillCatalog', () => {
        it('should prefer frontmatter description for one-line summary', () => {
            const { id, rootPath } = createTestWorkspace();

            try {
                const skillsDir = resolve(rootPath, 'skills');
                mkdirSync(skillsDir, { recursive: true });
                writeFileSync(
                    resolve(skillsDir, 'frontmatter-test.md'),
                    `---
name: frontmatter-test
description: 这是来自 frontmatter 的一句话摘要
---

# 标题不应覆盖 frontmatter
`,
                    'utf8'
                );

                const catalog = getSkillCatalog(id);
                expect(catalog).toContain('frontmatter-test：这是来自 frontmatter 的一句话摘要');
            } finally {
                cleanupTestWorkspace(id, rootPath);
            }
        });
    });
});
