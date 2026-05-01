import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { estimateTokens, compactIfNeeded, formatCompactLog, CompactResult, getAllCompactsLight, getLatestCompact, saveCompact } from '../../src/services/context-summary';
import * as configModule from '../../src/config';
import { initDb, closeDb } from '../../src/db/index';
import { existsSync, unlinkSync } from 'fs';
import { resolve } from 'path';

// Mock config
const mockConfig = {
    claude: {
        api_key: 'test_key',
        base_url: 'https://api.anthropic.com',
        model: 'test-model',
        max_tokens: 4096,
        count_tokens_enabled: false,
        count_tokens_fixed: 2000,
        context_window_messages: 0,
        compact: {
            enabled: true,
            threshold_ratio: 0.8,
            token_limit: 10000,  // 测试中设为较低值，使现有测试数据能触发压缩
            preserve_rounds: 4,
            summary_model: 'test-summary-model',
            max_summary_tokens: 500,
        },
    },
};

// Mock Anthropic
vi.mock('@anthropic-ai/sdk', () => {
    return {
        default: class MockAnthropic {
            messages = {
                create: vi.fn().mockResolvedValue({
                    content: [{ type: 'text', text: '【测试摘要】这是对话的简要总结。' }],
                }),
            };
        },
    };
});

const testDbPath = resolve(__dirname, 'test-compact.db');

describe('context-summary', () => {
    beforeEach(() => {
        vi.spyOn(configModule, 'getConfig').mockReturnValue(mockConfig as any);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe('estimateTokens', () => {
        it('应正确估算纯文本消息的 token 数', () => {
            const messages = [{ role: 'user', content: 'Hello world' }];
            const tokens = estimateTokens(messages as any);
            // 11 字符 / 4 = ~3 tokens
            expect(tokens).toBeGreaterThan(0);
            expect(tokens).toBeLessThan(10);
        });

        it('应正确处理代码块（更高密度）', () => {
            const messages = [{ role: 'user', content: '```js\nconst x = 1;\n```' }];
            const tokens = estimateTokens(messages as any);
            // 代码块应该按 /3.5 计算
            expect(tokens).toBeGreaterThan(0);
        });

        it('应正确处理数组内容格式', () => {
            const messages = [{
                role: 'user',
                content: [{ type: 'text', text: 'Hello world' }],
            }];
            const tokens = estimateTokens(messages as any);
            expect(tokens).toBeGreaterThan(0);
        });

        it('应正确处理 tool_use 和 tool_result', () => {
            const messages = [
                {
                    role: 'assistant',
                    content: [{ type: 'tool_use', name: 'bash', id: 'tool_1' }],
                },
                {
                    role: 'user',
                    content: [{ type: 'tool_result', tool_use_id: 'tool_1', content: 'output' }],
                },
            ];
            const tokens = estimateTokens(messages as any);
            expect(tokens).toBeGreaterThan(0);
        });

        it('空消息应返回 0', () => {
            expect(estimateTokens([])).toBe(0);
        });
    });

    describe('compactIfNeeded', () => {
        it('未超过阈值时不应压缩', async () => {
            const messages = [
                { role: 'user', content: 'Hi' },
                { role: 'assistant', content: 'Hello' },
            ];

            const result = await compactIfNeeded(messages as any);

            expect(result.didCompact).toBe(false);
            expect(result.messages).toHaveLength(2);
        });

        it('禁用 compact 时不应压缩', async () => {
            mockConfig.claude.compact.enabled = false;

            // 生成足够多的长消息以超过阈值
            const longContent = 'a'.repeat(5000); // ~1250 tokens
            const messages = Array(10).fill(null).map(() => ({
                role: 'user',
                content: longContent,
            }));

            const result = await compactIfNeeded(messages as any);

            expect(result.didCompact).toBe(false);
            mockConfig.claude.compact.enabled = true; // 恢复
        });

        it('消息数量不足时不应压缩', async () => {
            // 只有 5 条消息，小于 preserve_rounds * 2 + 2
            const longContent = 'a'.repeat(5000);
            const messages = Array(5).fill(null).map(() => ({
                role: 'user',
                content: longContent,
            }));

            const result = await compactIfNeeded(messages as any);

            expect(result.didCompact).toBe(false);
        });

        it('超过阈值时应触发压缩', async () => {
            // 生成足够多的长消息以超过阈值
            const longContent = 'a'.repeat(5000); // ~1250 tokens each
            const messages = Array(20).fill(null).map((_, i) => ({
                role: i % 2 === 0 ? 'user' : 'assistant',
                content: longContent,
            }));

            const onEvent = vi.fn();
            const result = await compactIfNeeded(messages as any, undefined, undefined, onEvent);

            expect(result.didCompact).toBe(true);
            // 压缩后消息数 = 2 (摘要对话) + 8 (保留的4轮 * 2)
            expect(result.messages.length).toBeLessThan(messages.length);
            // 应该触发事件
            expect(onEvent).toHaveBeenCalledWith('compact_start', expect.any(Object));
            expect(onEvent).toHaveBeenCalledWith('compact_done', expect.any(Object));
        });

        it('压缩后的消息应包含摘要和保留的消息', async () => {
            const longContent = 'a'.repeat(5000);
            const messages = Array(20).fill(null).map((_, i) => ({
                role: i % 2 === 0 ? 'user' : 'assistant',
                content: longContent,
            }));

            const result = await compactIfNeeded(messages as any);

            expect(result.didCompact).toBe(true);
            // 第一条应该是用户发送的摘要
            expect(result.messages[0].role).toBe('user');
            expect((result.messages[0] as any).content).toContain('上下文摘要');
            // 第二条应该是 assistant 确认
            expect(result.messages[1].role).toBe('assistant');
        });

        it('应正确计算节省的 token 数', async () => {
            const longContent = 'a'.repeat(5000);
            const messages = Array(20).fill(null).map((_, i) => ({
                role: i % 2 === 0 ? 'user' : 'assistant',
                content: longContent,
            }));

            const result = await compactIfNeeded(messages as any);

            expect(result.didCompact).toBe(true);
            expect(result.compactedTokens).toBeLessThan(result.originalTokens);
            expect(result.summary).toBeDefined();
        });
    });

    describe('formatCompactLog', () => {
        it('未压缩时应返回正确格式', () => {
            const result: CompactResult = {
                messages: [],
                didCompact: false,
                originalTokens: 1000,
                compactedTokens: 1000,
            };

            const log = formatCompactLog(result);
            expect(log).toContain('未触发压缩');
            expect(log).toContain('1000');
        });

        it('压缩后应显示节省比例', () => {
            const result: CompactResult = {
                messages: [],
                didCompact: true,
                originalTokens: 4000,
                compactedTokens: 2000,
                summary: 'test summary',
            };

            const log = formatCompactLog(result);
            expect(log).toContain('4000 → 2000');
            expect(log).toContain('50.0%');
        });
    });

    describe('getAllCompactsLight', () => {
        beforeEach(() => {
            if (existsSync(testDbPath)) unlinkSync(testDbPath);
            if (existsSync(testDbPath + '-wal')) unlinkSync(testDbPath + '-wal');
            if (existsSync(testDbPath + '-shm')) unlinkSync(testDbPath + '-shm');
            initDb(testDbPath);
        });

        afterEach(() => {
            closeDb();
            if (existsSync(testDbPath)) unlinkSync(testDbPath);
            if (existsSync(testDbPath + '-wal')) unlinkSync(testDbPath + '-wal');
            if (existsSync(testDbPath + '-shm')) unlinkSync(testDbPath + '-shm');
        });

        it('should return empty array when no compacts exist', () => {
            const result = getAllCompactsLight('non-existent-session');
            expect(result).toEqual([]);
        });

        it('should return compact records without compacted_messages field', async () => {
            await saveCompact(
                'test-session',
                'test-workspace',
                'Test summary',
                [{ role: 'user', content: 'test' }],
                1000,
                500
            );

            const result = getAllCompactsLight('test-session');

            expect(result).toHaveLength(1);
            expect(result[0]).not.toHaveProperty('compacted_messages');
            expect(result[0]).toHaveProperty('id');
            expect(result[0]).toHaveProperty('session_id', 'test-session');
            expect(result[0]).toHaveProperty('workspace_id', 'test-workspace');
            expect(result[0]).toHaveProperty('compacted_at');
            expect(result[0].compacted_at).toBeGreaterThan(0);
            expect(result[0]).toHaveProperty('summary', 'Test summary');
            expect(result[0]).toHaveProperty('original_tokens', 1000);
            expect(result[0]).toHaveProperty('compacted_tokens', 500);
        });

        it('should return multiple compacts ordered by compacted_at ASC', async () => {
            await saveCompact(
                'test-session',
                'test-workspace',
                'First',
                [{ role: 'user', content: 'first' }],
                1000,
                500
            );

            await new Promise(r => setTimeout(r, 10));

            await saveCompact(
                'test-session',
                'test-workspace',
                'Second',
                [{ role: 'user', content: 'second' }],
                2000,
                1000
            );

            const result = getAllCompactsLight('test-session');

            expect(result).toHaveLength(2);
            expect(result[0].summary).toBe('First');
            expect(result[1].summary).toBe('Second');
            expect(result[0].compacted_at).toBeLessThan(result[1].compacted_at);
        });
    });

    describe('getLatestCompact', () => {
        beforeEach(() => {
            if (existsSync(testDbPath)) unlinkSync(testDbPath);
            if (existsSync(testDbPath + '-wal')) unlinkSync(testDbPath + '-wal');
            if (existsSync(testDbPath + '-shm')) unlinkSync(testDbPath + '-shm');
            initDb(testDbPath);
        });

        afterEach(() => {
            closeDb();
            if (existsSync(testDbPath)) unlinkSync(testDbPath);
            if (existsSync(testDbPath + '-wal')) unlinkSync(testDbPath + '-wal');
            if (existsSync(testDbPath + '-shm')) unlinkSync(testDbPath + '-shm');
        });

        it('should return null when no compacts exist', () => {
            const result = getLatestCompact('non-existent-session');
            expect(result).toBeNull();
        });

        it('should return the most recent compact by compacted_at', async () => {
            await saveCompact(
                'test-session',
                'test-workspace',
                'First summary',
                [{ role: 'user', content: 'first' }],
                1000,
                500
            );

            // Small delay to ensure different timestamps
            await new Promise(r => setTimeout(r, 10));

            await saveCompact(
                'test-session',
                'test-workspace',
                'Latest summary',
                [{ role: 'user', content: 'second' }],
                2000,
                1000
            );

            const result = getLatestCompact('test-session');

            expect(result).not.toBeNull();
            expect(result!.summary).toBe('Latest summary');
            expect(result!.compacted_tokens).toBe(1000);
            expect(result!.session_id).toBe('test-session');
        });

        it('should return the only compact when exactly one exists', async () => {
            await saveCompact(
                'only-session',
                'only-workspace',
                'Only summary',
                [{ role: 'user', content: 'only' }],
                500,
                250
            );

            const result = getLatestCompact('only-session');

            expect(result).not.toBeNull();
            expect(result!.summary).toBe('Only summary');
            expect(result!.original_tokens).toBe(500);
        });
    });
});
