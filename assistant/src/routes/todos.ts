import { Hono } from 'hono';
import { readTodoList, writeTodoList } from '../services/tools/todo';
import { executeClaudeCode } from '../services/tools/claude-code';
import { getWorkspaceRootPath } from '../services/workspace-config';
import { broadcastToWorkspace } from './chat';

export const todoRouter = new Hono();

export const autoExecuteState = new Map<string, boolean>();
const executingWorkspaces = new Set<string>();

// GET /api/todos?workspaceId=xxx
todoRouter.get('/', async (c) => {
    const workspaceId = c.req.query('workspaceId');
    if (!workspaceId) {
        return c.json({ error: 'workspaceId is required' }, 400);
    }
    const list = readTodoList(workspaceId);
    return c.json({
        ...list,
        autoExecute: autoExecuteState.get(workspaceId) || false,
    });
});

// GET /api/todos/auto-execute
todoRouter.get('/auto-execute', (c) => {
    const workspaceId = c.req.query('workspaceId');
    if (!workspaceId) {
        return c.json({ error: 'workspaceId is required' }, 400);
    }
    return c.json({ autoExecute: autoExecuteState.get(workspaceId) || false });
});

// POST /api/todos/auto-execute
todoRouter.post('/auto-execute', async (c) => {
    const { workspaceId, enabled } = await c.req.json();
    if (!workspaceId) {
        return c.json({ error: 'workspaceId is required' }, 400);
    }

    autoExecuteState.set(workspaceId, enabled);
    broadcastToWorkspace(workspaceId, { type: 'auto_execute_changed', payload: { enabled } });
    
    if (enabled && !executingWorkspaces.has(workspaceId)) {
        startExecutionLoop(workspaceId).catch(err => {
            console.error('[TodoLoop] loop error:', err);
        });
    }
    
    return c.json({ success: true, enabled });
});

// PATCH /api/todos/:index
todoRouter.patch('/:index', async (c) => {
    const { workspaceId, status, text } = await c.req.json();
    const index = parseInt(c.req.param('index'), 10);
    if (!workspaceId) {
        return c.json({ error: 'workspaceId is required' }, 400);
    }
    
    const list = readTodoList(workspaceId);
    if (index >= 0 && index < list.items.length) {
        if (typeof status === 'string') {
            list.items[index].status = status as any;
        }
        if (typeof text === 'string') {
            list.items[index].text = text;
        }
        writeTodoList(workspaceId, list.items);
        return c.json({ success: true });
    }
    return c.json({ error: 'Index out of bounds' }, 404);
});

// 执行闭环逻辑
async function startExecutionLoop(workspaceId: string) {
    if (executingWorkspaces.has(workspaceId)) return;
    executingWorkspaces.add(workspaceId);

    try {
        while (autoExecuteState.get(workspaceId)) {
            const list = readTodoList(workspaceId);
            const items = [...list.items];
            const pendingIndex = items.findIndex(i => i.status === 'pending');
            
            if (pendingIndex === -1) {
                // 如果没有待执行任务，自动关闭开关
                autoExecuteState.set(workspaceId, false);
                broadcastToWorkspace(workspaceId, { type: 'auto_execute_changed', payload: { enabled: false } });
                break;
            }
            
            items[pendingIndex].status = 'running';
            items[pendingIndex].output = undefined;
            items[pendingIndex].error = undefined;
            writeTodoList(workspaceId, items);

            const taskText = items[pendingIndex].text;
            const cwd = getWorkspaceRootPath(workspaceId);
            const contextWrapper = { cwd, workspaceId };
            
            let output = '';
            let errorMsg = '';
            let status: 'done' | 'failed' = 'done';
            
            try {
                // 使用 claude-code 执行任务
                const result = await executeClaudeCode({
                    task: taskText,
                    context: "Auto-executing todo item."
                }, contextWrapper);

                if (result.success) {
                    status = 'done';
                    if (result.data && typeof result.data.output === 'string') {
                        output = result.data.output;
                    } else {
                        output = 'Success';
                    }
                } else {
                    status = 'failed';
                    errorMsg = result.error || 'Failed to execute';
                    if (result.data && typeof result.data.output === 'string') {
                        output = result.data.output;
                    }
                }
            } catch (err: any) {
                status = 'failed';
                errorMsg = err.message || 'Unknown error';
            }

            // 执行完毕，重读状态防止冲突
            const currentList = readTodoList(workspaceId);
            const updatedItems = [...currentList.items];
            
            // 基于文本和正在执行状态找到原来的项目并更新
            const matchedIndex = updatedItems.findIndex(i => i.text === taskText && i.status === 'running');
            
            if (matchedIndex !== -1) {
                updatedItems[matchedIndex].status = status;
                updatedItems[matchedIndex].output = output;
                updatedItems[matchedIndex].error = errorMsg;
                writeTodoList(workspaceId, updatedItems);
            } else if (pendingIndex < updatedItems.length) {
                // 兜底降级：直接以最初索引更新
                updatedItems[pendingIndex].status = status;
                updatedItems[pendingIndex].output = output;
                updatedItems[pendingIndex].error = errorMsg;
                writeTodoList(workspaceId, updatedItems);
            }
        }
    } finally {
        executingWorkspaces.delete(workspaceId);
    }
}
