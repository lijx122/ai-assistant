import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { authRouter, rateLimitMap } from '../src/routes/auth';
import { createToken, verifyToken, COOKIE_NAME } from '../src/middleware/auth';
import { initDb, closeDb } from '../src/db/index';
import { loadConfig, resetConfig } from '../src/config';
import { writeFileSync, unlinkSync, existsSync } from 'fs';
import { resolve } from 'path';

const testDbPath = resolve(__dirname, 'test-auth.db');
const testConfigPath = resolve(__dirname, 'test-config-auth.yaml');

describe('Auth Module', () => {
    let app: Hono;

    beforeEach(() => {
        // config
        writeFileSync(testConfigPath, `
server:
  port: 8888
auth:
  jwt_secret: "test_secret"
  token_expire_days: 1
  login_rate_limit: 3
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

        // reset rate limit
        rateLimitMap.clear();

        // db
        if (existsSync(testDbPath)) unlinkSync(testDbPath);
        if (existsSync(testDbPath + '-wal')) unlinkSync(testDbPath + '-wal');
        if (existsSync(testDbPath + '-shm')) unlinkSync(testDbPath + '-shm');
        initDb(testDbPath);

        app = new Hono();
        app.route('/api/auth', authRouter);
    });

    afterEach(() => {
        closeDb();
        if (existsSync(testDbPath)) unlinkSync(testDbPath);
        if (existsSync(testDbPath + '-wal')) unlinkSync(testDbPath + '-wal');
        if (existsSync(testDbPath + '-shm')) unlinkSync(testDbPath + '-shm');
        if (existsSync(testConfigPath)) unlinkSync(testConfigPath);
    });

    describe('JWT functions', () => {
        it('should create and verify token', async () => {
            const token = await createToken('user123', 'admin');
            const payload = await verifyToken(token);
            expect(payload).not.toBeNull();
            expect(payload!.userId).toBe('user123');
            expect(payload!.role).toBe('admin');
        });

        it('should return null for invalid token', async () => {
            const payload = await verifyToken('invalid.token.here');
            expect(payload).toBeNull();
        });
    });

    describe('Login Route', () => {
        it('should fail with missing credentials', async () => {
            const req = new Request('http://localhost/api/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({})
            });
            const res = await app.request(req);
            expect(res.status).toBe(400);
        });

        it('should fail with incorrect credentials', async () => {
            const req = new Request('http://localhost/api/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username: 'owner', password: 'wrongpassword' })
            });
            const res = await app.request(req);
            expect(res.status).toBe(401);
        });

        it('should login successfully and set cookie', async () => {
            const req = new Request('http://localhost/api/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username: 'owner', password: 'admin' }) // Default setup in db index
            });
            const res = await app.request(req);
            expect(res.status).toBe(200);
            const setCookie = res.headers.get('set-cookie');
            expect(setCookie).toContain(COOKIE_NAME);
        });

        it('should trigger rate limit after 3 failed attempts', async () => {
            const makeReq = () => new Request('http://localhost/api/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-real-ip': '1.1.1.1' },
            });

            await app.request(makeReq()); // 1st missing (limit count++)
            await app.request(makeReq()); // 2nd missing
            await app.request(makeReq()); // 3rd missing

            // 4th should be 429
            const res = await app.request(makeReq());
            expect(res.status).toBe(429);
            const data = await res.json();
            expect(data.error).toBe('Rate limit exceeded');
        });

        it('should reset rate limit after successful login', async () => {
            const makeReq = (body: any) => new Request('http://localhost/api/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-real-ip': '2.2.2.2' },
                body: JSON.stringify(body)
            });

            await app.request(makeReq({})); // +1 fail
            const preSize = rateLimitMap.size;

            const res = await app.request(makeReq({ username: 'owner', password: 'admin' })); // success
            expect(res.status).toBe(200);
            expect(rateLimitMap.has('2.2.2.2')).toBe(false);
        });
    });

    describe('Middleware & /me Route', () => {
        it('should block if no cookie', async () => {
            const req = new Request('http://localhost/api/auth/me');
            const res = await app.request(req);
            expect(res.status).toBe(401);
        });

        it('should block if invalid cookie token', async () => {
            const req = new Request('http://localhost/api/auth/me', {
                headers: { Cookie: `${COOKIE_NAME}=invalid_token` }
            });
            const res = await app.request(req);
            expect(res.status).toBe(401);
        });

        it('should access /me with valid token', async () => {
            const token = await createToken('user123', 'admin');
            const req = new Request('http://localhost/api/auth/me', {
                headers: { Cookie: `${COOKIE_NAME}=${token}` }
            });
            const res = await app.request(req);
            expect(res.status).toBe(200);
            const data = await res.json();
            expect(data.user.userId).toBe('user123');
        });
    });

    describe('Logout Route', () => {
        it('should clear cookie on logout', async () => {
            const req = new Request('http://localhost/api/auth/logout', { method: 'POST' });
            const res = await app.request(req);
            expect(res.status).toBe(200);
            const setCookie = res.headers.get('set-cookie');
            expect(setCookie).toContain(`${COOKIE_NAME}=;`);
        });
    });
});
