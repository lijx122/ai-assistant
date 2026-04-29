/**
 * record_lesson 工具
 * 让 agent 把用户的自然语言纠正/规则写入全局经验库
 */

import type { ToolDefinition, ToolContext, ToolResult } from './types';
import { recordLesson } from '../lessons';

export const recordLessonToolDefinition: ToolDefinition = {
    name: 'record_lesson',
    description: `将一条可复用的规则/教训写入全局经验库（lessons）。

调用时机：当用户明确纠正了你的做法，或描述了一条"将来同类任务应该遵守的规则"时，主动调用此工具。

判断标准（满足任意一条就写）：
- 用户说"不对/别这样/下次/以后/记住/应该"等纠正性表述
- 用户描述了一个可在未来同类任务中重复使用的规则
- 你发现了一个之前未注意到的、对未来有价值的约束

不要记录（这些不是教训）：
- 一次性的事实或状态（"这个文件是 X"、"当前版本是 Y"）
- 用户的个人喜好但没有规则性（"我喜欢蓝色"）
- 已经存在于代码或文档中的显式规范

参数说明：
- task_type：分类标签，自由文本（如 "ts-debug"、"git-commit"、"vue-component"）
- title：一句话总结，≤60字，用于向量化检索
- summary：简短说明（≤200字），包含 Why——为什么这条规则重要
- detail：完整内容，支持 Markdown，建议结构：规则 → Why → How to apply
- links：可选，与已有教训建立关联 [{target_id, relation}]，relation 用 contradicts/refines/prerequisite/related

全局共享：所有 workspace 共用同一个 lessons 库，习惯跨项目积累。`,
    input_schema: {
        type: 'object',
        properties: {
            task_type: {
                type: 'string',
                description: '分类标签（如 "ts-debug"、"git-commit"）',
            },
            title: {
                type: 'string',
                description: '一句话总结，≤60字',
            },
            summary: {
                type: 'string',
                description: '简短说明（≤200字），包含 Why',
            },
            detail: {
                type: 'string',
                description: '完整 Markdown 内容：规则 → Why → How to apply',
            },
            links: {
                type: 'array',
                description: '与已有教训建立关联（可选）',
                items: {
                    type: 'object',
                    properties: {
                        target_id: { type: 'string', description: '目标教训 ID' },
                        relation: { type: 'string', description: 'contradicts / refines / prerequisite / related' },
                        strength: { type: 'number', description: '关联强度 0~1，默认 1.0' },
                    },
                    required: ['target_id', 'relation'],
                },
            },
        },
        required: ['task_type', 'title', 'summary', 'detail'],
    },
};

export async function executeRecordLesson(
    input: {
        task_type: string;
        title: string;
        summary: string;
        detail: string;
        links?: Array<{ target_id: string; relation: string; strength?: number }>;
    },
    context: ToolContext
): Promise<ToolResult> {
    const { task_type, title, summary, detail, links } = input;

    // 截断 title/summary 防止意外过长
    const safeTitle = title.slice(0, 120);
    const safeSummary = summary.slice(0, 500);

    const result = await recordLesson({
        taskType: task_type,
        title: safeTitle,
        summary: safeSummary,
        detail,
        sourceSessionId: context.sessionId,
        sourceWorkspaceId: context.workspaceId,
        links,
    });

    return {
        success: true,
        data: {
            id: result.id,
            action: result.action,
            task_type,
            title: safeTitle,
            message: result.action === 'created'
                ? `教训已记录（ID: ${result.id}）`
                : `已更新已有相似教训（ID: ${result.id}）`,
        },
    };
}

export const recordLessonTool = {
    definition: recordLessonToolDefinition,
    executor: executeRecordLesson,
    timeoutMs: 15000,
    riskLevel: 'low' as const,
    requiresConfirmation: false,
};
