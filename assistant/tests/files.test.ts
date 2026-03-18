import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { filesRouter } from '../src/routes/files';
import { workspaceRouter } from '../src/routes/workspaces';
import { authRouter } from '../src/routes/auth';
import { initDb, closeDb } from '../src/db/index';
import { loadConfig, resetConfig } from '../src/config';
import { writeFileSync, unlinkSync, existsSync, mkdirSync, rmSync } from 'fs';
import { resolve } from 'path';

const testDbPath = resolve(__dirname, 'test-files.db');
const testConfigPath = resolve(__dirname, 'test-config-files.yaml');

describe('Files API (T-3.3)', () => {
    let app: Hono;
    let authCookie: string;
    let workspaceId: string;
    let testDir: string;

    beforeEach(async () => {
        // Create test config
        writeFileSync(testConfigPath, `
server:
  port: 8888
auth:
  jwt_secret: "test_secret"
  token_expire_days: 1
  login_rate_limit: 3
claude:
  api_key: "test_key"
runner: {}
terminal: {}
files:
  allowed_roots:
    - /tmp/test-allowed
memory: {}
lark: {}
tasks: {}
logs: {}
        `);
        resetConfig();
        loadConfig(testConfigPath);

        // Reset database
        if (existsSync(testDbPath)) unlinkSync(testDbPath);
        if (existsSync(testDbPath + '-wal')) unlinkSync(testDbPath + '-wal');
        if (existsSync(testDbPath + '-shm')) unlinkSync(testDbPath + '-shm');
        initDb(testDbPath);

        // Create app with routers
        app = new Hono();
        app.route('/api/auth', authRouter);
        app.route('/api/workspaces', workspaceRouter);
        app.route('/api/files', filesRouter);

        // Login to get auth cookie
        const loginRes = await app.request('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'owner', password: 'admin' })
        });
        authCookie = loginRes.headers.get('set-cookie') || '';

        // Create a test workspace
        const wsRes = await app.request('/api/workspaces', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Cookie': authCookie },
            body: JSON.stringify({ name: 'TestFilesWorkspace', description: 'For file tests' })
        });
        const wsData = await wsRes.json();
        workspaceId = wsData.workspace.id;
        testDir = resolve(process.cwd(), 'data', 'workspaces', workspaceId);

        // Create test files
        mkdirSync(resolve(testDir, 'subdir'), { recursive: true });
        writeFileSync(resolve(testDir, 'test.txt'), 'Hello World');
        writeFileSync(resolve(testDir, 'test.ts'), 'const x: number = 42;');
        writeFileSync(resolve(testDir, 'subdir', 'nested.json'), '{"key": "value"}');
    });

    afterEach(() => {
        closeDb();
        // Cleanup test files
        if (testDir && existsSync(testDir)) {
            rmSync(testDir, { recursive: true, force: true });
        }
        if (existsSync(testDbPath)) unlinkSync(testDbPath);
        if (existsSync(testDbPath + '-wal')) unlinkSync(testDbPath + '-wal');
        if (existsSync(testDbPath + '-shm')) unlinkSync(testDbPath + '-shm');
        if (existsSync(testConfigPath)) unlinkSync(testConfigPath);
    });

    describe('GET /api/files', () => {
        it('should list directory contents', async () => {
            const res = await app.request(`/api/files?workspaceId=${workspaceId}&path=.`, {
                headers: { 'Cookie': authCookie }
            });
            expect(res.status).toBe(200);

            const data = await res.json();
            expect(data.success).toBe(true);
            expect(data.files).toBeInstanceOf(Array);
            expect(data.files.length).toBeGreaterThanOrEqual(3);

            // Check file structure
            const txtFile = data.files.find((f: any) => f.name === 'test.txt');
            expect(txtFile).toBeDefined();
            expect(txtFile.isFile).toBe(true);
            expect(txtFile.isDirectory).toBe(false);
            expect(txtFile.language).toBe('plaintext');

            // Check directory
            const subdir = data.files.find((f: any) => f.name === 'subdir');
            expect(subdir).toBeDefined();
            expect(subdir.isDirectory).toBe(true);

            // TypeScript file should have language
            const tsFile = data.files.find((f: any) => f.name === 'test.ts');
            expect(tsFile).toBeDefined();
            expect(tsFile.language).toBe('typescript');
        });

        it('should list subdirectory contents', async () => {
            const res = await app.request(`/api/files?workspaceId=${workspaceId}&path=subdir`, {
                headers: { 'Cookie': authCookie }
            });
            expect(res.status).toBe(200);

            const data = await res.json();
            expect(data.success).toBe(true);
            expect(data.files.length).toBe(1);
            expect(data.files[0].name).toBe('nested.json');
        });

        it('should require workspaceId', async () => {
            const res = await app.request('/api/files', {
                headers: { 'Cookie': authCookie }
            });
            expect(res.status).toBe(400);

            const data = await res.json();
            expect(data.error).toContain('workspaceId is required');
        });

        it('should reject invalid workspace', async () => {
            const res = await app.request('/api/files?workspaceId=invalid-id', {
                headers: { 'Cookie': authCookie }
            });
            expect(res.status).toBe(404);
        });

        it('should deny access to paths outside allowed directories', async () => {
            const res = await app.request(`/api/files?workspaceId=${workspaceId}&path=/etc`, {
                headers: { 'Cookie': authCookie }
            });
            expect(res.status).toBe(403);

            const data = await res.json();
            expect(data.error).toContain('Access denied');
        });
    });

    describe('GET /api/files/content', () => {
        it('should read file content', async () => {
            const res = await app.request(`/api/files/content?workspaceId=${workspaceId}&path=test.txt`, {
                headers: { 'Cookie': authCookie }
            });
            expect(res.status).toBe(200);

            const data = await res.json();
            expect(data.success).toBe(true);
            expect(data.content).toBe('Hello World');
            expect(data.language).toBe('plaintext');
            expect(data.path).toBe('test.txt');
        });

        it('should detect TypeScript language', async () => {
            const res = await app.request(`/api/files/content?workspaceId=${workspaceId}&path=test.ts`, {
                headers: { 'Cookie': authCookie }
            });
            expect(res.status).toBe(200);

            const data = await res.json();
            expect(data.language).toBe('typescript');
            expect(data.content).toBe('const x: number = 42;');
        });

        it('should require path parameter', async () => {
            const res = await app.request(`/api/files/content?workspaceId=${workspaceId}`, {
                headers: { 'Cookie': authCookie }
            });
            expect(res.status).toBe(400);
        });

        it('should return 404 for non-existent file', async () => {
            const res = await app.request(`/api/files/content?workspaceId=${workspaceId}&path=nonexistent.txt`, {
                headers: { 'Cookie': authCookie }
            });
            expect(res.status).toBe(404);
        });

        it('should deny access to files outside allowed directories', async () => {
            const res = await app.request(`/api/files/content?workspaceId=${workspaceId}&path=/etc/passwd`, {
                headers: { 'Cookie': authCookie }
            });
            expect(res.status).toBe(403);
        });
    });

    describe('PUT /api/files/content', () => {
        it('should write file content', async () => {
            const res = await app.request('/api/files/content', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json', 'Cookie': authCookie },
                body: JSON.stringify({
                    workspaceId,
                    path: 'newfile.txt',
                    content: 'New file content'
                })
            });
            expect(res.status).toBe(200);

            const data = await res.json();
            expect(data.success).toBe(true);
            expect(data.path).toBe('newfile.txt');

            // Verify file was written
            const readRes = await app.request(`/api/files/content?workspaceId=${workspaceId}&path=newfile.txt`, {
                headers: { 'Cookie': authCookie }
            });
            const readData = await readRes.json();
            expect(readData.content).toBe('New file content');
        });

        it('should update existing file', async () => {
            const res = await app.request('/api/files/content', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json', 'Cookie': authCookie },
                body: JSON.stringify({
                    workspaceId,
                    path: 'test.txt',
                    content: 'Updated content'
                })
            });
            expect(res.status).toBe(200);

            // Verify update
            const readRes = await app.request(`/api/files/content?workspaceId=${workspaceId}&path=test.txt`, {
                headers: { 'Cookie': authCookie }
            });
            const readData = await readRes.json();
            expect(readData.content).toBe('Updated content');

            // Restore original content
            await app.request('/api/files/content', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json', 'Cookie': authCookie },
                body: JSON.stringify({
                    workspaceId,
                    path: 'test.txt',
                    content: 'Hello World'
                })
            });
        });

        it('should create parent directories automatically', async () => {
            const res = await app.request('/api/files/content', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json', 'Cookie': authCookie },
                body: JSON.stringify({
                    workspaceId,
                    path: 'deep/nested/path/file.txt',
                    content: 'Deep nested content'
                })
            });
            expect(res.status).toBe(200);

            // Verify file was created
            const readRes = await app.request(`/api/files/content?workspaceId=${workspaceId}&path=deep/nested/path/file.txt`, {
                headers: { 'Cookie': authCookie }
            });
            const readData = await readRes.json();
            expect(readData.content).toBe('Deep nested content');
        });

        it('should require all parameters', async () => {
            const res = await app.request('/api/files/content', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json', 'Cookie': authCookie },
                body: JSON.stringify({ workspaceId, path: 'file.txt' }) // missing content
            });
            expect(res.status).toBe(400);
        });

        it('should deny write to paths outside workspace', async () => {
            const res = await app.request('/api/files/content', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json', 'Cookie': authCookie },
                body: JSON.stringify({
                    workspaceId,
                    path: '/etc/passwd',
                    content: 'malicious'
                })
            });
            expect(res.status).toBe(403);
        });

        it('should deny write to paths outside workspace (using ..)', async () => {
            const res = await app.request('/api/files/content', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json', 'Cookie': authCookie },
                body: JSON.stringify({
                    workspaceId,
                    path: '../../../etc/passwd',
                    content: 'malicious'
                })
            });
            expect(res.status).toBe(403);
        });
    });

    describe('Authentication', () => {
        it('should require authentication for list', async () => {
            const res = await app.request(`/api/files?workspaceId=${workspaceId}`);
            expect(res.status).toBe(401);
        });

        it('should require authentication for read', async () => {
            const res = await app.request(`/api/files/content?workspaceId=${workspaceId}&path=test.txt`);
            expect(res.status).toBe(401);
        });

        it('should require authentication for write', async () => {
            const res = await app.request('/api/files/content', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ workspaceId, path: 'test.txt', content: 'test' })
            });
            expect(res.status).toBe(401);
        });
    });
});
