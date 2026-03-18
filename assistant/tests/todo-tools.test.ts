import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, existsSync, rmSync, unlinkSync } from 'fs';
import { resolve } from 'path';
import {
    readTodoList,
    writeTodoList,
    getTodoFilePath,
    executeTodoWrite,
    executeTodoRead,
    TodoItem,
} from '../src/services/tools/todo';
import { ToolContext } from '../src/services/tools/types';
import { initDb, closeDb, getDb } from '../src/db';
import { randomUUID } from 'crypto';

const testDbPath = resolve(__dirname, 'test-todo.db');

// Helper to create a test workspace
function createTestWorkspace(name: string = 'Test Workspace') {
    const db = getDb();
    const id = randomUUID();
    const rootPath = resolve(process.cwd(), 'data', 'workspaces', `test-todo-${id}`);

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

describe('Todo Tools (T-2.6)', () => {
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

    describe('readTodoList', () => {
        it('should return empty list when todo file does not exist', () => {
            const { id, rootPath } = createTestWorkspace();

            try {
                const list = readTodoList(id);

                expect(list.items).toEqual([]);
                expect(list.updatedAt).toBeGreaterThan(0);
            } finally {
                cleanupTestWorkspace(id, rootPath);
            }
        });

        it('should return empty list for non-existent workspace', () => {
            const list = readTodoList('non-existent-id');

            expect(list.items).toEqual([]);
            expect(list.updatedAt).toBeGreaterThan(0);
        });

        it('should read existing todo list', () => {
            const { id, rootPath } = createTestWorkspace();

            try {
                const items: TodoItem[] = [
                    { text: 'Task 1', status: 'pending' },
                    { text: 'Task 2', status: 'done' },
                ];
                writeTodoList(id, items);

                const list = readTodoList(id);

                expect(list.items).toHaveLength(2);
                expect(list.items[0].text).toBe('Task 1');
                expect(list.items[0].status).toBe('pending');
                expect(list.items[1].text).toBe('Task 2');
                expect(list.items[1].status).toBe('done');
            } finally {
                cleanupTestWorkspace(id, rootPath);
            }
        });

        it('should handle invalid JSON gracefully', () => {
            const { id, rootPath } = createTestWorkspace();

            try {
                // Write invalid JSON
                const fs = require('fs');
                const todoPath = getTodoFilePath(id);
                fs.writeFileSync(todoPath, 'invalid json', 'utf8');

                const list = readTodoList(id);

                expect(list.items).toEqual([]);
            } finally {
                cleanupTestWorkspace(id, rootPath);
            }
        });

        it('should handle malformed data structure', () => {
            const { id, rootPath } = createTestWorkspace();

            try {
                const fs = require('fs');
                const todoPath = getTodoFilePath(id);
                fs.writeFileSync(todoPath, JSON.stringify({ notItems: [] }), 'utf8');

                const list = readTodoList(id);

                expect(list.items).toEqual([]);
            } finally {
                cleanupTestWorkspace(id, rootPath);
            }
        });
    });

    describe('writeTodoList', () => {
        it('should create todo file', () => {
            const { id, rootPath } = createTestWorkspace();

            try {
                const items: TodoItem[] = [{ text: 'New task', status: 'pending' }];
                const result = writeTodoList(id, items);

                expect(result.items).toEqual(items);
                expect(result.updatedAt).toBeGreaterThan(0);

                const fs = require('fs');
                const todoPath = getTodoFilePath(id);
                expect(fs.existsSync(todoPath)).toBe(true);
            } finally {
                cleanupTestWorkspace(id, rootPath);
            }
        });

        it('should overwrite existing todo file', () => {
            const { id, rootPath } = createTestWorkspace();

            try {
                // First write
                writeTodoList(id, [{ text: 'Old task', status: 'done' }]);

                // Second write
                const newItems: TodoItem[] = [
                    { text: 'Task A', status: 'pending' },
                    { text: 'Task B', status: 'pending' },
                ];
                const result = writeTodoList(id, newItems);

                expect(result.items).toHaveLength(2);
                expect(result.items[0].text).toBe('Task A');
            } finally {
                cleanupTestWorkspace(id, rootPath);
            }
        });
    });

    describe('executeTodoWrite', () => {
        it('should write todo list and return success', () => {
            const { id, rootPath } = createTestWorkspace();

            try {
                const items: TodoItem[] = [
                    { text: 'Write code', status: 'done' },
                    { text: 'Write tests', status: 'pending' },
                ];
                const context = { workspaceId: id, sessionId: 'test', channel: 'web' as const };
                const result = executeTodoWrite({ items }, context);

                expect(result.success).toBe(true);
                expect(result.data?.count).toBe(2);
                expect(result.data?.message).toContain('2 tasks');
                expect(result.data?.message).toContain('1 completed');
            } finally {
                cleanupTestWorkspace(id, rootPath);
            }
        });

        it('should handle empty list', () => {
            const { id, rootPath } = createTestWorkspace();

            try {
                const context = { workspaceId: id, sessionId: 'test', channel: 'web' as const };
                const result = executeTodoWrite({ items: [] }, context);

                expect(result.success).toBe(true);
                expect(result.data?.count).toBe(0);
                expect(result.data?.message).toContain('0 tasks');
            } finally {
                cleanupTestWorkspace(id, rootPath);
            }
        });

        it('should return error on failure', () => {
            // Use invalid workspace ID that can't be written to
            const context = { workspaceId: '/invalid/path', sessionId: 'test', channel: 'web' as const };
            const result = executeTodoWrite({ items: [{ text: 'test', status: 'pending' }] }, context);

            expect(result.success).toBe(false);
            expect(result.error).toContain('Failed');
        });
    });

    describe('executeTodoRead', () => {
        it('should read empty list', () => {
            const { id, rootPath } = createTestWorkspace();

            try {
                const context = { workspaceId: id, sessionId: 'test', channel: 'web' as const };
                const result = executeTodoRead({}, context);

                expect(result.data?.items).toEqual([]);
                expect(result.data?.count).toBe(0);
                expect(result.data?.completed).toBe(0);
            } finally {
                cleanupTestWorkspace(id, rootPath);
            }
        });

        it('should read list with correct counts', () => {
            const { id, rootPath } = createTestWorkspace();

            try {
                const items: TodoItem[] = [
                    { text: 'Done 1', status: 'done' },
                    { text: 'Done 2', status: 'done' },
                    { text: 'Pending', status: 'pending' },
                ];
                writeTodoList(id, items);

                const context = { workspaceId: id, sessionId: 'test', channel: 'web' as const };
                const result = executeTodoRead({}, context);

                expect(result.data?.items).toHaveLength(3);
                expect(result.data?.count).toBe(3);
                expect(result.data?.completed).toBe(2);
            } finally {
                cleanupTestWorkspace(id, rootPath);
            }
        });
    });

    describe('getTodoFilePath', () => {
        it('should return correct path', () => {
            const { id, rootPath } = createTestWorkspace();

            try {
                const path = getTodoFilePath(id);

                expect(path).toContain('.todo.json');
                expect(path).toContain(rootPath);
            } finally {
                cleanupTestWorkspace(id, rootPath);
            }
        });
    });

    describe('Todo item validation', () => {
        it('should filter out invalid items when reading', () => {
            const { id, rootPath } = createTestWorkspace();

            try {
                const fs = require('fs');
                const todoPath = getTodoFilePath(id);

                // Write data with some invalid items
                const malformedData = {
                    items: [
                        { text: 'Valid', status: 'done' },
                        { text: 123, status: 'pending' }, // invalid text type
                        { text: 'Also valid', status: 'pending' },
                        { status: 'done' }, // missing text
                        { text: 'Missing done' }, // missing done/status
                    ],
                    updatedAt: Date.now(),
                };
                fs.writeFileSync(todoPath, JSON.stringify(malformedData), 'utf8');

                const list = readTodoList(id);

                // Because missing 'status' or 'done' defaults to 'pending',
                // '{ text: 'Missing done' }' is considered valid.
                expect(list.items).toHaveLength(3);
                expect(list.items[0].text).toBe('Valid');
                expect(list.items[1].text).toBe('Also valid');
                expect(list.items[2].text).toBe('Missing done');
            } finally {
                cleanupTestWorkspace(id, rootPath);
            }
        });
    });
});
