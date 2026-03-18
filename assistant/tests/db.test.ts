import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDb, getDb, closeDb } from '../src/db/index';
import { unlinkSync, rmdirSync, existsSync } from 'fs';
import { resolve } from 'path';

describe('Database Module', () => {
    const testDbName = 'test-assistant.db';
    const testDbPath = resolve(__dirname, testDbName);

    beforeEach(() => {
        // Clean up before each test
        if (existsSync(testDbPath)) unlinkSync(testDbPath);
        if (existsSync(testDbPath + '-wal')) unlinkSync(testDbPath + '-wal');
        if (existsSync(testDbPath + '-shm')) unlinkSync(testDbPath + '-shm');
    });

    afterEach(() => {
        closeDb();
        if (existsSync(testDbPath)) unlinkSync(testDbPath);
        if (existsSync(testDbPath + '-wal')) unlinkSync(testDbPath + '-wal');
        if (existsSync(testDbPath + '-shm')) unlinkSync(testDbPath + '-shm');
    });

    it('should initialize the database idempotently', () => {
        // First initialization
        const db1 = initDb(testDbPath);
        expect(db1).toBeDefined();

        // Check if the owner user was created
        const owner = db1.prepare('SELECT username FROM users WHERE username = ?').get('owner') as any;
        expect(owner).toBeDefined();
        expect(owner.username).toBe('owner');

        const tables1 = db1.prepare('SELECT count(*) as cnt FROM sqlite_master WHERE type=\'table\'').get() as any;
        const tableCount = tables1.cnt;

        closeDb();

        // Second initialization (idempotency check)
        const db2 = initDb(testDbPath);
        const tables2 = db2.prepare('SELECT count(*) as cnt FROM sqlite_master WHERE type=\'table\'').get() as any;
        expect(tables2.cnt).toBe(tableCount); // Ensure no new tables or duplication issues

        const usersMatch = db2.prepare('SELECT count(*) as cnt FROM users WHERE username = ?').get('owner') as any;
        expect(usersMatch.cnt).toBe(1); // Ensure owner is not duplicated
    });

    it('should return the correct singleton from getDb()', () => {
        const db = initDb(testDbPath);
        expect(getDb()).toBe(db);
    });
});
