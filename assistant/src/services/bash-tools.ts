/**
 * Bash 工具 - 在工作区执行 shell 命令
 */

import { spawn } from 'child_process';
import { getDb } from '../db';
import { resolve } from 'path';
import os from 'os';

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

// 工具定义
export const bashToolDefinition = {
    name: 'bash',
    description: `在宿主机执行 shell 命令。必须提供 command 参数。命令超时 ${TIMEOUT_MS / 1000} 秒，输出超过 ${MAX_OUTPUT} 字符会被截断。返回 success 字段指示命令是否成功执行。

${getPlatformHint()}

请根据当前平台选择兼容的命令语法。`,
    input_schema: {
        type: 'object' as const,
        properties: {
            command: {
                type: 'string' as const,
                description: '要执行的 shell 命令（如 "ls -la" 或 "npm test"）',
            },
            cwd: {
                type: 'string' as const,
                description: '可选：工作目录（相对工作区 root_path）。默认为工作区根目录',
            },
        },
        required: ['command' as const],
    },
};

// 执行 bash 命令（使用 spawn + AbortController，确保可 kill）
export function executeBash(workspaceId: string, input: { command: string; cwd?: string }): Promise<{
    success: boolean;
    output: string;
    exit_code: number;
    elapsed_ms: number;
    truncated?: boolean;
}> {
    const { command, cwd } = input;
    const startTime = Date.now();

    // 获取工作区 root_path
    const db = getDb();
    const workspace = db.prepare('SELECT root_path FROM workspaces WHERE id = ?').get(workspaceId) as
        { root_path: string } | undefined;

    if (!workspace) {
        return Promise.reject(new Error(`Workspace ${workspaceId} not found`));
    }

    // 计算实际工作目录
    let actualCwd = workspace.root_path;
    if (cwd) {
        const resolvedPath = resolve(workspace.root_path, cwd);
        if (!resolvedPath.startsWith(workspace.root_path)) {
            return Promise.reject(new Error(`Invalid cwd: ${cwd} (path traversal detected)`));
        }
        actualCwd = resolvedPath;
    }

    console.log(`[BashTool] Executing in ${actualCwd}: ${command.slice(0, 100)}${command.length > 100 ? '...' : ''}`);

    return new Promise((resolve) => {
        const abortController = new AbortController();
        let stdout = '';
        let stderr = '';
        let killed = false;
        let forceKillTimer: NodeJS.Timeout | null = null;

        // 使用 spawn 替代 execSync，支持 AbortController
        const shell = process.env.SHELL || '/bin/sh';
        const child = spawn(shell, ['-c', command], {
            cwd: actualCwd,
            signal: abortController.signal,
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        // 收集 stdout
        child.stdout?.on('data', (data: Buffer) => {
            stdout += data.toString('utf8');
        });

        // 收集 stderr
        child.stderr?.on('data', (data: Buffer) => {
            stderr += data.toString('utf8');
        });

        // 设置超时 - 先 SIGTERM，5秒后 SIGKILL
        const timeoutId = setTimeout(() => {
            killed = true;
            console.log(`[BashTool] Timeout reached (${TIMEOUT_MS}ms), sending SIGTERM...`);

            // 先尝试优雅终止
            child.kill('SIGTERM');

            // 5秒后如未退出，强制 SIGKILL
            forceKillTimer = setTimeout(() => {
                if (!child.killed) {
                    console.log(`[BashTool] Process still alive, sending SIGKILL...`);
                    child.kill('SIGKILL');
                }
            }, 5000);
        }, TIMEOUT_MS);

        // 清理强制 kill 定时器
        const clearForceKillTimer = () => {
            if (forceKillTimer) {
                clearTimeout(forceKillTimer);
                forceKillTimer = null;
            }
        };

        // 进程结束
        child.on('close', (code: number | null) => {
            clearTimeout(timeoutId);
            clearForceKillTimer();
            const elapsed = Date.now() - startTime;

            // 合并输出
            const combinedOutput = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n\n');
            let finalOutput = combinedOutput;

            if (killed) {
                finalOutput += `\n\n[命令执行超时（${TIMEOUT_MS / 1000}秒），已终止]`;
            }

            const truncated = finalOutput.length > MAX_OUTPUT;
            const exitCode = code ?? (killed ? -1 : 1);

            resolve({
                success: code === 0 && !killed,
                output: truncateOutput(finalOutput),
                exit_code: exitCode,
                elapsed_ms: elapsed,
                truncated,
            });
        });

        // 错误处理（如 spawn 失败）
        child.on('error', (err: Error) => {
            clearTimeout(timeoutId);
            clearForceKillTimer();
            const elapsed = Date.now() - startTime;

            let finalOutput = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n\n');
            if (killed || err.name === 'AbortError') {
                finalOutput += `\n\n[命令执行超时（${TIMEOUT_MS / 1000}秒），已终止]`;
            } else {
                finalOutput += `\n\n[执行错误: ${err.message}]`;
            }

            const truncated = finalOutput.length > MAX_OUTPUT;

            resolve({
                success: false,
                output: truncateOutput(finalOutput),
                exit_code: -1,
                elapsed_ms: elapsed,
                truncated,
            });
        });
    });
}
