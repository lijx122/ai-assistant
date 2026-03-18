import Database from 'better-sqlite3';
import { readFileSync, mkdirSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { runMigrations, backfillMessagesFts } from './migrate';
import { getConfig } from '../config';

let dbInstance: Database.Database | null = null;

function resolveSchemaPath(): string {
    const candidates = [
        // 生产构建后：dist/db/schema.sql
        resolve(__dirname, 'schema.sql'),
        // 开发/调试：项目源码路径
        resolve(process.cwd(), 'src/db/schema.sql'),
    ];

    for (const p of candidates) {
        if (existsSync(p)) return p;
    }

    throw new Error(`[DB] schema.sql not found. tried: ${candidates.join(', ')}`);
}

export function initDb(dbPath?: string): Database.Database {
    if (dbInstance && !dbPath) return dbInstance;

    // 使用配置的数据目录
    const cfg = getConfig();
    const actualPath = dbPath || resolve(cfg.dataDir, 'assistant.db');

    // Ensure the data directory exists
    const dir = dirname(actualPath);
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
    }

    const db = new Database(actualPath);

    // Configure WAL for concurrency and performance
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');

    // Load and apply the schema (idempotent due to IF NOT EXISTS)
    const schemaPath = resolveSchemaPath();
    const schema = readFileSync(schemaPath, 'utf8');
    db.exec(schema);

    // Run pending migrations
    runMigrations(db);

    // Backfill messages_fts with original text (FTS5 built-in tokenization)
    try {
        backfillMessagesFts(db);
    } catch (err) {
        console.warn('[DB] Failed to backfill messages_fts:', err);
    }

    dbInstance = db;
    return dbInstance;
}

export function getDb(): Database.Database {
    if (!dbInstance) {
        return initDb();
    }
    return dbInstance;
}

export function closeDb(): void {
    if (dbInstance) {
        dbInstance.close();
        dbInstance = null;
    }
}
