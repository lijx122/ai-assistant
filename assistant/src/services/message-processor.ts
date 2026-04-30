/**
 * Message Processor 模块
 * 统一消息处理入口，所有渠道消息汇聚到同一处理链路
 *
 * @module src/services/message-processor
 */

import { randomUUID } from 'crypto';
import { getDb } from '../db';
import { workspaceLock } from './workspace-lock';
import { getRunner, AgentStreamCallback } from './agent-runner';
import { buildWorkspaceConfigPrompt } from './workspace-config';
import { needsRecall, searchHistory, insertMessageFts } from './recall';
import { archiveSession } from './archiver';
import { channelManager, ChannelMessage } from '../channels';
import { Command } from '../channels/base';
import { webSocketChannel, clearTokenBuffer } from '../channels/websocket';
import { serializeContent, buildMessagesForSession } from './chat-messages';
import { broadcastToWorkspace } from '../routes/chat';
import { indexMessage } from './message-indexer';
import { deliveryQueue } from './channel-delivery';
import { logger } from './logger';
import { clearSkillCache } from './skill-loader';
import { searchRelevantLessons } from './lessons';

/**
 * 构建 System Prompt
 * 注入优先级：工作区记忆 > 用户偏好 > Recall（按需）
 */
export async function buildSystemPrompt(
    workspaceId: string,
    userContent: string,
    notifyTarget?: any
): Promise<string> {
    // 开发模式：每次对话开始前清除 skill 缓存，确保文件修改即时生效
    if (process.env.NODE_ENV !== 'production') {
        clearSkillCache();
    }
    const workspaceConfigPrompt = buildWorkspaceConfigPrompt(workspaceId);
    const systemPromptParts: string[] = [];

    // 0. 思维方法论（硬编码，不可通过对话修改）
    systemPromptParts.push(`
## 思维方法论

以下是你处理所有问题时必须遵循的基本方法论，来源于唯物辩证法的实践原则：

**一、实事求是**
没有调查就没有发言权。
- 回答涉及具体事实、代码实现、当前状态时，先读文件/搜索/查数据库，不凭记忆推断
- 不确定的事情明确说不确定，给出获取准确信息的方法
- 发现自己的判断与实际情况不符时，立即纠正，不辩解

**二、抓主要矛盾**
任何复杂问题都有主要矛盾和次要矛盾，解决主要矛盾是关键。
- 用户描述的问题往往不是真正的问题，先判断主要矛盾（根本原因）
- 不要同时解决10个问题，找到最关键的一个先突破
- 区分「紧急」和「重要」，主要矛盾不一定是最紧急的那个

**三、具体问题具体分析**
矛盾有普遍性，但每个矛盾都有其特殊性，不能套模板。
- 同样的错误现象可能有不同根因，不能看到 404 就说「检查路由」
- 给出方案前先理解当前项目的具体架构和约束
- 不同阶段（开发/生产/调试）有不同的处理原则

**四、实践是检验真理的标准**
分析和方案都是假设，执行后才能验证。
- 有条件时优先给出可执行的验证步骤，而不是停留在理论分析
- 方案执行后检查结果，发现偏差立即调整
- 「我认为应该可以」不如「执行 X 命令看输出」

**五、集中优势兵力，各个歼灭**
不分散力量，在决定性方向集中突破，不搞全面铺开。
- 任务拆解后，优先执行依赖最少、影响最大的那个步骤
- 一次对话解决一个核心问题，不要试图同时处理所有问题
- 复杂任务先打通主干流程，细节问题后续迭代

**六、从实际出发，不从原则出发**
先看现实情况，再选择方法，而不是先有方法再套现实。
- 不因为「最佳实践」就推翻现有可用的方案
- 现有代码能跑就尽量在此基础上改，不轻易重写
- 用户的约束条件（时间/资源/能力）是真实存在的，方案要在约束内
`);

    // 1. 可用工具索引表
    systemPromptParts.push(`
## 可用工具

以下工具按类别列出，遇到不熟悉的工具或需要了解详细用法时，
调用 read_skill("tools-<类别>") 获取完整说明。

文件操作：read_file · write_file · file_delete · file_move
搜索研究：web_search · web_fetch · deep_research
记忆系统：recall · read_workspace_memory · read_impression
笔记管理：note_write · note_read · note_search
任务自动化：create_task · reminder_set
代码执行：bash · code_search · code_analyze · claude_code
Git：git_history · git_revert
渠道通知：（内部工具，无需调用）

工具选择原则：
- 优先选最轻量的工具（code_search 优于 claude_code）
- 只读操作不触发 HITL，写操作谨慎
- 不确定工具用法时先 read_skill 再使用
`);

    // 2. 工作区配置（IDENTITY.md + USER.md + TOOLS.md）
    if (workspaceConfigPrompt) {
        systemPromptParts.push(workspaceConfigPrompt);
    }

    // 3. Skills 目录（从 .skills/ 动态加载）
    const { listSkills } = await import('./skill-loader');
    const allSkills = listSkills();
    if (allSkills.length > 0) {
        // 按前缀分组
        const toolSkills = allSkills.filter(s => s.name.startsWith('tools-'));
        const otherSkills = allSkills.filter(s => !s.name.startsWith('tools-'));

        let skillSection = '## 可用 Skills\n\n';
        skillSection += '遇到不熟悉的工具或需要了解详细用法时，调用 read_skill 获取完整指南。\n\n';

        if (toolSkills.length) {
            skillSection += '**工具说明 Skills**（按类别）：\n';
            for (const s of toolSkills) {
                skillSection += `- \`read_skill("${s.name}")\`：${s.description}\n`;
                if (s.whenToUse) {
                    skillSection += `  触发：${s.whenToUse}\n`;
                }
            }
            skillSection += '\n';
        }

        if (otherSkills.length) {
            skillSection += '**任务 Skills**：\n';
            for (const s of otherSkills) {
                skillSection += `- \`read_skill("${s.name}")\`：${s.description}\n`;
                if (s.whenToUse) {
                    skillSection += `  触发：${s.whenToUse}\n`;
                }
            }
        }

        systemPromptParts.push(skillSection);
    }

    // 3.5-A. 过往教训（动态注入，按语义相关性检索）
    try {
        const lessons = await searchRelevantLessons(userContent, {
            topK: 5,
            threshold: 0.45,
            expandGraph: true,
        });
        if (lessons.length > 0) {
            const capped = lessons.slice(0, 3); // 总量 >2000 字时裁剪到 top-3
            const lines = capped.map(l => {
                let line = `- [${l.task_type}] ${l.title}：${l.summary}`;
                if (l.edge_reason) line += `\n  (关联来源: ${l.edge_reason})`;
                return line;
            });
            const totalLen = lines.join('\n').length;
            const finalLines = totalLen > 2000 ? lines.slice(0, 3) : lines;
            systemPromptParts.push(`## 过往教训\n\n以下是与本次任务语义相关的历史经验，请在处理前阅读并遵守：\n\n${finalLines.join('\n')}`);
        }
    } catch {
        // 教训检索失败静默降级
    }

    // 3.5-B. Reflection 指令（静态）
    systemPromptParts.push(`## Reflection 指令

当你观察到用户在纠正你的做法（包含「不对 / 别这样 / 下次 / 以后 / 记住 / 应该」等表述），或明确描述一条「将来同类任务应该遵守的规则」时，主动调用 record_lesson 工具写入经验库。

只记录可复用的规则，不记一次性事实或用户当前状态。如果发现新教训与过往某条教训相关/矛盾/细化，用 links 参数建立关联（relation 填 related/contradicts/refines）。`);

    // 3.5-C. 委派质量指令（静态）
    systemPromptParts.push(`## 委派质量指令

调用 claude_code 工具前，必须在参数里塞齐上下文：
- project_context.cwd_note：工作目录语义（如「ClaudeOS 主项目，Node/TS/Vue3 + SQLite」）
- project_context.files_of_interest：涉及文件的完整路径数组
- project_context.failure_log：如果是修复失败，填入上次报错日志
- project_context.extra_constraints：项目硬约束（如「Windows + Git Bash、conventional commits」）

不要只丢一句 task 就调用——上下文不全，输出质量就低。`);

    // 3.5-D. 工具选择边界（静态）
    systemPromptParts.push(`## 工具选择边界（硬性规则）

遇到下列场景必须调用指定工具，不要自己写脚本/代码实现：

- **定时 / 周期执行**：调 create_task（cron 表达式 + 任务描述），不要在 shell 脚本写 crontab，不要在 JS 写 setInterval，不要在 Python 写 schedule.every
- **搜历史对话 / 查过往教训**：调 recall（传 source='lessons' 或 'both'），不要自己读 SQLite
- **时效性信息查询（新闻/金融/时事）**：调 fresh_news_search，不要直接 web_search 后手工排版
- **代码搜索**：优先 code_search / recall，不要用 bash grep -r
- **文件读写**：用 read_file / write_file，不要写 bash cat/echo 重定向

这条清单不是建议，是硬性规则——写脚本复刻工具功能就是失职。`);

    // 4. 基础角色定义
    systemPromptParts.push('You are a helpful personal assistant.');

    // 5. 行为约束
    systemPromptParts.push(`
---
重要行为约束：
1. 执行工具前不要预测或猜测结果
2. 必须先调用工具，拿到真实结果后再总结
3. 正确格式：「我来执行xxx」→ [调用工具] → 「结果如下：[真实数据]」
4. 错误格式：「结果如下：[猜测数据]」→ [调用工具]（这是不允许的）
---`);

    // 6. 任务分析框架（内部判断，不需要输出）
    systemPromptParts.push(`
---
处理任何请求前，先在内部完成以下判断（不需要输出）：
1. 主要矛盾是什么？（用户真正要解决的问题）
2. 我现在有没有足够的信息？（没有则先调查）
3. 最小可行的解决路径是什么？（不是最完美的）
4. 如何验证方案是否有效？（可执行的验证步骤）
---`);

    // 7. 消息来源（如果有）
    if (notifyTarget) {
        systemPromptParts.push(`\n\n当前消息来源：${JSON.stringify(notifyTarget)}`);
    }

    // 8. 深度研究模式检测（当用户消息包含深度研究指令时）
    // deep_research 是真工具，支持三种模式
    if (userContent && userContent.includes('deep_research')) {
        systemPromptParts.push(`
---
【深度研究模式】
deep_research 工具支持三种模式：
- web：网络深度研究（默认），执行多轮搜索和内容抓取
- codebase：分析当前工作区代码，调用 Claude Code 进行架构分析
- github：分析 GitHub 项目，支持快速分析和深度分析（含 clone）

用户请求使用 deep_research 工具时，请：
1. 根据用户意图选择合适的 mode（web/codebase/github）
2. 调用 deep_research 工具，传入用户的具体研究主题和相关参数
3. 等待工具返回聚合后的真实研究数据
4. 基于真实数据（而非猜测）生成完整报告
5. 报告中必须引用具体的 URL、数据或代码片段

重要：deep_research 工具会执行真实的搜索、代码分析或项目分析，请信任并基于返回的数据生成报告。`);
    }

    // 9. 任务追踪规范（渠道消息自动追踪）
    systemPromptParts.push(`
---
## 任务追踪规范（渠道消息必读）

当收到需要多步骤完成的任务类消息（如"帮我搜索 xxx 并整理成报告"、
"查一下 xxx"、"分析一下 xxx"等）时，必须按以下流程操作：

1. **处理前**：调用 todo_read 查看现有任务
2. **创建任务**：如果需要执行多个步骤，用 todo_write 创建任务列表，
   将相关项标记为 done: false（注意：是布尔值 false，不是字符串）
3. **执行任务**：按步骤执行，完成一步更新一步（仍为 done: false）
4. **处理完成后**：必须再次调用 todo_write，将相关任务项标记为 done: true
5. **失败处理**：如果任务无法完成，调用 todo_write 将该项标记为 done: true，
   并在内容中说明失败原因

重要：不要忘记最后的 done: true 标记，这是自动化任务追踪的关键。
只有在本次会话中创建或更新的 todo 项才需要标记，查询类任务无需创建 todo。
---`);

    return systemPromptParts.join('\n');
}

/**
 * 发送回复到渠道
 */
async function sendReply(
    channelId: string,
    content: string,
    target?: any
): Promise<void> {
    const channel = channelManager.get(channelId);
    if (!channel) {
        console.warn(`[Processor] Channel ${channelId} not found`);
        return;
    }

    await channel.sendMessage(content, { target });
}

/**
 * 处理系统指令
 * @returns 是否是指令（true 表示已处理，不需要进入 AgentRunner）
 */
async function handleCommand(
    msg: ChannelMessage,
    workspaceId: string
): Promise<boolean> {
    const text = msg.content.trim();
    const db = getDb();

    // /help - 显示可用指令列表
    if (text === '/help') {
        const helpText = `可用指令：
/workspace {name} 或 切换工作区 {name} - 切换工作区
/recall {query} - 手动触发历史搜索
/archive - 手动归档当前会话
修复 - 修复最近的严重告警
忽略 - 忽略最近的严重告警
调整 - 调整检测脚本（需先「忽略」告警）
/help - 显示此帮助信息`;

        if (msg.raw?.chatId) {
            // 飞书渠道
            const { larkChannel } = await import('../channels/lark');
            await larkChannel.sendMessage(helpText, {
                target: { channel: 'lark', chat_id: msg.raw.chatId, message_id: msg.channelMessageId }
            });
        } else {
            // WebSocket 渠道
            await webSocketChannel.sendMessage(helpText, { target: workspaceId });
        }
        return true;
    }

    // /workspace {name} 或 切换工作区 {name} - 切换工作区
    const workspaceMatch = text.match(/^\/workspace\s+(\S+)$/i) ||
                           text.match(/^切换工作区\s+(\S+)$/i);
    if (workspaceMatch) {
        const wsName = workspaceMatch[1];
        const targetWs = db.prepare('SELECT id FROM workspaces WHERE name = ? AND status = ?').get(wsName, 'active') as any;

        if (targetWs) {
            // 更新 chat_workspace_map（通过 LarkChannel 的映射）
            if (msg.raw?.chatId) {
                const { larkChannel } = await import('../channels/lark');
                (larkChannel as any).chatWorkspaceMap?.set(msg.raw.chatId, targetWs.id);
            }

            const replyText = `已切换到工作区「${wsName}」`;
            if (msg.raw?.chatId) {
                await sendReply('lark', replyText, { channel: 'lark', chat_id: msg.raw.chatId, message_id: msg.channelMessageId });
            } else {
                await webSocketChannel.sendMessage(replyText, { target: workspaceId });
            }
        } else {
            const replyText = `未找到工作区「${wsName}」`;
            if (msg.raw?.chatId) {
                await sendReply('lark', replyText, { channel: 'lark', chat_id: msg.raw.chatId, message_id: msg.channelMessageId });
            } else {
                await webSocketChannel.sendMessage(replyText, { target: workspaceId });
            }
        }
        return true;
    }

    // /recall {query} - 手动触发历史搜索
    const recallMatch = text.match(/^\/recall\s+(.+)$/i);
    if (recallMatch) {
        const query = recallMatch[1];
        const result = searchHistory(workspaceId, query);

        let replyText: string;
        if (result.found === 0) {
            replyText = '未找到相关历史记录';
        } else {
            const sections = result.results.map(r =>
                `[${r.date} ${r.role}] ${r.content.slice(0, 200)}${r.content.length > 200 ? '...' : ''}`
            );
            replyText = '---相关历史记录---\n' + sections.join('\n---\n');
        }

        if (msg.raw?.chatId) {
            await sendReply('lark', replyText, { channel: 'lark', chat_id: msg.raw.chatId, message_id: msg.channelMessageId });
        } else {
            await webSocketChannel.sendMessage(replyText, { target: workspaceId });
        }
        return true;
    }

    // /archive - 手动归档当前会话
    if (text === '/archive') {
        if (!msg.sessionId) {
            const replyText = '无法确定当前会话';
            if (msg.raw?.chatId) {
                await sendReply('lark', replyText, { channel: 'lark', chat_id: msg.raw.chatId, message_id: msg.channelMessageId });
            } else {
                await webSocketChannel.sendMessage(replyText, { target: workspaceId });
            }
            return true;
        }

        const result = await archiveSession(msg.sessionId, workspaceId);
        let replyText: string;

        if (result.success) {
            if (result.skipped) {
                replyText = result.reason === 'already_archived'
                    ? '当前会话已归档，无需重复操作'
                    : '消息太少，无需归档';
            } else {
                replyText = `会话已归档（摘要 ${result.tokens} tokens）`;
            }
        } else {
            replyText = `归档失败：${result.reason}`;
        }

        if (msg.raw?.chatId) {
            await sendReply('lark', replyText, { channel: 'lark', chat_id: msg.raw.chatId, message_id: msg.channelMessageId });
        } else {
            await webSocketChannel.sendMessage(replyText, { target: workspaceId });
        }
        return true;
    }

    // ===== 告警指令处理 =====
    const alertReplyMatch = text.match(/^(修复|忽略|调整)$/);
    if (alertReplyMatch) {
        const command = alertReplyMatch[1];
        const { attemptFix, ignoreAlert, adjustScript, getLatestCriticalAlert, updatePendingScriptAdjust } = await import('./alert-handler');

        // 查询最近的通知中 critical 告警
        const latestAlert = await getLatestCriticalAlert(workspaceId);

        if (!latestAlert) {
            const replyText = '当前没有待处理的严重告警';
            if (msg.raw?.chatId) {
                await sendReply('lark', replyText, { channel: 'lark', chat_id: msg.raw.chatId, message_id: msg.channelMessageId });
            } else {
                await webSocketChannel.sendMessage(replyText, { target: workspaceId });
            }
            return true;
        }

        if (command === '修复') {
            // 触发修复
            await attemptFix(latestAlert.id, workspaceId);
            const replyText = `已开始修复告警 ${latestAlert.id.slice(0, 8)}，请稍后查看结果`;
            if (msg.raw?.chatId) {
                await sendReply('lark', replyText, { channel: 'lark', chat_id: msg.raw.chatId, message_id: msg.channelMessageId });
            } else {
                await webSocketChannel.sendMessage(replyText, { target: workspaceId });
            }
            return true;
        }

        if (command === '忽略') {
            // 忽略告警，询问是否调整脚本
            await ignoreAlert(latestAlert.id, workspaceId);
            const replyText = `已忽略告警 ${latestAlert.id.slice(0, 8)}\n\n是否调整检测脚本以避免重复告警？\n回复「调整」开始调整，回复「不用」保持现状`;
            if (msg.raw?.chatId) {
                await sendReply('lark', replyText, { channel: 'lark', chat_id: msg.raw.chatId, message_id: msg.channelMessageId });
            } else {
                await webSocketChannel.sendMessage(replyText, { target: workspaceId });
            }
            return true;
        }

        if (command === '调整') {
            // 检查是否有标记了 pending_script_adjust 的告警
            const pendingAlert = await getLatestCriticalAlert(workspaceId, true);
            if (pendingAlert && pendingAlert.pending_script_adjust) {
                await adjustScript(pendingAlert.id, workspaceId);
                const replyText = `开始调整检测脚本，告警 ${pendingAlert.id.slice(0, 8)}`;
                if (msg.raw?.chatId) {
                    await sendReply('lark', replyText, { channel: 'lark', chat_id: msg.raw.chatId, message_id: msg.channelMessageId });
                } else {
                    await webSocketChannel.sendMessage(replyText, { target: workspaceId });
                }
            } else {
                const replyText = '没有找到需要调整脚本的告警，请先「忽略」一个告警';
                if (msg.raw?.chatId) {
                    await sendReply('lark', replyText, { channel: 'lark', chat_id: msg.raw.chatId, message_id: msg.channelMessageId });
                } else {
                    await webSocketChannel.sendMessage(replyText, { target: workspaceId });
                }
            }
            return true;
        }
    }

    return false;
}

/**
 * 处理结构化命令（来自各渠道的统一命令格式）
 * @returns 是否已处理
 */
async function handleCommandByType(
    cmd: Command,
    msg: ChannelMessage,
    workspaceId: string
): Promise<boolean> {
    const db = getDb();

    switch (cmd.type) {
        case 'workspace_switch': {
            // /ws 切换工作区
            const wsName = cmd.args?.trim();
            if (!wsName) {
                await replyToMessage(msg, '用法：/ws <工作区名称>');
                return true;
            }
            const targetWs = db.prepare(
                'SELECT id, name FROM workspaces WHERE name = ? AND status = ?'
            ).get(wsName, 'active') as { id: string; name: string } | undefined;
            if (targetWs) {
                // 更新渠道特定的工作区映射
                if (msg.raw?.chatId) {
                    // 飞书：更新 chatWorkspaceMap
                    const { larkChannel } = await import('../channels/lark');
                    (larkChannel as any).chatWorkspaceMap?.set(msg.raw.chatId, targetWs.id);
                } else if (msg.raw?.accountId) {
                    // 微信：更新 senderWorkspaceMap
                    const { weixinChannel } = await import('../channels/weixin');
                    if (msg.senderId) {
                        (weixinChannel as any).senderWorkspaceMap?.set(msg.senderId, targetWs.id);
                    }
                }
                await replyToMessage(msg, `✅ 已切换到工作区「${targetWs.name}」`);
            } else {
                await replyToMessage(msg, `❌ 未找到工作区「${wsName}」`);
            }
            return true;
        }

        case 'workspace_list': {
            // /workspaces 列出所有工作区
            const workspaces = db.prepare(
                'SELECT name FROM workspaces WHERE status = ? ORDER BY name'
            ).all('active') as { name: string }[];
            const list = workspaces.map(w => `• ${w.name}`).join('\n');
            await replyToMessage(msg, `📋 可用工作区：\n\n${list || '（无）'}\n\n输入 /ws <名称> 切换`);
            return true;
        }

        case 'help': {
            // /help 帮助
            const helpText = `📖 助手命令：

/ws <名称> - 切换工作区
/workspaces - 列出所有工作区
/recall <关键词> - 搜索历史记录
/archive - 手动归档当前会话
/help - 显示此帮助

其他问题将转发给 AI 助手处理。`;
            await replyToMessage(msg, helpText);
            return true;
        }

        case 'terminal_block': {
            // /terminal 等终端命令拦截
            await replyToMessage(msg, '⚠️ 终端操作请前往 Web 界面。');
            return true;
        }
    }

    return false;
}

/**
 * 处理交互按钮点击
 * 将 actionId 转换为对应文本指令处理
 */
async function handleActionButton(
    msg: ChannelMessage,
    workspaceId: string
): Promise<boolean> {
    if (!msg.actionId) return false;

    // 根据 actionId 执行相应操作
    switch (msg.actionId) {
        case 'confirm_fix':
            // 触发修复流程
            if (msg.actionData?.alertId) {
                const { attemptFix } = await import('./alert-handler');
                await attemptFix(msg.actionData.alertId, workspaceId);
                return true;
            }
            break;

        case 'ignore_alert':
            // 忽略告警
            if (msg.actionData?.alertId) {
                const { ignoreAlert } = await import('./alert-handler');
                await ignoreAlert(msg.actionData.alertId, workspaceId);
                return true;
            }
            break;

        // 可以扩展更多 actionId 处理
    }

    return false;
}

/**
 * 运行 Agent 任务（从渠道调用）
 * 这是 chat.ts runAgentTask 的渠道适配版本
 */
async function runAgentTaskForChannel(
    sessionId: string,
    workspaceId: string,
    userContent: string,
    msg: ChannelMessage
): Promise<void> {
    const db = getDb();

    // Stream buffer for incremental saves
    let streamBuffer = '';
    let lastSaveTime = Date.now();
    const SAVE_INTERVAL_MS = 1500;

    // 预插入助手占位消息（created_at = now + 1，确保在 user 消息之后）
    const assistantMsgId = randomUUID();
    const now = Date.now();
    db.prepare(
        `INSERT INTO messages (id, session_id, workspace_id, user_id, role, content, status, streaming_content, is_partial, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'streaming', '', 1, ?)`
    ).run(assistantMsgId, sessionId, workspaceId, 'owner', 'assistant', '', now + 1);

    // 写入用户消息
    const userMsgId = randomUUID();
    db.prepare(
        'INSERT INTO messages (id, session_id, workspace_id, user_id, role, content, message_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(userMsgId, sessionId, workspaceId, 'owner', 'user', userContent, msg.channelMessageId || null, now);

    // 同步插入用户消息到 messages_fts（用于 Recall 全文检索作为降级）
    insertMessageFts(userMsgId, sessionId, workspaceId, 'user', userContent, now);

    // 异步生成向量 embedding（不 await，不阻塞主流程）
    indexMessage(userMsgId, workspaceId, sessionId, userContent, 'user')
        .catch(() => {}); // 静默降级

    // 更新会话活跃时间
    const title = userContent.slice(0, 20);
    db.prepare(
        "UPDATE sessions SET last_active_at = ?, title = COALESCE(NULLIF(title, ''), ?) WHERE id = ?"
    ).run(now, title, sessionId);

    // 排队提示
    const lockStatus = workspaceLock.getQueuePosition?.(workspaceId) ?? 0;
    if (lockStatus > 0) {
        const queueMsg = `正在处理中，已排队第 ${lockStatus} 位...`;
        if (msg.raw?.chatId) {
            await sendReply('lark', queueMsg, { channel: 'lark', chat_id: msg.raw.chatId, message_id: msg.channelMessageId });
        }
    }

    const release = await workspaceLock.acquire(workspaceId);

    try {
        // 构建消息列表
        const anthropicMsgs = await buildMessagesForSession(sessionId, workspaceId, {
            logPrefix: 'Processor',
            onEvent: (type, payload) => {
                if (type === 'compact_start' || type === 'compact_done') {
                    broadcastToWorkspace(workspaceId, { type, payload });
                }
            },
        });

        // 构建 system prompt
        const notifyTarget = msg.raw?.chatId ? {
            channel: 'lark',
            chat_id: msg.raw.chatId,
            user_open_id: msg.senderId,
            is_group: msg.isGroup,
            message_id: msg.channelMessageId,
        } : undefined;

        const systemPrompt = await buildSystemPrompt(workspaceId, userContent, notifyTarget);

        // Content blocks collection — per-round via round_complete
        let runtimeError: string | null = null;
        let inputTokens = 0;
        let outputTokens = 0;
        let currentPlaceholderId = assistantMsgId;
        let isFirstRound = true;
        let finalAssistantContent: any[] | null = null;

        const onEvent: AgentStreamCallback = (type, payload) => {
            // 广播到 WebSocket 客户端
            broadcastToWorkspace(workspaceId, { type, payload });

            if (type === 'text') {
                streamBuffer += payload;

                const now = Date.now();
                if (now - lastSaveTime >= SAVE_INTERVAL_MS) {
                    updateStreamingContent(currentPlaceholderId, streamBuffer);
                    lastSaveTime = now;
                }
            } else if (type === 'tool_call') {
                // 仅广播，round_complete 携带完整数据
            } else if (type === 'tool_result') {
                // 仅广播
            } else if (type === 'round_complete') {
                const { assistant, toolResults } = payload;

                // 保存本轮 assistant 消息（第一轮覆盖占位符，后续轮更新上一轮占位符）
                finalizeMessage(currentPlaceholderId, assistant, sessionId, workspaceId, 'assistant');
                isFirstRound = false;

                // 保存 tool_result 用户消息
                for (const tr of toolResults) {
                    const toolResultMsgId = randomUUID();
                    db.prepare(
                        'INSERT INTO messages (id, session_id, workspace_id, user_id, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
                    ).run(toolResultMsgId, sessionId, workspaceId, 'owner', 'user', serializeContent([tr]), Date.now());
                }

                // 为下一轮创建 streaming 占位符（is_partial=1，被 buildMessagesForSession 排除）
                const newPlaceholderId = randomUUID();
                const nowTs = Date.now();
                db.prepare(
                    `INSERT INTO messages (id, session_id, workspace_id, user_id, role, content, status, streaming_content, is_partial, created_at)
                     VALUES (?, ?, ?, ?, ?, ?, 'streaming', '', 1, ?)`
                ).run(newPlaceholderId, sessionId, workspaceId, 'owner', 'assistant', '', nowTs);
                currentPlaceholderId = newPlaceholderId;
                streamBuffer = '';
            } else if (type === 'done') {
                if (Array.isArray(payload) && payload.length > 0) {
                    finalAssistantContent = payload;
                }
            } else if (type === 'error') {
                console.error(`[Processor] Error event received:`, payload);
                runtimeError = typeof payload === 'string' ? payload : JSON.stringify(payload);
            } else if (type === 'usage') {
                inputTokens = payload?.input_tokens ?? 0;
                outputTokens = payload?.output_tokens ?? 0;
            }
        };

        const runner = getRunner(workspaceId, onEvent);
        const startTime = Date.now();

        // 运行 Agent
        await runner.run(anthropicMsgs, { systemPrompt, sessionId, workspaceId, onEvent });

        const duration = Date.now() - startTime;

        // 最终完成：更新最后一个占位符为最终文本（无工具调用的纯文本响应）
        if (runtimeError) {
            finalizeMessage(
                currentPlaceholderId,
                [{ type: 'text', text: `执行失败：${runtimeError}` }],
                sessionId,
                workspaceId,
                'assistant'
            );
        } else if (finalAssistantContent) {
            finalizeMessage(currentPlaceholderId, finalAssistantContent, sessionId, workspaceId, 'assistant');
        } else if (streamBuffer) {
            finalizeMessage(
                currentPlaceholderId,
                [{ type: 'text', text: streamBuffer }],
                sessionId,
                workspaceId,
                'assistant'
            );
        } else {
            db.prepare(
                `UPDATE messages SET status = 'complete', streaming_content = NULL, is_partial = 0 WHERE id = ?`
            ).run(currentPlaceholderId);
        }

        // 更新会话活跃时间
        db.prepare('UPDATE sessions SET last_active_at = ? WHERE id = ?').run(Date.now(), sessionId);

        // 记录 SDK 调用
        db.prepare(
            'INSERT INTO sdk_calls (id, session_id, workspace_id, user_id, model, input_tokens, output_tokens, duration_ms, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        ).run(randomUUID(), sessionId, workspaceId, 'owner', 'claude', inputTokens, outputTokens, duration, 'success', Date.now());

        // 回复渠道（统一通过 deliveryQueue 可靠投递）
        const replyContent = streamBuffer.trim() || '[处理完成，无返回内容]';

        if (msg.raw?.accountId) {
            // 微信：通过 deliveryQueue 可靠发送（带重试）
            deliveryQueue.enqueue({
                sessionId,
                channelType: 'weixin',
                senderId: msg.raw.senderId || '',
                botToken: msg.raw.botToken,
                contextToken: msg.raw.contextToken,
                workspaceId,
            });
        } else if (msg.raw?.chatId) {
            // 飞书：通过 deliveryQueue 可靠发送（带重试）
            deliveryQueue.enqueue({
                sessionId,
                channelType: 'lark',
                senderId: msg.senderId || '',
                messageId: msg.channelMessageId,
                chatId: msg.raw.chatId,
                workspaceId,
            });
        } else {
            // WebSocket：直接发送（无重试需求）
            await sendReply('lark', replyContent);
        }

    } catch (e: any) {
        console.error('[Processor] Agent task failed:', e);

        markMessageInterrupted(assistantMsgId, streamBuffer, sessionId, workspaceId, 'assistant');

        db.prepare(
            'INSERT INTO sdk_calls (id, session_id, workspace_id, user_id, model, status, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        ).run(randomUUID(), sessionId, workspaceId, 'owner', 'claude', 'error', e.message || 'Error', Date.now());

        broadcastToWorkspace(workspaceId, { type: 'error', payload: e.message || 'Execution Error' });

        // WebSocket 错误通知（微信/飞书错误由 deliveryQueue 在全部重试失败后发送提示）
        const errorMsg = `执行错误：${e.message}`;
        if (!msg.raw?.accountId && !msg.raw?.chatId) {
            await sendReply('lark', errorMsg);
        }
    } finally {
        // 确保 token 缓存被清空（即使出错）
        if (workspaceId) {
            clearTokenBuffer(workspaceId);
        }
        release();
    }
}

/**
 * 更新流式内容
 */
function updateStreamingContent(msgId: string, content: string): void {
    const db = getDb();
    db.prepare('UPDATE messages SET streaming_content = ? WHERE id = ?').run(content, msgId);
}

/**
 * 完成消息
 */
function finalizeMessage(msgId: string, contentBlocks: any[], sessionId?: string, workspaceId?: string, role?: string): void {
    const db = getDb();
    const content = serializeContent(contentBlocks);
    db.prepare(
        `UPDATE messages SET content = ?, streaming_content = NULL, status = 'complete', is_partial = 0 WHERE id = ?`
    ).run(content, msgId);

    // 清空该工作区的 token 缓存（消息已完成）
    if (workspaceId) {
        clearTokenBuffer(workspaceId);
    }

    // 同步插入到 messages_fts（只索引用户消息）
    if (sessionId && workspaceId && role === 'user') {
        insertMessageFts(msgId, sessionId, workspaceId, role, content, Date.now());
    }
}

/**
 * 标记消息中断
 */
function markMessageInterrupted(msgId: string, partialContent: string, sessionId?: string, workspaceId?: string, role?: string): void {
    const db = getDb();
    const content = partialContent || '';
    const serialized = serializeContent([{ type: 'text', text: content }]);
    db.prepare(
        `UPDATE messages SET content = ?, streaming_content = NULL, status = 'interrupted', is_partial = 0 WHERE id = ?`
    ).run(serialized, msgId);

    // 同步插入到 messages_fts（只索引用户消息）
    if (sessionId && workspaceId && role === 'user') {
        insertMessageFts(msgId, sessionId, workspaceId, role, serialized, Date.now());
    }
}

/**
 * 统一回复函数 - 支持所有渠道
 */
async function replyToMessage(msg: ChannelMessage, text: string): Promise<void> {
    if (msg.raw?.chatId) {
        // 飞书渠道
        await sendReply('lark', text, { channel: 'lark', chat_id: msg.raw.chatId, message_id: msg.channelMessageId });
    } else if (msg.raw?.accountId && msg.raw?.botToken) {
        // 微信渠道
        const { sendTextMessage } = await import('../services/weixin/ilink-api');
        await sendTextMessage(
            msg.raw.botToken,
            msg.raw.senderId,
            text,
            msg.raw.contextToken
        );
    } else {
        // WebSocket 渠道
        await webSocketChannel.sendMessage(text, { target: msg.workspaceId });
    }
}

/**
 * 统一消息处理入口
 * 所有渠道的消息都通过这个函数处理
 *
 * @param msg 统一消息结构
 * @param workspaceId 工作区ID
 */
export async function processChannelMessage(
    msg: ChannelMessage,
    workspaceId: string
): Promise<void> {
    console.log(`[Processor] Processing message from ${msg.senderId || 'unknown'}, workspace: ${workspaceId}`);

    // Log channel message received
    const channelName = msg.raw?.chatId ? 'lark' : msg.raw?.accountId ? 'weixin' : 'websocket';
    logger.system.info('channel', `Message received from ${msg.senderId || 'unknown'}`, { workspaceId, channel: channelName, contentLength: msg.content?.length || 0 });

    // 0. 命令消息优先处理（来自各渠道的统一命令）
    if (msg.command) {
        const handled = await handleCommandByType(msg.command, msg, workspaceId);
        if (handled) return;
    }

    // 1. 交互按钮检测（优先级最高，如果是指令或按钮操作则直接返回）
    if (msg.actionId) {
        const handled = await handleActionButton(msg, workspaceId);
        if (handled) return;
    }

    // 2. 指令检测（基于文本的命令）
    const isCommand = await handleCommand(msg, workspaceId);
    if (isCommand) {
        console.log('[Processor] Command handled, skipping AgentRunner');
        return;
    }

    // 3. 拦截终端命令（安全考虑）
    const text = msg.content.trim();
    if (text.startsWith('/terminal') || text.startsWith('/bash')) {
        await replyToMessage(msg, '请前往 Web 终端面板进行系统级操作。');
        return;
    }

    // 4. 调用 AgentRunner 处理
    if (!msg.sessionId) {
        console.error('[Processor] Missing sessionId');
        await replyToMessage(msg, '系统错误：无法确定会话');
        return;
    }

    await runAgentTaskForChannel(msg.sessionId, workspaceId, msg.content, msg);
}
