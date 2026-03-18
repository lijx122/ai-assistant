import { Context, Next } from 'hono';
import { getCookie } from 'hono/cookie';
import { getConfig } from '../config';
import { AuthContext } from '../types';

export const COOKIE_NAME = 'assistant_token';

type JoseModule = typeof import('jose');
let joseModulePromise: Promise<JoseModule> | null = null;

function importModule<T>(specifier: string): Promise<T> {
    // Vitest 运行在模块沙箱内，new Function(import) 可能缺少回调导致失败
    if (process.env.VITEST) {
        return import(specifier) as Promise<T>;
    }
    const dynamicImport = new Function('s', 'return import(s)') as (s: string) => Promise<T>;
    return dynamicImport(specifier);
}

function loadJose(): Promise<JoseModule> {
    if (!joseModulePromise) {
        joseModulePromise = importModule<JoseModule>('jose');
    }
    return joseModulePromise;
}

export async function createToken(userId: string, role: string): Promise<string> {
    const config = getConfig();
    const secret = new TextEncoder().encode(config.jwtSecret);
    const { SignJWT } = await loadJose();
    return new SignJWT({ userId, role })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .setExpirationTime(`${config.auth.token_expire_days}d`)
        .sign(secret);
}

export async function verifyToken(token: string): Promise<AuthContext | null> {
    try {
        const config = getConfig();
        const secret = new TextEncoder().encode(config.jwtSecret);
        const { jwtVerify } = await loadJose();
        const { payload } = await jwtVerify(token, secret);
        return {
            userId: payload.userId as string,
            role: payload.role as 'admin' | 'member',
        };
    } catch {
        return null;
    }
}

export async function authMiddleware(c: Context, next: Next) {
    const token = getCookie(c, COOKIE_NAME);
    if (!token) {
        return c.json({ error: 'Unauthorized' }, 401);
    }

    const payload = await verifyToken(token);
    if (!payload) {
        return c.json({ error: 'Invalid token' }, 401);
    }

    c.set('user', payload);
    await next();
}
