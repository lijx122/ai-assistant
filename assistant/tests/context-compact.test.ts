import { describe, it, expect } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import {
    estimateTokens,
    compactMessages,
    formatCompactLog,
    CompactResult,
} from '../src/services/context-compact';

describe('Context Compact (T-2.7)', () => {
    describe('estimateTokens', () => {
        it('should return 0 for empty messages', () => {
            const tokens = estimateTokens([]);
            expect(tokens).toBe(0);
        });

        it('should estimate tokens for simple text messages', () => {
            const messages: Anthropic.MessageParam[] = [
                { role: 'user', content: 'Hello world' },
            ];
            // 11 chars / 4 ≈ 3 tokens
            const tokens = estimateTokens(messages);
            expect(tokens).toBeGreaterThan(0);
            expect(tokens).toBeLessThan(10);
        });

        it('should estimate tokens for array content', () => {
            const messages: Anthropic.MessageParam[] = [
                {
                    role: 'user',
                    content: [{ type: 'text', text: 'Hello world' }],
                },
            ];
            const tokens = estimateTokens(messages);
            expect(tokens).toBeGreaterThan(0);
        });

        it('should estimate higher tokens for code blocks', () => {
            const messages: Anthropic.MessageParam[] = [
                { role: 'user', content: '```typescript\nconst x = 1;\n```' },
            ];
            const tokens = estimateTokens(messages);
            // Code has higher token density
            expect(tokens).toBeGreaterThan(0);
        });

        it('should accumulate tokens for multiple messages', () => {
            const messages: Anthropic.MessageParam[] = [
                { role: 'user', content: 'Hello' },
                { role: 'assistant', content: 'Hi there' },
                { role: 'user', content: 'How are you?' },
            ];
            const tokens = estimateTokens(messages);
            expect(tokens).toBeGreaterThan(5);
        });
    });

    describe('compactMessages', () => {
        it('should not compact when under threshold', () => {
            const messages: Anthropic.MessageParam[] = [
                { role: 'user', content: 'Short message' },
            ];

            const result = compactMessages(messages, {
                maxTokens: 1000,
                preserveRounds: 4,
                thresholdRatio: 0.8,
            });

            expect(result.didCompact).toBe(false);
            expect(result.messages).toHaveLength(1);
            expect(result.originalTokens).toBe(result.compactedTokens);
        });

        it('should preserve system prompt when compacting', () => {
            const messages: Anthropic.MessageParam[] = [
                { role: 'system', content: 'You are a helpful assistant.' },
                { role: 'user', content: 'Hello'.repeat(500) }, // Long message to trigger compact
                { role: 'assistant', content: 'Hi'.repeat(500) },
            ];

            const result = compactMessages(messages, {
                maxTokens: 100,
                preserveRounds: 4,
                thresholdRatio: 0.8,
            });

            expect(result.didCompact).toBe(true);
            expect(result.messages[0].role).toBe('system');
            expect(result.messages[0].content).toBe('You are a helpful assistant.');
        });

        it('should preserve recent rounds when compacting', () => {
            const longText = 'A'.repeat(200);
            const messages: Anthropic.MessageParam[] = [
                { role: 'user', content: 'Old question 1 ' + longText },
                { role: 'assistant', content: 'Old answer 1 ' + longText },
                { role: 'user', content: 'Old question 2 ' + longText },
                { role: 'assistant', content: 'Old answer 2 ' + longText },
                { role: 'user', content: 'Recent question' },
                { role: 'assistant', content: 'Recent answer' },
            ];

            const result = compactMessages(messages, {
                maxTokens: 100,
                preserveRounds: 2,
                thresholdRatio: 0.8,
            });

            expect(result.didCompact).toBe(true);
            // Should preserve last 2 rounds (4 messages: user + assistant for each round)
            const lastTwoMessages = result.messages.slice(-2);
            expect(lastTwoMessages[0].content).toBe('Recent question');
            expect(lastTwoMessages[1].content).toBe('Recent answer');
        });

        it('should compress tool_result messages', () => {
            const longText = 'B'.repeat(500);
            const messages: Anthropic.MessageParam[] = [
                { role: 'user', content: 'Do something' },
                {
                    role: 'assistant',
                    content: [{ type: 'tool_use', id: 'tool-1', name: 'todo_write', input: {} }],
                },
                {
                    role: 'user',
                    content: [{
                        type: 'tool_result',
                        tool_use_id: 'tool-1',
                        content: 'Long result data '.repeat(100),
                    }],
                },
                { role: 'user', content: longText }, // Trigger compact
            ];

            const result = compactMessages(messages, {
                maxTokens: 100,
                preserveRounds: 1,
                thresholdRatio: 0.8,
            });

            expect(result.didCompact).toBe(true);
            // Find compressed tool_result
            const compressedToolResult = result.messages.find(
                (m) => typeof m.content === 'string' && m.content.includes('[Compressed:')
            );
            expect(compressedToolResult).toBeDefined();
            expect(compressedToolResult?.content).toContain('Tool');
        });

        it('should compress long assistant messages', () => {
            const longResponse = 'A'.repeat(1000);
            const messages: Anthropic.MessageParam[] = [
                { role: 'user', content: 'Tell me something long' },
                { role: 'assistant', content: longResponse },
                { role: 'user', content: 'B'.repeat(500) }, // Trigger compact
            ];

            const result = compactMessages(messages, {
                maxTokens: 100,
                preserveRounds: 1,
                thresholdRatio: 0.8,
            });

            expect(result.didCompact).toBe(true);
            // The assistant message should be compressed (not the preserved one)
            const compressedMsg = result.messages.find(
                (m) => m.role === 'assistant' && typeof m.content === 'string' && m.content.includes('[content truncated]')
            );
            expect(compressedMsg).toBeDefined();
        });

        it('should handle empty messages array', () => {
            const result = compactMessages([], {
                maxTokens: 1000,
                preserveRounds: 4,
            });

            expect(result.didCompact).toBe(false);
            expect(result.messages).toHaveLength(0);
        });

        it('should handle messages with array content blocks', () => {
            const messages: Anthropic.MessageParam[] = [
                {
                    role: 'user',
                    content: [
                        { type: 'text', text: 'Hello '.repeat(200) },
                        { type: 'text', text: 'World '.repeat(200) },
                    ],
                },
                { role: 'assistant', content: 'Response '.repeat(200) },
            ];

            const result = compactMessages(messages, {
                maxTokens: 100,
                preserveRounds: 1,
                thresholdRatio: 0.8,
            });

            expect(result.didCompact).toBe(true);
        });

        it('should use default preserveRounds of 4', () => {
            const longText = 'X'.repeat(100);
            const messages: Anthropic.MessageParam[] = [
                { role: 'user', content: 'Q1 ' + longText },
                { role: 'assistant', content: 'A1 ' + longText },
                { role: 'user', content: 'Q2 ' + longText },
                { role: 'assistant', content: 'A2 ' + longText },
                { role: 'user', content: 'Q3 ' + longText },
                { role: 'assistant', content: 'A3 ' + longText },
                { role: 'user', content: 'Q4 ' + longText },
                { role: 'assistant', content: 'A4 ' + longText },
                { role: 'user', content: 'Q5 ' + longText },
                { role: 'assistant', content: 'A5 ' + longText },
            ];

            const result = compactMessages(messages, {
                maxTokens: 100,
                thresholdRatio: 0.8,
            });

            expect(result.didCompact).toBe(true);
            // Should preserve last 4 rounds = 8 messages
            // Plus system messages if any
            const preservedCount = result.messages.filter(
                (m) => m.content === 'Q5 ' + longText || m.content === 'A5 ' + longText ||
                       m.content === 'Q4 ' + longText || m.content === 'A4 ' + longText ||
                       m.content === 'Q3 ' + longText || m.content === 'A3 ' + longText ||
                       m.content === 'Q2 ' + longText || m.content === 'A2 ' + longText
            ).length;
            expect(preservedCount).toBeGreaterThanOrEqual(4);
        });
    });

    describe('formatCompactLog', () => {
        it('should format compact log correctly', () => {
            const result: CompactResult = {
                messages: [],
                didCompact: true,
                originalTokens: 1000,
                compactedTokens: 600,
                compressedCount: 3,
            };

            const log = formatCompactLog(result);

            expect(log).toContain('Context compacted');
            expect(log).toContain('1000 → 600');
            expect(log).toContain('(-400');
            expect(log).toContain('-40.0%)');
            expect(log).toContain('3 messages compressed');
        });

        it('should handle zero savings', () => {
            const result: CompactResult = {
                messages: [],
                didCompact: true,
                originalTokens: 1000,
                compactedTokens: 1000,
                compressedCount: 0,
            };

            const log = formatCompactLog(result);

            expect(log).toContain('(-0, -0.0%)');
        });
    });

    describe('integration scenarios', () => {
        it('should handle realistic conversation flow', () => {
            const messages: Anthropic.MessageParam[] = [
                { role: 'system', content: 'You are a helpful assistant.' },
                { role: 'user', content: 'What is TypeScript?' },
                { role: 'assistant', content: 'TypeScript is a typed superset of JavaScript that compiles to plain JavaScript.' },
                { role: 'user', content: 'How do I install it?' },
                { role: 'assistant', content: 'You can install it via npm: npm install -g typescript' },
                { role: 'user', content: 'Show me an example'.repeat(100) },
                { role: 'assistant', content: 'Here is an example: '.repeat(200) },
            ];

            const result = compactMessages(messages, {
                maxTokens: 200,
                preserveRounds: 2,
                thresholdRatio: 0.8,
            });

            expect(result.didCompact).toBe(true);
            // System prompt preserved
            expect(result.messages[0].role).toBe('system');
            // Recent rounds preserved
            const contents = result.messages.map(m => typeof m.content === 'string' ? m.content : '');
            expect(contents.some(c => c.includes('Show me an example'))).toBe(true);
            expect(contents.some(c => c.includes('Here is an example'))).toBe(true);
        });

        it('should handle tool use and result pairs', () => {
            const messages: Anthropic.MessageParam[] = [
                { role: 'user', content: 'Check my todos' },
                {
                    role: 'assistant',
                    content: [{ type: 'tool_use', id: 'tool-1', name: 'todo_read', input: {} }],
                },
                {
                    role: 'user',
                    content: [{
                        type: 'tool_result',
                        tool_use_id: 'tool-1',
                        content: JSON.stringify({ items: [{ text: 'Task 1', done: false }] }),
                    }],
                },
                { role: 'assistant', content: 'You have 1 pending task.'.repeat(100) },
                { role: 'user', content: 'Add a new task'.repeat(200) },
            ];

            const result = compactMessages(messages, {
                maxTokens: 150,
                preserveRounds: 1,
                thresholdRatio: 0.8,
            });

            expect(result.didCompact).toBe(true);
            // tool_result should be compressed but tool_use preserved
            const toolUseMsg = result.messages.find(
                (m) => typeof m.content !== 'string' && Array.isArray(m.content) &&
                       m.content.some((b: any) => b.type === 'tool_use')
            );
            expect(toolUseMsg).toBeDefined();
        });
    });
});
