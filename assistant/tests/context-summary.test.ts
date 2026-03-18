import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { estimateTokens, compactIfNeeded, formatCompactLog, CompactResult } from '../../src/services/context-summary';
import * as configModule from '../../src/config';

// Mock config
const mockConfig = {
    claude: {
        api_key: 'test_key',
        base_url: 'https://api.anthropic.com',
        model: 'claude-opus-4-6',
        max_tokens: 4096,
        count_tokens_enabled: false,
        count_tokens_fixed: 2000,
        context_window_messages: 0,
        compact: {
            enabled: true,
            threshold_ratio: 0.8,
            token_limit: 10000,  // 测试中设为较低值，使现有测试数据能触发压缩
            preserve_rounds: 4,
            summary_model: 'claude-haiku-4-5-20251001',
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
});
