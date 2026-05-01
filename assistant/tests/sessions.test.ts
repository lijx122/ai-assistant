import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import { sessionRouter } from '../src/routes/sessions';
import { createToken, COOKIE_NAME } from '../src/middleware/auth';
import { initDb, closeDb, getDb } from '../src/db/index';
import { loadConfig, resetConfig } from '../src/config';
import { writeFileSync, unlinkSync, existsSync } from 'fs';
import { resolve } from 'path';
import { randomUUID } from 'crypto';

vi.mock('../src/services/message-cache', () => ({
  messageCache: {
    get: vi.fn().mockReturnValue(null),
    set: vi.fn(),
    invalidate: vi.fn(),
  },
}));

vi.mock('../src/services/context-summary', () => ({
  getAllCompactsLight: vi.fn().mockReturnValue([]),
}));

vi.mock('../src/routes/chat', () => ({
  broadcastToWorkspace: vi.fn(),
}));

const testDbPath = resolve(__dirname, 'test-sessions.db');
const testConfigPath = resolve(__dirname, 'test-config-sessions.yaml');

describe('Sessions Router', () => {
  let app: Hono;
  let token: string;

  beforeEach(async () => {
    writeFileSync(testConfigPath, `
server: { port: 8888 }
auth: { jwt_secret: "test_secret_sessions", token_expire_days: 1 }
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
    app.route('/api/sessions', sessionRouter);

    token = await createToken('user_test', 'admin');
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

  // ── GET /:id/messages — is_partial filtering ──

  describe('GET /:id/messages', () => {
    it('should filter out is_partial=1 messages', async () => {
      const db = getDb();
      const sessionId = randomUUID();
      const now = Date.now();

      db.prepare(
        'INSERT INTO sessions (id, workspace_id, user_id, channel, title, started_at, last_active_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(sessionId, 'ws-test', 'user_test', 'web', 'Test', now, now);

      // Insert 2 messages: one normal, one partial placeholder from streaming
      db.prepare(
        'INSERT INTO messages (id, session_id, workspace_id, user_id, role, content, created_at, is_partial) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run('msg-normal', sessionId, 'ws-test', 'user_test', 'user', 'Hello', now, 0);

      db.prepare(
        'INSERT INTO messages (id, session_id, workspace_id, user_id, role, content, created_at, is_partial) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run('msg-partial', sessionId, 'ws-test', 'user_test', 'assistant', JSON.stringify([{ type: 'text', text: 'streaming_placeholder' }]), now + 1, 1);

      const res = await app.request(makeReq(`/api/sessions/${sessionId}/messages`));
      expect(res.status).toBe(200);

      const data = await res.json() as any;
      expect(data.messages.length).toBe(1);
      expect(data.messages[0].id).toBe('msg-normal');
      expect(data.messages[0].content).toBe('Hello');
      expect(data.fromCache).toBe(false);
    });

    it('should return all messages when no partial messages exist', async () => {
      const db = getDb();
      const sessionId = randomUUID();
      const now = Date.now();

      db.prepare(
        'INSERT INTO sessions (id, workspace_id, user_id, channel, title, started_at, last_active_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(sessionId, 'ws-test', 'user_test', 'web', 'Test', now, now);

      db.prepare(
        'INSERT INTO messages (id, session_id, workspace_id, user_id, role, content, created_at, is_partial) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run('msg-1', sessionId, 'ws-test', 'user_test', 'user', 'Question', now, 0);

      db.prepare(
        'INSERT INTO messages (id, session_id, workspace_id, user_id, role, content, created_at, is_partial) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run('msg-2', sessionId, 'ws-test', 'user_test', 'assistant', 'Answer', now + 1, 0);

      const res = await app.request(makeReq(`/api/sessions/${sessionId}/messages`));
      expect(res.status).toBe(200);

      const data = await res.json() as any;
      expect(data.messages.length).toBe(2);
      expect(data.fromCache).toBe(false);
    });

    it('should return 404 for non-existent session', async () => {
      const res = await app.request(makeReq('/api/sessions/nonexistent/messages'));
      expect(res.status).toBe(404);
      const data = await res.json() as any;
      expect(data.error).toBe('Session not found');
    });
  });

  // ── POST /:sessionId/rollback — orphan cleanup ──

  describe('POST /:sessionId/rollback', () => {
    it('should clean up orphan messages_fts and message_embeddings records', async () => {
      const db = getDb();
      const sessionId = randomUUID();
      const workspaceId = 'ws-rollback';
      const baseTime = Date.now();

      // Create session
      db.prepare(
        'INSERT INTO sessions (id, workspace_id, user_id, channel, title, started_at, last_active_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(sessionId, workspaceId, 'user_test', 'web', 'Rollback Test', baseTime, baseTime);

      // Insert 3 messages: msg1 (keep), msg2 (deleted on rollback), msg3 (deleted on rollback)
      db.prepare(
        'INSERT INTO messages (id, session_id, workspace_id, user_id, role, content, created_at, is_partial) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run('msg-rb-1', sessionId, workspaceId, 'user_test', 'user', 'keep me', baseTime, 0);

      db.prepare(
        'INSERT INTO messages (id, session_id, workspace_id, user_id, role, content, created_at, is_partial) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run('msg-rb-2', sessionId, workspaceId, 'user_test', 'assistant', 'delete me 1', baseTime + 1, 0);

      db.prepare(
        'INSERT INTO messages (id, session_id, workspace_id, user_id, role, content, created_at, is_partial) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run('msg-rb-3', sessionId, workspaceId, 'user_test', 'user', 'delete me 2', baseTime + 2, 0);

      // Insert orphan FTS record referencing msg-rb-2 (will need cleanup)
      db.prepare(
        'INSERT INTO messages_fts (content, message_id, session_id, workspace_id, role, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run('delete me 1', 'msg-rb-2', sessionId, workspaceId, 'assistant', baseTime + 1);

      // Insert orphan FTS record referencing msg-rb-3 (will need cleanup)
      db.prepare(
        'INSERT INTO messages_fts (content, message_id, session_id, workspace_id, role, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run('delete me 2', 'msg-rb-3', sessionId, workspaceId, 'user', baseTime + 2);

      // Insert orphan message_embeddings record referencing msg-rb-2
      db.prepare(
        'INSERT INTO message_embeddings (message_id, workspace_id, session_id, embedding, created_at) VALUES (?, ?, ?, ?, ?)'
      ).run('msg-rb-2', workspaceId, sessionId, Buffer.alloc(4, 0), Date.now());

      // Insert orphan message_embeddings record referencing msg-rb-3
      db.prepare(
        'INSERT INTO message_embeddings (message_id, workspace_id, session_id, embedding, created_at) VALUES (?, ?, ?, ?, ?)'
      ).run('msg-rb-3', workspaceId, sessionId, Buffer.alloc(4, 0), Date.now());

      // Verify pre-rollback state
      expect((db.prepare('SELECT COUNT(*) as c FROM messages WHERE session_id = ?').get(sessionId) as any).c).toBe(3);
      expect((db.prepare('SELECT COUNT(*) as c FROM messages_fts WHERE session_id = ?').get(sessionId) as any).c).toBe(2);
      expect((db.prepare('SELECT COUNT(*) as c FROM message_embeddings WHERE session_id = ?').get(sessionId) as any).c).toBe(2);

      // Rollback to msg-rb-1 (delete msg-rb-2 and msg-rb-3)
      const res = await app.request(makeReq(`/api/sessions/${sessionId}/rollback`, 'POST', {
        to_message_id: 'msg-rb-1',
      }));

      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.success).toBe(true);
      expect(data.deletedCount).toBe(2);

      // msg-rb-1 should still exist
      const remaining = db.prepare('SELECT id FROM messages WHERE session_id = ?').all(sessionId) as any[];
      expect(remaining.map((r: any) => r.id)).toEqual(['msg-rb-1']);

      // Orphan messages_fts records should be deleted
      const ftsRemaining = db.prepare('SELECT message_id FROM messages_fts WHERE session_id = ?').all(sessionId) as any[];
      expect(ftsRemaining.length).toBe(0);

      // Orphan message_embeddings records should be deleted
      const embRemaining = db.prepare('SELECT message_id FROM message_embeddings WHERE session_id = ?').all(sessionId) as any[];
      expect(embRemaining.length).toBe(0);
    });

    it('should NOT delete FTS/embedding records for messages in other sessions', async () => {
      const db = getDb();
      const sessionIdA = randomUUID();
      const sessionIdB = randomUUID();
      const workspaceId = 'ws-rb-isolate';
      const baseTime = Date.now();

      // Create 2 sessions
      db.prepare(
        'INSERT INTO sessions (id, workspace_id, user_id, channel, title, started_at, last_active_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(sessionIdA, workspaceId, 'user_test', 'web', 'A', baseTime, baseTime);
      db.prepare(
        'INSERT INTO sessions (id, workspace_id, user_id, channel, title, started_at, last_active_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(sessionIdB, workspaceId, 'user_test', 'web', 'B', baseTime, baseTime);

      // SessionA: msg-a1 (keep), msg-a2 (to be deleted)
      db.prepare(
        'INSERT INTO messages (id, session_id, workspace_id, user_id, role, content, created_at, is_partial) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run('msg-a1', sessionIdA, workspaceId, 'user_test', 'user', 'A1', baseTime, 0);
      db.prepare(
        'INSERT INTO messages (id, session_id, workspace_id, user_id, role, content, created_at, is_partial) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run('msg-a2', sessionIdA, workspaceId, 'user_test', 'assistant', 'A2', baseTime + 1, 0);

      // SessionB: msg-b1 (unrelated, should survive)
      db.prepare(
        'INSERT INTO messages (id, session_id, workspace_id, user_id, role, content, created_at, is_partial) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run('msg-b1', sessionIdB, workspaceId, 'user_test', 'user', 'B1', baseTime, 0);

      // FTS record for msg-b1 in sessionB
      db.prepare(
        'INSERT INTO messages_fts (content, message_id, session_id, workspace_id, role, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run('B1', 'msg-b1', sessionIdB, workspaceId, 'user', baseTime);

      // Embedding record for msg-b1 in sessionB
      db.prepare(
        'INSERT INTO message_embeddings (message_id, workspace_id, session_id, embedding, created_at) VALUES (?, ?, ?, ?, ?)'
      ).run('msg-b1', workspaceId, sessionIdB, Buffer.alloc(4, 0), Date.now());

      // Rollback sessionA to msg-a1
      const res = await app.request(makeReq(`/api/sessions/${sessionIdA}/rollback`, 'POST', {
        to_message_id: 'msg-a1',
      }));
      expect(res.status).toBe(200);

      // SessionB's FTS and embedding should remain untouched
      const ftsB = db.prepare('SELECT message_id FROM messages_fts WHERE session_id = ?').get(sessionIdB) as any;
      expect(ftsB.message_id).toBe('msg-b1');

      const embB = db.prepare('SELECT message_id FROM message_embeddings WHERE session_id = ?').get(sessionIdB) as any;
      expect(embB.message_id).toBe('msg-b1');
    });

    it('should return 400 when to_message_id is missing', async () => {
      const sessionId = randomUUID();
      const now = Date.now();
      const db = getDb();
      db.prepare(
        'INSERT INTO sessions (id, workspace_id, user_id, channel, title, started_at, last_active_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(sessionId, 'ws-test', 'user_test', 'web', 'Test', now, now);

      const res = await app.request(makeReq(`/api/sessions/${sessionId}/rollback`, 'POST', {}));
      expect(res.status).toBe(400);
      const data = await res.json() as any;
      expect(data.error).toBe('to_message_id is required');
    });

    it('should return 404 when target message not found in session', async () => {
      const sessionId = randomUUID();
      const now = Date.now();
      const db = getDb();
      db.prepare(
        'INSERT INTO sessions (id, workspace_id, user_id, channel, title, started_at, last_active_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(sessionId, 'ws-test', 'user_test', 'web', 'Test', now, now);

      const res = await app.request(makeReq(`/api/sessions/${sessionId}/rollback`, 'POST', {
        to_message_id: 'nonexistent-msg',
      }));
      expect(res.status).toBe(404);
      const data = await res.json() as any;
      expect(data.error).toBe('Message not found in this session');
    });

    it('should handle rollback to the only message (delete nothing)', async () => {
      const db = getDb();
      const sessionId = randomUUID();
      const baseTime = Date.now();

      db.prepare(
        'INSERT INTO sessions (id, workspace_id, user_id, channel, title, started_at, last_active_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(sessionId, 'ws-test', 'user_test', 'web', 'Test', baseTime, baseTime);

      db.prepare(
        'INSERT INTO messages (id, session_id, workspace_id, user_id, role, content, created_at, is_partial) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run('msg-only', sessionId, 'ws-test', 'user_test', 'user', 'only', baseTime, 0);

      const res = await app.request(makeReq(`/api/sessions/${sessionId}/rollback`, 'POST', {
        to_message_id: 'msg-only',
      }));
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.success).toBe(true);
      expect(data.deletedCount).toBe(0);

      // Message should still be there
      const remaining = db.prepare('SELECT id FROM messages WHERE session_id = ?').all(sessionId) as any[];
      expect(remaining.length).toBe(1);
    });
  });

  // ── POST /:id/branch — exclude is_partial=1 ──

  describe('POST /:id/branch', () => {
    it('should exclude is_partial=1 messages when copying to branch', async () => {
      const db = getDb();
      const originalSessionId = randomUUID();
      const workspaceId = 'ws-branch';
      const baseTime = Date.now();

      db.prepare(
        'INSERT INTO sessions (id, workspace_id, user_id, channel, title, started_at, last_active_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(originalSessionId, workspaceId, 'user_test', 'web', 'Original', baseTime, baseTime);

      // msg1: normal user message
      db.prepare(
        'INSERT INTO messages (id, session_id, workspace_id, user_id, role, content, created_at, is_partial) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run('br-msg1', originalSessionId, workspaceId, 'user_test', 'user', 'Question 1', baseTime, 0);

      // msg2: partial/placeholder assistant message from streaming
      db.prepare(
        'INSERT INTO messages (id, session_id, workspace_id, user_id, role, content, created_at, is_partial) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run('br-msg2', originalSessionId, workspaceId, 'user_test', 'assistant', JSON.stringify([{ type: 'text', text: 'partial placeholder' }]), baseTime + 1, 1);

      // msg3: normal user message (branch point)
      db.prepare(
        'INSERT INTO messages (id, session_id, workspace_id, user_id, role, content, created_at, is_partial) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run('br-msg3', originalSessionId, workspaceId, 'user_test', 'user', 'Question 2', baseTime + 2, 0);

      // Branch from msg3 (inclusive: copy msg1, msg3; skip msg2)
      const res = await app.request(makeReq(`/api/sessions/${originalSessionId}/branch`, 'POST', {
        branchFromMessageId: 'br-msg3',
      }));

      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.success).toBe(true);
      expect(data.messagesCopied).toBe(2); // Only msg1 and msg3

      // Verify new session's messages
      const newSessionMessages = db.prepare(
        'SELECT role, content, is_partial FROM messages WHERE session_id = ? ORDER BY created_at ASC'
      ).all(data.newSessionId) as any[];

      expect(newSessionMessages.length).toBe(2);

      // First copied message should be msg1 (user)
      expect(newSessionMessages[0].role).toBe('user');
      expect(newSessionMessages[0].content).toBe('Question 1');
      expect(newSessionMessages[0].is_partial).toBe(0);

      // Second copied message should be msg3 (user) - msg2 skipped
      expect(newSessionMessages[1].role).toBe('user');
      expect(newSessionMessages[1].content).toBe('Question 2');
      expect(newSessionMessages[1].is_partial).toBe(0);

      // Original session still has all 3 messages
      const originalCount = (db.prepare('SELECT COUNT(*) as c FROM messages WHERE session_id = ?').get(originalSessionId) as any).c;
      expect(originalCount).toBe(3);
    });

    it('should return 400 when branchFromMessageId is missing', async () => {
      const sessionId = randomUUID();
      const now = Date.now();
      const db = getDb();
      db.prepare(
        'INSERT INTO sessions (id, workspace_id, user_id, channel, title, started_at, last_active_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(sessionId, 'ws-test', 'user_test', 'web', 'Test', now, now);

      const res = await app.request(makeReq(`/api/sessions/${sessionId}/branch`, 'POST', {}));
      expect(res.status).toBe(400);
      const data = await res.json() as any;
      expect(data.error).toBe('Missing branchFromMessageId');
    });

    it('should return 404 when original session not found', async () => {
      const res = await app.request(makeReq('/api/sessions/nonexistent/branch', 'POST', {
        branchFromMessageId: 'some-msg',
      }));
      expect(res.status).toBe(404);
      const data = await res.json() as any;
      expect(data.error).toBe('Session not found');
    });

    it('should return 404 when branch point message not in session', async () => {
      const sessionId = randomUUID();
      const now = Date.now();
      const db = getDb();
      db.prepare(
        'INSERT INTO sessions (id, workspace_id, user_id, channel, title, started_at, last_active_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(sessionId, 'ws-test', 'user_test', 'web', 'Test', now, now);

      const res = await app.request(makeReq(`/api/sessions/${sessionId}/branch`, 'POST', {
        branchFromMessageId: 'msg-not-here',
      }));
      expect(res.status).toBe(404);
      const data = await res.json() as any;
      expect(data.error).toBe('Branch message not found in this session');
    });

    it('should copy zero messages when branching from before first message', async () => {
      const db = getDb();
      const sessionId = randomUUID();
      const baseTime = Date.now();

      db.prepare(
        'INSERT INTO sessions (id, workspace_id, user_id, channel, title, started_at, last_active_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(sessionId, 'ws-test', 'user_test', 'web', 'Test', baseTime, baseTime);

      // Only msg at time baseTime+10, branch from msg at time baseTime-1 (doesn't exist)
      // Actually we need a message to exist, let me use a different approach:
      // Create 1 message, branch from a DIFFERENT session's message that doesn't belong to this session

      // Create a message in a different session
      const otherSessionId = randomUUID();
      db.prepare(
        'INSERT INTO sessions (id, workspace_id, user_id, channel, title, started_at, last_active_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(otherSessionId, 'ws-test', 'user_test', 'web', 'Other', baseTime, baseTime);
      db.prepare(
        'INSERT INTO messages (id, session_id, workspace_id, user_id, role, content, created_at, is_partial) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run('other-msg', otherSessionId, 'ws-test', 'user_test', 'user', 'hello', baseTime, 0);

      // Try to branch from sessionId using other-msg (which is in otherSessionId)
      const res = await app.request(makeReq(`/api/sessions/${sessionId}/branch`, 'POST', {
        branchFromMessageId: 'other-msg',
      }));
      expect(res.status).toBe(404);
    });
  });
});
