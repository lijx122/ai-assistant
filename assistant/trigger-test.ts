import { triggerTask } from './src/services/cron';
import { initDb } from './src/db';
import { loadConfig } from './src/config';
import { getDb } from './src/db';

loadConfig();
initDb();

const taskId = '9a27acc5-7cce-47eb-982b-66894e051990';
console.log(`[Test] Triggering task ${taskId}...`);

async function waitForAlert(taskId: string, timeout = 30000): Promise<void> {
    const db = getDb();
    const start = Date.now();
    
    while (Date.now() - start < timeout) {
        const alert = db.prepare(
            "SELECT id, status, ai_analysis FROM alerts WHERE task_id = ? ORDER BY created_at DESC LIMIT 1"
        ).get(taskId) as { id: string; status: string; ai_analysis: string } | undefined;
        
        if (alert) {
            console.log(`[Test] Alert ${alert.id}: status=${alert.status}, ai_analysis=${alert.ai_analysis ? 'set' : 'null'}`);
            if (alert.status === 'notified' || alert.ai_analysis) {
                console.log('[Test] Alert processed successfully!');
                return;
            }
        }
        
        await new Promise(r => setTimeout(r, 1000));
    }
    throw new Error('Timeout waiting for alert processing');
}

triggerTask(taskId).then(() => {
    console.log('[Test] Task triggered, waiting for alert processing...');
    return waitForAlert(taskId);
}).then(() => {
    process.exit(0);
}).catch((err) => {
    console.error('[Test] Failed:', err);
    process.exit(1);
});
