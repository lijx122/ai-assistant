/**
 * Post-Session Processor
 *
 * 会话结束后自动处理：
 * 1. 更新 todolist 文件
 * 2. 更新工作区记忆
 * 3. 更新用户偏好印象
 *
 * 三层架构：
 * - Layer 1: 当前对话记忆（compact + Recall，已在外部实现）
 * - Layer 2: 工作区记忆（项目级，每 workspace 一条）
 * - Layer 3: 用户偏好（复用 compact 总结时机，置信度过滤）
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import Anthropic from '@anthropic-ai/sdk';
import { getDb } from '../db';
import { getConfig, MODELS } from '../config';
import { randomUUID } from 'crypto';

interface Message {
    id: string;
    session_id: string;
    workspace_id: string;
    role: string;
    content: string;
    created_at: number;
}

interface TodolistUpdateResult {
    success: boolean;
    filepath?: string;
    updated: boolean;
    error?: string;
}

interface WorkspaceMemoryResult {
    success: boolean;
    updated: boolean;
    content?: string;
    error?: string;
}

interface ImpressionResult {
    success: boolean;
    updated: boolean;
    content?: string;
    confidence?: number;
    error?: string;
}

interface PostSessionResult {
    step1: TodolistUpdateResult;
    step2: WorkspaceMemoryResult;
    step3: ImpressionResult;
}

// Todolist 文件优先级（从 config 读取，有默认值）
let TODOLIST_FILENAMES: string[] = ['todo.md', 'TODO.md', 'todolist.md'];

/**
 * 更新配置缓存（应在配置加载后调用）
 */
export function updateMemoryConfigCache(): void {
    const config = getConfig();
    TODOLIST_FILENAMES = config.memory.workspace.todolist_filenames;
    console.log('[PostSession] Config cache updated:', {
        todolist_filenames: TODOLIST_FILENAMES,
        workspace_enabled: config.memory.workspace.enabled,
        impression_enabled: config.memory.impression.enabled,
    });
}

/**
 * 主入口：执行 Post-Session 处理
 */
export async function runPostSession(
    sessionId: string,
    workspaceId: string
): Promise<PostSessionResult> {
    console.log(`[PostSession] Starting processing for session=${sessionId}, workspace=${workspaceId}`);

    const result: PostSessionResult = {
        step1: { success: false, updated: false },
        step2: { success: false, updated: false },
        step3: { success: false, updated: false },
    };

    // Step 1: 更新 todolist 文件
    try {
        result.step1 = await updateTodolist(sessionId, workspaceId);
        console.log(`[PostSession] Step 1 (Todolist) done: ${result.step1.updated ? 'updated' : 'skipped'}`);
    } catch (error: any) {
        console.error(`[PostSession] Step 1 (Todolist) failed:`, error.message);
        result.step1 = { success: false, updated: false, error: error.message };
    }

    // Step 2: 更新工作区记忆
    try {
        result.step2 = await updateWorkspaceMemory(sessionId, workspaceId, result.step1.filepath);
        console.log(`[PostSession] Step 2 (WorkspaceMemory) done: ${result.step2.updated ? 'updated' : 'skipped'}`);
    } catch (error: any) {
        console.error(`[PostSession] Step 2 (WorkspaceMemory) failed:`, error.message);
        result.step2 = { success: false, updated: false, error: error.message };
    }

    // Step 3: 更新用户偏好
    try {
        result.step3 = await updateImpressions(sessionId, workspaceId);
        console.log(`[PostSession] Step 3 (Impressions) done: ${result.step3.updated ? 'updated' : 'skipped'}`);
    } catch (error: any) {
        console.error(`[PostSession] Step 3 (Impressions) failed:`, error.message);
        result.step3 = { success: false, updated: false, error: error.message };
    }

    console.log(`[PostSession] Completed for session=${sessionId}`);
    return result;
}

/**
 * Step 1: 更新 todolist 文件
 * - 查找工作区根目录 todo.md / TODO.md / todolist.md（文件名从 config 读取）
 * - 读取最后 20 轮消息
 * - Haiku 生成更新后的 todolist
 * - 写回文件
 */
async function updateTodolist(
    sessionId: string,
    workspaceId: string
): Promise<TodolistUpdateResult> {
    const config = getConfig();
    const workspacePath = resolve(config.dataDir, 'workspaces', workspaceId);

    // 使用配置中的文件名列表
    const todolistFilenames = config.memory.workspace.todolist_filenames;

    // 查找存在的 todolist 文件
    let todolistPath: string | null = null;
    for (const filename of todolistFilenames) {
        const filepath = resolve(workspacePath, filename);
        if (existsSync(filepath)) {
            todolistPath = filepath;
            break;
        }
    }

    // 如果都不存在，默认创建第一个
    if (!todolistPath) {
        todolistPath = resolve(workspacePath, todolistFilenames[0] || 'todo.md');
    }

    // 读取现有内容（如果存在）
    let existingContent = '';
    if (existsSync(todolistPath)) {
        existingContent = readFileSync(todolistPath, 'utf8');
    }

    // 读取最后 20 轮消息
    const messages = getRecentMessages(sessionId, 40); // 20轮 = 40条消息（user+assistant）
    if (messages.length === 0) {
        return { success: true, filepath: todolistPath, updated: false };
    }

    // 格式化消息用于 Haiku
    const formattedMessages = formatMessagesForPrompt(messages);

    // 调用 Haiku 更新 todolist
    const updatedContent = await generateTodolistUpdate(existingContent, formattedMessages);

    // 如果内容有变化，写回文件
    if (updatedContent !== existingContent) {
        writeFileSync(todolistPath, updatedContent, 'utf8');
        return { success: true, filepath: todolistPath, updated: true };
    }

    return { success: true, filepath: todolistPath, updated: false };
}

/**
 * Step 2: 更新工作区记忆
 * - 读取更新后的 todolist + 当前 workspace_memory + 最后 20 轮消息
 * - Haiku 生成/更新项目记忆
 * - UPSERT 写入，控制在 config.memory.workspace.max_chars 以内
 */
async function updateWorkspaceMemory(
    sessionId: string,
    workspaceId: string,
    todolistPath: string | undefined
): Promise<WorkspaceMemoryResult> {
    const config = getConfig();

    // 检查功能是否启用
    if (!config.memory.workspace.enabled) {
        console.log(`[PostSession] Workspace memory disabled, skipping`);
        return { success: true, updated: false };
    }

    const db = getDb();

    // 读取当前工作区记忆
    const currentMemory = db.prepare(
        'SELECT content FROM workspace_memory WHERE workspace_id = ?'
    ).get(workspaceId) as { content: string } | undefined;

    // 读取更新后的 todolist
    let todolistContent = '';
    if (todolistPath && existsSync(todolistPath)) {
        todolistContent = readFileSync(todolistPath, 'utf8');
    }

    // 读取最后 20 轮消息
    const messages = getRecentMessages(sessionId, 40);
    const formattedMessages = formatMessagesForPrompt(messages);

    // 调用 Haiku 生成工作区记忆
    const newMemory = await generateWorkspaceMemory(
        currentMemory?.content || '',
        todolistContent,
        formattedMessages,
        config.memory.workspace.max_chars
    );

    // UPSERT 写入数据库
    const id = randomUUID();
    const now = new Date().toISOString();

    db.prepare(
        `INSERT INTO workspace_memory (id, workspace_id, content, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(workspace_id) DO UPDATE SET
            content = excluded.content,
            updated_at = excluded.updated_at`
    ).run(id, workspaceId, newMemory, now);

    return { success: true, updated: true, content: newMemory };
}

/**
 * Step 3: 更新用户偏好
 * - 读取当前 impressions + 最后 10 轮消息
 * - Haiku 更新偏好，输出含 confidence(0.0-1.0) 的结构
 * - 置信度 < config.memory.impression.min_confidence 的内容不写入
 */
async function updateImpressions(
    sessionId: string,
    workspaceId: string
): Promise<ImpressionResult> {
    const config = getConfig();

    // 检查功能是否启用
    if (!config.memory.impression.enabled) {
        console.log(`[PostSession] Impressions disabled, skipping`);
        return { success: true, updated: false };
    }

    const db = getDb();

    // 读取当前用户偏好
    const currentImpression = db.prepare(
        'SELECT content, confidence_avg FROM impressions WHERE workspace_id = ?'
    ).get(workspaceId) as { content: string; confidence_avg: number } | undefined;

    // 读取最后 10 轮消息
    const messages = getRecentMessages(sessionId, 20);
    const formattedMessages = formatMessagesForPrompt(messages);

    // 调用 Haiku 更新用户偏好
    const result = await generateImpressions(
        currentImpression?.content || '',
        formattedMessages,
        config.memory.impression.max_chars
    );

    // 置信度检查（使用配置的阈值）
    const minConfidence = config.memory.impression.min_confidence;
    if (result.confidence < minConfidence) {
        return {
            success: true,
            updated: false,
            content: result.content,
            confidence: result.confidence
        };
    }

    // 计算平均置信度（如果有历史记录）
    const newConfidenceAvg = currentImpression?.confidence_avg
        ? (currentImpression.confidence_avg + result.confidence) / 2
        : result.confidence;

    // UPSERT 写入数据库
    const id = randomUUID();
    const now = new Date().toISOString();

    db.prepare(
        `INSERT INTO impressions (id, workspace_id, content, confidence_avg, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(workspace_id) DO UPDATE SET
            content = excluded.content,
            confidence_avg = excluded.confidence_avg,
            updated_at = excluded.updated_at`
    ).run(id, workspaceId, result.content, newConfidenceAvg, now);

    return {
        success: true,
        updated: true,
        content: result.content,
        confidence: result.confidence
    };
}

/**
 * 从数据库读取最近 N 条消息
 */
function getRecentMessages(sessionId: string, limit: number): Message[] {
    const db = getDb();
    return db.prepare(
        `SELECT id, session_id, workspace_id, role, content, created_at
         FROM messages
         WHERE session_id = ? AND status = 'complete'
         ORDER BY created_at DESC
         LIMIT ?`
    ).all(sessionId, limit) as Message[];
}

/**
 * 格式化消息用于 Haiku prompt
 */
function formatMessagesForPrompt(messages: Message[]): string {
    // 按时间升序排列（数据库返回是 DESC）
    const sorted = [...messages].sort((a, b) => a.created_at - b.created_at);

    return sorted.map((msg, idx) => {
        const content = extractTextFromContent(msg.content);
        // 截断超长内容
        const truncated = content.length > 500
            ? content.slice(0, 500) + '... [截断]'
            : content;
        return `[${idx + 1}] ${msg.role.toUpperCase()}: ${truncated}`;
    }).join('\n\n');
}

/**
 * 从 content 中提取纯文本
 */
function extractTextFromContent(content: string): string {
    try {
        const parsed = JSON.parse(content);
        if (Array.isArray(parsed)) {
            return parsed
                .filter((b: any) => b.type === 'text' && b.text)
                .map((b: any) => b.text)
                .join(' ');
        }
        if (typeof parsed === 'string') {
            return parsed;
        }
        if (parsed.text) {
            return parsed.text;
        }
    } catch {
        // 不是 JSON，返回原样
    }
    return content;
}

/**
 * 调用 Anthropic Haiku 生成 todolist 更新
 */
async function generateTodolistUpdate(
    existingTodolist: string,
    recentMessages: string
): Promise<string> {
    const config = getConfig();
    const anthropic = new Anthropic({
        apiKey: config.anthropicApiKey,
        baseURL: config.anthropicBaseUrl,
    });

    const prompt = `你是一个任务管理助手。请根据最近的对话内容，更新下方的 todolist。

## 当前 Todolist
${existingTodolist || '(空)'}

## 最近对话记录
${recentMessages}

## 更新要求
1. 标记已完成的任务（将 [ ] 改为 [x]）
2. 添加新任务（基于对话中明确提到的新需求）
3. 保持原有格式和结构
4. 如果对话中取消了某个任务，可以删除或标记为取消
5. 可以适当补充子任务或备注
6. 保持简洁，不要添加与对话无关的内容

请直接输出更新后的 todolist 内容（保持 Markdown 格式）：`;

    try {
        const response = await anthropic.messages.create({
            model: MODELS.compact,
            max_tokens: 1500,
            messages: [{ role: 'user', content: prompt }],
        });

        const textBlock = response.content.find((b: any) => b.type === 'text');
        if (!textBlock || textBlock.type !== 'text') {
            return existingTodolist;
        }

        return textBlock.text.trim();
    } catch (error) {
        console.error('[PostSession] Haiku todolist update failed:', error);
        return existingTodolist;
    }
}

/**
 * 调用 Anthropic Haiku 生成工作区记忆
 */
async function generateWorkspaceMemory(
    currentMemory: string,
    todolistContent: string,
    recentMessages: string,
    maxChars: number = 300
): Promise<string> {
    const config = getConfig();
    const anthropic = new Anthropic({
        apiKey: config.anthropicApiKey,
        baseURL: config.anthropicBaseUrl,
    });

    const prompt = `你是一个项目记忆助手。请根据当前记忆、todolist 和最近对话，生成简洁的工作区记忆。

## 当前工作区记忆
${currentMemory || '(无)'}

## 当前 Todolist
${todolistContent || '(无)'}

## 最近对话记录
${recentMessages}

## 生成要求
1. 控制在 ${maxChars} 字以内
2. 包含以下方面：
   - 项目架构/技术栈（如有提及）
   - 重要决策和关键节点
   - 关键文件/模块
   - 长期任务和待办
   - 失败记录（尝试过但失败的方案，避免AI重复踩坑）
3. 保留旧记忆中的有效信息，合并新信息
4. 使用简洁的要点形式

请直接输出工作区记忆内容：`;

    try {
        const response = await anthropic.messages.create({
            model: MODELS.compact,
            max_tokens: 800,
            messages: [{ role: 'user', content: prompt }],
        });

        const textBlock = response.content.find((b: any) => b.type === 'text');
        if (!textBlock || textBlock.type !== 'text') {
            return currentMemory || '（暂无记忆）';
        }

        const memory = textBlock.text.trim();
        // 确保不超过 maxChars
        if (memory.length > maxChars) {
            return memory.slice(0, maxChars - 3) + '...';
        }
        return memory;
    } catch (error) {
        console.error('[PostSession] Haiku workspace memory failed:', error);
        return currentMemory || '（暂无记忆）';
    }
}

interface ImpressionResultData {
    content: string;
    confidence: number;
}

/**
 * 调用 Anthropic Haiku 生成用户偏好
 */
async function generateImpressions(
    currentImpression: string,
    recentMessages: string,
    maxChars: number = 300
): Promise<ImpressionResultData> {
    const config = getConfig();
    const anthropic = new Anthropic({
        apiKey: config.anthropicApiKey,
        baseURL: config.anthropicBaseUrl,
    });

    const prompt = `你是一个用户画像助手。请根据当前印象和最近对话，更新用户偏好信息。

## 当前用户印象
${currentImpression || '(无)'}

## 最近对话记录
${recentMessages}

## 更新要求
1. 包含以下方面（如能从对话中明确推断）：
   - 基本信息（称呼/职业/地点等用户明确说出的）
   - 技术偏好（喜欢的语言/框架/工具）
   - 沟通偏好（喜欢详细/简洁、主动/被动等）
   - 工作习惯（工作时间、代码风格偏好等）
2. 只记录用户**明确表达**的信息，不要猜测
3. 控制在 ${maxChars} 字以内

## 输出格式
请以 JSON 格式输出：
{
  "content": "用户印象内容（纯文本）",
  "confidence": 0.85  // 0.0-1.0，表示你对这些信息的确定程度
}

confidence 评分标准：
- 0.9-1.0：用户明确说出的信息（如"我是Java开发者"）
- 0.7-0.9：可以合理推断但有一定假设（如多次提到喜欢React）
- <0.7：不确定性较高的推断

confidence < 0.7 的内容不会被记录。请只输出 JSON：`;

    try {
        const response = await anthropic.messages.create({
            model: MODELS.compact,
            max_tokens: 500,
            messages: [{ role: 'user', content: prompt }],
        });

        const textBlock = response.content.find((b: any) => b.type === 'text');
        if (!textBlock || textBlock.type !== 'text') {
            return { content: currentImpression || '', confidence: 0 };
        }

        // 解析 JSON 响应
        const text = textBlock.text.trim();
        // 尝试提取 JSON 块
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            return {
                content: parsed.content || currentImpression || '',
                confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5
            };
        }

        // 降级：返回纯文本，置信度 0
        return { content: currentImpression || '', confidence: 0 };
    } catch (error) {
        console.error('[PostSession] Haiku impressions failed:', error);
        return { content: currentImpression || '', confidence: 0 };
    }
}

/**
 * 检查会话是否已处理（防重）
 */
export function isSessionProcessed(sessionId: string): boolean {
    const db = getDb();
    const row = db.prepare(
        'SELECT 1 FROM post_session_log WHERE session_id = ?'
    ).get(sessionId);
    return !!row;
}

/**
 * 标记会话为已处理
 */
export function markSessionProcessed(sessionId: string): void {
    const db = getDb();
    const id = randomUUID();
    const now = new Date().toISOString();

    db.prepare(
        `INSERT INTO post_session_log (id, session_id, triggered_at)
         VALUES (?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
            triggered_at = excluded.triggered_at`
    ).run(id, sessionId, now);
}

/**
 * 获取工作区记忆（用于对话前注入）
 */
export function getWorkspaceMemory(workspaceId: string): string | null {
    const db = getDb();
    const row = db.prepare(
        'SELECT content FROM workspace_memory WHERE workspace_id = ?'
    ).get(workspaceId) as { content: string } | undefined;
    return row?.content || null;
}

/**
 * 获取用户偏好（用于对话前注入）
 */
export function getImpressions(workspaceId: string): string | null {
    const db = getDb();
    const row = db.prepare(
        'SELECT content FROM impressions WHERE workspace_id = ?'
    ).get(workspaceId) as { content: string } | undefined;
    return row?.content || null;
}
