import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { executeBash, bashToolDefinition } from '../src/services/bash-tools';
import { getDb, initDb } from '../src/db';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';

describe('bash-tools', () => {
    const testWorkspaceId = 'test-bash-workspace';
    const testWorkspacePath = join(process.cwd(), 'workspaces', testWorkspaceId);

    beforeAll(() => {
        // 确保数据库已初始化
        initDb();

        // 创建测试工作区目录
        if (!existsSync(testWorkspacePath)) {
            mkdirSync(testWorkspacePath, { recursive: true });
        }

        // 插入测试工作区
        const db = getDb();
        db.prepare(`
            INSERT OR IGNORE INTO workspaces (id, user_id, name, root_path, status, created_at)
            VALUES (?, 'test-user', ?, ?, 'active', unixepoch())
        `).run(testWorkspaceId, 'Test Workspace', testWorkspacePath);
    });

    afterAll(() => {
        // 清理测试工作区
        const db = getDb();
        db.prepare('DELETE FROM workspaces WHERE id = ?').run(testWorkspaceId);

        // 可选：删除目录
        // if (existsSync(testWorkspacePath)) {
        //     rmSync(testWorkspacePath, { recursive: true });
        // }
    });

    describe('bashToolDefinition', () => {
        it('should have correct structure', () => {
            expect(bashToolDefinition.name).toBe('bash');
            expect(bashToolDefinition.description).toContain('30');
            expect(bashToolDefinition.input_schema.required).toContain('command');
        });
    });

    describe('executeBash', () => {
        it('should execute simple command successfully', async () => {
            const result = await executeBash(testWorkspaceId, { command: 'echo "hello world"' });

            expect(result.success).toBe(true);
            expect(result.exit_code).toBe(0);
            expect(result.output).toContain('hello world');
            expect(result.elapsed_ms).toBeGreaterThanOrEqual(0);
            expect(result.elapsed_ms).toBeLessThan(5000);
        });

        it('should capture stderr separately', async () => {
            const result = await executeBash(testWorkspaceId, { command: 'echo "stdout" && echo "stderr" >&2' });

            expect(result.success).toBe(true);
            expect(result.output).toContain('stdout');
            expect(result.output).toContain('stderr');
        });

        it('should return non-zero exit code for failed command', async () => {
            const result = await executeBash(testWorkspaceId, { command: 'exit 42' });

            expect(result.success).toBe(false);
            expect(result.exit_code).toBe(42);
        });

        it('should respect cwd parameter', async () => {
            // 创建子目录
            const subDir = join(testWorkspacePath, 'subdir');
            if (!existsSync(subDir)) {
                mkdirSync(subDir);
            }

            const result = await executeBash(testWorkspaceId, {
                command: 'pwd',
                cwd: 'subdir'
            });

            expect(result.success).toBe(true);
            expect(result.output).toContain('subdir');
        });

        it('should reject path traversal in cwd', async () => {
            await expect(executeBash(testWorkspaceId, {
                command: 'pwd',
                cwd: '../..'
            })).rejects.toThrow('path traversal');
        });

        it('should timeout and kill long-running command', async () => {
            const startTime = Date.now();

            // 使用死循环命令，肯定会超时
            const result = await executeBash(testWorkspaceId, {
                command: 'while true; do echo "x"; sleep 0.1; done'
            });

            const elapsed = Date.now() - startTime;

            expect(result.success).toBe(false);
            expect(result.exit_code).toBe(-1);
            expect(result.output).toContain('超时');
            expect(result.output).toContain('30秒');
            expect(result.output).toContain('已终止');
            // 应该在 30-40 秒内完成（含缓冲时间）
            expect(elapsed).toBeGreaterThanOrEqual(30000);
            expect(elapsed).toBeLessThan(40000);
        }, 45000); // 测试超时设置为 45 秒

        it('should handle command not found', async () => {
            const result = await executeBash(testWorkspaceId, { command: 'command_that_does_not_exist_12345' });

            expect(result.success).toBe(false);
            expect(result.output.toLowerCase()).toContain('not found');
        });

        it('should truncate long output', async () => {
            const result = await executeBash(testWorkspaceId, { command: 'yes | head -10000' });

            expect(result.truncated).toBe(true);
            expect(result.output.length).toBeLessThan(9000); // 截断后应小于上限
            expect(result.output).toContain('输出已截断');
        });

        it('should handle commands with pipes', async () => {
            const result = await executeBash(testWorkspaceId, { command: 'echo "a b c" | wc -w' });

            expect(result.success).toBe(true);
            expect(result.output).toContain('3');
        });
    });
});
