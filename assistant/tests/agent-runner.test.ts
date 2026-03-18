import { describe, it, expect, beforeEach, afterEach, vi, Mock } from 'vitest';
import { getRunner, clearRunners, AgentRunner } from '../src/services/agent-runner';
import { loadConfig, resetConfig } from '../src/config';
import Anthropic from '@anthropic-ai/sdk';
import { writeFileSync, unlinkSync, existsSync } from 'fs';
import { resolve } from 'path';

const testConfigPath = resolve(__dirname, 'test-config-runner.yaml');

// Mock Anthropic module globally
vi.mock('@anthropic-ai/sdk', () => {
    const AnthropicMock = vi.fn();
    AnthropicMock.prototype.messages = {
        create: vi.fn()
    };
    return { default: AnthropicMock };
});

describe('AgentRunner Module (T-2.2)', () => {
    beforeEach(() => {
        writeFileSync(testConfigPath, `
server: { port: 8888 }
auth: { jwt_secret: "test", token_expire_days: 1 }
claude:
  api_key: "sk-mock-key"
  base_url: "https://api.test.com"
  model: "claude-mock-model"
  max_tokens: 1000
runner:
  idle_timeout_minutes: 60
terminal: {}
files: {}
memory: {}
lark: {}
tasks: {}
logs: {}
    `);
        resetConfig();
        loadConfig(testConfigPath);
        clearRunners();
        vi.clearAllMocks();
    });

    afterEach(() => {
        clearRunners();
        if (existsSync(testConfigPath)) unlinkSync(testConfigPath);
    });

    const setupMockStream = (chunks: any[]) => {
        const mockController = { abort: vi.fn() };
        const asyncIterable = {
            [Symbol.asyncIterator]: async function* () {
                for (const chunk of chunks) {
                    yield chunk;
                }
            },
            controller: mockController
        };
        const anthropicInstance = (Anthropic as unknown as Mock).mock.instances[0];
        anthropicInstance.messages.create.mockResolvedValue(asyncIterable);
        return mockController;
    };

    it('should create and return the same runner for the same workspace', () => {
        const cb = vi.fn();
        const runner1 = getRunner('ws-1', cb);
        const runner2 = getRunner('ws-1', cb);
        const runner3 = getRunner('ws-2', cb);

        expect(runner1).toBe(runner2);
        expect(runner1).not.toBe(runner3);
    });

    it('should handle text delta stream perfectly', async () => {
        const events: any[] = [];
        const cb = (type: string, payload: any) => events.push({ type, payload });

        const runner = getRunner('ws-1', cb);

        setupMockStream([
            { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } },
            { type: 'content_block_delta', delta: { type: 'text_delta', text: ' World' } },
            { type: 'message_stop' }
        ]);

        await runner.run([], 'system', cb);

        expect(events).toEqual([
            { type: 'text', payload: 'Hello' },
            { type: 'text', payload: ' World' },
            { type: 'done', payload: null }
        ]);
    });

    it('should abort cleanly if destroyed during run', async () => {
        const events: any[] = [];
        const cb = (type: string, payload: any) => events.push({ type, payload });

        const runner = getRunner('ws-1', cb);

        // Send one chunk, then destroy the runner before the second
        let streamStep = 0;
        const mockController = { abort: vi.fn() };
        const asyncIterable = {
            [Symbol.asyncIterator]: async function* () {
                yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Chunk1' } };
                runner.destroy();
                yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Chunk2' } };
            },
            controller: mockController
        };

        const anthropicInstance = (Anthropic as unknown as Mock).mock.instances[0];
        anthropicInstance.messages.create.mockResolvedValue(asyncIterable);

        await runner.run([], 'sys', cb);

        expect(events.find(e => e.payload === 'Chunk1')).toBeDefined();
        expect(events.find(e => e.payload === 'Chunk2')).toBeUndefined();
        expect(events.find(e => e.type === 'error' && e.payload === 'Runner aborted mid-stream')).toBeDefined();
        expect(mockController.abort).toHaveBeenCalled();
    });

    it('should handle underlying API initialization error', async () => {
        const events: any[] = [];
        const cb = (type: string, payload: any) => events.push({ type, payload });

        const runner = getRunner('ws-1', cb);
        const anthropicInstance = (Anthropic as unknown as Mock).mock.instances[0];
        anthropicInstance.messages.create.mockRejectedValue(new Error('Network offline'));

        await runner.run([], undefined, cb);

        expect(events).toEqual([
            { type: 'error', payload: 'Network offline' }
        ]);
    });
});
