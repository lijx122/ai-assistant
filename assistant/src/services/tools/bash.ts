/**
 * Bash 工具 - 在工作区执行 shell 命令
 */

import { spawn } from 'child_process';
import { resolve } from 'path';
import os from 'os';
import { isDangerousCommand, buildConfirmationRequest } from './danger-detector';
import type { ToolDefinition, ToolExecutor, ToolContext, ToolResult } from './types';

// 输出截断上限
const MAX_OUTPUT = 8000;
const TIMEOUT_MS = 30000;

// 截断函数
function truncateOutput(output: string, maxLen: number = MAX_OUTPUT): string {
    if (output.length <= maxLen) return output;
    return output.slice(0, maxLen) + `\n[输出已截断，共 ${output.length} 字符]`;
}

// 获取运行时平台信息
function getPlatformHint(): string {
    const platform = os.platform();
    const arch = os.arch();
    const shell = process.env.SHELL || '/bin/sh';

    if (platform === 'darwin') {
        return `当前环境：macOS (${arch})，Shell：${shell}。
注意：macOS 不支持 Linux 特有的命令参数。
- 查看内存：使用 vm_stat 或 ps -o rss= -p <pid>
- 查看进程：使用 ps aux
- 不要使用 top -bn1（-b 参数不存在）
- 不要使用 free -h（命令不存在）`;
    } else if (platform === 'linux') {
        return `当前环境：Linux (${arch})，Shell：${shell}。
常用命令：
- 查看内存：free -h 或 cat /proc/meminfo
- 查看进程：ps aux 或 top -bn1`;
    } else {
        return `当前环境：${platform} (${arch})，Shell：${shell}`;
    }
}

/**
 * 工具定义
 */
export const bashToolDefinition: ToolDefinition = {
    name: 'bash',
    description: `在宿主机执行 shell 命令。必须提供 command 参数。命令超时 ${TIMEOUT_MS / 1000} 秒，输出超过 ${MAX_OUTPUT} 字符会被截断。

${getPlatformHint()}

请根据当前平台选择兼容的命令语法。`,
    input_schema: {
        type: 'object',
        properties: {
            command: {
                type: 'string',
                description: '要执行的 shell 命令（如 "ls -la" 或 "npm test"）',
            },
            cwd: {
                type: 'string',
                description: '可选：工作目录（相对工作区 root_path）。默认为工作区根目录',
            },
        },
        required: ['command'],
    },
};

/**
 * 执行 bash 命令
 */
export async function executeBash(
    input: { command: string; cwd?: string },
    context: ToolContext
): Promise<ToolResult> {
    const { command, cwd } = input;
    const { workspaceId } = context;
    const startTime = Date.now();

    // 检测危险命令
    const dangerCheck = isDangerousCommand(command);
    if (dangerCheck.isDangerous) {
        const confirmationReq = buildConfirmationRequest(dangerCheck);
        return {
            success: false,
            error: `危险命令需要确认: ${confirmationReq.description}`,
            requiresConfirmation: true,
            confirmationId: `bash-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
            confirmationTitle: confirmationReq.title,
            confirmationDescription: `命令: ${command}\n\n${confirmationReq.description}`,
            riskLevel: dangerCheck.risk,
            elapsed_ms: 0,
        };
    }

    // 使用统一注入的 cwd
    let actualCwd = context.cwd;
    if (!actualCwd) {
        return {
            success: false,
            error: `Workspace cwd not resolved`,
            elapsed_ms: Date.now() - startTime,
        };
    }

    if (cwd) {
        const resolvedPath = resolve(actualCwd, cwd);
        if (!resolvedPath.startsWith(actualCwd)) {
            return {
                success: false,
                error: `Invalid cwd: ${cwd} (path traversal detected)`,
                elapsed_ms: Date.now() - startTime,
            };
        }
        actualCwd = resolvedPath;
    }

    console.log(`[BashTool] Executing in ${actualCwd}: ${command.slice(0, 100)}${command.length > 100 ? '...' : ''}`);

    return new Promise((resolve) => {
        let stdout = '';
        let stderr = '';
        let killed = false;
        let forceKillTimer: NodeJS.Timeout | null = null;

        const shell = process.env.SHELL || '/bin/sh';
        const child = spawn(shell, ['-c', command], {
            cwd: actualCwd,
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        child.stdout?.on('data', (data: Buffer) => {
            stdout += data.toString('utf8');
        });

        child.stderr?.on('data', (data: Buffer) => {
            stderr += data.toString('utf8');
        });

        // 设置超时 - 先 SIGTERM，5秒后 SIGKILL
        const timeoutId = setTimeout(() => {
            killed = true;
            console.log(`[BashTool] Timeout reached (${TIMEOUT_MS}ms), sending SIGTERM...`);

            child.kill('SIGTERM');

            forceKillTimer = setTimeout(() => {
                if (!child.killed) {
                    console.log(`[BashTool] Process still alive, sending SIGKILL...`);
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

            const truncated = finalOutput.length > MAX_OUTPUT;

            resolve({
                success: code === 0 && !killed,
                data: {
                    output: truncateOutput(finalOutput),
                    exit_code: code ?? (killed ? -1 : 1),
                    truncated,
                },
                elapsed_ms: elapsed,
            });
        });

        child.on('error', (err: Error) => {
            clearTimeout(timeoutId);
            clearForceKillTimer();
            const elapsed = Date.now() - startTime;

            let finalOutput = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n\n');
            if (killed) {
                finalOutput += `\n\n[命令执行超时（${TIMEOUT_MS / 1000}秒），已终止]`;
            } else {
                finalOutput += `\n\n[执行错误: ${err.message}]`;
            }

            const truncated = finalOutput.length > MAX_OUTPUT;

            resolve({
                success: false,
                data: {
                    output: truncateOutput(finalOutput),
                    exit_code: -1,
                    truncated,
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
export const bashTool = {
    definition: bashToolDefinition,
    executor: executeBash,
    timeoutMs: TIMEOUT_MS,
    riskLevel: 'high' as const, // bash 是高风险操作
    requiresConfirmation: false, // 暂时不需要确认，后续根据命令内容判断
};
