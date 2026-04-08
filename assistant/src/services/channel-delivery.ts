/**
 * Channel Delivery Queue — 渠道消息可靠发送
 *
 * 位于 processChannelMessage 输出层的统一发送层。
 * 职责：从 DB 读取 AI 回复 → 发送到对应渠道 → 失败重试
 *
 * 微信/飞书均通过此队列发送，渠道代码零改动。
 *
 * @module src/services/channel-delivery
 */

import { sendTextMessage } from './weixin/ilink-api';
import { larkChannel } from '../channels/lark';
import { getDb } from '../db';
import { logger } from './logger';

// ─── 常量 ───────────────────────────────────────────────────

const SEND_RETRIES = 3;
const SEND_RETRY_DELAYS = [2000, 4000, 6000]; // 指数退避（ms）
const MAX_DB_POLL_MS = 30000;  // 从 DB 读取回复的最大等待时间
const DB_POLL_INTERVAL_MS = 500;

// ─── 类型 ───────────────────────────────────────────────────

interface DeliveryTask {
    sessionId: string;
    channelType: 'weixin' | 'lark' | 'websocket';
    senderId: string;
    botToken?: string;       // 微信用
    contextToken?: string;  // 微信用
    messageId?: string;     // 飞书 message_id（reply 用）
    chatId?: string;        // 飞书 chat_id（无 messageId 时）
    workspaceId: string;
    enqueuedAt?: number;
}

// ─── 队列实现 ───────────────────────────────────────────────

class ChannelDeliveryQueue {
    private pending = new Set<string>(); // sessionId → 是否有待发送任务

    /**
     * 入队：从 DB 读取 AI 回复并可靠发送
     * processChannelMessage 在 AI 处理完成后调用此方法（不 await）
     */
    enqueue(task: DeliveryTask): void {
        const key = `${task.channelType}:${task.sessionId}`;
        if (this.pending.has(key)) {
            console.log(`[Delivery] Already pending: ${key}, skipping duplicate enqueue`);
            return;
        }

        this.pending.add(key);
        this.sendWithRetry(task)
            .then(() => {
                this.pending.delete(key);
            })
            .catch((e: any) => {
                console.error(`[Delivery] Failed to send after all retries: ${key} — ${e.message}`);
                this.pending.delete(key);
            });
    }

    private async sendWithRetry(task: DeliveryTask): Promise<void> {
        // 从 DB 读取 AI 回复（最多等待 30s，AI 通常在数秒内完成）
        const reply = await this.pollReplyFromDb(task.sessionId);

        for (let attempt = 1; attempt <= SEND_RETRIES; attempt++) {
            try {
                await this.send(task, reply);
                console.log(`[Delivery] Sent to ${task.channelType}:${task.senderId}, session=${task.sessionId}`);

                logger.system.info('delivery', `Reply sent: ${task.sessionId}`, {
                    channel: task.channelType,
                    senderId: task.senderId,
                    attempt,
                });
                return;
            } catch (e: any) {
                if (attempt === SEND_RETRIES) {
                    // 最后一次也失败 → 发错误提示
                    await this.sendErrorNotice(task, e.message).catch(() => {});
                    throw e;
                }
                const delay = SEND_RETRY_DELAYS[attempt - 1] ?? 6000;
                console.warn(`[Delivery] Send retry ${attempt}/${SEND_RETRIES} in ${delay}ms: ${e.message}`);
                await sleep(delay);
            }
        }
    }

    private async pollReplyFromDb(sessionId: string): Promise<string> {
        const db = getDb();
        const start = Date.now();

        while (Date.now() - start < MAX_DB_POLL_MS) {
            const rows = db
                .prepare(
                    `SELECT content FROM messages
                     WHERE session_id = ? AND role = 'assistant' AND status = 'complete'
                     ORDER BY created_at DESC LIMIT 1`
                )
                .all(sessionId) as any[];

            if (rows.length > 0) {
                return this.extractText(rows[0].content);
            }

            await sleep(DB_POLL_INTERVAL_MS);
        }

        return '[处理完成，无返回内容]';
    }

    private extractText(content: string): string {
        try {
            const blocks = JSON.parse(content);
            if (Array.isArray(blocks)) {
                return blocks
                    .filter((b: any) => b.type === 'text')
                    .map((b: any) => b.text)
                    .join('\n')
                    .trim();
            }
        } catch {
            // 纯文本
        }
        return (content || '').trim() || '[处理完成，无返回内容]';
    }

    private async send(task: DeliveryTask, reply: string): Promise<void> {
        if (task.channelType === 'weixin') {
            if (!task.botToken || !task.senderId) {
                throw new Error('Missing botToken or senderId for weixin delivery');
            }
            await sendTextMessage(task.botToken, task.senderId, reply, task.contextToken || '');
        } else if (task.channelType === 'lark') {
            if (task.messageId) {
                await larkChannel.replyText(task.messageId, reply);
            } else if (task.chatId) {
                await larkChannel.sendMessage(reply, {
                    target: { channel: 'lark', chat_id: task.chatId },
                });
            } else {
                throw new Error('Lark delivery requires either messageId or chatId');
            }
        } else {
            // WebSocket 渠道已在 processChannelMessage 中处理（发到这里已无意义）
            console.warn(`[Delivery] WebSocket delivery not implemented here: ${task.sessionId}`);
        }
    }

    private async sendErrorNotice(task: DeliveryTask, error: string): Promise<void> {
        const notice = `[系统提示] 处理您的消息时遇到问题，请稍后重试。`;
        try {
            if (task.channelType === 'weixin') {
                await sendTextMessage(task.botToken!, task.senderId, notice, task.contextToken || '');
            } else if (task.channelType === 'lark') {
                if (task.messageId) {
                    await larkChannel.replyText(task.messageId, notice);
                } else if (task.chatId) {
                    await larkChannel.sendMessage(notice, {
                        target: { channel: 'lark', chat_id: task.chatId },
                    });
                }
            }
        } catch (e: any) {
            console.error(`[Delivery] Error notice failed: ${e.message}`);
        }
    }

    /** 队列状态（监控用） */
    getPendingCount(): number {
        return this.pending.size;
    }

    getStats(): { pending: number; channel: 'weixin' | 'lark' }[] {
        // 返回当前待发送队列的渠道分布（内存状态）
        return Array.from(this.pending).map((key) => {
            const [channelType, sessionId] = key.split(':') as ['weixin' | 'lark', string];
            void sessionId;
            return { pending: 1, channel: channelType };
        });
    }
}

// ─── 导出单例 ───────────────────────────────────────────────

export const deliveryQueue = new ChannelDeliveryQueue();

// ─── 工具函数 ───────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
