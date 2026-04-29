import { Hono } from 'hono';
import { authMiddleware } from '../middleware/auth';
import { AuthContext } from '../types';
import {
    listLessons,
    recordLesson,
    updateLesson,
    deleteLesson,
    readLessonDetail,
    linkLessons,
    unlinkLessons,
    getLessonGraph,
} from '../services/lessons';

export const lessonsRouter = new Hono<{ Variables: { user: AuthContext } }>();

lessonsRouter.use('*', authMiddleware);

/** GET /api/lessons?q=&taskType= — 全局列表 */
lessonsRouter.get('/', async (c) => {
    const q = c.req.query('q') || '';
    const taskType = c.req.query('taskType') || '';
    const lessons = listLessons({ q: q || undefined, taskType: taskType || undefined });
    return c.json({ lessons });
});

/** POST /api/lessons — 手动创建一条教训 */
lessonsRouter.post('/', async (c) => {
    const body = await c.req.json();
    const { task_type, title, summary, detail, links } = body;
    if (!task_type || !title || !summary || !detail) {
        return c.json({ error: 'task_type, title, summary, detail are required' }, 400);
    }
    const result = await recordLesson({ taskType: task_type, title, summary, detail, links });
    return c.json({ id: result.id, action: result.action });
});

/** GET /api/lessons/:id — 元数据 + 正文 */
lessonsRouter.get('/:id', async (c) => {
    const id = c.req.param('id');
    const lessons = await listLessons();
    const meta = lessons.find(l => l.id === id);
    if (!meta) return c.json({ error: 'Not found' }, 404);
    const detail = await readLessonDetail(id);
    return c.json({ ...meta, detail });
});

/** PUT /api/lessons/:id — 更新 */
lessonsRouter.put('/:id', async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json();
    await updateLesson(id, {
        title: body.title,
        summary: body.summary,
        detail: body.detail,
        taskType: body.task_type,
    });
    return c.json({ success: true });
});

/** DELETE /api/lessons/:id */
lessonsRouter.delete('/:id', async (c) => {
    const id = c.req.param('id');
    await deleteLesson(id);
    return c.json({ success: true });
});

/** GET /api/lessons/:id/graph?depth=1 */
lessonsRouter.get('/:id/graph', async (c) => {
    const id = c.req.param('id');
    const depth = parseInt(c.req.query('depth') || '1', 10);
    const graph = await getLessonGraph(id, depth);
    return c.json(graph);
});

/** POST /api/lessons/:from/links — 建立关联 */
lessonsRouter.post('/:from/links', async (c) => {
    const fromId = c.req.param('from');
    const body = await c.req.json();
    const { to_id, relation, strength } = body;
    if (!to_id || !relation) {
        return c.json({ error: 'to_id and relation are required' }, 400);
    }
    await linkLessons(fromId, to_id, relation, strength);
    return c.json({ success: true });
});

/** DELETE /api/lessons/:from/links/:to — 删除关联 */
lessonsRouter.delete('/:from/links/:to', async (c) => {
    const fromId = c.req.param('from');
    const toId = c.req.param('to');
    await unlinkLessons(fromId, toId);
    return c.json({ success: true });
});
