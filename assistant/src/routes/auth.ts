import { Hono } from 'hono';
import { setCookie, deleteCookie } from 'hono/cookie';
import { timingSafeEqual } from 'crypto';
import { compare } from 'bcrypt';
import { createToken, authMiddleware, COOKIE_NAME } from '../middleware/auth';
import { getConfig } from '../config';
import { AuthContext } from '../types';
import { getDb } from '../db';

export const authRouter = new Hono<{ Variables: { user: AuthContext } }>();

// ip -> { count, expireAt }
export const rateLimitMap = new Map<string, { count: number, expireAt: number }>();

function safeEqual(a: string, b: string): boolean {
    const aBuf = Buffer.from(a);
    const bBuf = Buffer.from(b);
    if (aBuf.length !== bBuf.length) return false;
    return timingSafeEqual(aBuf, bBuf);
}

authRouter.post('/login', async (c) => {
    const ip = c.req.header('x-real-ip') || c.req.header('x-forwarded-for') || '127.0.0.1';
    const now = Date.now();
    const config = getConfig();

    let limit = rateLimitMap.get(ip);
    if (limit && now < limit.expireAt) {
        if (limit.count >= config.auth.login_rate_limit) {
            return c.json({ error: 'Rate limit exceeded' }, 429);
        }
    } else {
        limit = { count: 0, expireAt: now + 10 * 60 * 1000 };
    }

    const body = await c.req.json().catch(() => ({}));
    const { username, password } = body;

    if (!username || !password) {
        limit.count++;
        rateLimitMap.set(ip, limit);
        return c.json({ error: 'Missing credentials' }, 400);
    }

    const db = getDb();

    // 从 DB 读取用户及其 password_hash
    const user = db.prepare(
        'SELECT username, password_hash, role FROM users WHERE username = ?'
    ).get(username) as { username: string; password_hash: string; role: string } | undefined;

    const usernameMatched = user && safeEqual(String(username), user.username);
    const passwordMatched = user && await compare(String(password), user.password_hash).catch(() => false);

    if (!usernameMatched || !passwordMatched) {
        limit.count++;
        rateLimitMap.set(ip, limit);
        return c.json({ error: 'Invalid credentials' }, 401);
    }

    // success
    rateLimitMap.delete(ip);

    const token = await createToken(user!.username, user!.role);
    setCookie(c, COOKIE_NAME, token, {
        httpOnly: true,
        maxAge: config.auth.token_expire_days * 24 * 60 * 60,
        path: '/',
        sameSite: 'Lax',
    });

    return c.json({ success: true, message: 'Logged in' });
});

authRouter.post('/logout', (c) => {
    deleteCookie(c, COOKIE_NAME, { path: '/' });
    return c.json({ success: true, message: 'Logged out' });
});

authRouter.get('/me', authMiddleware, (c) => {
    const user = c.get('user');
    return c.json({ user });
});
