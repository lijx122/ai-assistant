/**
 * ClaudeCode 工具 - 调用 Claude CLI 执行修复任务
 *
 * 用途：运维告警自动修复时，调用 Claude 分析和修复代码
 */

import { spawn } from 'child_process';
import { resolve } from 'path';
import type { ToolDefinition, ToolContext, ToolResult } from './types';

// 超时配置：5分钟
const TIMEOUT_MS = 300000;
const MAX_OUTPUT = 10000;

// 截断函数
function truncateOutput(output: string, maxLen: number = MAX_OUTPUT): string {
    if (output.length <= maxLen) return output;
    return output.slice(0, maxLen) + `\n[输出已截断，共 ${output.length} 字符]`;
}

/**
 * 工具定义
 */
export const claudeCodeToolDefinition: ToolDefinition = {
    name: 'claude_code',
    description: `调用 Claude CLI 执行代码修复任务。用于运维告警的自动修复场景。

参数说明：
- task: 修复任务的描述（如"修复数据库连接超时问题"）
- context: 上下文信息（如错误日志、相关代码片段）
- workdir: 可选，工作目录（默认为当前进程的工作目录）

执行命令：claude -p "{task}\n\n上下文：\n{context}" --allowedTools "Bash,Read,Edit,Write" --output-format text

注意：
- 超时时间为 5 分钟
- 仅允许使用 Bash, Read, Edit, Write 工具
- 返回包含 exitCode 和 output`,
    input_schema: {
        type: 'object',
        properties: {
            task: {
                type: 'string',
                description: '修复任务的描述（必需）',
            },
            context: {
                type: 'string',
                description: '上下文信息，如错误日志、相关代码等（必需）',
            },
            workdir: {
                type: 'string',
                description: '可选：工作目录（相对或绝对路径）',
            },
        },
        required: ['task', 'context'],
    },
};

/**
 * 执行 ClaudeCode 工具
 */
export async function executeClaudeCode(
    input: { task: string; context: string; workdir?: string },
    _context: ToolContext
): Promise<ToolResult> {
    const { task, context, workdir } = input;
    const startTime = Date.now();

    // 确定工作目录
    let actualCwd = _context.cwd || process.cwd();
    if (workdir) {
        actualCwd = resolve(actualCwd, workdir);
    }

    // 构造 prompt
    const prompt = `${task}\n\n上下文：\n${context}`;

    console.log(`[ClaudeCode] Task: ${task.slice(0, 50)}${task.length > 50 ? '...' : ''}`);

    return new Promise((resolve) => {
        let stdout = '';
        let stderr = '';
        let killed = false;
        let forceKillTimer: NodeJS.Timeout | null = null;

        // 构造 claude 命令参数
        const args = [
            '-p', prompt,
            '--allowedTools', 'Bash,Read,Edit,Write',
            '--output-format', 'text',
        ];

        const child = spawn('claude', args, {
            cwd: actualCwd,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: {
                // 只传递必要的 ASCII 安全的环境变量
                PATH: process.env.PATH,
                HOME: process.env.HOME,
                USER: process.env.USER,
                ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
                ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
                // 强制使用 C 语言环境，避免中文编码问题
                LANG: 'C',
                LC_ALL: 'C',
            },
        });

        child.stdout?.on('data', (data: Buffer) => {
            stdout += data.toString('utf8');
        });

        child.stderr?.on('data', (data: Buffer) => {
            stderr += data.toString('utf8');
        });

        // 设置超时
        const timeoutId = setTimeout(() => {
            killed = true;
            console.log(`[ClaudeCode] Timeout reached (${TIMEOUT_MS}ms), sending SIGTERM...`);

            child.kill('SIGTERM');

            forceKillTimer = setTimeout(() => {
                if (!child.killed) {
                    console.log(`[ClaudeCode] Process still alive, sending SIGKILL...`);
                    child.kill('SIGKILL');
                }
            }, 5000);
        }, TIMEOUT_MS);

        const clearForceKillTimer = () => {
            if (forceKillTimer) {
                clearTimeout(forceKillTimer);
                forceKillTimer = null;
            }
        };

        child.on('close', (code: number | null) => {
            clearTimeout(timeoutId);
            clearForceKillTimer();
            const elapsed = Date.now() - startTime;

            const combinedOutput = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n\n');
            let finalOutput = combinedOutput;

            if (killed) {
                finalOutput += `\n\n[命令执行超时（${TIMEOUT_MS / 1000}秒），已终止]`;
            }

            resolve({
                success: code === 0 && !killed,
                data: {
                    output: truncateOutput(finalOutput),
                    exit_code: code ?? (killed ? -1 : 1),
                    task: task.slice(0, 100),
                },
                elapsed_ms: elapsed,
            });
        });

        child.on('error', (err: Error) => {
            clearTimeout(timeoutId);
            clearForceKillTimer();
            const elapsed = Date.now() - startTime;

            // 特殊处理：claude 命令不存在
            if (err.message?.includes('ENOENT') || err.message?.includes('spawn claude')) {
                resolve({
                    success: false,
                    error: 'Claude CLI 未安装或未在 PATH 中。请运行: npm install -g @anthropic-ai/claude-code',
                    data: {
                        output: '',
                        exit_code: -1,
                    },
                    elapsed_ms: elapsed,
                });
                return;
            }

            let finalOutput = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n\n');
            if (killed) {
                finalOutput += `\n\n[命令执行超时（${TIMEOUT_MS / 1000}秒），已终止]`;
            } else {
                finalOutput += `\n\n[执行错误: ${err.message}]`;
            }

            resolve({
                success: false,
                data: {
                    output: truncateOutput(finalOutput),
                    exit_code: -1,
                },
                error: err.message,
                elapsed_ms: elapsed,
            });
        });
    });
}

/**
 * 注册的工具配置
 */
export const claudeCodeTool = {
    definition: claudeCodeToolDefinition,
    executor: executeClaudeCode,
    timeoutMs: TIMEOUT_MS,
    riskLevel: 'high' as const, // 调用外部 AI 是高风险操作
    requiresConfirmation: false,
};
