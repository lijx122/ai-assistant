/**
 * Message Cache - 会话消息内存缓存
 *
 * 目标：减少频繁切换会话时的数据库查询，将响应时间从数十毫秒降至亚毫秒级。
 * 策略：
 * - 缓存主体（messages + compacts），TTL=5分钟
 * - 消息写入后 append 追加，避免全量刷新
 * - compact/删除后 invalidate，强制重新加载
 * - 增量刷新：只查缓存时间戳之后的新消息
 */

export interface CachedMessages {
    messages: any[];
    compacts: any[];
    lastMessageId: string;
    cachedAt: number;
}

export interface CacheEntry {
    data: CachedMessages;
}

class MessageCacheService {
    private cache = new Map<string, CacheEntry>();
    private readonly TTL = 5 * 60 * 1000; // 5分钟

    // ── 基础读写 ───────────────────────────────────────────

    get(sessionId: string): CachedMessages | null {
        const entry = this.cache.get(sessionId);
        if (!entry) return null;

        if (Date.now() - entry.data.cachedAt > this.TTL) {
            this.cache.delete(sessionId);
            return null;
        }

        return entry.data;
    }

    set(sessionId: string, messages: any[], compacts: any[]) {
        const last = messages[messages.length - 1];
        this.cache.set(sessionId, {
            data: {
                messages,
                compacts,
                lastMessageId: last?.id || '',
                cachedAt: Date.now(),
            },
        });
    }

    // ── 变更同步 ───────────────────────────────────────────

    /**
     * 追加新消息（AI 回复完成后调用，避免每次都全量刷新）
     */
    append(sessionId: string, message: any) {
        const entry = this.cache.get(sessionId);
        if (!entry) return;

        entry.data.messages.push(message);
        entry.data.lastMessageId = message.id || '';
        entry.data.cachedAt = Date.now();
    }

    /**
     * 失效缓存（compact 执行后、消息删除后会话删除时调用）
     */
    invalidate(sessionId: string) {
        this.cache.delete(sessionId);
    }

    /**
     * 批量失效（会话删除时，清除相关会话的所有缓存）
     */
    invalidateAll(sessionIds: string[]) {
        for (const id of sessionIds) {
            this.cache.delete(id);
        }
    }

    // ── 调试 ──────────────────────────────────────────────

    getStats() {
        return {
            size: this.cache.size,
            sessions: [...this.cache.keys()],
        };
    }
}

export const messageCache = new MessageCacheService();
