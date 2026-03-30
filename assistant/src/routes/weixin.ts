/**
 * WeChat 渠道路由
 *
 * @module src/routes/weixin
 */

import { Hono } from 'hono';
import { weixinChannel } from '../channels/weixin';
import { getDb } from '../db';
import { authMiddleware } from '../middleware/auth';

export const weixinRouter = new Hono();

// 认证中间件
weixinRouter.use('*', authMiddleware);

// 获取所有已登录的微信账号
weixinRouter.get('/accounts', (c) => {
    const accounts = weixinChannel.getAllAccounts();
    return c.json({ accounts });
});

// 开始登录：返回二维码
weixinRouter.post('/login', async (c) => {
    try {
        const result = await weixinChannel.startLogin();
        console.log('[Weixin API] /login response:', {
            sessionId: result.sessionId,
            hasQrcodeImg: !!result.qrcodeImgBase64,
            imgLen: result.qrcodeImgBase64?.length || 0,
            hasQrcodeUrl: !!result.qrcodeUrl,
        });
        return c.json(result);
    } catch (e: any) {
        console.error('[Weixin] Login failed:', e.message);
        return c.json({ error: e.message }, 500);
    }
});

// 查询登录状态
weixinRouter.get('/login/:sessionId/status', (c) => {
    const { sessionId } = c.req.param();
    const db = getDb();
    const session = db.prepare(
        'SELECT status, account_id FROM weixin_sessions WHERE id = ?'
    ).get(sessionId) as any;
    if (!session) {
        return c.json({ error: 'Session not found' }, 404);
    }
    return c.json(session);
});

// 断开账号
weixinRouter.delete('/accounts/:accountId', async (c) => {
    const { accountId } = c.req.param();
    await weixinChannel.disconnectAccount(accountId);
    return c.json({ success: true });
});
