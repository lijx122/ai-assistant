/**
 * Terminal Service Tests
 *
 * 测试范围：
 * - 创建/关闭终端会话
 * - 会话数量上限检查
 * - 终端数据读写
 * - 终端大小调整
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    createTerminal,
    closeTerminal,
    getTerminal,
    listTerminals,
    writeToTerminal,
    resizeTerminal,
    getActiveSessionCount,
    onTerminalData,
    _clearAllSessionsForTesting,
} from '../src/services/terminal';
import { getDb, initDb } from '../src/db';
import { getConfig, resetConfig } from '../src/config';

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

// Mock config
vi.mock('../src/config', async () => {
    const actual = await vi.importActual('../src/config');
    return {
        ...actual as any,
        getConfig: vi.fn(() => ({
            terminal: {
                max_sessions: 3,
                shell: '/bin/bash',
            },
        })),
    };
});

describe('Terminal Service', () => {
    const workspaceId = 'test-workspace-001';
    const userId = 'test-user-001';

    beforeEach(() => {
        // 清理所有会话状态
        _clearAllSessionsForTesting();

        initDb(':memory:');

        // 创建工作区
        const db = getDb();
        db.prepare(
            'INSERT INTO workspaces (id, user_id, name, root_path, created_at) VALUES (?, ?, ?, ?, ?)'
        ).run(workspaceId, userId, 'Test Workspace', '/tmp/test', Date.now());

        // Reset mocks
        vi.clearAllMocks();
    });

    afterEach(() => {
        resetConfig();
        _clearAllSessionsForTesting();
    });

    describe('createTerminal', () => {
        it('should create a terminal session successfully', () => {
            const session = createTerminal(workspaceId, userId);

            expect(session).toBeDefined();
            expect(session.id).toBeDefined();
            expect(session.workspaceId).toBe(workspaceId);
            expect(session.userId).toBe(userId);
            expect(session.pty).toBe(mockPty);
            expect(session.title).toBeDefined();
        });

        it('should use provided cwd and title', () => {
            const customCwd = '/custom/path';
            const customTitle = 'My Terminal';

            const session = createTerminal(workspaceId, userId, customCwd, customTitle);

            expect(session.cwd).toBe(customCwd);
            expect(session.title).toBe(customTitle);
        });

        it('should throw error when max sessions reached', () => {
            // Create max sessions
            createTerminal(workspaceId, userId);
            createTerminal(workspaceId, userId);
            createTerminal(workspaceId, userId);

            // Fourth session should fail
            expect(() => createTerminal(workspaceId, userId)).toThrow('Maximum terminal sessions');
        });

        it('should write session to database', () => {
            const session = createTerminal(workspaceId, userId);

            const db = getDb();
            const row = db.prepare('SELECT * FROM terminal_sessions WHERE id = ?').get(session.id);

            expect(row).toBeDefined();
            expect((row as any).workspace_id).toBe(workspaceId);
            expect((row as any).user_id).toBe(userId);
            expect((row as any).pid).toBe(12345);
        });
    });

    describe('getTerminal', () => {
        it('should return terminal session by id', () => {
            const session = createTerminal(workspaceId, userId);
            const found = getTerminal(session.id);

            expect(found).toBeDefined();
            expect(found?.id).toBe(session.id);
        });

        it('should return undefined for non-existent session', () => {
            const found = getTerminal('non-existent-id');
            expect(found).toBeUndefined();
        });
    });

    describe('listTerminals', () => {
        it('should list all active terminals', () => {
            createTerminal(workspaceId, userId);
            createTerminal(workspaceId, userId);

            const list = listTerminals();
            expect(list).toHaveLength(2);
        });

        it('should filter by workspaceId', () => {
            const otherWorkspaceId = 'other-workspace';
            const db = getDb();
            db.prepare(
                'INSERT INTO workspaces (id, user_id, name, root_path, created_at) VALUES (?, ?, ?, ?, ?)'
            ).run(otherWorkspaceId, userId, 'Other', '/tmp/other', Date.now());

            createTerminal(workspaceId, userId);
            createTerminal(otherWorkspaceId, userId);

            const list = listTerminals(workspaceId);
            expect(list).toHaveLength(1);
            expect(list[0].workspaceId).toBe(workspaceId);
        });

        it('should filter by userId', () => {
            const otherUserId = 'other-user';

            createTerminal(workspaceId, userId);
            createTerminal(workspaceId, otherUserId);

            const list = listTerminals(undefined, userId);
            expect(list).toHaveLength(1);
            expect(list[0].userId).toBe(userId);
        });
    });

    describe('getActiveSessionCount', () => {
        it('should return correct count', () => {
            expect(getActiveSessionCount()).toBe(0);

            createTerminal(workspaceId, userId);
            expect(getActiveSessionCount()).toBe(1);

            createTerminal(workspaceId, userId);
            expect(getActiveSessionCount()).toBe(2);
        });
    });

    describe('writeToTerminal', () => {
        it('should write data to pty', () => {
            const session = createTerminal(workspaceId, userId);

            writeToTerminal(session.id, 'hello world');

            expect(mockPty.write).toHaveBeenCalledWith('hello world');
        });

        it('should throw for non-existent session', () => {
            expect(() => writeToTerminal('non-existent', 'data')).toThrow('not found');
        });
    });

    describe('resizeTerminal', () => {
        it('should resize pty', () => {
            const session = createTerminal(workspaceId, userId);

            resizeTerminal(session.id, 120, 40);

            expect(mockPty.resize).toHaveBeenCalledWith(120, 40);
        });

        it('should throw for non-existent session', () => {
            expect(() => resizeTerminal('non-existent', 80, 24)).toThrow('not found');
        });
    });

    describe('onTerminalData', () => {
        it('should subscribe to terminal data', () => {
            const session = createTerminal(workspaceId, userId);
            const callback = vi.fn();

            const unsubscribe = onTerminalData(session.id, callback);

            // Simulate data from PTY
            if (mockPty._dataCallback) {
                mockPty._dataCallback('test data');
            }

            expect(callback).toHaveBeenCalledWith('test data');
            expect(unsubscribe).toBeTypeOf('function');
        });

        it('should throw for non-existent session', () => {
            expect(() => onTerminalData('non-existent', () => {})).toThrow('not found');
        });
    });

    describe('closeTerminal', () => {
        it('should send SIGTERM by default', async () => {
            const session = createTerminal(workspaceId, userId);

            await closeTerminal(session.id);

            expect(mockPty.kill).toHaveBeenCalledWith('SIGTERM');
        });

        it('should send SIGKILL when force=true', async () => {
            const session = createTerminal(workspaceId, userId);

            await closeTerminal(session.id, true);

            expect(mockPty.kill).toHaveBeenCalledWith('SIGKILL');
        });

        it('should throw for non-existent session', async () => {
            await expect(closeTerminal('non-existent')).rejects.toThrow('not found');
        });
    });
});
