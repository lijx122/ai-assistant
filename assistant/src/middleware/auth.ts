import { Context, Next } from 'hono';
import { getCookie } from 'hono/cookie';
import { getConfig } from '../config';
import { AuthContext } from '../types';

export const COOKIE_NAME = 'assistant_token';

type JoseModule = typeof import('jose');
let joseModulePromise: Promise<JoseModule> | null = null;

/**
 * 动态模块白名单
 * 替换 new Function('s', 'return import(s)') 避免动态代码执行风险
 */
const moduleRegistry: Record<string, () => Promise<any>> = {
    'jose': () => import('jose'),
};

function loadModule<T>(specifier: string): Promise<T> {
    const loader = moduleRegistry[specifier];
    if (!loader) {
        return Promise.reject(new Error(`Module '${specifier}' is not in the whitelist`));
    }
    return loader() as Promise<T>;
}

function loadJose(): Promise<JoseModule> {
    if (!joseModulePromise) {
        joseModulePromise = loadModule<JoseModule>('jose');
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
