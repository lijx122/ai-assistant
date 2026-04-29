/**
 * 全局经验库（lessons）数据层
 * - DB 存元数据 + embedding（title+summary 向量化）
 * - 正文 md 存 <dataDir>/lessons/<id>.md
 * - 跨 workspace 全局共享，不做 workspace 过滤
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { getDb } from '../db';
import { getConfig } from '../config';
import { embed, cosineSimilarity } from './embedder';

const SIMILARITY_THRESHOLD = 0.45;
const DEDUP_THRESHOLD = 0.85;

interface LessonRow {
    id: string;
    task_type: string;
    title: string;
    summary: string;
    embedding: Buffer;
    md_path: string;
    source_session_id: string | null;
    source_message_id: string | null;
    source_workspace_id: string | null;
    hit_count: number;
    created_at: number;
    updated_at: number;
}

interface LessonEdgeRow {
    from_id: string;
    to_id: string;
    relation: string;
    strength: number;
}

export interface LessonMeta {
    id: string;
    task_type: string;
    title: string;
    summary: string;
    md_path: string;
    hit_count: number;
    created_at: number;
    updated_at: number;
    source_workspace_id?: string | null;
}

export interface LessonSearchResult extends LessonMeta {
    score: number;
    edge_reason?: string;
}

function getLessonsDir(): string {
    const dir = join(getConfig().dataDir, 'lessons');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    return dir;
}

function rowToMeta(row: LessonRow): LessonMeta {
    return {
        id: row.id,
        task_type: row.task_type,
        title: row.title,
        summary: row.summary,
        md_path: row.md_path,
        hit_count: row.hit_count,
        created_at: row.created_at,
        updated_at: row.updated_at,
        source_workspace_id: row.source_workspace_id,
    };
}

/**
 * 记录一条新教训（全局）
 * 写入前检查去重：相似度 > DEDUP_THRESHOLD 则 update 现有条目
 */
export async function recordLesson(params: {
    taskType: string;
    title: string;
    summary: string;
    detail: string;
    sourceSessionId?: string;
    sourceMessageId?: string;
    sourceWorkspaceId?: string;
    links?: Array<{ target_id: string; relation: string; strength?: number }>;
}): Promise<{ id: string; action: 'created' | 'updated' }> {
    const { taskType, title, summary, detail, sourceSessionId, sourceMessageId, sourceWorkspaceId, links } = params;
    const db = getDb();

    const queryText = `${title}\n${summary}`;
    const vec = await embed(queryText);

    // 去重检查
    const existing = await searchRelevantLessons(queryText, { topK: 1, threshold: DEDUP_THRESHOLD, expandGraph: false });
    if (existing.length > 0 && existing[0].score >= DEDUP_THRESHOLD) {
        const existingId = existing[0].id;
        await updateLesson(existingId, { taskType, title, summary, detail });
        if (links?.length) {
            for (const l of links) {
                linkLessons(existingId, l.target_id, l.relation, l.strength ?? 1.0);
            }
        }
        return { id: existingId, action: 'updated' };
    }

    // 新建
    const id = randomUUID();
    const mdPath = join(getLessonsDir(), `${id}.md`);
    const mdContent = `# ${title}\n\n## Summary\n\n${summary}\n\n## Detail\n\n${detail}`;
    writeFileSync(mdPath, mdContent, 'utf8');

    const now = Date.now();
    const vecBlob = Buffer.from(vec.buffer);
    db.prepare(`
        INSERT INTO lessons (id, task_type, title, summary, embedding, md_path,
            source_session_id, source_message_id, source_workspace_id, hit_count, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
    `).run(id, taskType, title, summary, vecBlob, mdPath,
        sourceSessionId ?? null, sourceMessageId ?? null, sourceWorkspaceId ?? null, now, now);

    if (links?.length) {
        for (const l of links) {
            linkLessons(id, l.target_id, l.relation, l.strength ?? 1.0);
        }
    }

    return { id, action: 'created' };
}

/**
 * 向量检索相关教训（全局，不过滤 workspace）
 * 支持图扩展：命中条目的 1 度邻居也加入结果
 */
export async function searchRelevantLessons(
    queryText: string,
    options: {
        topK?: number;
        threshold?: number;
        expandGraph?: boolean;
        graphDepth?: number;
    } = {}
): Promise<LessonSearchResult[]> {
    const { topK = 5, threshold = SIMILARITY_THRESHOLD, expandGraph = true } = options;

    const db = getDb();
    const rows = db.prepare('SELECT * FROM lessons').all() as LessonRow[];
    if (rows.length === 0) return [];

    const queryVec = await embed(queryText);

    const scored = rows
        .map(row => {
            const embeddingVec = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4);
            const score = cosineSimilarity(queryVec, embeddingVec);
            return { row, score };
        })
        .filter(x => x.score >= threshold)
        .sort((a, b) => b.score - a.score)
        .slice(0, topK);

    const results: LessonSearchResult[] = scored.map(({ row, score }) => ({ ...rowToMeta(row), score }));

    // 图扩展：拉出 1 度邻居
    if (expandGraph && results.length > 0) {
        const resultIds = new Set(results.map(r => r.id));
        for (const result of [...results]) {
            const edges = db.prepare(
                `SELECT * FROM lesson_edges WHERE (from_id = ? OR to_id = ?) AND strength >= 0.5`
            ).all(result.id, result.id) as LessonEdgeRow[];

            for (const edge of edges) {
                const neighborId = edge.from_id === result.id ? edge.to_id : edge.from_id;
                if (resultIds.has(neighborId)) continue;

                const neighborRow = db.prepare('SELECT * FROM lessons WHERE id = ?').get(neighborId) as LessonRow | undefined;
                if (!neighborRow) continue;

                results.push({ ...rowToMeta(neighborRow), score: result.score * edge.strength * 0.8, edge_reason: `via ${result.title} (${edge.relation})` });
                resultIds.add(neighborId);

                if (results.length >= topK + 3) break;
            }
            if (results.length >= topK + 3) break;
        }
    }

    // 异步更新命中计数
    if (scored.length > 0) {
        const ids = scored.map(x => x.row.id);
        setImmediate(() => {
            try {
                const stmt = db.prepare('UPDATE lessons SET hit_count = hit_count + 1 WHERE id = ?');
                for (const id of ids) stmt.run(id);
            } catch {
                // 非关键操作，忽略错误
            }
        });
    }

    return results;
}

/** 读取教训正文 md */
export function readLessonDetail(id: string): string | null {
    const db = getDb();
    const row = db.prepare('SELECT md_path FROM lessons WHERE id = ?').get(id) as { md_path: string } | undefined;
    if (!row) return null;
    if (!existsSync(row.md_path)) return null;
    return readFileSync(row.md_path, 'utf8');
}

/** 更新教训（可选择性传入要改的字段） */
export async function updateLesson(id: string, patch: Partial<{
    taskType: string;
    title: string;
    summary: string;
    detail: string;
}>): Promise<void> {
    const db = getDb();
    const row = db.prepare('SELECT * FROM lessons WHERE id = ?').get(id) as LessonRow | undefined;
    if (!row) throw new Error(`Lesson ${id} not found`);

    const newTitle = patch.title ?? row.title;
    const newSummary = patch.summary ?? row.summary;
    const newTaskType = patch.taskType ?? row.task_type;
    const now = Date.now();

    // 如果 title 或 summary 变了，重新 embed
    let vecBlob = row.embedding;
    if (patch.title || patch.summary) {
        const newVec = await embed(`${newTitle}\n${newSummary}`);
        vecBlob = Buffer.from(newVec.buffer);
    }

    db.prepare(`
        UPDATE lessons SET task_type=?, title=?, summary=?, embedding=?, updated_at=? WHERE id=?
    `).run(newTaskType, newTitle, newSummary, vecBlob, now, id);

    if (patch.detail) {
        writeFileSync(row.md_path, `# ${newTitle}\n\n## Summary\n\n${newSummary}\n\n## Detail\n\n${patch.detail}`, 'utf8');
    }
}

/** 删除教训（同步删 md 文件 + edges） */
export function deleteLesson(id: string): void {
    const db = getDb();
    const row = db.prepare('SELECT md_path FROM lessons WHERE id = ?').get(id) as { md_path: string } | undefined;
    if (!row) return;

    db.prepare('DELETE FROM lesson_edges WHERE from_id = ? OR to_id = ?').run(id, id);
    db.prepare('DELETE FROM lessons WHERE id = ?').run(id);

    try {
        if (existsSync(row.md_path)) unlinkSync(row.md_path);
    } catch {
        // 文件已不存在，忽略
    }
}

/** 列出所有教训元数据（不读 md） */
export function listLessons(filter?: { taskType?: string; q?: string }): LessonMeta[] {
    const db = getDb();
    let sql = 'SELECT * FROM lessons';
    const params: string[] = [];

    if (filter?.taskType) {
        sql += ' WHERE task_type = ?';
        params.push(filter.taskType);
    } else if (filter?.q) {
        sql += ' WHERE title LIKE ? OR summary LIKE ?';
        params.push(`%${filter.q}%`, `%${filter.q}%`);
    }

    sql += ' ORDER BY updated_at DESC';
    return (db.prepare(sql).all(...params) as LessonRow[]).map(rowToMeta);
}

/** 建立教训之间的关联边 */
export function linkLessons(fromId: string, toId: string, relation: string, strength = 1.0): void {
    const db = getDb();
    db.prepare(`
        INSERT OR REPLACE INTO lesson_edges (from_id, to_id, relation, strength, created_at)
        VALUES (?, ?, ?, ?, ?)
    `).run(fromId, toId, relation, strength, Date.now());
}

/** 删除关联边 */
export function unlinkLessons(fromId: string, toId: string): void {
    const db = getDb();
    db.prepare('DELETE FROM lesson_edges WHERE from_id = ? AND to_id = ?').run(fromId, toId);
}

/** 获取一条教训的图邻居（用于 UI 展示） */
export function getLessonGraph(id: string, depth = 1): {
    lesson: LessonMeta | null;
    neighbors: Array<{ lesson: LessonMeta; relation: string; strength: number; direction: 'out' | 'in' }>;
} {
    const db = getDb();
    const row = db.prepare('SELECT * FROM lessons WHERE id = ?').get(id) as LessonRow | undefined;
    if (!row) return { lesson: null, neighbors: [] };

    const edges = db.prepare(
        'SELECT * FROM lesson_edges WHERE from_id = ? OR to_id = ?'
    ).all(id, id) as LessonEdgeRow[];

    const neighbors = [];
    for (const edge of edges) {
        const neighborId = edge.from_id === id ? edge.to_id : edge.from_id;
        const direction: 'out' | 'in' = edge.from_id === id ? 'out' : 'in';
        const nr = db.prepare('SELECT * FROM lessons WHERE id = ?').get(neighborId) as LessonRow | undefined;
        if (nr) {
            neighbors.push({ lesson: rowToMeta(nr), relation: edge.relation, strength: edge.strength, direction });
        }
    }

    return { lesson: rowToMeta(row), neighbors };
}
