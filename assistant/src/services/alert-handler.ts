/**
 * Alert Handler 模块
 * 告警处理核心逻辑：AI分析、通知分发、自动修复
 *
 * @module src/services/alert-handler
 */

import { randomUUID } from 'crypto';
import { getDb } from '../db';
import { getConfig } from '../config';
import { executeClaudeCode } from './tools/claude-code';
import { channelManager } from '../channels';

// 告警状态类型
export type AlertStatus = 'pending' | 'notified' | 'fixing' | 'resolved' | 'failed' | 'ignored';
export type AlertSeverity = 'warn' | 'critical';

// 告警数据结构
export interface AlertData {
    id: string;
    workspace_id: string;
    session_id?: string;
    task_id?: string;
    source: string;
    message: string;
    raw?: string;
    status: AlertStatus;
    severity?: AlertSeverity;
    ai_analysis?: string;
    suggest_fix?: string;
    fix_attempts: number;
    fix_log?: string;
    pending_script_adjust: number;
    created_at: string;
}

// 创建告警
export async function createAlert(data: {
    workspace_id: string;
    task_id?: string;
    source: string;
    message: string;
    raw?: string;
}): Promise<string> {
    const db = getDb();
    const id = randomUUID();

    db.prepare(`
        INSERT INTO alerts (
            id, workspace_id, task_id, source, message, raw,
            status, fix_attempts, pending_script_adjust, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        id,
        data.workspace_id,
        data.task_id || null,
        data.source,
        data.message,
        data.raw || null,
        'pending',
        0,
        0,
        new Date().toISOString()
    );

    console.log(`[AlertHandler] Created alert ${id} from ${data.source}`);
    return id;
}

// 更新告警状态
export function updateAlertStatus(
    alertId: string,
    status: AlertStatus,
    extra?: Partial<AlertData>
): void {
    const db = getDb();
    const fields: string[] = ['status = ?'];
    const values: any[] = [status];

    if (extra?.severity) {
        fields.push('severity = ?');
        values.push(extra.severity);
    }
    if (extra?.ai_analysis) {
        fields.push('ai_analysis = ?');
        values.push(extra.ai_analysis);
    }
    if (extra?.suggest_fix) {
        fields.push('suggest_fix = ?');
        values.push(extra.suggest_fix);
    }
    if (extra?.fix_log) {
        fields.push('fix_log = ?');
        values.push(extra.fix_log);
    }

    values.push(alertId);

    db.prepare(`
        UPDATE alerts SET ${fields.join(', ')} WHERE id = ?
    `).run(...values);

    console.log(`[AlertHandler] Alert ${alertId} status: ${status}`);
}

// 增加修复尝试次数
export function incrementFixAttempts(alertId: string): number {
    const db = getDb();
    db.prepare('UPDATE alerts SET fix_attempts = fix_attempts + 1 WHERE id = ?').run(alertId);
    const row = db.prepare('SELECT fix_attempts FROM alerts WHERE id = ?').get(alertId) as { fix_attempts: number };
    return row.fix_attempts;
}

// 追加修复日志
export function appendFixLog(alertId: string, log: string): void {
    const db = getDb();
    const row = db.prepare('SELECT fix_log FROM alerts WHERE id = ?').get(alertId) as { fix_log: string | null };
    const newLog = row.fix_log ? `${row.fix_log}\n---\n${log}` : log;
    db.prepare('UPDATE alerts SET fix_log = ? WHERE id = ?').run(newLog, alertId);
}

// 主处理函数
export async function handleAlert(alertId: string): Promise<void> {
    console.log(`[AlertHandler] handleAlert started: ${alertId}`);

    const db = getDb();
    const alert = db.prepare('SELECT * FROM alerts WHERE id = ?').get(alertId) as AlertData | undefined;

    if (!alert) {
        console.error(`[AlertHandler] Alert ${alertId} not found`);
        return;
    }

    console.log(`[AlertHandler] Processing alert ${alertId}, workspace: ${alert.workspace_id}, source: ${alert.source}`);

    try {
        // ===== 问题1修复：查找或创建专用的系统告警 session =====
        let alertSession = db.prepare(
            `SELECT id FROM sessions WHERE workspace_id = ? AND title = '__system_alerts__' LIMIT 1`
        ).get(alert.workspace_id) as { id: string } | undefined;

        if (!alertSession) {
            const sessionId = randomUUID();
            const now = Date.now();
            db.prepare(
                `INSERT INTO sessions (id, workspace_id, user_id, channel, title, started_at, last_active_at)
                 VALUES (?, ?, ?, 'system', '__system_alerts__', ?, ?)`
            ).run(sessionId, alert.workspace_id, 'system', now, now);
            alertSession = { id: sessionId };
            console.log(`[AlertHandler] Created system alert session ${sessionId} for workspace ${alert.workspace_id}`);
        }

        const sessionId = alertSession.id;

        // 更新告警记录关联的会话
        db.prepare('UPDATE alerts SET session_id = ? WHERE id = ?').run(sessionId, alertId);

        // 构造告警消息内容
        const alertContent = `【系统告警】任务执行失败，请分析以下报错信息并告知用户是否需要处理：

来源：${alert.source}
错误描述：${alert.message}
详细日志：${alert.raw || '无'}

请：
1. 用一句话解释这个错误的原因
2. 判断严重程度（普通提示 / 需要处理）
3. 如果需要处理，询问用户是否需要自动修复`;

        // 更新状态为 notified
        updateAlertStatus(alertId, 'notified');

        // ===== 问题2修复：直接调用 AgentRunner，不走 processChannelMessage =====
        const aiResponse = await runAgentTaskForAlert({
            sessionId,
            workspaceId: alert.workspace_id,
            userMessage: alertContent,
        });

        console.log(`[AlertHandler] AI response: "${aiResponse.slice(0, 100)}..."`);

        // 通过 channelManager 广播 AI 回复到所有渠道
        await channelManager.broadcast(
            `⚠️ **系统告警**\n\n来源: ${alert.source}\n\n${aiResponse}`,
            { target: alert.workspace_id }
        );

        console.log(`[AlertHandler] Broadcast to channels: success`);
        console.log(`[AlertHandler] Alert ${alertId} processed successfully`);
    } catch (err: any) {
        console.error(`[AlertHandler] Failed to process alert ${alertId}:`, err.message);
        // 更新为失败状态，避免重复处理
        updateAlertStatus(alertId, 'failed', {
            ai_analysis: `处理失败: ${err.message}`,
        });
    }
}

/**
 * 告警专用的 AgentRunner 调用函数
 * 简化版：直接运行 Agent，返回文本回复
 */
async function runAgentTaskForAlert({
    sessionId,
    workspaceId,
    userMessage,
}: {
    sessionId: string;
    workspaceId: string;
    userMessage: string;
}): Promise<string> {
    const db = getDb();
    const config = getConfig();

    // 动态导入依赖（避免循环依赖）
    const { getRunner } = await import('./agent-runner');
    const { buildWorkspaceConfigPrompt } = await import('./workspace-config');
    const { compactIfNeeded } = await import('./context-summary');

    // 插入用户消息到数据库
    const userMsgId = randomUUID();
    const now = Date.now();
    db.prepare(
        'INSERT INTO messages (id, session_id, workspace_id, user_id, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(userMsgId, sessionId, workspaceId, 'system', 'user', userMessage, now);

    // 更新会话活跃时间
    db.prepare('UPDATE sessions SET last_active_at = ? WHERE id = ?').run(now, sessionId);

    // 加载历史消息
    const rows = db.prepare(
        'SELECT role, content FROM messages WHERE session_id = ? ORDER BY created_at ASC'
    ).all(sessionId) as any[];

    let messages = rows
        .filter(r => r.content && r.content.trim().length > 0)
        .map(r => ({
            role: (r.role === 'assistant' ? 'assistant' : 'user') as 'user' | 'assistant',
            content: r.content,
        }));

    // 执行 compact 检测（如果需要）
    if (config.claude.compact.enabled) {
        const { estimateTokens } = await import('./context-summary');
        const estimated = estimateTokens(messages);
        const tokenLimit = config.claude.compact.token_limit ?? 60000;
        const ratioThreshold = Math.floor(config.claude.max_tokens * config.claude.compact.threshold_ratio);

        if (estimated > tokenLimit && estimated > ratioThreshold) {
            console.log(`[AlertHandler] Token threshold exceeded, triggering compact...`);
            const compactResult = await compactIfNeeded(messages, sessionId, workspaceId);
            if (compactResult.didCompact) {
                messages = compactResult.messages;
            }
        }
    }

    // 构建 system prompt
    const workspaceConfigPrompt = buildWorkspaceConfigPrompt(workspaceId);
    const systemPrompt = `${workspaceConfigPrompt || ''}

You are a system monitoring assistant. Analyze alerts and provide clear, actionable responses.

重要行为约束：
1. 执行工具前不要预测或猜测结果
2. 必须先调用工具，拿到真实结果后再总结
3. 正确格式：「我来执行xxx」→ [调用工具] → 「结果如下：[真实数据]」`;

    // 收集 AI 回复文本
    let responseText = '';

    const onEvent = (type: string, payload: any) => {
        if (type === 'text') {
            responseText += payload;
        } else if (type === 'error') {
            console.error(`[AlertHandler] Agent error:`, payload);
        }
    };

    // 运行 Agent
    const runner = getRunner(workspaceId, onEvent);
    await runner.run(messages, systemPrompt.trim(), sessionId, workspaceId, onEvent);

    // 保存 AI 回复到数据库
    if (responseText) {
        const assistantMsgId = randomUUID();
        db.prepare(
            'INSERT INTO messages (id, session_id, workspace_id, user_id, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).run(assistantMsgId, sessionId, workspaceId, 'system', 'assistant', responseText, Date.now());
    }

    return responseText || '[AI 未返回内容]';
}

// 尝试修复
export async function attemptFix(alertId: string, workspaceId: string): Promise<void> {
    const config = getConfig();
    const db = getDb();
    const alert = db.prepare('SELECT * FROM alerts WHERE id = ?').get(alertId) as AlertData | undefined;

    if (!alert) {
        console.error(`[AlertHandler] Alert ${alertId} not found`);
        return;
    }

    // 检查尝试次数
    const maxAttempts = config.ops?.alert?.max_fix_attempts || 3;
    const currentAttempts = incrementFixAttempts(alertId);

    if (currentAttempts > maxAttempts) {
        const msg = `告警 ${alertId} 已达最大修复尝试次数 (${maxAttempts})，需要人工介入`;
        console.log(`[AlertHandler] ${msg}`);
        updateAlertStatus(alertId, 'failed');

        // 通知人工介入
        await channelManager.broadcast(
            `⚠️ ${msg}\n来源: ${alert.source}\n消息: ${alert.message}`);
        return;
    }

    updateAlertStatus(alertId, 'fixing');
    console.log(`[AlertHandler] Attempt ${currentAttempts}/${maxAttempts} to fix alert ${alertId}`);

    // 调用 Claude Code 工具
    const fixLog: string[] = [];
    fixLog.push(`=== Fix Attempt ${currentAttempts}/${maxAttempts} ===`);
    fixLog.push(`Time: ${new Date().toISOString()}`);

    try {
        const task = `修复以下问题: ${alert.message}`;
        const context = `告警来源: ${alert.source}\n分析: ${alert.ai_analysis || '无'}\n建议修复: ${alert.suggest_fix || '无'}\n原始数据: ${alert.raw || '无'}`;

        // 读取技能文档
        let skillContent = '';
        try {
            const { readFileSync } = require('fs');
            const { resolve } = require('path');
            skillContent = readFileSync(
                resolve(process.cwd(), 'scripts/skills/fix-service.md'),
                'utf8'
            );
        } catch {
            skillContent = '修复原则: 安全第一，备份优先，最小变更';
        }

        const fullContext = `${context}\n\n修复指导:\n${skillContent}`;

        const result = await executeClaudeCode(
            { task, context: fullContext },
            { workspaceId }
        );

        fixLog.push(`Exit Code: ${result.data?.exit_code ?? 'unknown'}`);
        fixLog.push(`Output:\n${result.data?.output || result.error || 'No output'}`);

        if (result.success && result.data?.exit_code === 0) {
            // 修复成功
            updateAlertStatus(alertId, 'resolved');
            appendFixLog(alertId, fixLog.join('\n'));

            // 发送成功通知
            await channelManager.broadcast(
                `✅ 告警 ${alertId} 自动修复成功\n来源: ${alert.source}\n尝试次数: ${currentAttempts}`);

            console.log(`[AlertHandler] Alert ${alertId} fixed successfully`);
        } else {
            // 修复失败，继续重试
            appendFixLog(alertId, fixLog.join('\n'));
            updateAlertStatus(alertId, 'notified');

            console.log(`[AlertHandler] Fix attempt ${currentAttempts} failed, will retry if needed`);

            // 递归重试
            if (currentAttempts < maxAttempts) {
                // 延迟后重试
                setTimeout(() => attemptFix(alertId, workspaceId), 5000);
            } else {
                // 最后一次也失败
                updateAlertStatus(alertId, 'failed');
                await channelManager.broadcast(
                    `❌ 告警 ${alertId} 自动修复失败，已达最大尝试次数\n来源: ${alert.source}\n需要人工介入`);
            }
        }
    } catch (err: any) {
        fixLog.push(`Error: ${err.message}`);
        appendFixLog(alertId, fixLog.join('\n'));
        updateAlertStatus(alertId, 'notified');

        console.error(`[AlertHandler] Fix error for alert ${alertId}:`, err);

        // 递归重试
        if (currentAttempts < maxAttempts) {
            setTimeout(() => attemptFix(alertId, workspaceId), 5000);
        } else {
            updateAlertStatus(alertId, 'failed');
        }
    }
}

// 忽略告警
export async function ignoreAlert(alertId: string, _workspaceId: string): Promise<void> {
    updateAlertStatus(alertId, 'ignored');
    console.log(`[AlertHandler] Alert ${alertId} ignored`);

    // 标记 pending_script_adjust=1，等待用户决定是否调整脚本
    const db = getDb();
    db.prepare('UPDATE alerts SET pending_script_adjust = 1 WHERE id = ?').run(alertId);
}

// 获取最近的 critical 告警
export async function getLatestCriticalAlert(workspaceId: string, pendingAdjustOnly?: boolean): Promise<AlertData | null> {
    const db = getDb();
    let sql = `
        SELECT * FROM alerts
        WHERE workspace_id = ? AND severity = 'critical'
    `;
    const params: any[] = [workspaceId];

    if (pendingAdjustOnly) {
        sql += ' AND pending_script_adjust = 1';
    } else {
        sql += " AND status IN ('notified', 'fixing', 'failed')";
    }

    sql += ' ORDER BY created_at DESC LIMIT 1';

    const alert = db.prepare(sql).get(...params) as AlertData | undefined;
    return alert || null;
}

// 更新 pending_script_adjust 标记
export function updatePendingScriptAdjust(alertId: string, value: number): void {
    const db = getDb();
    db.prepare('UPDATE alerts SET pending_script_adjust = ? WHERE id = ?').run(value, alertId);
}

// 调整检测脚本
export async function adjustScript(alertId: string, workspaceId: string): Promise<void> {
    const db = getDb();
    const alert = db.prepare('SELECT * FROM alerts WHERE id = ?').get(alertId) as AlertData | undefined;

    if (!alert || !alert.task_id) {
        console.error(`[AlertHandler] Alert ${alertId} not found or has no task_id`);
        await channelManager.broadcast('无法调整脚本：告警或任务信息缺失', { target: workspaceId });
        return;
    }

    // 获取任务信息
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(alert.task_id) as
        { script_path?: string; name: string } | undefined;

    if (!task || !task.script_path) {
        console.error(`[AlertHandler] Task ${alert.task_id} not found or has no script`);
        await channelManager.broadcast('无法调整脚本：任务脚本路径不存在', { target: workspaceId });
        return;
    }

    const scriptPath = task.script_path;
    const backupPath = `${scriptPath}.bak.${Date.now()}`;

    console.log(`[AlertHandler] Adjusting script ${scriptPath} for alert ${alertId}`);
    await channelManager.broadcast(`开始调整检测脚本: ${task.name}\n备份路径: ${backupPath}`, { target: workspaceId });

    try {
        const { readFileSync, writeFileSync, copyFileSync } = require('fs');
        const { spawn } = require('child_process');

        // 1. 备份脚本
        copyFileSync(scriptPath, backupPath);

        // 2. 读取原脚本内容
        const originalScript = readFileSync(scriptPath, 'utf8');

        // 3. 调用 claude_code 工具添加过滤逻辑
        const task_prompt = `为以下检测脚本添加过滤逻辑，排除已知的误报情况。

原脚本路径: ${scriptPath}
误报告警信息: ${alert.message}
建议修复方案: ${alert.suggest_fix || '添加适当的过滤条件'}

要求:
1. 保持原有检测逻辑不变
2. 添加过滤条件排除本次误报
3. 使用注释说明过滤原因
4. 返回完整的修改后脚本内容`;

        const context = `原始脚本:\n${originalScript}\n\n告警来源: ${alert.source}\n原始数据: ${alert.raw || '无'}`;

        const result = await executeClaudeCode(
            { task: task_prompt, context, workdir: require('path').dirname(scriptPath) },
            { workspaceId }
        );

        if (!result.success) {
            throw new Error(`AI 调整失败: ${result.error || result.data?.output}`);
        }

        // 4. 提取修改后的脚本内容
        const output = result.data?.output || '';
        const scriptMatch = output.match(/```(?:bash|sh)?\n([\s\S]*?)```/) || output.match(/<script>([\s\S]*?)<\/script>/) || [null, output];
        const adjustedScript = scriptMatch[1]?.trim() || output;

        if (!adjustedScript || adjustedScript.length < 50) {
            throw new Error('AI 返回的脚本内容无效或太短');
        }

        // 5. 写入临时文件验证语法
        const tempPath = `${scriptPath}.tmp`;
        writeFileSync(tempPath, adjustedScript);

        // 6. bash -n 语法验证
        const syntaxCheck = await new Promise<{ success: boolean; output: string }>((resolve) => {
            const child = spawn('bash', ['-n', tempPath], { stdio: ['ignore', 'pipe', 'pipe'] });
            let stderr = '';
            child.stderr?.on('data', (data: Buffer) => { stderr += data.toString(); });
            child.on('close', (code: number | null) => {
                resolve({ success: code === 0, output: stderr });
            });
            child.on('error', () => resolve({ success: false, output: 'Failed to run bash -n' }));
        });

        // 清理临时文件
        try { require('fs').unlinkSync(tempPath); } catch {}

        if (!syntaxCheck.success) {
            throw new Error(`语法验证失败: ${syntaxCheck.output}`);
        }

        // 7. 写入正式脚本
        writeFileSync(scriptPath, adjustedScript);

        // 8. 更新告警状态
        updatePendingScriptAdjust(alertId, 0);

        console.log(`[AlertHandler] Script adjusted successfully: ${scriptPath}`);
        await channelManager.broadcast(
            `✅ 检测脚本调整成功\n脚本: ${task.name}\n备份: ${backupPath}\n已添加过滤逻辑，下次检测将排除此类误报`,
            { target: workspaceId }
        );

    } catch (err: any) {
        console.error(`[AlertHandler] Script adjustment failed:`, err);

        // 还原备份
        try {
            const { existsSync, copyFileSync } = require('fs');
            if (existsSync(backupPath)) {
                copyFileSync(backupPath, scriptPath);
                await channelManager.broadcast(
                    `❌ 脚本调整失败，已还原备份\n错误: ${err.message.slice(0, 200)}`,
                    { target: workspaceId }
                );
            } else {
                await channelManager.broadcast(
                    `❌ 脚本调整失败且备份不存在，请手动检查\n错误: ${err.message.slice(0, 200)}`,
                    { target: workspaceId }
                );
            }
        } catch (restoreErr: any) {
            await channelManager.broadcast(
                `❌ 脚本调整失败且还原备份也失败\n调整错误: ${err.message.slice(0, 100)}\n还原错误: ${restoreErr.message.slice(0, 100)}`,
                { target: workspaceId }
            );
        }
    }
}
