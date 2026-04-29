import { Hono } from 'hono';
import { randomUUID } from 'crypto';
import Anthropic from '@anthropic-ai/sdk';
import { getDb } from '../db';
import { getConfig, MODELS } from '../config';
import { authMiddleware } from '../middleware/auth';
import { AuthContext } from '../types';

export const plansRouter = new Hono<{ Variables: { user: AuthContext } }>();

plansRouter.use('*', authMiddleware);

// ── helpers ──────────────────────────────────────────────────────────────────

function mapStep(row: any) {
    return {
        id: row.id,
        plan_id: row.plan_id,
        order_index: row.idx,
        title: row.title,
        prompt: row.description || '',
        status: row.status,
        output: row.result || null,
        created_at: row.created_at,
        updated_at: row.updated_at,
    };
}

function getPlanWithSteps(db: ReturnType<typeof getDb>, id: string) {
    const plan = db.prepare('SELECT * FROM plans WHERE id = ?').get(id) as any;
    if (!plan) return null;
    const stepRows = db.prepare(
        'SELECT * FROM plan_steps WHERE plan_id = ? ORDER BY idx ASC'
    ).all(id) as any[];
    return { ...plan, steps: stepRows.map(mapStep) };
}

// ── routes ───────────────────────────────────────────────────────────────────

/** GET /api/plans?workspaceId= */
plansRouter.get('/', (c) => {
    const workspaceId = c.req.query('workspaceId');
    if (!workspaceId) return c.json({ error: 'workspaceId is required' }, 400);
    const db = getDb();
    const plans = db.prepare(
        'SELECT * FROM plans WHERE workspace_id = ? ORDER BY created_at DESC'
    ).all(workspaceId) as any[];
    return c.json({ plans });
});

/** GET /api/plans/:id */
plansRouter.get('/:id', (c) => {
    const db = getDb();
    const plan = getPlanWithSteps(db, c.req.param('id'));
    if (!plan) return c.json({ error: 'Not found' }, 404);
    return c.json({ plan });
});

/** POST /api/plans/generate — AI 拆解需求为步骤 */
plansRouter.post('/generate', async (c) => {
    const body = await c.req.json();
    const { workspaceId, requirement } = body;
    if (!workspaceId || !requirement) {
        return c.json({ error: 'workspaceId and requirement are required' }, 400);
    }

    const db = getDb();
    const config = getConfig();
    const now = Date.now();
    const planId = randomUUID();

    // Create plan record first
    db.prepare(
        `INSERT INTO plans (id, workspace_id, title, requirement, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'draft', ?, ?)`
    ).run(planId, workspaceId, requirement.slice(0, 60), requirement, now, now);

    // Call Haiku to split into steps
    try {
        const client = new Anthropic({ apiKey: config.anthropicApiKey });
        const resp = await client.messages.create({
            model: MODELS.compact,
            max_tokens: 1024,
            messages: [{
                role: 'user',
                content: `将以下需求拆解为 3~7 个有序执行步骤，以 JSON 数组返回，每项格式：{"title":"步骤标题","prompt":"给 agent 的具体执行指令"}。只返回 JSON 数组，不要其他内容。\n\n需求：${requirement}`,
            }],
        });

        const text = resp.content[0]?.type === 'text' ? resp.content[0].text.trim() : '[]';
        const jsonText = text.replace(/^```json\s*/i, '').replace(/```$/, '').trim();
        const parsed: Array<{ title: string; prompt: string }> = JSON.parse(jsonText);

        const insertStep = db.prepare(
            `INSERT INTO plan_steps (id, plan_id, idx, title, description, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`
        );
        for (let i = 0; i < parsed.length; i++) {
            insertStep.run(randomUUID(), planId, i, parsed[i].title, parsed[i].prompt, now, now);
        }
    } catch (e) {
        console.error('[Plans] AI generate failed:', e);
        // Insert a placeholder step so the plan is not empty
        db.prepare(
            `INSERT INTO plan_steps (id, plan_id, idx, title, description, status, created_at, updated_at)
             VALUES (?, ?, 0, ?, '', 'pending', ?, ?)`
        ).run(randomUUID(), planId, '步骤 1（AI 拆解失败，请手动编辑）', now, now);
    }

    const plan = getPlanWithSteps(db, planId);
    return c.json({ plan });
});

/** PUT /api/plans/:id — 更新标题 */
plansRouter.put('/:id', async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json();
    const db = getDb();
    if (body.title !== undefined) {
        db.prepare('UPDATE plans SET title = ?, updated_at = ? WHERE id = ?')
            .run(body.title, Date.now(), id);
    }
    return c.json({ success: true });
});

/** PUT /api/plans/:id/steps — 保存步骤 */
plansRouter.put('/:id/steps', async (c) => {
    const planId = c.req.param('id');
    const body = await c.req.json();
    const steps: Array<{ id?: string; title: string; prompt: string; order_index: number }> = body.steps || [];
    const db = getDb();
    const now = Date.now();

    // Delete all existing steps and re-insert (simplest for reorder)
    db.prepare('DELETE FROM plan_steps WHERE plan_id = ?').run(planId);
    const insert = db.prepare(
        `INSERT INTO plan_steps (id, plan_id, idx, title, description, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`
    );
    for (const s of steps) {
        insert.run(s.id && !s.id.startsWith('new-') ? s.id : randomUUID(),
            planId, s.order_index, s.title, s.prompt || '', now, now);
    }
    db.prepare('UPDATE plans SET updated_at = ? WHERE id = ?').run(now, planId);
    return c.json({ success: true });
});

/** POST /api/plans/:id/confirm */
plansRouter.post('/:id/confirm', async (c) => {
    const id = c.req.param('id');
    getDb().prepare("UPDATE plans SET status = 'confirmed', updated_at = ? WHERE id = ?")
        .run(Date.now(), id);
    return c.json({ success: true });
});

/** POST /api/plans/:id/execute — MVP: 仅改状态 */
plansRouter.post('/:id/execute', async (c) => {
    const id = c.req.param('id');
    getDb().prepare("UPDATE plans SET status = 'running', updated_at = ? WHERE id = ?")
        .run(Date.now(), id);
    return c.json({ success: true });
});

/** POST /api/plans/:id/pause */
plansRouter.post('/:id/pause', async (c) => {
    const id = c.req.param('id');
    getDb().prepare("UPDATE plans SET status = 'paused', updated_at = ? WHERE id = ?")
        .run(Date.now(), id);
    return c.json({ success: true });
});

/** POST /api/plans/:id/resume */
plansRouter.post('/:id/resume', async (c) => {
    const id = c.req.param('id');
    getDb().prepare("UPDATE plans SET status = 'running', updated_at = ? WHERE id = ?")
        .run(Date.now(), id);
    return c.json({ success: true });
});

/** DELETE /api/plans/:id */
plansRouter.delete('/:id', async (c) => {
    const id = c.req.param('id');
    const db = getDb();
    db.prepare('DELETE FROM plan_steps WHERE plan_id = ?').run(id);
    db.prepare('DELETE FROM plans WHERE id = ?').run(id);
    return c.json({ success: true });
});

/** POST /api/plans/:id/steps/:stepId/retry */
plansRouter.post('/:id/steps/:stepId/retry', async (c) => {
    const stepId = c.req.param('stepId');
    getDb().prepare("UPDATE plan_steps SET status = 'pending', result = NULL, updated_at = ? WHERE id = ?")
        .run(Date.now(), stepId);
    return c.json({ success: true });
});

/** POST /api/plans/:id/steps/:stepId/skip */
plansRouter.post('/:id/steps/:stepId/skip', async (c) => {
    const stepId = c.req.param('stepId');
    getDb().prepare("UPDATE plan_steps SET status = 'skipped', updated_at = ? WHERE id = ?")
        .run(Date.now(), stepId);
    return c.json({ success: true });
});
