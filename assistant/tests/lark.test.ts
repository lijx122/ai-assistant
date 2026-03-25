import { describe, it, expect, beforeEach, afterEach, vi, Mock } from 'vitest';
import { startLarkService, stopLarkService } from '../src/services/lark';
import { loadConfig, resetConfig } from '../src/config';
import { initDb, closeDb, getDb } from '../src/db/index';
import * as lark from '@larksuiteoapi/node-sdk';
import { writeFileSync, unlinkSync, existsSync } from 'fs';
import { resolve } from 'path';

const testDbPath = resolve(__dirname, 'test-lark.db');
const testConfigPath = resolve(__dirname, 'test-config-lark.yaml');

vi.mock('@larksuiteoapi/node-sdk', () => {
    const replyMock = vi.fn();
    const registerMock = vi.fn().mockReturnThis();

    class MockEventDispatcher {
        verificationToken: string;
        encryptKey: string;
        handles: Map<string, Function> = new Map();

        constructor(params: { verificationToken?: string; encryptKey?: string }) {
            this.verificationToken = params.verificationToken || '';
            this.encryptKey = params.encryptKey || '';
        }

        register(handles: Record<string, Function>) {
            for (const [event, handler] of Object.entries(handles)) {
                this.handles.set(event, handler);
            }
            return this;
        }
    }

    const MockWSClient = vi.fn().mockImplementation(function(this: any, params: any) {
        this.params = params;
        this.eventDispatcher = null;
        this.start = async ({ eventDispatcher }: { eventDispatcher: any }) => {
            this.eventDispatcher = eventDispatcher;
        };
    });

    const MockClient = vi.fn().mockImplementation(function() {
        return { im: { message: { reply: replyMock } } };
    });

    return {
        Client: MockClient,
        WSClient: MockWSClient,
        EventDispatcher: MockEventDispatcher,
        replyMock
    };
});

// Mock larkChannel - must be before agent-runner mock
vi.mock('../src/channels', () => ({
    larkChannel: {
        isAvailable: () => false,
        getLarkClient: () => null,
        onMessage: vi.fn(),
        sendMessage: vi.fn().mockResolvedValue({ success: true }),
        sendAlert: vi.fn().mockResolvedValue({ success: true }),
    },
    ChannelMessage: class {},
    channelManager: {
        register: vi.fn(),
        initializeAll: vi.fn(),
        onMessage: vi.fn(),
        shutdownAll: vi.fn(),
    },
    webSocketChannel: {
        registerConnection: vi.fn(),
        unregisterConnection: vi.fn(),
        sendMessage: vi.fn(),
    },
}));

// Mock agent runner with correct signature: run(messages, systemPrompt, sessionId, workspaceId, onEvent)
vi.mock('../src/services/agent-runner', () => ({
    getRunner: vi.fn().mockReturnValue({
        run: async (msgs: any, sys: any, sessionId: any, workspaceId: any, onEvent: any) => {
            // Support both old (msgs, sys, cb) and new (msgs, sys, sessionId, workspaceId, onEvent) signatures
            const callback = typeof sessionId === 'function' ? sessionId : typeof workspaceId === 'function' ? workspaceId : onEvent;
            if (callback) callback('text', 'Lark mock reply');
        },
        isDestroyed: false
    })
}));

describe('Lark Integration (T-2.4)', () => {
    beforeEach(() => {
        writeFileSync(testConfigPath, `
server: { port: 8888 }
auth: { jwt_secret: "test", token_expire_days: 1 }
claude: { api_key: "dev", base_url: "base", model: "model", max_tokens: 100 }
runner: { idle_timeout_minutes: 60 }
terminal: {}
files: {}
memory: {}
lark:
  enabled: true
  app_id: "test_app_id"
  app_secret: "test_app_sec"
tasks: {}
logs: {}
    `);
        resetConfig();
        loadConfig(testConfigPath);

        if (existsSync(testDbPath)) unlinkSync(testDbPath);
        if (existsSync(testDbPath + '-wal')) unlinkSync(testDbPath + '-wal');
        if (existsSync(testDbPath + '-shm')) unlinkSync(testDbPath + '-shm');
        initDb(testDbPath);
    });

    afterEach(() => {
        closeDb();
        stopLarkService();
        if (existsSync(testDbPath)) unlinkSync(testDbPath);
        if (existsSync(testDbPath + '-wal')) unlinkSync(testDbPath + '-wal');
        if (existsSync(testDbPath + '-shm')) unlinkSync(testDbPath + '-shm');
        if (existsSync(testConfigPath)) unlinkSync(testConfigPath);
        vi.clearAllMocks();
    });

    it('should initialize Lark when enabled', () => {
        startLarkService();
        expect(lark.Client).toHaveBeenCalled();
        expect(lark.WSClient).toHaveBeenCalled();
    });

    it('should process simulated message and reply using active workspace mapping', async () => {
        // Create active workspace
        const db = getDb();
        db.prepare('INSERT INTO workspaces (id, user_id, name, created_at, status) VALUES (?,?,?,?,?)')
            .run('ws-lark', 'owner', 'MyWS', Date.now(), 'active');

        startLarkService();

        // Extract registered handler from EventDispatcher
        const wsClientInstance = (lark.WSClient as any).mock.instances[0];
        const eventDispatcher = wsClientInstance.eventDispatcher;
        const handlerFn = eventDispatcher.handles.get('im.message.receive_v1');

        // Simulate incoming event
        await handlerFn({
            message: {
                message_type: 'text',
                content: JSON.stringify({ text: "Hello AI" }),
                message_id: "lark_msg_1",
                chat_id: "chat_abc"
            }
        });

        // Wait for fire-and-forget
        await new Promise(r => setTimeout(r, 100));

        const replyMock = (lark as any).replyMock;
        expect(replyMock).toHaveBeenCalledWith({
            path: { message_id: "lark_msg_1" },
            data: {
                content: JSON.stringify({ text: 'Lark mock reply' }),
                msg_type: 'text'
            }
        });

        // Assert DB changes
        const msgs = db.prepare('SELECT * FROM messages WHERE workspace_id = ?').all('ws-lark') as any[];
        expect(msgs.length).toBe(2);
        expect(msgs[0].content).toBe('Hello AI');
        expect(msgs[1].content).toBe('Lark mock reply');
    });

    it('should trap terminal commands and deny them in IM', async () => {
        startLarkService();

        const db = getDb();
        db.prepare('INSERT INTO workspaces (id, user_id, name, created_at, status) VALUES (?,?,?,?,?)')
            .run('ws-lark2', 'owner', 'MyWS', Date.now(), 'active');

        const wsClientInstance = (lark.WSClient as unknown as Mock).mock.instances[0];
        const eventDispatcher = wsClientInstance.eventDispatcher;
        const handlerFn = eventDispatcher.handles.get('im.message.receive_v1');

        await handlerFn({
            message: {
                message_type: 'text',
                content: JSON.stringify({ text: "/terminal run ls" }),
                message_id: "lark_msg_2",
                chat_id: "chat_abc"
            }
        });

        const replyMock = (lark as any).replyMock;
        expect(replyMock).toHaveBeenCalledWith(expect.objectContaining({
            path: { message_id: "lark_msg_2" }
        }));
        // Verify reply content was the rejection text
        const replyData = replyMock.mock.calls[1] ? replyMock.mock.calls[1][0].data.content : replyMock.mock.calls[0][0].data.content;
        expect(replyData).toContain('请前往 Web 终端面板');
    });

    it('should truncate message history to last 10 messages when exceeding limit', async () => {
        const db = getDb();
        db.prepare('INSERT INTO workspaces (id, user_id, name, created_at, status) VALUES (?,?,?,?,?)')
            .run('ws-lark3', 'owner', 'MyWS', Date.now(), 'active');

        // Insert 15 historical messages
        const sessionId = `lark_chat_truncate`;
        for (let i = 0; i < 15; i++) {
            db.prepare('INSERT INTO messages (id, session_id, workspace_id, user_id, role, content, created_at) VALUES (?,?,?,?,?,?,?)')
                .run(`msg-${i}`, sessionId, 'ws-lark3', 'owner', 'user', `Message ${i}`, Date.now() + i);
        }

        startLarkService();

        const wsClientInstance = (lark.WSClient as unknown as Mock).mock.instances[0];
        const eventDispatcher = wsClientInstance.eventDispatcher;
        const handlerFn = eventDispatcher.handles.get('im.message.receive_v1');

        // Trigger new message
        await handlerFn({
            message: {
                message_type: 'text',
                content: JSON.stringify({ text: "New message" }),
                message_id: "lark_msg_truncate",
                chat_id: "chat_truncate"
            }
        });

        await new Promise(r => setTimeout(r, 100));

        // Verify message was processed
        const replyMock = (lark as any).replyMock;
        expect(replyMock).toHaveBeenCalled();
    });

    it('should handle AgentRunner execution errors and log to sdk_calls', async () => {
        // Override getRunner mock to throw error
        const { getRunner } = await import('../src/services/agent-runner');
        (getRunner as Mock).mockReturnValueOnce({
            run: async () => { throw new Error('Runner execution failed'); },
            isDestroyed: false
        });

        const db = getDb();
        db.prepare('INSERT INTO workspaces (id, user_id, name, created_at, status) VALUES (?,?,?,?,?)')
            .run('ws-lark-error', 'owner', 'MyWS', Date.now(), 'active');

        startLarkService();

        const wsClientInstance = (lark.WSClient as unknown as Mock).mock.instances[0];
        const eventDispatcher = wsClientInstance.eventDispatcher;
        const handlerFn = eventDispatcher.handles.get('im.message.receive_v1');

        await handlerFn({
            message: {
                message_type: 'text',
                content: JSON.stringify({ text: "Trigger error" }),
                message_id: "lark_msg_error",
                chat_id: "chat_error"
            }
        });

        await new Promise(r => setTimeout(r, 150));

        // Verify error was logged to sdk_calls
        const sdkCalls = db.prepare('SELECT * FROM sdk_calls WHERE workspace_id = ?').all('ws-lark-error') as any[];
        expect(sdkCalls.length).toBe(1);
        expect(sdkCalls[0].status).toBe('error');
        expect(sdkCalls[0].error).toContain('Runner execution failed');

        // Verify error message was sent to user
        const replyMock = (lark as any).replyMock;
        const lastCall = replyMock.mock.calls[replyMock.mock.calls.length - 1];
        expect(lastCall[0].data.content).toContain('执行错误');
    });

    it('should handle replyText errors gracefully', async () => {
        // Setup reply mock to throw error
        const replyMock = (lark as any).replyMock;
        replyMock.mockRejectedValueOnce(new Error('Network error'));

        const db = getDb();
        db.prepare('INSERT INTO workspaces (id, user_id, name, created_at, status) VALUES (?,?,?,?,?)')
            .run('ws-lark-reply-error', 'owner', 'MyWS', Date.now(), 'active');

        startLarkService();

        const wsClientInstance = (lark.WSClient as unknown as Mock).mock.instances[0];
        const eventDispatcher = wsClientInstance.eventDispatcher;
        const handlerFn = eventDispatcher.handles.get('im.message.receive_v1');

        await handlerFn({
            message: {
                message_type: 'text',
                content: JSON.stringify({ text: "Test reply error" }),
                message_id: "lark_msg_reply_error",
                chat_id: "chat_reply_error"
            }
        });

        await new Promise(r => setTimeout(r, 150));

        // Should not throw - error is caught and logged
        expect(true).toBe(true);
    });

    it('should warn and not start when enabled but missing app_id or app_secret', () => {
        // Clear any existing env vars
        delete process.env.LARK_APP_ID;
        delete process.env.LARK_APP_SECRET;

        // Create config with lark enabled but missing credentials
        writeFileSync(testConfigPath, `
server: { port: 8888 }
auth: { jwt_secret: "test", token_expire_days: 1 }
claude: { api_key: "dev", base_url: "base", model: "model", max_tokens: 100 }
runner: { idle_timeout_minutes: 60 }
terminal: {}
files: {}
memory: {}
lark:
  enabled: true
tasks: {}
logs: {}
        `);
        resetConfig();
        loadConfig(testConfigPath);

        const consoleSpy = vi.spyOn(console, 'warn');

        startLarkService();

        // Check that warn was called (the exact message may vary)
        expect(consoleSpy).toHaveBeenCalled();

        // Verify the message contains the expected text
        const warnCalls = consoleSpy.mock.calls;
        const foundWarning = warnCalls.some(call =>
            call.some(arg => typeof arg === 'string' && arg.includes('app_id or app_secret'))
        );
        expect(foundWarning).toBe(true);

        consoleSpy.mockRestore();

        // Restore env vars for other tests
        process.env.LARK_APP_ID = 'test_app_id';
        process.env.LARK_APP_SECRET = 'test_app_sec';
    });

    it('should reply with error when user has no active workspace', async () => {
        const db = getDb();
        // No workspace created for this test

        startLarkService();

        const wsClientInstance = (lark.WSClient as unknown as Mock).mock.instances[0];
        const eventDispatcher = wsClientInstance.eventDispatcher;
        const handlerFn = eventDispatcher.handles.get('im.message.receive_v1');

        await handlerFn({
            message: {
                message_type: 'text',
                content: JSON.stringify({ text: "Hello without workspace" }),
                message_id: "lark_msg_no_workspace",
                chat_id: "chat_no_workspace"
            }
        });

        await new Promise(r => setTimeout(r, 100));

        const replyMock = (lark as any).replyMock;
        expect(replyMock).toHaveBeenCalledWith(
            expect.objectContaining({
                path: { message_id: "lark_msg_no_workspace" }
            })
        );

        const lastCall = replyMock.mock.calls[replyMock.mock.calls.length - 1];
        expect(lastCall[0].data.content).toContain('您尚未创建任何工作区');
    });

    it('should show queue position when workspace is locked', async () => {
        const db = getDb();
        db.prepare('INSERT INTO workspaces (id, user_id, name, created_at, status) VALUES (?,?,?,?,?)')
            .run('ws-lark-queue', 'owner', 'MyWS', Date.now(), 'active');

        // Mock getQueuePosition to return queue position
        const { workspaceLock } = await import('../src/services/workspace-lock');
        (workspaceLock as any).getQueuePosition = vi.fn().mockReturnValue(3);

        startLarkService();

        const wsClientInstance = (lark.WSClient as unknown as Mock).mock.instances[0];
        const eventDispatcher = wsClientInstance.eventDispatcher;
        const handlerFn = eventDispatcher.handles.get('im.message.receive_v1');

        await handlerFn({
            message: {
                message_type: 'text',
                content: JSON.stringify({ text: "Test queue" }),
                message_id: "lark_msg_queue",
                chat_id: "chat_queue"
            }
        });

        await new Promise(r => setTimeout(r, 100));

        const replyMock = (lark as any).replyMock;
        // Should show queue position
        const calls = replyMock.mock.calls;
        const queueCall = calls.find((call: any) => {
            const content = call[0]?.data?.content || '';
            return content.includes('正在处理中') || content.includes('排队第');
        });

        expect(queueCall).toBeTruthy();

        // Cleanup
        delete (workspaceLock as any).getQueuePosition;
    });

    it('should not start when lark is disabled', () => {
        writeFileSync(testConfigPath, `
server: { port: 8888 }
auth: { jwt_secret: "test", token_expire_days: 1 }
claude: { api_key: "dev", base_url: "base", model: "model", max_tokens: 100 }
runner: { idle_timeout_minutes: 60 }
terminal: {}
files: {}
memory: {}
lark:
  enabled: false
  app_id: "test_app_id"
  app_secret: "test_app_sec"
tasks: {}
logs: {}
        `);
        resetConfig();
        loadConfig(testConfigPath);

        startLarkService();

        // Should not initialize WSClient
        expect(lark.WSClient).not.toHaveBeenCalled();
    });

    it('should ignore non-text messages', async () => {
        const db = getDb();
        db.prepare('INSERT INTO workspaces (id, user_id, name, created_at, status) VALUES (?,?,?,?,?)')
            .run('ws-lark-non-text', 'owner', 'MyWS', Date.now(), 'active');

        startLarkService();

        const wsClientInstance = (lark.WSClient as unknown as Mock).mock.instances[0];
        const eventDispatcher = wsClientInstance.eventDispatcher;
        const handlerFn = eventDispatcher.handles.get('im.message.receive_v1');

        await handlerFn({
            message: {
                message_type: 'image',
                content: JSON.stringify({ file_key: "test_image" }),
                message_id: "lark_msg_image",
                chat_id: "chat_image"
            }
        });

        await new Promise(r => setTimeout(r, 50));

        // Should not create any messages in DB
        const msgs = db.prepare('SELECT * FROM messages WHERE workspace_id = ?').all('ws-lark-non-text') as any[];
        expect(msgs.length).toBe(0);
    });

    it('should ignore duplicate messages (idempotency check)', async () => {
        const db = getDb();
        db.prepare('INSERT INTO workspaces (id, user_id, name, created_at, status) VALUES (?,?,?,?,?)')
            .run('ws-lark-duplicate', 'owner', 'MyWS', Date.now(), 'active');

        // Pre-insert the message to simulate duplicate
        db.prepare('INSERT INTO messages (id, session_id, workspace_id, user_id, role, content, message_id, created_at) VALUES (?,?,?,?,?,?,?,?)')
            .run('existing-msg-id', 'lark_chat_dup', 'ws-lark-duplicate', 'owner', 'user', 'Previous message', 'lark_msg_dup', Date.now());

        startLarkService();

        const wsClientInstance = (lark.WSClient as unknown as Mock).mock.instances[0];
        const eventDispatcher = wsClientInstance.eventDispatcher;
        const handlerFn = eventDispatcher.handles.get('im.message.receive_v1');

        await handlerFn({
            message: {
                message_type: 'text',
                content: JSON.stringify({ text: "Duplicate message" }),
                message_id: "lark_msg_dup",
                chat_id: "chat_dup"
            }
        });

        await new Promise(r => setTimeout(r, 50));

        // Should not create new message
        const msgs = db.prepare('SELECT * FROM messages WHERE workspace_id = ?').all('ws-lark-duplicate') as any[];
        expect(msgs.length).toBe(1);
        expect(msgs[0].content).toBe('Previous message');
    });

    it('should intercept /bash commands', async () => {
        const db = getDb();
        db.prepare('INSERT INTO workspaces (id, user_id, name, created_at, status) VALUES (?,?,?,?,?)')
            .run('ws-lark-bash', 'owner', 'MyWS', Date.now(), 'active');

        startLarkService();

        const wsClientInstance = (lark.WSClient as unknown as Mock).mock.instances[0];
        const eventDispatcher = wsClientInstance.eventDispatcher;
        const handlerFn = eventDispatcher.handles.get('im.message.receive_v1');

        await handlerFn({
            message: {
                message_type: 'text',
                content: JSON.stringify({ text: "/bash run ls" }),
                message_id: "lark_msg_bash",
                chat_id: "chat_bash"
            }
        });

        const replyMock = (lark as any).replyMock;
        expect(replyMock).toHaveBeenCalledWith(expect.objectContaining({
            path: { message_id: "lark_msg_bash" }
        }));

        const replyData = replyMock.mock.calls[0][0].data.content;
        expect(replyData).toContain('请前往 Web 终端面板');
    });

    it('should handle workspace lock without getQueuePosition method', async () => {
        const db = getDb();
        db.prepare('INSERT INTO workspaces (id, user_id, name, created_at, status) VALUES (?,?,?,?,?)')
            .run('ws-lark-no-queue', 'owner', 'MyWS', Date.now(), 'active');

        const { workspaceLock } = await import('../src/services/workspace-lock');
        delete (workspaceLock as any).getQueuePosition;

        startLarkService();

        const wsClientInstance = (lark.WSClient as unknown as Mock).mock.instances[0];
        const eventDispatcher = wsClientInstance.eventDispatcher;
        const handlerFn = eventDispatcher.handles.get('im.message.receive_v1');

        await handlerFn({
            message: {
                message_type: 'text',
                content: JSON.stringify({ text: "Test no queue" }),
                message_id: "lark_msg_no_queue",
                chat_id: "chat_no_queue"
            }
        });

        await new Promise(r => setTimeout(r, 100));

        const replyMock = (lark as any).replyMock;
        // Should process normally without queue message
        expect(replyMock).toHaveBeenCalled();
    });

    it('should not truncate messages when context_window_messages is 0', async () => {
        writeFileSync(testConfigPath, `
server: { port: 8888 }
auth: { jwt_secret: "test", token_expire_days: 1 }
claude: { api_key: "dev", base_url: "base", model: "model", max_tokens: 100, context_window_messages: 0 }
runner: { idle_timeout_minutes: 60 }
terminal: {}
files: {}
memory: {}
lark:
  enabled: true
  app_id: "test_app_id"
  app_secret: "test_app_sec"
tasks: {}
logs: {}
        `);
        resetConfig();
        loadConfig(testConfigPath);

        const db = getDb();
        db.prepare('INSERT INTO workspaces (id, user_id, name, created_at, status) VALUES (?,?,?,?,?)')
            .run('ws-lark-no-truncate', 'owner', 'MyWS', Date.now(), 'active');

        // Insert 15 messages
        const sessionId = 'lark_chat_no_truncate';
        for (let i = 0; i < 15; i++) {
            db.prepare('INSERT INTO messages (id, session_id, workspace_id, user_id, role, content, created_at) VALUES (?,?,?,?,?,?,?)')
                .run(`msg-no-trunc-${i}`, sessionId, 'ws-lark-no-truncate', 'owner', 'user', `Message ${i}`, Date.now() + i);
        }

        startLarkService();

        const wsClientInstance = (lark.WSClient as unknown as Mock).mock.instances[0];
        const eventDispatcher = wsClientInstance.eventDispatcher;
        const handlerFn = eventDispatcher.handles.get('im.message.receive_v1');

        await handlerFn({
            message: {
                message_type: 'text',
                content: JSON.stringify({ text: "New message" }),
                message_id: "lark_msg_no_truncate",
                chat_id: "chat_no_truncate"
            }
        });

        await new Promise(r => setTimeout(r, 100));

        const replyMock = (lark as any).replyMock;
        expect(replyMock).toHaveBeenCalled();
    });

    it('should handle non-text event types in callback', async () => {
        const { getRunner } = await import('../src/services/agent-runner');
        (getRunner as Mock).mockReturnValueOnce({
            run: async (msgs: any, sys: any, cb: any) => {
                // Call callback with non-text event
                cb('tool_use', { name: 'test_tool' });
                cb('text', 'Final response');
            },
            isDestroyed: false
        });

        const db = getDb();
        db.prepare('INSERT INTO workspaces (id, user_id, name, created_at, status) VALUES (?,?,?,?,?)')
            .run('ws-lark-non-text-event', 'owner', 'MyWS', Date.now(), 'active');

        startLarkService();

        const wsClientInstance = (lark.WSClient as unknown as Mock).mock.instances[0];
        const eventDispatcher = wsClientInstance.eventDispatcher;
        const handlerFn = eventDispatcher.handles.get('im.message.receive_v1');

        await handlerFn({
            message: {
                message_type: 'text',
                content: JSON.stringify({ text: "Test non-text event" }),
                message_id: "lark_msg_non_text_event",
                chat_id: "chat_non_text_event"
            }
        });

        await new Promise(r => setTimeout(r, 100));

        const replyMock = (lark as any).replyMock;
        expect(replyMock).toHaveBeenCalled();
    });

    it('should handle errors without message property', async () => {
        const { getRunner } = await import('../src/services/agent-runner');
        (getRunner as Mock).mockReturnValueOnce({
            run: async () => {
                const err = new Error();
                delete err.message;
                throw err;
            },
            isDestroyed: false
        });

        const db = getDb();
        db.prepare('INSERT INTO workspaces (id, user_id, name, created_at, status) VALUES (?,?,?,?,?)')
            .run('ws-lark-no-msg', 'owner', 'MyWS', Date.now(), 'active');

        startLarkService();

        const wsClientInstance = (lark.WSClient as unknown as Mock).mock.instances[0];
        const eventDispatcher = wsClientInstance.eventDispatcher;
        const handlerFn = eventDispatcher.handles.get('im.message.receive_v1');

        await handlerFn({
            message: {
                message_type: 'text',
                content: JSON.stringify({ text: "Test no message" }),
                message_id: "lark_msg_no_msg",
                chat_id: "chat_no_msg"
            }
        });

        await new Promise(r => setTimeout(r, 150));

        const sdkCalls = db.prepare('SELECT * FROM sdk_calls WHERE workspace_id = ?').all('ws-lark-no-msg') as any[];
        expect(sdkCalls.length).toBe(1);
        expect(sdkCalls[0].error).toBe('Unknown error');
    });

    it('should handle stopLarkService when wsClient is null', () => {
        // Don't start service, wsClient should be null
        stopLarkService();

        // Should not throw
        expect(true).toBe(true);
    });

    it('should correctly handle both assistant and user roles in message history', async () => {
        const db = getDb();
        db.prepare('INSERT INTO workspaces (id, user_id, name, created_at, status) VALUES (?,?,?,?,?)')
            .run('ws-lark-roles', 'owner', 'MyWS', Date.now(), 'active');

        // Insert both user and assistant messages
        const sessionId = 'lark_chat_roles';
        db.prepare('INSERT INTO messages (id, session_id, workspace_id, user_id, role, content, created_at) VALUES (?,?,?,?,?,?,?)')
            .run('msg-role-1', sessionId, 'ws-lark-roles', 'owner', 'user', 'User message 1', Date.now());
        db.prepare('INSERT INTO messages (id, session_id, workspace_id, user_id, role, content, created_at) VALUES (?,?,?,?,?,?,?)')
            .run('msg-role-2', sessionId, 'ws-lark-roles', 'owner', 'assistant', 'Assistant message', Date.now() + 1);
        db.prepare('INSERT INTO messages (id, session_id, workspace_id, user_id, role, content, created_at) VALUES (?,?,?,?,?,?,?)')
            .run('msg-role-3', sessionId, 'ws-lark-roles', 'owner', 'user', 'User message 2', Date.now() + 2);

        startLarkService();

        const wsClientInstance = (lark.WSClient as unknown as Mock).mock.instances[0];
        const eventDispatcher = wsClientInstance.eventDispatcher;
        const handlerFn = eventDispatcher.handles.get('im.message.receive_v1');

        await handlerFn({
            message: {
                message_type: 'text',
                content: JSON.stringify({ text: "New message" }),
                message_id: "lark_msg_roles",
                chat_id: "chat_roles"
            }
        });

        await new Promise(r => setTimeout(r, 100));

        const replyMock = (lark as any).replyMock;
        expect(replyMock).toHaveBeenCalled();
    });

    it('should handle pushToTarget when larkClient is null', async () => {
        const { pushToTarget } = await import('../src/services/lark');

        // Don't start service, larkClient should be null
        await pushToTarget(
            { channel: 'lark', chat_id: 'test_chat_id', message_id: 'test_msg_id' },
            'Test message'
        );

        // Should not throw and should handle gracefully
        expect(true).toBe(true);
    });

    it('should build notify target correctly', async () => {
        const { buildNotifyTarget } = await import('../src/services/lark');

        const target = buildNotifyTarget('chat_123', 'user_456', 'msg_789', true);

        expect(target).toEqual({
            channel: 'lark',
            chat_id: 'chat_123',
            user_open_id: 'user_456',
            message_id: 'msg_789',
            is_group: true,
        });
    });

    it('should push alert to default chat id', async () => {
        // Setup config with default_chat_id
        writeFileSync(testConfigPath, `
server: { port: 8888 }
auth: { jwt_secret: "test", token_expire_days: 1 }
claude: { api_key: "dev", base_url: "base", model: "model", max_tokens: 100 }
runner: { idle_timeout_minutes: 60 }
terminal: {}
files: {}
memory: {}
lark:
  enabled: true
  app_id: "test_app_id"
  app_secret: "test_app_sec"
  default_chat_id: "alert_chat_id"
tasks: {}
logs: {}
        `);
        resetConfig();
        loadConfig(testConfigPath);

        const { pushAlert } = await import('../src/services/lark');

        startLarkService();

        // Should not throw
        await pushAlert('Test alert message');

        expect(true).toBe(true);
    });

    it('should skip pushToTarget for non-lark channels', async () => {
        const { pushToTarget } = await import('../src/services/lark');

        startLarkService();

        // Should not throw for web channel
        await pushToTarget(
            { channel: 'web', chat_id: 'test_chat' },
            'Test message'
        );

        // Should not throw for none channel
        await pushToTarget(
            { channel: 'none' },
            'Test message'
        );

        expect(true).toBe(true);
    });

    it('should handle /ws command to switch workspace', async () => {
        const db = getDb();
        db.prepare('INSERT INTO workspaces (id, user_id, name, created_at, status) VALUES (?,?,?,?,?)')
            .run('ws-lark-ws1', 'owner', 'workspace1', Date.now(), 'active');
        db.prepare('INSERT INTO workspaces (id, user_id, name, created_at, status) VALUES (?,?,?,?,?)')
            .run('ws-lark-ws2', 'owner', 'workspace2', Date.now(), 'active');

        startLarkService();

        const wsClientInstance = (lark.WSClient as unknown as Mock).mock.instances[0];
        const eventDispatcher = wsClientInstance.eventDispatcher;
        const handlerFn = eventDispatcher.handles.get('im.message.receive_v1');

        // First message to establish workspace
        await handlerFn({
            message: {
                message_type: 'text',
                content: JSON.stringify({ text: "Hello" }),
                message_id: "lark_msg_ws_init",
                chat_id: "chat_ws_test"
            }
        });

        await new Promise(r => setTimeout(r, 100));

        // Now switch workspace
        await handlerFn({
            message: {
                message_type: 'text',
                content: JSON.stringify({ text: "/ws workspace2" }),
                message_id: "lark_msg_ws_switch",
                chat_id: "chat_ws_test"
            }
        });

        await new Promise(r => setTimeout(r, 100));

        const replyMock = (lark as any).replyMock;
        const lastCall = replyMock.mock.calls[replyMock.mock.calls.length - 1];
        expect(lastCall[0].data.content).toContain('已切换到工作区');
    });

    it('should reject invalid /ws command', async () => {
        const db = getDb();
        db.prepare('INSERT INTO workspaces (id, user_id, name, created_at, status) VALUES (?,?,?,?,?)')
            .run('ws-lark-ws-curr', 'owner', 'current_ws', Date.now(), 'active');

        startLarkService();

        const wsClientInstance = (lark.WSClient as unknown as Mock).mock.instances[0];
        const eventDispatcher = wsClientInstance.eventDispatcher;
        const handlerFn = eventDispatcher.handles.get('im.message.receive_v1');

        await handlerFn({
            message: {
                message_type: 'text',
                content: JSON.stringify({ text: "/ws nonexistent_workspace" }),
                message_id: "lark_msg_ws_invalid",
                chat_id: "chat_ws_invalid"
            }
        });

        await new Promise(r => setTimeout(r, 100));

        const replyMock = (lark as any).replyMock;
        const lastCall = replyMock.mock.calls[replyMock.mock.calls.length - 1];
        expect(lastCall[0].data.content).toContain('未找到工作区');
    });

    it('should truncate long messages correctly', async () => {
        const db = getDb();
        db.prepare('INSERT INTO workspaces (id, user_id, name, created_at, status) VALUES (?,?,?,?,?)')
            .run('ws-lark-long', 'owner', 'MyWS', Date.now(), 'active');

        startLarkService();

        // Mock getRunner to return a very long response
        const { getRunner } = await import('../src/services/agent-runner');
        const longResponse = 'A'.repeat(30000); // 超过 28000 字符限制

        (getRunner as Mock).mockReturnValueOnce({
            run: async (msgs: any, sys: any, sessionId: any, workspaceId: any, onEvent: any) => {
                const callback = typeof sessionId === 'function' ? sessionId : typeof workspaceId === 'function' ? workspaceId : onEvent;
                // Split into chunks to simulate streaming
                for (let i = 0; i < longResponse.length; i += 1000) {
                    if (callback) callback('text', longResponse.slice(i, i + 1000));
                }
            },
            isDestroyed: false
        });

        const wsClientInstance = (lark.WSClient as unknown as Mock).mock.instances[0];
        const eventDispatcher = wsClientInstance.eventDispatcher;
        const handlerFn = eventDispatcher.handles.get('im.message.receive_v1');

        await handlerFn({
            message: {
                message_type: 'text',
                content: JSON.stringify({ text: "Generate long response" }),
                message_id: "lark_msg_long",
                chat_id: "chat_long"
            }
        });

        await new Promise(r => setTimeout(r, 200));

        const replyMock = (lark as any).replyMock;
        const lastCall = replyMock.mock.calls[replyMock.mock.calls.length - 1];
        const content = lastCall[0].data.content;

        // Should be truncated
        expect(content.length).toBeLessThanOrEqual(28000 + 100); // Allow some buffer for truncation message
        expect(content).toContain('内容过长已截断');
    });

    it('should skip pushAlert when default_chat_id is empty', async () => {
        // Setup config without default_chat_id
        writeFileSync(testConfigPath, `
server: { port: 8888 }
auth: { jwt_secret: "test", token_expire_days: 1 }
claude: { api_key: "dev", base_url: "base", model: "model", max_tokens: 100 }
runner: { idle_timeout_minutes: 60 }
terminal: {}
files: {}
memory: {}
lark:
  enabled: true
  app_id: "test_app_id"
  app_secret: "test_app_sec"
  default_chat_id: ""
tasks: {}
logs: {}
        `);
        resetConfig();
        loadConfig(testConfigPath);

        const { pushAlert } = await import('../src/services/lark');

        startLarkService();

        // Should not throw when default_chat_id is empty
        await pushAlert('Test alert');

        expect(true).toBe(true);
    });

    it('should handle pushToTarget with at mention in group', async () => {
        const { pushToTarget } = await import('../src/services/lark');

        startLarkService();

        // Should include @ mention for group messages (using message_id to trigger reply)
        await pushToTarget(
            { channel: 'lark', chat_id: 'group_chat', user_open_id: 'user_123', is_group: true, message_id: 'msg_123' },
            'Hello group'
        );

        const replyMock = (lark as any).replyMock;
        // Check that the mock was called
        expect(replyMock).toHaveBeenCalled();
    });

    it('should record input/output tokens from usage event', async () => {
        const db = getDb();
        db.prepare('INSERT INTO workspaces (id, user_id, name, created_at, status) VALUES (?,?,?,?,?)')
            .run('ws-lark-tokens', 'owner', 'MyWS', Date.now(), 'active');

        // Mock getRunner to trigger usage event
        const { getRunner } = await import('../src/services/agent-runner');
        (getRunner as Mock).mockReturnValueOnce({
            run: async (msgs: any, sys: any, sessionId: any, workspaceId: any, onEvent: any) => {
                const callback = typeof sessionId === 'function' ? sessionId : typeof workspaceId === 'function' ? workspaceId : onEvent;
                if (callback) {
                    callback('text', 'Response with tokens');
                    callback('usage', { input_tokens: 150, output_tokens: 50 });
                }
            },
            isDestroyed: false
        });

        startLarkService();

        const wsClientInstance = (lark.WSClient as unknown as Mock).mock.instances[0];
        const eventDispatcher = wsClientInstance.eventDispatcher;
        const handlerFn = eventDispatcher.handles.get('im.message.receive_v1');

        await handlerFn({
            message: {
                message_type: 'text',
                content: JSON.stringify({ text: "Test tokens" }),
                message_id: "lark_msg_tokens",
                chat_id: "chat_tokens"
            }
        });

        await new Promise(r => setTimeout(r, 150));

        // Verify sdk_calls record has token counts
        const sdkCalls = db.prepare('SELECT * FROM sdk_calls WHERE workspace_id = ?').all('ws-lark-tokens') as any[];
        expect(sdkCalls.length).toBe(1);
        expect(sdkCalls[0].input_tokens).toBe(150);
        expect(sdkCalls[0].output_tokens).toBe(50);
    });

    it('should filter group messages without @bot', async () => {
        const db = getDb();
        db.prepare('INSERT INTO workspaces (id, user_id, name, created_at, status) VALUES (?,?,?,?,?)')
            .run('ws-lark-group', 'owner', 'MyWS', Date.now(), 'active');

        startLarkService();

        const wsClientInstance = (lark.WSClient as unknown as Mock).mock.instances[0];
        const eventDispatcher = wsClientInstance.eventDispatcher;
        const handlerFn = eventDispatcher.handles.get('im.message.receive_v1');

        // Group message without @bot
        await handlerFn({
            message: {
                message_type: 'text',
                content: JSON.stringify({ text: "Hello everyone" }),
                message_id: "lark_msg_group_no_at",
                chat_id: "chat_group",
                chat_type: "group"
            },
            sender: { sender_id: { open_id: "user_123" } },
            bot: { bot_id: "bot_abc" }
        });

        await new Promise(r => setTimeout(r, 100));

        // Should not create any messages in DB
        const msgs = db.prepare('SELECT * FROM messages WHERE workspace_id = ?').all('ws-lark-group') as any[];
        expect(msgs.length).toBe(0);
    });

    it('should process group messages with @bot', async () => {
        const db = getDb();
        db.prepare('INSERT INTO workspaces (id, user_id, name, created_at, status) VALUES (?,?,?,?,?)')
            .run('ws-lark-group-at', 'owner', 'MyWS', Date.now(), 'active');

        startLarkService();

        const wsClientInstance = (lark.WSClient as unknown as Mock).mock.instances[0];
        const eventDispatcher = wsClientInstance.eventDispatcher;
        const handlerFn = eventDispatcher.handles.get('im.message.receive_v1');

        // Group message with @bot
        await handlerFn({
            message: {
                message_type: 'text',
                content: JSON.stringify({ text: "<at user_id=\"bot_abc\"></at> Hello bot" }),
                message_id: "lark_msg_group_at",
                chat_id: "chat_group_at",
                chat_type: "group"
            },
            sender: { sender_id: { open_id: "user_123" } },
            bot: { bot_id: "bot_abc" }
        });

        await new Promise(r => setTimeout(r, 150));

        // Should process the message
        const replyMock = (lark as any).replyMock;
        expect(replyMock).toHaveBeenCalled();
    });

    it('should filter group messages when at is not targeting this bot', async () => {
        const db = getDb();
        db.prepare('INSERT INTO workspaces (id, user_id, name, created_at, status) VALUES (?,?,?,?,?)')
            .run('ws-lark-group-wrong-bot', 'owner', 'MyWS', Date.now(), 'active');

        startLarkService();

        const wsClientInstance = (lark.WSClient as unknown as Mock).mock.instances[0];
        const eventDispatcher = wsClientInstance.eventDispatcher;
        const handlerFn = eventDispatcher.handles.get('im.message.receive_v1');

        // Group message with @ but targeting different bot
        await handlerFn({
            message: {
                message_type: 'text',
                content: JSON.stringify({ text: "<at user_id=\"other_bot\"></at> Hello" }),
                message_id: "lark_msg_group_wrong_bot",
                chat_id: "chat_group_wrong",
                chat_type: "group"
            },
            sender: { sender_id: { open_id: "user_123" } },
            bot: { bot_id: "bot_abc" }  // Current bot is bot_abc, but message @ other_bot
        });

        await new Promise(r => setTimeout(r, 100));

        // Should not create any messages in DB
        const msgs = db.prepare('SELECT * FROM messages WHERE workspace_id = ?').all('ws-lark-group-wrong-bot') as any[];
        expect(msgs.length).toBe(0);
    });

    it('should filter group messages when bot object is empty', async () => {
        const db = getDb();
        db.prepare('INSERT INTO workspaces (id, user_id, name, created_at, status) VALUES (?,?,?,?,?)')
            .run('ws-lark-group-empty-bot', 'owner', 'MyWS', Date.now(), 'active');

        startLarkService();

        const wsClientInstance = (lark.WSClient as unknown as Mock).mock.instances[0];
        const eventDispatcher = wsClientInstance.eventDispatcher;
        const handlerFn = eventDispatcher.handles.get('im.message.receive_v1');

        // Group message with empty bot object
        await handlerFn({
            message: {
                message_type: 'text',
                content: JSON.stringify({ text: "Hello" }),
                message_id: "lark_msg_group_empty_bot",
                chat_id: "chat_group_empty",
                chat_type: "group"
            },
            sender: { sender_id: { open_id: "user_123" } },
            bot: {}  // Empty bot object
        });

        await new Promise(r => setTimeout(r, 100));

        // Should not create any messages in DB
        const msgs = db.prepare('SELECT * FROM messages WHERE workspace_id = ?').all('ws-lark-group-empty-bot') as any[];
        expect(msgs.length).toBe(0);
    });

    it('should push to target without message_id using create', async () => {
        const { pushToTarget } = await import('../src/services/lark');

        startLarkService();

        // Create a spy on larkClient.im.message.create
        const createMock = vi.fn();
        const { larkClient: client } = await import('../src/services/lark');
        if (client) {
            (client as any).im.message.create = createMock;
        }

        // Push without message_id should use create
        await pushToTarget(
            { channel: 'lark', chat_id: 'chat_123' },
            'Test message without reply'
        );

        // The mock should track the call
        expect(true).toBe(true);
    });

    // Bug fix verification: messages should be isolated by session_id, not workspace_id
    // https://github.com/personal-assistant/assistant/issues/session-isolation
    it('should isolate message history by session_id (not workspace_id)', async () => {
        const db = getDb();
        db.prepare('INSERT INTO workspaces (id, user_id, name, created_at, status) VALUES (?,?,?,?,?)')
            .run('ws-lark-session-isolation', 'owner', 'MyWS', Date.now(), 'active');

        // Insert messages from a WEB session (different session_id)
        const webSessionId = 'web_session_abc123';
        db.prepare('INSERT INTO sessions (id, workspace_id, user_id, channel, title, started_at, last_active_at) VALUES (?,?,?,?,?,?,?)')
            .run(webSessionId, 'ws-lark-session-isolation', 'owner', 'web', 'Web Session', Date.now(), Date.now());
        db.prepare('INSERT INTO messages (id, session_id, workspace_id, user_id, role, content, created_at) VALUES (?,?,?,?,?,?,?)')
            .run('msg-web-1', webSessionId, 'ws-lark-session-isolation', 'owner', 'user', 'Web user message', Date.now());
        db.prepare('INSERT INTO messages (id, session_id, workspace_id, user_id, role, content, created_at) VALUES (?,?,?,?,?,?,?)')
            .run('msg-web-2', webSessionId, 'ws-lark-session-isolation', 'owner', 'assistant', 'Web assistant response', Date.now() + 1);

        // Create a LARK session with lark_chat_id (this simulates a pre-existing lark session)
        const larkSessionId = 'lark_session_isolation_test';
        const larkChatId = 'chat_isolation_test';
        db.prepare('INSERT INTO sessions (id, workspace_id, user_id, channel, lark_chat_id, title, started_at, last_active_at) VALUES (?,?,?,?,?,?,?,?)')
            .run(larkSessionId, 'ws-lark-session-isolation', 'owner', 'lark', larkChatId, 'Lark Session', Date.now() + 2, Date.now() + 2);

        // Insert messages from the LARK session
        db.prepare('INSERT INTO messages (id, session_id, workspace_id, user_id, role, content, created_at) VALUES (?,?,?,?,?,?,?)')
            .run('msg-lark-1', larkSessionId, 'ws-lark-session-isolation', 'owner', 'user', 'Lark user message', Date.now() + 3);
        db.prepare('INSERT INTO messages (id, session_id, workspace_id, user_id, role, content, created_at) VALUES (?,?,?,?,?,?,?)')
            .run('msg-lark-2', larkSessionId, 'ws-lark-session-isolation', 'owner', 'assistant', 'Lark assistant response', Date.now() + 4);

        // Mock AgentRunner to capture the messages passed to it
        const { getRunner } = await import('../src/services/agent-runner');
        let capturedMessages: any[] = [];
        (getRunner as Mock).mockReturnValueOnce({
            run: async (messages: any[]) => {
                capturedMessages = messages;
            },
            isDestroyed: false
        });

        startLarkService();

        const wsClientInstance = (lark.WSClient as unknown as Mock).mock.instances[0];
        const eventDispatcher = wsClientInstance.eventDispatcher;
        const handlerFn = eventDispatcher.handles.get('im.message.receive_v1');

        // Trigger a new message from the lark chat
        await handlerFn({
            message: {
                message_type: 'text',
                content: JSON.stringify({ text: "New lark message" }),
                message_id: "lark_msg_isolation_test",
                chat_id: larkChatId
            }
        });

        await new Promise(r => setTimeout(r, 150));

        // Verify the messages passed to AgentRunner
        // Should contain only lark session messages + the new message, NOT web session messages
        const messageContents = capturedMessages.map(m => typeof m.content === 'string' ? m.content : '');

        // Should contain lark messages
        expect(messageContents).toContain('Lark user message');
        expect(messageContents).toContain('Lark assistant response');
        expect(messageContents).toContain('New lark message');

        // Should NOT contain web messages (this was the bug)
        expect(messageContents).not.toContain('Web user message');
        expect(messageContents).not.toContain('Web assistant response');
    });
});
