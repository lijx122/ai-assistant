/**
 * iLink API 封装
 * 微信个人 Bot API
 *
 * @module src/services/weixin/ilink-api
 */

const ILINK_BASE = 'https://ilinkai.weixin.qq.com';

/**
 * 生成 X-WECHAT-UIN header（每次随机）
 */
function genWeixinUin(): string {
    const uint32 = Math.floor(Math.random() * 0xFFFFFFFF);
    return Buffer.from(String(uint32)).toString('base64');
}

function buildHeaders(botToken?: string): Record<string, string> {
    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'AuthorizationType': 'ilink_bot_token',
        'X-WECHAT-UIN': genWeixinUin(),
    };
    if (botToken) {
        headers['Authorization'] = `Bearer ${botToken}`;
    }
    return headers;
}

/**
 * 获取登录二维码
 */
export async function getBotQrcode(): Promise<{
    qrcode: string;
    qrcode_url: string;
    qrcode_img_content: string;
}> {
    const res = await fetch(
        `${ILINK_BASE}/ilink/bot/get_bot_qrcode?bot_type=3`,
        {
            headers: buildHeaders(),
            signal: AbortSignal.timeout(30000),
        }
    );
    if (!res.ok) {
        throw new Error(`getBotQrcode failed: ${res.status}`);
    }
    return res.json();
}

/**
 * 轮询二维码扫描状态
 */
export async function getQrcodeStatus(qrcode: string): Promise<{
    status: 'pending' | 'confirmed' | 'expired';
    bot_token?: string;
    baseurl?: string;
}> {
    const res = await fetch(
        `${ILINK_BASE}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`,
        {
            headers: buildHeaders(),
            signal: AbortSignal.timeout(30000),
        }
    );
    if (!res.ok) {
        throw new Error(`getQrcodeStatus failed: ${res.status}`);
    }
    return res.json();
}

/**
 * 长轮询收消息
 */
export async function getUpdates(
    botToken: string,
    getUpdatesBuf: string = ''
): Promise<{
    ret: number;
    msgs?: WeixinMessage[];
    get_updates_buf?: string;
}> {
    const res = await fetch(
        `${ILINK_BASE}/ilink/bot/getupdates`,
        {
            method: 'POST',
            headers: buildHeaders(botToken),
            body: JSON.stringify({
                get_updates_buf: getUpdatesBuf || '',
                base_info: { channel_version: '1.0.2' },
            }),
            signal: AbortSignal.timeout(40000), // 35秒 + 5秒缓冲
        }
    );
    if (!res.ok) {
        throw new Error(`getUpdates failed: ${res.status}`);
    }
    const json = await res.json();
    // API 超时返回 null，需要处理
    return json ?? { ret: 0, msgs: [], get_updates_buf: getUpdatesBuf };
}

/**
 * 发送消息（文字）
 */
export async function sendTextMessage(
    botToken: string,
    toUserId: string,
    text: string,
    contextToken: string
): Promise<{ ret: number }> {
    const clientId = `bot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const res = await fetch(
        `${ILINK_BASE}/ilink/bot/sendmessage`,
        {
            method: 'POST',
            headers: buildHeaders(botToken),
            body: JSON.stringify({
                msg: {
                    from_user_id: '',
                    to_user_id: toUserId,
                    client_id: clientId,
                    message_type: 2,    // BOT 发出
                    message_state: 2,   // FINISH
                    context_token: contextToken,
                    item_list: [
                        { type: 1, text_item: { text } },
                    ],
                },
            }),
            signal: AbortSignal.timeout(30000),
        }
    );
    if (!res.ok) {
        throw new Error(`sendTextMessage failed: ${res.status}`);
    }
    return res.json();
}

/**
 * 消息类型定义
 */
export interface WeixinMessage {
    from_user_id: string;
    to_user_id: string;
    message_type: number;
    message_state: number;
    context_token: string;
    item_list: Array<{
        type: number;
        text_item?: { text: string };
        img_item?: { aes_key: string; cdnurl: string };
    }>;
}
