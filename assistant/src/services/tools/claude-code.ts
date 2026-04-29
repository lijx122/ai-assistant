/**
 * ClaudeCode 工具 - 通用任务委派，调用 Claude CLI 执行任意任务
 */

import { spawn } from 'child_process';
import { resolve, join } from 'path';
import { existsSync, readFileSync } from 'fs';
import type { ToolDefinition, ToolContext, ToolResult } from './types';

const DEFAULT_TIMEOUT_MS = 300000;
const MAX_TIMEOUT_MS = 1800000;
const MAX_OUTPUT = 10000;
const CLAUDE_MD_MAX_CHARS = 2000;

function truncateOutput(output: string, maxLen: number = MAX_OUTPUT): string {
    if (output.length <= maxLen) return output;
    return output.slice(0, maxLen) + `\n[输出已截断，共 ${output.length} 字符]`;
}

/** 读工作目录下的 CLAUDE.md，截断到 CLAUDE_MD_MAX_CHARS */
function readClaudeMd(cwd: string): string {
    const candidates = [join(cwd, 'CLAUDE.md'), join(cwd, '.claude', 'CLAUDE.md')];
    for (const p of candidates) {
        if (existsSync(p)) {
            const content = readFileSync(p, 'utf8');
            return content.length > CLAUDE_MD_MAX_CHARS
                ? content.slice(0, CLAUDE_MD_MAX_CHARS) + '\n...[CLAUDE.md 已截断]'
                : content;
        }
    }
    return '';
}

/** 结构化项目上下文 */
interface ProjectContext {
    cwd_note?: string;           // 工作目录语义描述
    files_of_interest?: string[]; // 涉及的文件完整路径（子 Claude 自己 Read）
    failure_log?: string;        // 上次失败的报错日志
    extra_constraints?: string;  // 项目硬约束
}

export const claudeCodeToolDefinition: ToolDefinition = {
    name: 'claude_code',
    description: `通用任务委派工具：调用 Claude CLI 执行代码修改、测试、分析、文件操作等任意任务。
适用场景：需要多步骤代码操作、文件读写、运行命令、修复 bug、实现功能、重构代码等。

参数说明：
- task：任务描述（必填，清晰描述要做什么）
- project_context：结构化项目上下文（强烈建议填写，上下文越完整，输出质量越高）
  - cwd_note：工作目录语义（如"ClaudeOS 主项目，Node/TS/Vue3 + SQLite"）
  - files_of_interest：涉及文件的完整路径数组（子 Claude 会自己 Read）
  - failure_log：上次失败的报错日志（修复场景必填）
  - extra_constraints：项目硬约束（如"Windows + Git Bash、conventional commits 格式"）
- context：补充自由文本（可选）
- allowed_tools：子 Claude 可用工具，默认 "Bash,Read,Edit,Write,Grep,Glob"
- append_system_prompt：追加给子 Claude 的 system prompt（可选，不填则自动从 CLAUDE.md 读取）
- timeout_ms：超时毫秒，默认 300000，最大 1800000
- workdir：工作目录（默认当前工作目录）

注意：上下文不全是输出质量低的主要原因，务必把 files_of_interest 和 extra_constraints 填齐。`,
    input_schema: {
        type: 'object',
        properties: {
            task: {
                type: 'string',
                description: '任务描述（必填）',
            },
            project_context: {
                type: 'object',
                description: '结构化项目上下文',
                properties: {
                    cwd_note: { type: 'string', description: '工作目录语义描述' },
                    files_of_interest: {
                        type: 'array',
                        items: { type: 'string' },
                        description: '涉及文件的完整路径',
                    },
                    failure_log: { type: 'string', description: '上次失败的报错日志' },
                    extra_constraints: { type: 'string', description: '项目硬约束' },
                },
            },
            context: {
                type: 'string',
                description: '补充自由文本（可选）',
            },
            allowed_tools: {
                type: 'string',
                description: '子 Claude 可用工具，默认 "Bash,Read,Edit,Write,Grep,Glob"',
            },
            append_system_prompt: {
                type: 'string',
                description: '追加给子 Claude 的 system prompt，不填则自动从 CLAUDE.md 读取',
            },
            timeout_ms: {
                type: 'number',
                description: '超时毫秒，默认 300000，最大 1800000',
            },
            workdir: {
                type: 'string',
                description: '工作目录（相对或绝对路径）',
            },
        },
        required: ['task'],
    },
};

export async function executeClaudeCode(
    input: {
        task: string;
        project_context?: ProjectContext;
        context?: string;
        allowed_tools?: string;
        append_system_prompt?: string;
        timeout_ms?: number;
        workdir?: string;
    },
    _context: ToolContext
): Promise<ToolResult> {
    const {
        task,
        project_context,
        context,
        allowed_tools = 'Bash,Read,Edit,Write,Grep,Glob',
        append_system_prompt,
        timeout_ms,
        workdir,
    } = input;

    const startTime = Date.now();
    const timeoutMs = Math.min(Math.max(timeout_ms ?? DEFAULT_TIMEOUT_MS, 30000), MAX_TIMEOUT_MS);

    // 确定工作目录
    let actualCwd = _context.cwd || process.cwd();
    if (workdir) {
        actualCwd = resolve(actualCwd, workdir);
    }

    // 构造结构化 prompt
    const parts: string[] = [task];

    if (project_context?.cwd_note) {
        parts.push(`## 项目上下文\n${project_context.cwd_note}`);
    }
    if (project_context?.files_of_interest?.length) {
        parts.push(`## 涉及文件（请自行 Read 获取内容）\n${project_context.files_of_interest.join('\n')}`);
    }
    if (project_context?.failure_log) {
        parts.push(`## 上次失败日志\n\`\`\`\n${project_context.failure_log}\n\`\`\``);
    }
    if (project_context?.extra_constraints) {
        parts.push(`## 必须遵守的约束\n${project_context.extra_constraints}`);
    }
    if (context) {
        parts.push(`## 补充信息\n${context}`);
    }

    const prompt = parts.join('\n\n');

    // 确定 --append-system-prompt 内容
    const systemPromptToAppend = append_system_prompt ?? readClaudeMd(actualCwd);

    console.log(`[ClaudeCode] Task: ${task.slice(0, 60)}${task.length > 60 ? '...' : ''}, cwd: ${actualCwd}`);

    return new Promise((resolvePromise) => {
        let stdout = '';
        let stderr = '';
        let killed = false;
        let forceKillTimer: NodeJS.Timeout | null = null;

        const args = ['-p', prompt, '--allowedTools', allowed_tools, '--output-format', 'text'];
        if (systemPromptToAppend) {
            args.push('--append-system-prompt', systemPromptToAppend);
        }

        const child = spawn('claude', args, {
            cwd: actualCwd,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: {
                PATH: process.env.PATH,
                HOME: process.env.HOME,
                USER: process.env.USER,
                ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
                ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
                LANG: 'C',
                LC_ALL: 'C',
            },
        });

        child.stdout?.on('data', (data: Buffer) => { stdout += data.toString('utf8'); });
        child.stderr?.on('data', (data: Buffer) => { stderr += data.toString('utf8'); });

        const timeoutId = setTimeout(() => {
            killed = true;
            console.log(`[ClaudeCode] Timeout (${timeoutMs}ms), sending SIGTERM...`);
            child.kill('SIGTERM');
            forceKillTimer = setTimeout(() => {
                if (!child.killed) child.kill('SIGKILL');
            }, 5000);
        }, timeoutMs);

        const clearForceKill = () => {
            if (forceKillTimer) { clearTimeout(forceKillTimer); forceKillTimer = null; }
        };

        child.on('close', (code: number | null) => {
            clearTimeout(timeoutId);
            clearForceKill();
            const elapsed = Date.now() - startTime;

            let output = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n\n');
            if (killed) output += `\n\n[命令执行超时（${timeoutMs / 1000}秒），已终止]`;

            resolvePromise({
                success: code === 0 && !killed,
                data: {
                    output: truncateOutput(output),
                    exit_code: code ?? (killed ? -1 : 1),
                    task: task.slice(0, 100),
                },
                elapsed_ms: elapsed,
            });
        });

        child.on('error', (err: Error) => {
            clearTimeout(timeoutId);
            clearForceKill();
            const elapsed = Date.now() - startTime;

            if (err.message?.includes('ENOENT') || err.message?.includes('spawn claude')) {
                resolvePromise({
                    success: false,
                    error: 'Claude CLI 未安装或未在 PATH 中。请运行: npm install -g @anthropic-ai/claude-code',
                    data: { output: '', exit_code: -1 },
                    elapsed_ms: elapsed,
                });
                return;
            }

            let output = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n\n');
            output += killed
                ? `\n\n[命令执行超时（${timeoutMs / 1000}秒），已终止]`
                : `\n\n[执行错误: ${err.message}]`;

            resolvePromise({
                success: false,
                data: { output: truncateOutput(output), exit_code: -1 },
                error: err.message,
                elapsed_ms: elapsed,
            });
        });
    });
}

export const claudeCodeTool = {
    definition: claudeCodeToolDefinition,
    executor: executeClaudeCode,
    timeoutMs: MAX_TIMEOUT_MS,
    riskLevel: 'high' as const,
    requiresConfirmation: false,
};
