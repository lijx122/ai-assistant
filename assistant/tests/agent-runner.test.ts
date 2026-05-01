import { describe, it, expect, beforeEach, afterEach, vi, Mock } from 'vitest';
import { getRunner, clearRunners, AgentRunner } from '../src/services/agent-runner';
import { loadConfig, resetConfig } from '../src/config';
import Anthropic from '@anthropic-ai/sdk';
import { executeTool } from '../src/services/tools';
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

// Mock tools module to avoid real tool execution in tests
vi.mock('../src/services/tools', () => ({
    registerAllTools: vi.fn(),
    getToolDefinitions: vi.fn().mockReturnValue([]),
    executeTool: vi.fn().mockResolvedValue({ success: true, data: {} }),
}));

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
        vi.mocked(executeTool).mockReset();
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

        await runner.run([], { systemPrompt: 'system', onEvent: cb });

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

        await runner.run([], { systemPrompt: 'sys', onEvent: cb });

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

        await runner.run([], { onEvent: cb });

        expect(events).toEqual([
            { type: 'error', payload: 'Network offline' }
        ]);
    });

    it('should not trigger maxRounds summary after abort()', async () => {
        const events: any[] = [];
        const cb = (type: string, payload: any) => events.push({ type, payload });

        const runner = getRunner('ws-1', cb);
        // Call abort() before run() — this sets the aborted flag so the
        // loop breaks immediately before any Anthropic API call is made.
        runner.abort();

        await runner.run(
            [{ role: 'user' as const, content: 'hello' }],
            { systemPrompt: 'sys', onEvent: cb }
        );

        // Should emit 'aborted' not 'done'. The maxRounds summary path
        // must NOT fire because terminated was set to true in the abort check.
        expect(events.find(e => e.type === 'aborted')).toBeDefined();
        expect(events.find(e => e.type === 'done')).toBeUndefined();

        // The mock Anthropic API should NOT have been called — the loop
        // breaks before reaching runOnce() → messages.create().
        const anthropicInstance = (Anthropic as unknown as Mock).mock.instances[0];
        expect(anthropicInstance.messages.create).not.toHaveBeenCalled();
    });

    // TODO: "should use maxRounds in summary prompt text"
    // Cannot test this with the current mock infrastructure. To reach maxRounds,
    // the agent loop must execute tool_use blocks each round, which requires:
    // (a) mock streams with content_block_start(tool_use) + input_json_delta +
    //     content_block_stop + message_stop per round, and
    // (b) working tool execution via executeTool() (tools are registered at
    //     module level by registerAllTools() and would fail against real
    //     filesystem/database). Adding full tool mocking is out of scope for
    //     this test suite at this point.

    it('should not make a second API call after abort() during multi-round run', async () => {
        // Regression test for: abort() path was missing `terminated = true`.
        // Without the fix, after abort breaks the loop, the `if (!terminated)`
        // block fires the maxRounds summary path, making a SECOND API call.
        const events: any[] = [];
        const cb = (type: string, payload: any) => events.push({ type, payload });
        const runner = getRunner('ws-abort-mid', cb);

        // Mock executeTool: when the runner executes the tool, it calls abort().
        // This simulates calling runner.abort() between round 1 and round 2.
        const mockExec = vi.mocked(executeTool);
        mockExec.mockImplementation(async () => {
            runner.abort();
            return { success: true, data: { result: 'tool-done' } };
        });

        // First API call returns a tool_use block.
        // Round 1 flow: API call → tool_use found → executeTool() → abort() called.
        // Round 2 flow: abort check at top of loop → break (terminated must be true).
        // If terminated stays false, the maxRounds summary path fires a SECOND API call.
        const toolUseStream = {
            [Symbol.asyncIterator]: async function* () {
                yield {
                    type: 'content_block_start',
                    content_block: { type: 'tool_use', id: 'tool-1', name: 'test_tool' },
                };
                yield {
                    type: 'content_block_delta',
                    delta: { type: 'input_json_delta', partial_json: '{}' },
                };
                yield { type: 'content_block_stop' };
                yield { type: 'message_stop', stop_reason: 'tool_use' };
            },
        };

        const anthropicInstance = (Anthropic as unknown as Mock).mock.instances[0];
        const createMock = anthropicInstance.messages.create;
        createMock.mockResolvedValue(toolUseStream);

        await runner.run(
            [{ role: 'user' as const, content: 'hello' }],
            { systemPrompt: 'sys', onEvent: cb }
        );

        // KEY ASSERTION: messages.create must be called exactly ONCE.
        // If the bug is reverted (terminated not set in abort path), the
        // maxRounds summary calls runOnce() → messages.create() a second time.
        expect(createMock).toHaveBeenCalledTimes(1);

        // Should emit 'aborted' (not 'done' which comes from maxRounds summary)
        expect(events.find(e => e.type === 'aborted')).toBeDefined();
        expect(events.find(e => e.type === 'done')).toBeUndefined();
    });
});
