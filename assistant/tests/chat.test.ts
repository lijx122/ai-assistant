import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import { chatRouter, broadcastToWorkspace } from '../src/routes/chat';
import { getRunner, clearRunners } from '../src/services/agent-runner';
import { workspaceLock } from '../src/services/workspace-lock';
import { createToken, COOKIE_NAME } from '../src/middleware/auth';
import { initDb, closeDb, getDb } from '../src/db/index';
import { loadConfig, resetConfig } from '../src/config';
import { writeFileSync, unlinkSync, existsSync } from 'fs';
import { resolve } from 'path';
import { webSocketChannel } from '../src/channels';

const testDbPath = resolve(__dirname, 'test-chat.db');
const testConfigPath = resolve(__dirname, 'test-config-chat.yaml');

vi.mock('../src/services/agent-runner', () => {
  const mockRun = vi.fn().mockImplementation(async (...args: any[]) => {
    const onEvent = args[args.length - 1];
    if (typeof onEvent === 'function') {
      onEvent('text', 'Mock reply');
      onEvent('done', null);
    }
  });

  return {
    getRunner: vi.fn().mockReturnValue({ run: mockRun, isDestroyed: false }),
    clearRunners: vi.fn(),
  };
});

describe('Chat Router (T-2.3)', () => {
  let app: Hono;
  let token: string;

  beforeEach(async () => {
    writeFileSync(testConfigPath, `
server: { port: 8888 }
auth: { jwt_secret: "test_secret_chat", token_expire_days: 1 }
claude:
  api_key: "test"
  base_url: "test"
  model: "test"
  max_tokens: 100
runner: {}
terminal: {}
files: {}
memory: {}
lark: {}
tasks: {}
logs: {}
    `);
    resetConfig();
    loadConfig(testConfigPath);

    if (existsSync(testDbPath)) unlinkSync(testDbPath);
    if (existsSync(testDbPath + '-wal')) unlinkSync(testDbPath + '-wal');
    if (existsSync(testDbPath + '-shm')) unlinkSync(testDbPath + '-shm');
    initDb(testDbPath);

    app = new Hono();
    app.route('/api/chat', chatRouter);

    token = await createToken('user_owner', 'admin');
    await webSocketChannel.shutdown();
    await webSocketChannel.initialize();
  });

  afterEach(() => {
    closeDb();
    if (existsSync(testDbPath)) unlinkSync(testDbPath);
    if (existsSync(testDbPath + '-wal')) unlinkSync(testDbPath + '-wal');
    if (existsSync(testDbPath + '-shm')) unlinkSync(testDbPath + '-shm');
    if (existsSync(testConfigPath)) unlinkSync(testConfigPath);
    vi.clearAllMocks();
  });

  const makeReq = (path: string, method = 'GET', body?: any) => new Request(`http://localhost${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Cookie: `${COOKIE_NAME}=${token}`
    },
    body: body ? JSON.stringify(body) : undefined
  });

  it('should accept message into queue and process background task', async () => {
    const mockWs = { readyState: 1, send: vi.fn() };
    const set = new Set<any>();
    set.add(mockWs);
    webSocketChannel.registerConnection('ws-alpha', mockWs);

    // Pre-create a session
    const db = getDb();
    db.prepare(
      'INSERT INTO sessions (id, workspace_id, user_id, channel, title, started_at, last_active_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run('sess-alpha', 'ws-alpha', 'user_owner', 'web', 'Test Session', Date.now(), Date.now());

    // Call /api/chat
    const res = await app.request(makeReq('/api/chat', 'POST', {
      workspaceId: 'ws-alpha',
      sessionId: 'sess-alpha',
      content: 'Hello World',
      messageId: 'uuid123'
    }));

    expect(res.status).toBe(202);

    // Wait for the background task
    await new Promise(r => setTimeout(r, 100));

    // Verify DB writes
    const msgs = db.prepare('SELECT * FROM messages WHERE session_id = ?').all('sess-alpha') as any[];
    expect(msgs.length).toBe(2); // 1 User, 1 Assistant
    // User content 是纯字符串
    expect(msgs[0].content).toBe('Hello World');
    expect(msgs[0].role).toBe('user');
    // Assistant content 是 JSON 序列化的 content blocks
    expect(JSON.parse(msgs[1].content)).toEqual([{ type: 'text', text: 'Mock reply' }]);
    expect(msgs[1].role).toBe('assistant');

    // Verify WS broadcasting
    expect(mockWs.send).toHaveBeenCalled();
  });

  it('should reject requests without workspaceId', async () => {
    const res = await app.request(makeReq('/api/chat', 'POST', { content: 'test' }));
    expect(res.status).toBe(400);
  });

  it('should prevent duplicate requests using messageId', async () => {
    const db = getDb();
    // Pre-create a session
    db.prepare(
      'INSERT INTO sessions (id, workspace_id, user_id, channel, title, started_at, last_active_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run('sess-dupe', 'ws-x', 'usr', 'web', 'Test', Date.now(), Date.now());

    // Pre-seed the DB with a message_id
    db.prepare(
      'INSERT INTO messages (id, session_id, workspace_id, user_id, role, content, message_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run('idx', 'sess-dupe', 'ws-x', 'usr', 'user', '["dupe content"]', 'dupe_msg_id', 0);

    const res = await app.request(makeReq('/api/chat', 'POST', {
      workspaceId: 'ws-x',
      sessionId: 'sess-dupe',
      content: 'new content',
      messageId: 'dupe_msg_id'
    }));

    const data = await res.json();
    expect(data.status).toBe('duplicate');

    // Assure background task does not duplicate db records (size = 1 seeded + 0 new = 1)
    const msgs = db.prepare('SELECT * FROM messages WHERE session_id = ?').all('sess-dupe') as any[];
    expect(msgs.length).toBe(1);
  });

  it('should fetch chat history with parsed content', async () => {
    const db = getDb();
    db.prepare(
      'INSERT INTO messages (id, session_id, workspace_id, user_id, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run('test1', 'sess', 'ws-y', 'user', 'user', 'hi', 1);

    const res = await app.request(makeReq('/api/chat/history?workspaceId=ws-y'));
    const data = await res.json();
    expect(data.messages.length).toBe(1);
    // Content should be parsed (string stays as string)
    expect(data.messages[0].content).toBe('hi');
  });

  it('should reject history fetch without workspaceId', async () => {
    const res = await app.request(makeReq('/api/chat/history'));
    expect(res.status).toBe(400);
  });
});
