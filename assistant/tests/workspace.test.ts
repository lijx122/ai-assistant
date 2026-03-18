import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { workspaceRouter } from '../src/routes/workspaces';
import { workspaceLock } from '../src/services/workspace-lock';
import { createToken, COOKIE_NAME } from '../src/middleware/auth';
import { initDb, closeDb } from '../src/db/index';
import { loadConfig, resetConfig } from '../src/config';
import { writeFileSync, unlinkSync, existsSync } from 'fs';
import { resolve } from 'path';

const testDbPath = resolve(__dirname, 'test-ws.db');
const testConfigPath = resolve(__dirname, 'test-config-ws.yaml');

describe('Workspace Module', () => {
  let app: Hono;
  let token: string;

  beforeEach(async () => {
    writeFileSync(testConfigPath, `
server:
  port: 8888
auth:
  jwt_secret: "test_secret_ws"
  token_expire_days: 1
claude:
  api_key: "test_key"
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
    app.route('/api/workspaces', workspaceRouter);

    token = await createToken('user_owner', 'admin');
  });

  afterEach(() => {
    closeDb();
    if (existsSync(testDbPath)) unlinkSync(testDbPath);
    if (existsSync(testDbPath + '-wal')) unlinkSync(testDbPath + '-wal');
    if (existsSync(testDbPath + '-shm')) unlinkSync(testDbPath + '-shm');
    if (existsSync(testConfigPath)) unlinkSync(testConfigPath);
  });

  describe('Workspace Lock', () => {
    it('should lock and queue sequentially', async () => {
      const order: number[] = [];
      const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

      const task1 = async () => {
        const release = await workspaceLock.acquire('ws-1');
        await wait(50);
        order.push(1);
        release();
      };

      const task2 = async () => {
        const release = await workspaceLock.acquire('ws-1');
        order.push(2);
        release();
      };

      const task3 = async () => {
        const release = await workspaceLock.acquire('ws-2'); // Different ID, should not block task 1
        order.push(3);
        release();
      };

      await Promise.all([task1(), task2(), task3()]);

      // task 3 should finish first (no wait, decoupled ID) -> then task 1 -> then task 2
      expect(order).toEqual([3, 1, 2]);
    });
  });

  describe('Routes CRUD', () => {
    const makeReq = (path: string, method = 'GET', body?: any) => new Request(`http://localhost${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Cookie: `${COOKIE_NAME}=${token}`
      },
      body: body ? JSON.stringify(body) : undefined
    });

    it('should create a workspace', async () => {
      const res = await app.request(makeReq('/api/workspaces', 'POST', { name: 'ws1', description: 'test ws' }));
      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.workspace.name).toBe('ws1');
      expect(data.workspace.user_id).toBe('user_owner');
    });

    it('should require a name for creation', async () => {
      const res = await app.request(makeReq('/api/workspaces', 'POST', { description: 'noname' }));
      expect(res.status).toBe(400);
    });

    it('should update a workspace', async () => {
      const res1 = await app.request(makeReq('/api/workspaces', 'POST', { name: 'oldName' }));
      const wsId = (await res1.json()).workspace.id;

      const res2 = await app.request(makeReq(`/api/workspaces/${wsId}`, 'PUT', { name: 'newName' }));
      expect(res2.status).toBe(200);

      const res3 = await app.request(makeReq('/api/workspaces', 'GET'));
      const list = await res3.json();
      expect(list.workspaces[0].name).toBe('newName');
    });

    it('should archive a workspace', async () => {
      const res1 = await app.request(makeReq('/api/workspaces', 'POST', { name: 'deleteMe' }));
      const wsId = (await res1.json()).workspace.id;

      let reslist = await app.request(makeReq('/api/workspaces', 'GET'));
      expect((await reslist.json()).workspaces.length).toBe(1);

      const res2 = await app.request(makeReq(`/api/workspaces/${wsId}`, 'DELETE'));
      expect(res2.status).toBe(200);

      reslist = await app.request(makeReq('/api/workspaces', 'GET'));
      expect((await reslist.json()).workspaces.length).toBe(0); // Archived workspaces aren't returned currently
    });

    it('should handle 404 for put/delete', async () => {
      const resPut = await app.request(makeReq('/api/workspaces/invalid', 'PUT', { name: 'x' }));
      expect(resPut.status).toBe(404);

      const resDel = await app.request(makeReq('/api/workspaces/invalid', 'DELETE'));
      expect(resDel.status).toBe(404);
    });
  });
});
