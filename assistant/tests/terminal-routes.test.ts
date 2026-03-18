/**
 * Terminal Routes Integration Tests (T-3.2)
 *
 * 测试范围：
 * - POST /api/terminal - 创建终端
 * - GET /api/terminal/list - 列出终端
 * - GET /api/terminal/:id - 获取终端详情
 * - POST /api/terminal/:id/resize - 调整终端大小
 * - DELETE /api/terminal/:id - 关闭终端
 * - WS /ws/terminal/:id - WebSocket 连接
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import { terminalRouter } from '../src/routes/terminal';
import { initDb, getDb } from '../src/db';
import { loadConfig, resetConfig } from '../src/config';
import { randomUUID } from 'crypto';
import { writeFileSync, unlinkSync, existsSync } from 'fs';
import { resolve } from 'path';

const testDbPath = resolve(__dirname, 'test-terminal.db');
const testConfigPath = resolve(__dirname, 'test-config-terminal.yaml');

// Mock node-pty
const mockPty = {
    pid: 12345,
    cols: 80,
    rows: 24,
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    onData: vi.fn((cb) => {
        mockPty._dataCallback = cb;
        return { dispose: vi.fn() };
    }),
    onExit: vi.fn((cb) => {
        mockPty._exitCallback = cb;
        return { dispose: vi.fn() };
    }),
    _dataCallback: null as ((data: string) => void) | null,
    _exitCallback: null as ((e: { exitCode: number; signal?: number }) => void) | null,
};

vi.mock('node-pty', () => ({
    spawn: vi.fn(() => mockPty),
}));

describe('Terminal Routes (T-3.2)', () => {
    let app: Hono;
    let workspaceId: string;
    let userId: string = 'test-user-terminal';
    let token: string;
    let terminalId: string;

    beforeEach(async () => {
        // Setup config
        const configContent = `
server:
  port: 8888
  host: 0.0.0.0
auth:
  jwt_secret: "test_secret"
  token_expire_days: 7
  login_rate_limit: 5
terminal:
  max_sessions: 3
  shell: "/bin/bash"
claude:
  api_key: "test_key"
  base_url: "https://test.com"
logs:
  retention_days: 90
  terminal_logging: false
runner:
  idle_timeout_minutes: 60
  max_crash_retries: 5
memory:
  enabled: false
lark:
  enabled: false
tasks:
  max_history_per_task: 100
files:
  allowed_roots: []
`;
        writeFileSync(testConfigPath, configContent);
        loadConfig(testConfigPath);

        // Setup DB
        initDb(testDbPath);
        const db = getDb();

        // Create test user
        const passwordHash = '$2b$10$abcdefghijklmnopqrstuvwxycdefghijklmnopqrstu';
        db.prepare(
            'INSERT OR IGNORE INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)'
        ).run(userId, 'testuser', passwordHash, Date.now());

        // Create test workspace
        workspaceId = randomUUID();
        db.prepare(
            'INSERT INTO workspaces (id, user_id, name, root_path, created_at) VALUES (?, ?, ?, ?, ?)'
        ).run(workspaceId, userId, 'Test Workspace', '/tmp/test', Date.now());

        // Create token
        const { createToken } = await import('../src/middleware/auth');
        token = await createToken(userId, 'admin');

        // Setup app with router
        app = new Hono();
        app.route('/api/terminal', terminalRouter);

        // Reset mocks
        vi.clearAllMocks();
    });

    afterEach(() => {
        resetConfig();
        if (existsSync(testConfigPath)) unlinkSync(testConfigPath);
        if (existsSync(testDbPath)) unlinkSync(testDbPath);
    });

    describe('POST /api/terminal', () => {
        it('should create a new terminal session', async () => {
            const res = await app.request('/api/terminal', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Cookie': `assistant_token=${token}`,
                },
                body: JSON.stringify({ workspaceId }),
            });

            expect(res.status).toBe(201);
            const data = await res.json();
            expect(data.success).toBe(true);
            expect(data.terminal).toBeDefined();
            expect(data.terminal.id).toBeDefined();
            expect(data.terminal.workspaceId).toBe(workspaceId);
            expect(data.terminal.pid).toBeDefined();

            terminalId = data.terminal.id;
        });

        it('should reject without workspaceId', async () => {
            const res = await app.request('/api/terminal', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Cookie': `assistant_token=${token}`,
                },
                body: JSON.stringify({}),
            });

            expect(res.status).toBe(400);
            const data = await res.json();
            expect(data.error).toContain('workspaceId');
        });

        it('should reject for non-existent workspace', async () => {
            const res = await app.request('/api/terminal', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Cookie': `assistant_token=${token}`,
                },
                body: JSON.stringify({ workspaceId: 'non-existent' }),
            });

            expect(res.status).toBe(404);
        });
    });

    describe('GET /api/terminal/list', () => {
        it('should list user terminals', async () => {
            // First create a terminal
            await app.request('/api/terminal', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Cookie': `assistant_token=${token}`,
                },
                body: JSON.stringify({ workspaceId }),
            });

            const res = await app.request('/api/terminal/list', {
                headers: {
                    'Cookie': `assistant_token=${token}`,
                },
            });

            expect(res.status).toBe(200);
            const data = await res.json();
            expect(data.terminals).toBeDefined();
            expect(Array.isArray(data.terminals)).toBe(true);
        });
    });

    describe('Max Sessions Limit', () => {
        it('should enforce max session limit (3)', async () => {
            const terminals: string[] = [];

            // Create 3 terminals (max allowed by test config)
            for (let i = 0; i < 3; i++) {
                const res = await app.request('/api/terminal', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Cookie': `assistant_token=${token}`,
                    },
                    body: JSON.stringify({ workspaceId }),
                });

                if (res.status === 201) {
                    const data = await res.json();
                    terminals.push(data.terminal.id);
                }
            }

            // 4th should be rejected
            const res = await app.request('/api/terminal', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Cookie': `assistant_token=${token}`,
                },
                body: JSON.stringify({ workspaceId }),
            });

            expect(res.status).toBe(429);
            const data = await res.json();
            expect(data.error).toContain('Maximum');

            // Cleanup
            const { _clearAllSessionsForTesting } = await import('../src/services/terminal');
            _clearAllSessionsForTesting();
        });
    });
});
