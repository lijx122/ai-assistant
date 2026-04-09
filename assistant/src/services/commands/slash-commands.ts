/**
 * Slash Commands - 斜杠指令拦截与处理
 *
 * 在消息到达 agentRunner 之前拦截，以 / 开头的文本被识别为指令。
 * 已知指令立即处理并直接返回响应，不调用 AI。
 */

import { getDb } from '../../db';
import { messageCache } from '../message-cache';

export interface SlashCommandResult {
    handled: boolean;
    response?: string;
    action?: string;
    actionData?: Record<string, any>;
}

type Handler = (
    parts: string[],
    ctx: { sessionId: string; workspaceId: string }
) => Promise<SlashCommandResult>;

const SLASH_COMMANDS: Record<string, Handler> = {

    // /compact — 手动触发上下文压缩
    compact: async (parts, ctx) => {
        // 动态导入避免循环依赖
        const { compactIfNeeded, estimateTokens } = await import('../context-summary');
        const { buildMessagesForSession } = await import('../chat-messages');
        const db = getDb();

        try {
            const messages = await buildMessagesForSession(ctx.sessionId, ctx.workspaceId, {
                logPrefix: 'SlashCommand',
                onEvent: (type, payload) => {
                    console.log(`[/compact] ${type}:`, payload);
                },
            });

            // 从 sdk_calls 获取最近一次 API 调用的真实 input_tokens
            const lastCall = db.prepare(
                'SELECT input_tokens FROM sdk_calls WHERE session_id = ? ORDER BY created_at DESC LIMIT 1'
            ).get(ctx.sessionId) as { input_tokens: number } | undefined;
            const realTokens = lastCall?.input_tokens ?? 0;

            const result = await compactIfNeeded(messages, ctx.sessionId, ctx.workspaceId, undefined, true);

            if (result.didCompact) {
                // 显示真实 token 消耗；compactedTokens 仍用 estimate（压缩后消息未真实送 API）
                const displayTokens = realTokens > 0 ? realTokens : result.originalTokens;
                const saved = displayTokens - result.compactedTokens;
                return {
                    handled: true,
                    response: `**压缩完成**\n\n实际消耗：${displayTokens} tokens → 压缩后：${result.compactedTokens} tokens\n节省：${saved} tokens（${displayTokens > 0 ? Math.round(saved / displayTokens * 100) : 0}%）\n\n摘要：${(result.summary || '').slice(0, 200)}...`,
                };
            } else {
                const displayTokens = realTokens > 0 ? realTokens : estimateTokens(messages);
                return {
                    handled: true,
                    response: `当前上下文（${displayTokens} tokens）消息量不足，无法压缩（至少需要保留一定对话历史）。`,
                };
            }
        } catch (err) {
            console.error('[/compact] Failed:', err);
            return {
                handled: true,
                response: `压缩失败：${err instanceof Error ? err.message : String(err)}`,
            };
        }
    },

    // /clear — 清空当前会话消息（保留 compact 快照和会话本身）
    clear: async (parts, ctx) => {
        const db = getDb();
        const deleted = db.transaction(() => {
            const r1 = db.prepare(
                'DELETE FROM messages WHERE session_id = ?'
            ).run(ctx.sessionId);
            db.prepare(
                'DELETE FROM session_compacts WHERE session_id = ?'
            ).run(ctx.sessionId);
            return r1.changes;
        })();

        messageCache.invalidate(ctx.sessionId);

        return {
            handled: true,
            response: `会话已清空（删除了 ${deleted} 条消息和所有 compact 快照）。`,
        };
    },

    // /skills — 列出所有可用 skills
    skills: async (parts, ctx) => {
        const { listSkills } = await import('../skill-loader');
        const skills = listSkills();

        if (skills.length === 0) {
            return { handled: true, response: '当前无可用 Skills。' };
        }

        const lines = skills.map(s =>
            `**${s.name}**\n  ${s.description}${s.whenToUse ? `\n  触发：${s.whenToUse}` : ''}`
        );

        return {
            handled: true,
            response: `**可用 Skills（${skills.length} 个）**\n\n${lines.join('\n\n')}\n\n使用方式：发送「读取 xxx skill」或「/skill [名称]」`,
        };
    },

    // /skill [名称] — 读取指定 skill 内容
    skill: async (parts, ctx) => {
        const name = parts[0];
        if (!name) {
            return {
                handled: true,
                response: '用法：`/skill <名称>`，例如 `/skill tools-code`\n\n可用：' +
                    (await import('../skill-loader')).listSkills().map(s => s.name).join(' · ')
            };
        }

        const { getSkill } = await import('../skill-loader');
        const skill = getSkill(name);

        if (!skill) {
            const { listSkills } = await import('../skill-loader');
            const available = listSkills().map(s => s.name).join(' · ');
            return {
                handled: true,
                response: `Skill "${name}" 不存在。\n\n可用：${available}`,
            };
        }

        // 返回 skill 全文（截断过长的）
        const content = skill.content.length > 3000
            ? skill.content.slice(0, 3000) + '\n\n_（内容过长已截断，使用 `/skill ' + name + '` 获取完整内容）_'
            : skill.content;

        return {
            handled: true,
            response: `**${skill.name}**\n\n${content}`,
        };
    },

    // /help — 显示所有指令
    help: async (parts, ctx) => {
        return {
            handled: true,
            response: `**斜杠指令**

\`/compact\` — 手动压缩当前对话上下文
\`/clear\` — 清空当前会话所有消息（不可恢复）
\`/skills\` — 列出所有可用 Skills
\`/skill <名称>\` — 读取指定 Skill 完整内容
\`/help\` — 显示此帮助

也可以直接说「读取 xxx skill」，AI 会调用 read_skill 工具。`,
        };
    },
};

/**
 * 解析并执行斜杠指令
 * @returns handled=true 表示已拦截处理；handled=false 表示放行给 AI
 */
export async function handleSlashCommand(
    content: string,
    ctx: { sessionId: string; workspaceId: string }
): Promise<SlashCommandResult> {
    const trimmed = (content || '').trim();

    if (!trimmed.startsWith('/')) {
        return { handled: false };
    }

    const spaceIdx = trimmed.indexOf(' ');
    const cmdRaw = spaceIdx === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIdx);
    const argsStr = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1);
    const parts = argsStr.split(/\s+/).filter(Boolean);
    const cmd = cmdRaw.toLowerCase();

    const handler = SLASH_COMMANDS[cmd];
    if (!handler) {
        // 未知指令，不拦截，让 AI 处理
        return { handled: false };
    }

    try {
        return await handler(parts, ctx);
    } catch (err) {
        console.error(`[/${cmd}] Handler error:`, err);
        return {
            handled: true,
            response: `指令 /${cmd} 执行失败：${err instanceof Error ? err.message : String(err)}`,
        };
    }
}
